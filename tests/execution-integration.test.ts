/**
 * 执行引擎集成测试：真实 mock HTTP 服务 ↔ undici ↔ kernel 写入门 ↔ 判定。
 * 端到端验证：事件落库、verdict 正确、重试→flaky、超时→errored、
 * 提取链、secret 不落库、大报文 artifact。
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compilePlan } from '../src/execution/plan-compiler.ts';
import { executePlan } from '../src/execution/runner.ts';
import type { RunEventInput } from '../src/kernel/shared/domain.ts';
import { defaultRunPolicy, type RunPolicy, type TestCaseRecord } from '../src/kernel/shared/domain.ts';
import { beginRun, setupProject, type SetupResult } from './helpers.ts';

const SECRET_VALUE = 'sk-live-abcdef0123456789fedcba';

interface MockState {
  failRemaining: Record<string, number>;
}

let server: Server;
let port = 0;
const state: MockState = { failRemaining: {} };

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (state.failRemaining[p] !== undefined && state.failRemaining[p]! > 0) {
      state.failRemaining[p]! -= 1;
      json(500, { error: 'temporarily_unavailable' });
      return;
    }

    if (req.method === 'GET' && p === '/orders') return json(200, { data: { items: [{ id: 1 }], total: 1 } });
    if (req.method === 'POST' && p === '/orders') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { amount?: number };
        if ((parsed.amount ?? 0) > 50000) return json(400, { error: 'AMOUNT_EXCEEDED' });
        return json(201, { data: { id: 'o_123' } });
      });
      return;
    }
    if (req.method === 'GET' && /^\/orders\/.+/.test(p)) return json(200, { data: { id: p.split('/')![2], status: 'created' } });
    if (req.method === 'GET' && p === '/flaky') return json(200, { ok: true });
    if (req.method === 'GET' && p === '/slow') {
      setTimeout(() => json(200, { ok: true }), 500);
      return;
    }
    if (req.method === 'GET' && p === '/secure') return json(200, { echoed: req.headers['authorization'] ?? null });
    if (req.method === 'GET' && p === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(100 * 1024));
      return;
    }
    if (req.method === 'GET' && p === '/redirect') {
      res.writeHead(302, { location: '/orders' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function adoptedCase(s: SetupResult, steps: { id: string; seq: number; kind: string; config: Record<string, unknown> }[], rows?: { label: string; values: Record<string, unknown>; intent: string }[]): Promise<TestCaseRecord> {
  const proposed = await s.kernel.call('case:propose', {
    projectId: s.projectId,
    proposedBy: 'test',
    draft: {
      name: `case-${Math.random().toString(36).slice(2, 7)}`,
      description: null,
      routeId: null,
      paramKind: rows === undefined ? 'single' : 'boundary',
      steps,
      params: { kind: rows === undefined ? 'single' : 'boundary', rows: rows ?? [{ label: 'baseline', values: {}, intent: 'baseline' }] },
      provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
      policyOverride: null,
      tags: [],
    },
  });
  return s.kernel.call('case:review', { projectId: s.projectId, caseId: proposed.id, action: 'adopt', actor: 'kel' });
}

interface TestEnv {
  id: number;
  baseUrl: string;
  variables: Record<string, unknown>;
  secretNames: string[];
  headers: Record<string, string>;
  allowSelfSigned: boolean;
}

async function mkEnv(s: SetupResult, overrides: Partial<TestEnv> = {}): Promise<TestEnv> {
  const e = await s.kernel.call('env:create', {
    projectId: s.projectId,
    name: 'staging',
    baseUrl: `http://127.0.0.1:${port}`,
    ...overrides,
  });
  return e as unknown as TestEnv;
}

async function runIt(s: SetupResult, envRec: TestEnv, cases: TestCaseRecord[], policy: RunPolicy): Promise<number> {
  const plan = await compilePlan({ cases, env: envRec as never, policy, seed: 7, nowMs: 0 });
  const { runId } = await s.kernel.call('run:begin', { projectId: s.projectId, envId: envRec.id, policy, seed: 7, plan });
  await executePlan({ kernel: s.kernel, projectId: s.projectId, runId, plan, env: envRec as never, secrets: (n) => (n === 'apiToken' ? SECRET_VALUE : undefined) });
  await s.kernel.call('run:finish', { projectId: s.projectId, runId, status: 'completed' });
  return runId;
}

describe('执行引擎（undici ↔ kernel）', () => {
  it('快乐路径：断言通过 → passed，事件完整落库', async () => {
    const s = await setupProject();
    const envRec = await mkEnv(s);
    const c = await adoptedCase(s, [
      { id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/orders' } },
      { id: 's1', seq: 1, kind: 'assert', config: { target: { kind: 'status' }, op: 'eq', expected: '200', severity: 'blocker' } },
      { id: 's2', seq: 2, kind: 'assert', config: { target: { kind: 'body_json', path: 'data.total' }, op: 'eq', expected: '1', severity: 'major' } },
    ]);
    const runId = await runIt(s, envRec, [c], defaultRunPolicy());

    const results = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(results.entries).toHaveLength(1);
    expect(results.entries[0]!.verdict).toBe('passed');
    expect(results.entries[0]!.failedAsserts).toBe(0);

    const kinds = (await s.kernel.call('run:events', { projectId: s.projectId, runId })).map((e) => e.kind);
    expect(kinds).toContain('entry_started');
    expect(kinds).toContain('request_sent');
    expect(kinds).toContain('response_received');
    expect(kinds).toContain('assert_evaluated');
    expect(kinds).toContain('entry_finished');
    expect(kinds).toContain('run_started');
    expect(kinds).toContain('run_finished');

    const run = await s.kernel.call('run:get', { projectId: s.projectId, runId });
    expect(run!.counters).toEqual({ total: 1, passed: 1, failed: 0, degraded: 0, errored: 0, skipped: 0, flaky: 0 });
    const verify = await s.kernel.call('run:verify', { projectId: s.projectId, runId });
    expect(verify.ok).toBe(true);
    s.kernel.close();
  });

  it('边界参数行：金额=50000 未被拒绝（mock 只拒 >50000）→ 该参数行 failed，报告能定位到"边界"', async () => {
    const s = await setupProject();
    const envRec = await mkEnv(s);
    const c = await adoptedCase(
      s,
      [
        { id: 's0', seq: 0, kind: 'request', config: { method: 'POST', url: '/orders', headers: { 'content-type': 'application/json' }, body: '{"amount":{{param.amount}}}' } },
        { id: 's1', seq: 1, kind: 'assert', config: { target: { kind: 'status' }, op: 'eq', expected: '{{param.expectedStatus}}', severity: 'critical', principleId: 7, sourceFile: 'order.controller.ts', sourceLine: 88 } },
      ],
      [
        { label: '金额=49999（边界内）', values: { amount: 49999, expectedStatus: '201' }, intent: 'baseline' },
        { label: '金额=50000（恰在边界）', values: { amount: 50000, expectedStatus: '400' }, intent: 'boundary_high' },
        { label: '金额=50001（超限）', values: { amount: 50001, expectedStatus: '400' }, intent: 'boundary_high' },
      ],
    );
    const runId = await runIt(s, envRec, [c], defaultRunPolicy());

    const results = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(results.entries).toHaveLength(3);
    const byLabel = new Map(results.entries.map((e) => [e.paramRowLabel, e.verdict]));
    expect(byLabel.get('金额=49999（边界内）')).toBe('passed');
    expect(byLabel.get('金额=50000（恰在边界）')).toBe('failed'); // ★ 未按预期拒绝
    expect(byLabel.get('金额=50001（超限）')).toBe('passed');

    const run = await s.kernel.call('run:get', { projectId: s.projectId, runId });
    expect(run!.counters).toEqual({ total: 1, passed: 0, failed: 1, degraded: 0, errored: 0, skipped: 0, flaky: 0 });

    // 断言带溯源：原则 7 / order.controller.ts:88 写进 assert_result
    const assertRow = results.asserts.find((a) => !a.passed)!;
    expect(assertRow.principleId).toBe(7);
    expect(assertRow.sourceFile).toBe('order.controller.ts');
    expect(assertRow.sourceLine).toBe(88);
    expect(assertRow.expected).toBe('400');
    s.kernel.close();
  });

  it('重试后通过 → passed + flaky（一等状态，不伪装成普通通过）', async () => {
    const s = await setupProject();
    const envRec = await mkEnv(s);
    state.failRemaining['/flaky'] = 2;
    const c = await adoptedCase(s, [
      { id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/flaky' } },
      { id: 's1', seq: 1, kind: 'assert', config: { target: { kind: 'status' }, op: 'eq', expected: '200', severity: 'major' } },
    ]);
    const policy: RunPolicy = { ...defaultRunPolicy(), retry: { ...defaultRunPolicy().retry, maxAttempts: 3, on: ['http_5xx', 'assert_failed'] } };
    const runId = await runIt(s, envRec, [c], policy);

    const results = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    const e = results.entries[0]!;
    expect(e.verdict).toBe('passed');
    expect(e.flaky).toBe(true);
    expect(e.attempts).toBe(3);

    const kinds = (await s.kernel.call('run:events', { projectId: s.projectId, runId })).map((ev) => ev.kind);
    expect(kinds.filter((k) => k === 'retry_scheduled')).toHaveLength(2);
    s.kernel.close();
  });

  it('连接被拒 → errored（不是 failed：没测成 ≠ 被测错了）', async () => {
    const s = await setupProject();
    // 绑定 0 号端口再释放：拿确定空闲的端口（port+1 会被并行测试的 server 撞上）
    const deadPort = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as { port: number }).port;
        probe.close(() => resolve(p));
      });
    });
    const envRec = await mkEnv(s, { baseUrl: `http://127.0.0.1:${deadPort}` });
    const c = await adoptedCase(s, [{ id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/orders' } }]);
    const policy = defaultRunPolicy(); // retry.on='any' 但 maxAttempts=1
    const runId = await runIt(s, envRec, [c], policy);

    const results = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(results.entries[0]!.verdict).toBe('errored');
    const errEvents = await s.kernel.call('run:events', { projectId: s.projectId, runId });
    const stepErr = errEvents.find((ev) => ev.kind === 'step_errored');
    expect((stepErr as { reason?: string } | undefined)?.reason).toBe('connect_failed');
    s.kernel.close();
  });

  it('超时 → timed_out（errored）', async () => {
    const s = await setupProject();
    const envRec = await mkEnv(s);
    const c = await adoptedCase(s, [
      { id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/slow', timeoutMs: 80 } },
    ]);
    const policy = { ...defaultRunPolicy(), retry: { ...defaultRunPolicy().retry, maxAttempts: 1 } };
    const runId = await runIt(s, envRec, [c], policy);

    const results = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(results.entries[0]!.verdict).toBe('errored');
    const evs = await s.kernel.call('run:events', { projectId: s.projectId, runId });
    expect((evs.find((e) => e.kind === 'step_errored') as { reason?: string } | undefined)?.reason).toBe('timed_out');
    s.kernel.close();
  });

  it('提取链：POST 拿 id → GET 用它（步骤间传值）', async () => {
    const s = await setupProject();
    const envRec = await mkEnv(s);
    const c = await adoptedCase(s, [
      { id: 's0', seq: 0, kind: 'request', config: { method: 'POST', url: '/orders', headers: { 'content-type': 'application/json' }, body: '{"amount":100}' } },
      { id: 's1', seq: 1, kind: 'extract', config: { name: 'orderId', from: { kind: 'body_json', path: 'data.id' } } },
      { id: 's2', seq: 2, kind: 'request', config: { method: 'GET', url: '/orders/{{var.orderId}}' } },
      { id: 's3', seq: 3, kind: 'assert', config: { target: { kind: 'body_json', path: 'data.status' }, op: 'eq', expected: 'created', severity: 'major' } },
    ]);
    const runId = await runIt(s, envRec, [c], defaultRunPolicy());

    const results = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(results.entries[0]!.verdict).toBe('passed');
    const evs = (await s.kernel.call('run:events', { projectId: s.projectId, runId })) as RunEventInput[];
    const extract = evs.find((e) => e.kind === 'var_extracted') as { name: string; value: string } | undefined;
    expect(extract?.name).toBe('orderId');
    expect(extract?.value).toContain('o_123'); // JSON 字符串化后的值
    const second = evs.filter((e) => e.kind === 'request_sent').map((e) => (e as unknown as { url: string }).url);
    expect(second[1]).toContain('/orders/o_123');
    s.kernel.close();
  });

  it('secret 注入请求但绝不落库（事件里只有 <secret>）', async () => {
    const s = await setupProject();
    const envRec = await mkEnv(s, { secretNames: ['apiToken'] });
    const c = await adoptedCase(s, [
      { id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/secure?t={{secret.apiToken}}', headers: { authorization: 'Bearer {{secret.apiToken}}' } } },
      { id: 's1', seq: 1, kind: 'assert', config: { target: { kind: 'body_json', path: 'echoed' }, op: 'contains', expected: 'Bearer', severity: 'info' } },
    ]);
    const runId = await runIt(s, envRec, [c], defaultRunPolicy());

    const raw = s.kernel.db.prepare('SELECT payload FROM run_event WHERE run_id = ?').all(runId) as { payload: string }[];
    const all = raw.map((r) => r.payload).join('\n');
    expect(all).not.toContain(SECRET_VALUE);
    expect(all).toContain('<secret>');
    s.kernel.close();
  });

  it('大报文 → artifact 外置，库内只存引用', async () => {
    const s = await setupProject();
    const envRec = await mkEnv(s);
    const c = await adoptedCase(s, [{ id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/big' } }]);
    const runId = await runIt(s, envRec, [c], defaultRunPolicy());

    const evs = await s.kernel.call('run:events', { projectId: s.projectId, runId });
    const resp = evs.find((e) => e.kind === 'response_received') as unknown as { bodyRef: string | null };
    expect(resp.bodyRef).toMatch(/^[0-9a-f]{64}$/);
    const art = await s.kernel.call('artifact:get', { sha256: resp.bodyRef! });
    expect(Buffer.from(art.contentBase64, 'base64').length).toBe(100 * 1024);
    s.kernel.close();
  });

  it('script 步骤：参与判定；抛错 → errored', async () => {
    const s = await setupProject();
    const envRec = await mkEnv(s);
    const ok = await adoptedCase(s, [
      { id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/orders' } },
      { id: 's1', seq: 1, kind: 'script', config: { code: 'return response.body.data.total === 1' } },
    ]);
    const bad = await adoptedCase(s, [
      { id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/orders' } },
      { id: 's1', seq: 1, kind: 'script', config: { code: 'throw new Error("签名算法缺失")' } },
    ]);
    const runId = await runIt(s, envRec, [ok, bad], defaultRunPolicy());

    const results = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    const byCase = new Map(results.entries.map((e) => [e.caseId, e]));
    expect(byCase.get(ok.id)!.verdict).toBe('passed');
    expect(byCase.get(bad.id)!.verdict).toBe('errored'); // 脚本坏了 ≠ 被测错了
    s.kernel.close();
  });

  it('重定向跟随：302 → 最终响应参与断言', async () => {
    const s = await setupProject();
    const envRec = await mkEnv(s);
    const c = await adoptedCase(s, [
      { id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/redirect', followRedirects: true } },
      { id: 's1', seq: 1, kind: 'assert', config: { target: { kind: 'body_json', path: 'data.total' }, op: 'eq', expected: '1', severity: 'major' } },
    ]);
    const runId = await runIt(s, envRec, [c], defaultRunPolicy());
    const results = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(results.entries[0]!.verdict).toBe('passed');
    s.kernel.close();
  });
});
