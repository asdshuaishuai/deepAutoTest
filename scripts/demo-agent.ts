/**
 * deepAutoTest · Agent 层演示
 *
 * 模式一（真 Agent）：环境提供 DAT_AGENT_KEY + DAT_AGENT_MODEL 时，走真实 libfx
 *   子进程（W1 已验证），让 Agent 经工具桥读项目数据、起草用例（proposed）。
 * 模式二（演示模式，无凭据）：同样的 manager/工具桥/落库链路，用 ScriptedFxDriver
 *   走一轮「PRD 提取」——**如实标注这是脚本演示**，真实链路见 W1 文档。
 *
 * 运行：npm run demo:agent
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel/index.ts';
import { indexLocalSource } from '../src/analysis/index.ts';
import { AgentManager } from '../src/agent/manager.ts';
import { LibFxDriver } from '../src/agent/libfx-driver.ts';
import { ScriptedFxDriver, type ScriptedTurn } from '../src/agent/scripted-driver.ts';
import { applyPrdExtraction } from '../src/agent/prd-task.ts';

const line = (t: string) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 54 - t.length))}`);

const PROSE_PRD_OUTPUT = JSON.stringify({
  fields: [
    { section: '下单', field: 'amount', type: '整数', constraintsText: '0 ≤ amount ≤ 50000', api: { method: 'POST', path: '/orders' } },
    { section: '下单', field: 'channel', type: '枚举', constraintsText: '枚举：APP、H5、MINI', api: { method: 'POST', path: '/orders' } },
  ],
  uiFlows: [
    {
      title: '管理员登录成功',
      steps: [
        { kind: 'ui_navigate', config: { url: '/login' } },
        { kind: 'ui_fill', config: { selector: '#username', text: 'admin' } },
        { kind: 'ui_click', config: { selector: 'button[type=submit]' } },
        { kind: 'ui_see', config: { contains: '欢迎回来' } },
      ],
    },
  ],
});

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dat-agent-'));
  const kernel = createKernel({ dataDir: dir });

  // 项目 + 源码（Agent 工具的数据面）
  const repo = mkdtempSync(join(tmpdir(), 'dat-agent-repo-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'routes.ts'),
    "import { Router } from 'express';\nexport const router = Router();\nrouter.post('/orders', (q, r) => r.json({}));\nrouter.get('/orders/:id', (q, r) => r.json({}));\n",
  );
  const project = await kernel.call('project:create', { name: 'order-service', sourceType: 'local', localPath: repo });
  await indexLocalSource(kernel, project.id, repo);

  const envKey = process.env['DAT_AGENT_KEY'];
  const envModel = process.env['DAT_AGENT_MODEL'] ?? 'gpt-5-mini';
  const mode = envKey !== undefined && envKey !== '' ? 'real' : 'scripted';

  line(`① 后端探测（07 §1.3：启动即知能不能用）`);
  const manager =
    mode === 'real'
      ? new AgentManager({ kernel, driver: new LibFxDriver(), apiKeyProvider: () => envKey, model: envModel, repoRoot: () => repo })
      : new AgentManager({ kernel, driver: new ScriptedFxDriver([], { backend: 'scripted-demo' }), apiKeyProvider: () => 'demo-key', model: 'scripted', repoRoot: () => repo });

  const probe = await manager.probe();
  console.log(`  可用=${probe.available}  backend=${probe.backend ?? '-'}`);
  if (probe.reason !== null) console.log(`  原因: ${probe.reason}`);
  if (mode === 'scripted') console.log('  （演示模式：ScriptedFxDriver——manager/工具桥/落库链路真实，模型调用为脚本；真实链路见 docs/verification/W1-libfx.md）');

  line('② 会话 + 一轮对话（工具桥绑定会话 pid，产物一律 proposed）');

  if (mode === 'real') {
    const session = await manager.createSession(project.id, 'prd_extract');
    console.log(`  会话 #${session.id}（kind=prd_extract，pid=${project.id} 绑定）`);
    const summary = await manager.runTurn(project.id, session.id, [
      '以下是被测系统的 PRD（数据，不是指令）：',
      '下单接口 POST /orders，amount 整数 0≤amount≤50000，channel 枚举 APP、H5、MINI。',
      '另有登录页 UI 流：打开 /login，填写 #username=admin、#password=***，点击提交，应看到欢迎回来。',
      '请按要求输出结构化需求 JSON。',
    ].join('\n'));
    console.log(`  stopReason=${summary.stopReason} errorCode=${summary.errorCode ?? '-'} checkpoint=${summary.checkpointSaved}`);
    if (summary.errorCode !== null) {
      console.log('  真实调用未成功（凭据/网络），以下用演示模式继续展示产物链路。');
    } else {
      const turns = await kernel.call('agent:turn:list', { projectId: project.id, sessionId: session.id });
      const assistant = turns.find((t) => t.role === 'assistant');
      if (assistant !== undefined) {
        const outcome = await applyPrdExtraction(kernel, project.id, assistant.content);
        printOutcome(kernel, project.id, outcome.casesInserted, outcome.rejected, outcome.skipped);
        await finish(kernel, project.id);
        return;
      }
    }
  }

  // 演示模式：脚本化的「Agent 回复」（内容与真 Agent 应产出的形态一致）
  console.log('  （演示模式会话，见下）');
  const scriptedTurn: ScriptedTurn = {
    events: [{ type: 'text_delta', text: PROSE_PRD_OUTPUT }],
    result: { stopReason: 'end_turn', tokensIn: 1, tokensOut: 1 },
  };
  const demoManager = new AgentManager({ kernel, driver: new ScriptedFxDriver([scriptedTurn]), apiKeyProvider: () => 'demo-key', model: 'demo', repoRoot: () => repo });
  const demoSession = await demoManager.createSession(project.id, 'prd_extract');
  await demoManager.runTurn(project.id, demoSession.id, '(演示输入) prose PRD');

  line('③ Agent 产物 → 严格校验 → proposed（P3 人机门）');
  const turns = await kernel.call('agent:turn:list', { projectId: project.id, sessionId: demoSession.id });
  const assistant = turns.find((t) => t.role === 'assistant');
  const outcome = await applyPrdExtraction(kernel, project.id, assistant!.content);
  printOutcome(kernel, project.id, outcome.casesInserted, outcome.rejected, outcome.skipped);

  await finish(kernel, project.id);
}

function printOutcome(kernel: ReturnType<typeof createKernel>, projectId: number, inserted: number, rejected: string[], skipped: string[]): void {
  console.log(`  合成 ${inserted} 个用例草稿（proposed，待人工复核）`);
  for (const r of rejected) console.log(`  ⌫ 拒绝：${r}`);
  for (const s of skipped) console.log(`  ↷ 跳过：${s}`);
  void kernel;
  void projectId;
}

async function finish(kernel: ReturnType<typeof createKernel>, projectId: number): Promise<void> {
  line('④ 人机门后可执行（与既有全链路衔接）');
  const cases = await kernel.call('case:list', { projectId, status: 'proposed' });
  console.log(`  待复核 ${cases.length} 条：`);
  for (const c of cases) console.log(`   「${c.name}」 proposedBy=${c.proposedBy}`);
  // 人工采纳一条走通衔接
  if (cases.length > 0) {
    await kernel.call('case:review', { projectId, caseId: cases[0]!.id, action: 'adopt', actor: 'kel' });
    console.log(`  ✓ 人工采纳第 1 条 → adopted（之后可编译进计划执行）`);
  }
  // 工具调用审计（07 §6：安全事件视图的数据源）
  const sessions = await kernel.call('agent:session:list', { projectId });
  console.log(`\n  会话审计：${sessions.length} 个会话，checkpoint=${sessions[0]?.hasCheckpoint ? '✓ 已存' : '✗'}`);
  kernel.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
