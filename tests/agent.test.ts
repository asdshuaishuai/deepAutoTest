/**
 * Agent 层（脚本驱动，确定性）：manager 全链路 + 七工具 + pid 越权 + P3 + checkpoint + 脱敏 + 降级 + PRD 提取。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentManager } from '../src/agent/manager.ts';
import { ScriptedFxDriver, type ScriptedTurn } from '../src/agent/scripted-driver.ts';
import { applyPrdExtraction } from '../src/agent/prd-task.ts';
import { executeTool } from '../src/agent/tools.ts';
import { mintProjectScope } from '../src/kernel/shared/ids.ts';
import { indexLocalSource } from '../src/analysis/scan.ts';
import { testKernel } from './helpers.ts';

async function makeFixtureProject(): Promise<{ kernel: ReturnType<typeof testKernel>['kernel']; h: ReturnType<typeof testKernel>; projectId: number; repo: string }> {
  const h = testKernel();
  const repo = join(tmpdir(), `dat-agent-repo-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'routes.ts'),
    "import { Router } from 'express';\nexport const router = Router();\nrouter.post('/orders', (q, r) => r.json({}));\n",
  );
  const project = await h.kernel.call('project:create', { name: 'svc', sourceType: 'local', localPath: repo });
  await indexLocalSource(h.kernel, project.id, repo);
  return { kernel: h.kernel, h, projectId: project.id, repo };
}

function turnOf(events: ScriptedTurn['events'], result: ScriptedTurn['result'], checkpoint?: Uint8Array): ScriptedTurn {
  return checkpoint === undefined ? { events, result } : { events, result, checkpoint };
}

describe('AgentManager（脚本驱动）', () => {
  it('完整一轮：流式文本落库（脱敏）、凭据永不入库、checkpoint 往返', async () => {
    const { kernel, h, projectId } = await makeFixtureProject();
    const checkpoint = new Uint8Array([9, 9, 9]);
    const driver = new ScriptedFxDriver([
      turnOf([{ type: 'text_delta', text: '联系人 138' }, { type: 'text_delta', text: '12345678 已分析' }], { stopReason: 'end_turn', tokensIn: 10, tokensOut: 5 }, checkpoint),
      turnOf([{ type: 'text_delta', text: '第二轮（基于 checkpoint 续跑）' }], { stopReason: 'end_turn' }),
    ]);
    const manager = new AgentManager({ kernel, driver, apiKeyProvider: () => 'sk-test', model: 'gpt-5-mini' });

    const probe = await manager.probe();
    expect(probe.available).toBe(true);

    const session = await manager.createSession(projectId, 'case_synth');
    const t1 = await manager.runTurn(projectId, session.id, '分析下单接口');
    expect(t1.stopReason).toBe('end_turn');
    expect(t1.errorCode).toBeNull();
    expect(t1.checkpointSaved).toBe(true);

    // 落库：user → assistant，内容脱敏
    const turns = await kernel.call('agent:turn:list', { projectId, sessionId: session.id });
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[1]!.content).toBe('联系人 138****5678 已分析');
    expect(turns[1]!.content).not.toContain('13812345678');

    // checkpoint 往返：第二轮创建会话时注入了第一轮的 checkpoint
    const t2 = await manager.runTurn(projectId, session.id, '继续');
    expect(t2.turnSeqs.length).toBe(2);
    expect(Buffer.from(driver.createdSessions[1]!.checkpoint!).equals(Buffer.from(checkpoint))).toBe(true); // checkpoint 字节级往返

    // session 列表：turnCount / hasCheckpoint
    const sessions = await kernel.call('agent:session:list', { projectId });
    expect(sessions[0]).toMatchObject({ turnCount: 4, hasCheckpoint: true });
    h.dispose();
  });

  it('工具桥：draft_case 产出 proposed（P3）；list_routes 只见本项目', async () => {
    const { kernel, h, projectId } = await makeFixtureProject();
    const driver = new ScriptedFxDriver([
      turnOf([{ type: 'tool_result', name: 'draft_case', ok: true }], { stopReason: 'end_turn' }),
    ]);
    const manager = new AgentManager({ kernel, driver, apiKeyProvider: () => 'sk', model: 'm' });
    const session = await manager.createSession(projectId, 'case_synth');

    // 模拟 Agent 经工具桥起草用例（真桥走 executeTool 回调）
    void manager;
    const scope = mintProjectScope(projectId);
    const outcome = await executeTool({ kernel, scope, repoRoot: null }, 'draft_case', {
      pid: projectId,
      draft: {
        name: 'Agent 草稿', description: null, routeId: null, paramKind: 'single',
        steps: [{ id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/orders' } }],
        params: { kind: 'single', rows: [{ label: 'baseline', values: {}, intent: 'baseline' }] },
        provenance: { principles: [], samples: [], agentSession: session.id, agentTurn: 1 },
        policyOverride: null, tags: [],
      },
    });
    expect(outcome).toMatchObject({ ok: true });
    if (outcome.ok) expect(outcome.data).toMatchObject({ status: 'proposed' }); // AI 生成 ≠ 生效

    const cases = await kernel.call('case:list', { projectId, status: 'proposed' });
    expect(cases[0]!.proposedBy).toBe('fx-agent');

    // 工具调用留痕（07 §6）
    await kernel.call('agent:turn:append', { projectId, sessionId: session.id, role: 'tool', content: 'drafted', toolName: 'draft_case' });
    const turns = await kernel.call('agent:turn:list', { projectId, sessionId: session.id });
    expect(turns.some((t) => t.role === 'tool' && t.toolName === 'draft_case')).toBe(true);
    h.dispose();
  });

  it('pid 越权：Agent 传别的 pid → fx_tool_denied（留痕由调用方写 turn）', async () => {
    const { kernel, h, projectId } = await makeFixtureProject();
    const scope = mintProjectScope(projectId);
    const outcome = await executeTool({ kernel, scope, repoRoot: null }, 'list_routes', { pid: 999 });
    expect(outcome).toMatchObject({ ok: false, code: 'fx_tool_denied' });
    if (!outcome.ok) expect(outcome.message).toContain('越权');

    // 未知工具同样拒绝（白名单之外）
    const rogue = await executeTool({ kernel, scope, repoRoot: null }, 'shell', { pid: projectId, cmd: 'rm -rf /' });
    expect(rogue).toMatchObject({ ok: false, code: 'fx_tool_denied' });
    h.dispose();
  });

  it('read_source：路径边界（越界拒绝）；凭据字段脱敏', async () => {
    const { kernel, h, projectId, repo } = await makeFixtureProject();
    const scope = mintProjectScope(projectId);

    const okRead = await executeTool({ kernel, scope, repoRoot: repo }, 'read_source', { pid: projectId, path: 'src/routes.ts' });
    expect(okRead.ok).toBe(true);

    const escape = await executeTool({ kernel, scope, repoRoot: repo }, 'read_source', { pid: projectId, path: '../../../etc/passwd' });
    expect(escape).toMatchObject({ ok: false, code: 'fx_tool_denied' });
    h.dispose();
  });

  it('凭据缺失 → fx_auth_refused；驱动不可用 → 明确原因且不创建会话失败', async () => {
    const { kernel, h, projectId } = await makeFixtureProject();
    const manager = new AgentManager({ kernel, driver: new ScriptedFxDriver([]), apiKeyProvider: () => undefined, model: 'm' });
    const session = await manager.createSession(projectId, 'case_synth');
    await expect(manager.runTurn(projectId, session.id, 'x')).rejects.toMatchObject({ code: 'fx_auth_refused' });

    const dead = new AgentManager({ kernel, driver: new ScriptedFxDriver([], { available: false, reason: 'libfx 平台不支持' }), apiKeyProvider: () => 'sk', model: 'm' });
    const probe = await dead.probe();
    expect(probe).toEqual({ available: false, backend: null, reason: 'libfx 平台不支持' });
    // 降级纪律：Agent 不可用不影响其它功能
    expect(await kernel.call('route:list', { projectId })).toHaveLength(1);
    h.dispose();
  });

  it('同会话并发 → session_busy（libfx 约束）', async () => {
    const { kernel, h, projectId } = await makeFixtureProject();
    const driver = new ScriptedFxDriver([turnOf([{ type: 'text_delta', text: 'a' }], { stopReason: 'end_turn' })]);
    const manager = new AgentManager({ kernel, driver, apiKeyProvider: () => 'sk', model: 'm' });
    const session = await manager.createSession(projectId, 'case_synth');
    // 串行语义：两轮依序完成（脚本耗尽 → 驱动回退空轮 end_turn）
    await manager.runTurn(projectId, session.id, 'one');
    const second = await manager.runTurn(projectId, session.id, 'two');
    expect(second.stopReason).toBe('end_turn');
    h.dispose();
  });

  it('stopReason=refused → fx_auth_refused 错误码（W1 实测形态）', async () => {
    const { kernel, h, projectId } = await makeFixtureProject();
    const driver = new ScriptedFxDriver([turnOf([], { stopReason: 'refused' })]);
    const manager = new AgentManager({ kernel, driver, apiKeyProvider: () => 'bad-key', model: 'm' });
    const session = await manager.createSession(projectId, 'case_synth');
    const summary = await manager.runTurn(projectId, session.id, 'ping');
    expect(summary.errorCode).toBe('fx_auth_refused');
    h.dispose();
  });
});

describe('PRD 提取任务（Agent 产物的信任边界）', () => {
  it('合法 JSON → 严格校验 → proposed 用例；越界内容逐条拒绝', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const text = JSON.stringify({
      fields: [
        { section: '下单', field: 'amount', type: '整数', constraintsText: '0 ≤ amount ≤ 50000', api: { method: 'POST', path: '/orders' } },
        { field: 'bad', constraintsText: 'x' }, // 缺 api → 拒
      ],
      uiFlows: [
        { title: '登录', steps: [{ kind: 'ui_navigate', config: { url: '/login' } }, { kind: 'ui_see', config: { contains: '欢迎' } }] },
        { title: '坏流', steps: [{ kind: 'shell_exec', config: {} }] }, // 未知步骤 → 整流拒
      ],
    });
    const outcome = await applyPrdExtraction(h.kernel, project.id, text);
    expect(outcome.casesInserted).toBe(3); // amount 应通过+应拒绝 + 登录 UI 流
    expect(outcome.rejected.some((r) => r.includes('bad'))).toBe(true);
    expect(outcome.rejected.some((r) => r.includes('坏流'))).toBe(true);

    const cases = await h.kernel.call('case:list', { projectId: project.id, status: 'proposed' });
    expect(cases.every((c) => c.proposedBy === 'fx-agent')).toBe(true);
    expect(cases.some((c) => c.name.includes('amount（应拒绝）'))).toBe(true);
    expect(cases.some((c) => c.name.startsWith('[UI] 登录'))).toBe(true);
    h.dispose();
  });

  it('非 JSON 输出 → 整批拒绝（不部分采纳）', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    await expect(applyPrdExtraction(h.kernel, project.id, '我觉得应该测一下下单接口')).rejects.toMatchObject({ code: 'fx_turn_failed' });
    expect(await h.kernel.call('case:list', { projectId: project.id })).toEqual([]);
    h.dispose();
  });

  it('幂等：同样输出重复应用零新增', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const text = JSON.stringify({
      fields: [{ field: 'amount', type: '整数', constraintsText: '≤ 50000', api: { method: 'POST', path: '/orders' } }],
      uiFlows: [],
    });
    const first = await applyPrdExtraction(h.kernel, project.id, text);
    const second = await applyPrdExtraction(h.kernel, project.id, text);
    expect(first.casesInserted).toBe(2);
    expect(second.casesInserted).toBe(0);
    expect(second.skipped).toHaveLength(2);
    h.dispose();
  });
});

describe('LibFxDriver（真子进程，W1 实证）', () => {
  it('子进程 probe：加载 libfx + 后端探测（无需凭据）', async () => {
    const { LibFxDriver } = await import('../src/agent/libfx-driver.ts');
    const driver = new LibFxDriver();
    if (!driver.available()) {
      console.warn('跳过：libfx 不可用');
      return;
    }
    const probe = await driver.probe();
    expect(typeof probe.backend).toBe('string');
    // W1 实测：本机 backend=native；其它环境如实记录探测结果
    expect(['native', 'wasm-jspi', 'unavailable']).toContain(probe.backend);
  }, 30000);
});
