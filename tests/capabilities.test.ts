/**
 * 能力完善批次：传输错误重试（03 §5.3 语义）、P3 edit 真实应用（07 §5.2）、OpenAPI 对账（06 §2.2）。
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compilePlan } from '../src/execution/plan-compiler.ts';
import { executePlan } from '../src/execution/index.ts';
import { normalizePathTemplate, parseSpec } from '../src/kernel/domain/openapi.ts';
import { applyEditsToDraft } from '../src/kernel/domain/review.ts';
import { defaultRunPolicy, type EnvRecord, type RunPolicy, type TestCaseDraft, type TestCaseRecord } from '../src/kernel/shared/domain.ts';
import { testKernel, type KernelHandle } from './helpers.ts';

const ENV: EnvRecord = {
  id: 1, projectId: 1, name: 'e', baseUrl: 'http://127.0.0.1:1',
  variables: {}, secretNames: [], headers: {}, allowSelfSigned: false, createdAtMs: 0,
};
const POLICY: RunPolicy = defaultRunPolicy();

async function adoptCase(h: KernelHandle, projectId: number, name: string, steps: { id: string; seq: number; kind: string; config: Record<string, unknown> }[]): Promise<TestCaseRecord> {
  const proposed = await h.kernel.call('case:propose', {
    projectId,
    proposedBy: 't',
    draft: {
      name, description: null, routeId: null, paramKind: 'single',
      steps: steps.map((s, i) => ({ id: s.id, seq: i, kind: s.kind, config: s.config })) as TestCaseDraft['steps'],
      params: { kind: 'single', rows: [{ label: 'baseline', values: {}, intent: 'baseline' }] },
      provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
      policyOverride: null, tags: [],
    },
  });
  return h.kernel.call('case:review', { projectId, caseId: proposed.id, action: 'adopt', actor: 'kel' });
}

/* ─────────────── A. 传输错误重试（03 §5.3） ─────────────── */

describe('传输错误重试（修复：connect_failed 曾被短路跳过）', () => {
  it('首连被重置 → connect_failed 重试 → 第二次成功（passed + flaky）', async () => {
    let refusedOnce = false;
    const server: Server = createServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    server.on('connection', (socket) => {
      if (!refusedOnce) {
        refusedOnce = true;
        socket.destroy(); // 第一次连接直接重置 → ECONNRESET → connect_failed
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const p = (server.address() as { port: number }).port;

    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const env = await h.kernel.call('env:create', { projectId: project.id, name: 'e', baseUrl: `http://127.0.0.1:${p}` });
    const c = await adoptCase(h, project.id, 'c', [{ id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/x' } }]);

    const policy = { ...defaultRunPolicy(), retry: { ...defaultRunPolicy().retry, maxAttempts: 3, on: 'any' as const } };
    const plan = await compilePlan({ cases: [c], env, policy, seed: 1, nowMs: 0 });
    const { runId } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy, seed: 1, plan });
    await executePlan({ kernel: h.kernel, projectId: project.id, runId, plan, env });
    await h.kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });

    const results = await h.kernel.call('run:results', { projectId: project.id, runId });
    expect(results.entries[0]!.verdict).toBe('passed');
    expect(results.entries[0]!.flaky).toBe(true);
    expect(results.entries[0]!.attempts).toBe(2);

    // on 过滤：不含 connect_failed 时不重试
    const policy2 = { ...defaultRunPolicy(), retry: { ...defaultRunPolicy().retry, maxAttempts: 3, on: ['http_5xx'] as never } };
    let refused2 = false;
    const server2: Server = createServer((_q, res) => res.end('{}'));
    server2.on('connection', (socket) => {
      if (!refused2) {
        refused2 = true;
        socket.destroy();
      }
    });
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
    const p2 = (server2.address() as { port: number }).port;
    const env2 = await h.kernel.call('env:create', { projectId: project.id, name: 'e2', baseUrl: `http://127.0.0.1:${p2}` });
    const c2 = await adoptCase(h, project.id, 'c2', [{ id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/x' } }]);
    const plan2 = await compilePlan({ cases: [c2], env: env2, policy: policy2, seed: 1, nowMs: 0 });
    const { runId: runId2 } = await h.kernel.call('run:begin', { projectId: project.id, envId: env2.id, policy: policy2, seed: 1, plan: plan2 });
    await executePlan({ kernel: h.kernel, projectId: project.id, runId: runId2, plan: plan2, env: env2 });
    await h.kernel.call('run:finish', { projectId: project.id, runId: runId2, status: 'completed' });
    const results2 = await h.kernel.call('run:results', { projectId: project.id, runId: runId2 });
    expect(results2.entries[0]!.verdict).toBe('errored'); // on 过滤：不重试
    expect(results2.entries[0]!.attempts).toBe(1);

    server.close();
    server2.close();
    h.dispose();
  }, 15000);
});

/* ─────────────── B. P3 edit 真实应用 ─────────────── */

describe('P3 edit：就地编辑真实生效（07 §5.2）', () => {
  it('edit 后内容真的变了；编译器用新内容；陈旧基线被拒', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const env = await h.kernel.call('env:create', { projectId: project.id, name: 'e', baseUrl: 'http://127.0.0.1:9' });
    const proposed = await h.kernel.call('case:propose', {
      projectId: project.id,
      proposedBy: 'fx-agent',
      draft: {
        name: '金额边界', description: null, routeId: null, paramKind: 'single',
        steps: [
          { id: 's0', seq: 0, kind: 'request', config: { method: 'POST', url: '/orders' } },
          { id: 's1', seq: 1, kind: 'assert', config: { target: { kind: 'status' }, op: 'eq', expected: '400', severity: 'major' } },
        ],
        params: { kind: 'single', rows: [{ label: 'baseline', values: {}, intent: 'baseline' }] },
        provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
        policyOverride: null, tags: [],
      },
    });

    // 陈旧基线：from 不符 → 拒绝（防盲覆盖）
    await expect(
      h.kernel.call('case:review', {
        projectId: project.id, caseId: proposed.id, action: 'edit', actor: 'kel',
        edits: [{ path: 'steps[1].config.expected', from: '999', to: '400' }],
      }),
    ).rejects.toMatchObject({ code: 'stale_edit' });

    // 正确基线：改断言期望 + 严重度
    const edited = await h.kernel.call('case:review', {
      projectId: project.id, caseId: proposed.id, action: 'edit', actor: 'kel',
      edits: [
        { path: 'steps[1].config.expected', from: '400', to: '422' },
        { path: 'steps[1].config.severity', from: 'major', to: 'critical' },
      ],
    });
    expect(edited.status).toBe('adopted');
    expect(edited.diff!.fields).toHaveLength(2);
    // ★ 内容真的变了
    expect(edited.steps[1]!.config).toMatchObject({ expected: '422', severity: 'critical' });

    // 编译器消费的就是新内容
    const adopted = await h.kernel.call('case:list', { projectId: project.id, status: 'adopted' });
    const plan = await compilePlan({ cases: adopted, env, policy: POLICY, seed: 1, nowMs: 0 });
    expect(plan.entries[0]!.steps[1]).toMatchObject({ kind: 'assert', expected: '422', severity: 'critical' });

    // 越权编辑面：routeId 不可改
    const p2 = await h.kernel.call('case:propose', {
      projectId: project.id, proposedBy: 'x',
      draft: {
        name: 'c2', description: null, routeId: null, paramKind: 'single',
        steps: [{ id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/x' } }],
        params: { kind: 'single', rows: [{ label: 'l', values: {}, intent: 'baseline' }] },
        provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
        policyOverride: null, tags: [],
      },
    });
    await expect(
      h.kernel.call('case:review', {
        projectId: project.id, caseId: p2.id, action: 'edit', actor: 'kel',
        edits: [{ path: 'routeId', from: null, to: 5 }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_edit' });
    h.dispose();
  });

  it('edit 应用后草稿非法 → 整体拒绝（不落半成品）', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const proposed = await h.kernel.call('case:propose', {
      projectId: project.id, proposedBy: 'x',
      draft: {
        name: 'c', description: null, routeId: null, paramKind: 'single',
        steps: [{ id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/x' } }],
        params: { kind: 'single', rows: [{ label: 'l', values: {}, intent: 'baseline' }] },
        provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
        policyOverride: null, tags: [],
      },
    });
    // 把 name 改成空 → validateCaseDraft 拒绝 → 内容与状态都不落
    await expect(
      h.kernel.call('case:review', {
        projectId: project.id, caseId: proposed.id, action: 'edit', actor: 'kel',
        edits: [{ path: 'name', from: 'c', to: '' }],
      }),
    ).rejects.toBeTruthy();
    const unchanged = await h.kernel.call('case:get', { projectId: project.id, caseId: proposed.id });
    expect(unchanged!.name).toBe('c');
    expect(unchanged!.status).toBe('proposed');
    h.dispose();
  });

  it('纯函数：applyEditsToDraft 不改输入', () => {
    const record = {
      id: 1, projectId: 1, routeId: null, status: 'adopted' as const, paramKind: 'single' as const,
      name: 'c',
      description: null,
      steps: [{ id: 's0', seq: 0, kind: 'request' as const, config: { url: '/a' } }],
      params: { kind: 'single' as const, rows: [] },
      provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
      policyOverride: null,
      tags: ['x'],
      proposedBy: 't', reviewedBy: 'k', reviewedAtMs: 1, diff: null, createdAtMs: 0,
    };
    applyEditsToDraft(record, [{ path: 'tags[0]', from: 'x', to: 'y' }]);
    expect(record.tags).toEqual(['x']);
  });
});

/* ─────────────── C. OpenAPI 对账 ─────────────── */

describe('OpenAPI 对账（S2 的 doc_drift / doc_missing）', () => {
  it('归一化模板路径；四类结果各就各位；flags 落列', async () => {
    expect(normalizePathTemplate('/orders/:id')).toBe('/orders/{}');
    expect(normalizePathTemplate('/orders/{orderId}')).toBe('/orders/{}');
    expect(normalizePathTemplate('/Users/123')).toBe('/users/123');
    expect(() => parseSpec('not-json')).toThrowError(/YAML/);

    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    // 源码路由（经 proposeBatch，模拟分析器产出）
    await h.kernel.call('source:recordIndex', { projectId: project.id, fileCount: 1, frameworks: ['express'] });
    const idx = (await h.kernel.call('source:recordIndex', { projectId: project.id, fileCount: 1, frameworks: ['express'] })).id;
    await h.kernel.call('route:proposeBatch', {
      projectId: project.id,
      sourceIndexId: idx,
      proposedBy: 'ts-morph',
      routes: [
        { method: 'POST', path: '/orders', handlerFile: 'a.ts', handlerLine: 1, framework: 'express', confidence: 'high' },   // 对齐
        { method: 'GET', path: '/orders/:id', handlerFile: 'a.ts', handlerLine: 2, framework: 'express', confidence: 'high' }, // 文档用 {orderId} → 归一后对齐
        { method: 'DELETE', path: '/orders/:id', handlerFile: 'a.ts', handlerLine: 3, framework: 'express', confidence: 'high' }, // 文档无 DELETE → drift
        { method: 'POST', path: '/internal/flush', handlerFile: 'b.ts', handlerLine: 1, framework: 'express', confidence: 'high' }, // 文档无 → missing
      ],
    });

    const spec = {
      openapi: '3.0.0',
      paths: {
        '/orders': { post: {} }, // 对齐（GET /orders 文档多了方法级差异 → 体现在 drift.docMethods 的反向，不在此断言）
        '/orders/{orderId}': { get: {} },
        '/webhooks': { post: {} }, // 文档有源码无 → docOnly（路径级）
      },
    };
    const outcome = await h.kernel.call('openapi:reconcile', { projectId: project.id, spec });
    expect(outcome.compared).toBe(4);
    expect(outcome.aligned).toBe(2);
    expect(outcome.drift.map((d) => d.method)).toEqual(['DELETE']);
    expect(outcome.drift[0]!.docMethods).toEqual(['GET']);
    expect(outcome.missing.map((m) => m.path)).toEqual(['/internal/flush']);
    expect(outcome.docOnly).toEqual([{ method: 'POST', path: '/webhooks' }]);

    // flags 落列：可筛选的高价值标记（06 §2.2）
    const routes = await h.kernel.call('route:list', { projectId: project.id });
    const byKey = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
    expect(byKey.get('DELETE /orders/:id')!.docDrift).toBe(true);
    expect(byKey.get('POST /internal/flush')!.docMissing).toBe(true);
    expect(byKey.get('POST /orders')!.docDrift).toBe(false);
    expect(byKey.get('POST /orders')!.docMissing).toBe(false);

    // YAML 字符串诚实拒绝
    await expect(h.kernel.call('openapi:reconcile', { projectId: project.id, spec: 'openapi: 3.0\npaths:' })).rejects.toMatchObject({ code: 'spec_invalid' });
    // 跨项目隔离（P5）：其它项目看不到任何路由 → 对账空集
    const other = await h.kernel.call('project:create', { name: 'o', sourceType: 'local' });
    const isolated = await h.kernel.call('openapi:reconcile', { projectId: other.id, spec });
    expect(isolated.compared).toBe(0);
    h.dispose();
  });
});
