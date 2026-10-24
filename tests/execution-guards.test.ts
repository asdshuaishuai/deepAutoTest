/**
 * 安全守卫回归锚（08 §2）：重定向防御链三分支 + secret 缺失路径。
 *
 * runner 的重定向循环（runner.ts，手动跟随：每一跳过 urlguard，注释明言
 * 「重定向是 SSRF 的经典载体」）有三个防御分支，此前零测试锚：
 *   ① 跳目标协议非 http/https（file:// 等）→ urlguard protocol_denied → step_errored(plan_invalid)
 *   ② 跳数封顶 hops < 10 —— 换自动重定向实现（如 undici maxRedirections）若丢此防护，本用例变红
 *   ③ 3xx 无 Location 头 → break（是「无跳可跟」，不是错误）
 * 以及 secret 缺失路径：供应商对在册 secret 名取不到值 → step_errored(env_error)，
 * 绝不发无凭据请求（回归成「继续发请求」会打真实服务且测试无感知）。
 *
 * 关键观测事实：request_sent 只在重定向循环【前】发一条，循环内的跳不产生任何
 * request_sent 事件——跳数只能用 mock server 命中计数观测。
 *
 * 模式与 tests/execution-integration.test.ts 相同：in-file beforeAll 起 node:http
 * mock server，只 import tests/helpers.ts 的 setupProject/beginRun（不修改 helpers）。
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compilePlan } from '../src/execution/plan-compiler.ts';
import { executePlan } from '../src/execution/runner.ts';
import type { EnvRecord, RunEvent, TestCaseRecord } from '../src/kernel/shared/domain.ts';
import { defaultRunPolicy } from '../src/kernel/shared/domain.ts';
import { beginRun, setupProject, type SetupResult } from './helpers.ts';

const SECRET_VALUE = 'sk-live-abcdef0123456789fedcba';

/* ─────────────── mock server（命中计数是跳数的唯一观测窗口） ─────────────── */

/** POST /echo 收到的凭据三落点（只在内存，不回显进 HTTP 响应，避免 secret 进事件流）。 */
interface EchoReceived {
  auth: string | undefined;
  q: string | undefined;
  token: string | undefined;
}

let server: Server;
let port = 0;
let hits: Record<string, number> = {};
let received: EchoReceived | null = null;

function resetMock(): void {
  hits = {};
  received = null;
}

function hitsOf(pathname: string): number {
  return hits[pathname] ?? 0;
}

function headerStr(v: IncomingHttpHeaders[string]): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    hits[p] = (hits[p] ?? 0) + 1;
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && p === '/loop') {
      // ② 自环：永远 302 指向自己（跳数封顶的唯一触发方式）
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    }
    if (req.method === 'GET' && p === '/to-file') {
      // ① SSRF 载体：跳向 file 协议（urlguard protocol_denied 分支）
      res.writeHead(302, { location: 'file:///etc/passwd' });
      res.end();
      return;
    }
    if (req.method === 'GET' && p === '/no-location') {
      // ③ 3xx 但无 Location 头
      res.writeHead(302);
      res.end();
      return;
    }
    if (req.method === 'GET' && p === '/ok') return json(200, { ok: true });
    if (req.method === 'POST' && p === '/echo') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let token: string | undefined;
        try {
          token = (JSON.parse(body) as { token?: string }).token;
        } catch {
          /* 非 JSON 视为未带 token */
        }
        received = { auth: headerStr(req.headers['authorization']), q: url.searchParams.get('t') ?? undefined, token };
        json(200, { ok: true });
      });
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

/* ─────────────── 场景搭建（自包含，不改 helpers） ─────────────── */

/** 指向 mock server 的环境记录（id 复用 setupProject 的默认环境，执行期以本对象为准）。 */
function envOf(s: SetupResult, secretNames: string[] = []): EnvRecord {
  return {
    id: s.envId,
    projectId: s.projectId,
    name: 'guard-mock',
    baseUrl: `http://127.0.0.1:${port}`,
    variables: {},
    secretNames,
    headers: {},
    allowSelfSigned: false,
    createdAtMs: 0,
  };
}

async function adoptedCase(s: SetupResult, steps: { id: string; seq: number; kind: string; config: Record<string, unknown> }[]): Promise<TestCaseRecord> {
  const proposed = await s.kernel.call('case:propose', {
    projectId: s.projectId,
    proposedBy: 'test',
    draft: {
      name: `guard-${Math.random().toString(36).slice(2, 7)}`,
      description: null,
      routeId: null,
      paramKind: 'single',
      steps,
      params: { kind: 'single', rows: [{ label: 'baseline', values: {}, intent: 'baseline' }] },
      provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
      policyOverride: null,
      tags: [],
    },
  });
  return s.kernel.call('case:review', { projectId: s.projectId, caseId: proposed.id, action: 'adopt', actor: 'kel' });
}

async function runPlan(
  s: SetupResult,
  cases: TestCaseRecord[],
  env: EnvRecord,
  secrets?: (name: string) => string | undefined,
): Promise<number> {
  const policy = defaultRunPolicy(); // maxAttempts=1：计数断言不受重试干扰
  const plan = await compilePlan({ cases, env, policy, seed: 7, nowMs: 0 });
  const runId = await beginRun(s, policy);
  await executePlan({ kernel: s.kernel, projectId: s.projectId, runId, plan, env, ...(secrets === undefined ? {} : { secrets }) });
  await s.kernel.call('run:finish', { projectId: s.projectId, runId, status: 'completed' });
  return runId;
}

function entryEventsOf(evs: RunEvent[], entryId: string): RunEvent[] {
  return evs.filter((e) => e.entryId === entryId);
}

function kindsOf(evs: RunEvent[]): string[] {
  return evs.map((e) => e.kind);
}

describe('安全守卫回归锚：重定向防御链三分支 + secret 缺失路径（08 §2）', () => {
  it('① 302 → Location: file:///etc/passwd：跳目标过 urlguard 拒绝（protocol_denied）→ step_errored(plan_invalid)，entry 判 errored，run 正常结束', async () => {
    resetMock();
    const s = await setupProject();
    const env = envOf(s);
    const c = await adoptedCase(s, [
      { id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/to-file', followRedirects: true } },
    ]);
    const runId = await runPlan(s, [c], env);
    const entryId = `${c.id}#0`;

    // 拒绝后未再出站：mock 只被首跳命中 1 次
    expect(hitsOf('/to-file')).toBe(1);

    const evs = await s.kernel.call('run:events', { projectId: s.projectId, runId });
    const entryEvs = entryEventsOf(evs, entryId);
    expect(kindsOf(entryEvs)).toEqual(['entry_started', 'request_sent', 'step_errored', 'entry_finished']);

    const stepErr = entryEvs.find((e): e is Extract<RunEvent, { kind: 'step_errored' }> => e.kind === 'step_errored');
    expect(stepErr?.reason).toBe('plan_invalid');
    expect(stepErr?.stepKind).toBe('request');
    expect(stepErr?.detail).toContain('重定向目标被 urlguard 拒绝');
    expect(stepErr?.detail).toContain('protocol_denied');

    const results = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(results.entries).toHaveLength(1);
    expect(results.entries[0]!.verdict).toBe('errored');

    // run 正常结束（run:finish(completed) 落了 run_finished，没有卡死或丢终态）
    expect(evs.some((e) => e.kind === 'run_finished')).toBe(true);
    s.kernel.close();
  });

  it('② 302 自环：跳数封顶（首跳+10 跳 = mock 命中恰 11 次），request_sent 落库恰 1 条，response_received 恰 1 条且 status=302，停止后无新请求', async () => {
    resetMock();
    const s = await setupProject();
    const env = envOf(s);
    const c = await adoptedCase(s, [
      { id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/loop', followRedirects: true } },
    ]);
    const runId = await runPlan(s, [c], env);
    const entryId = `${c.id}#0`;

    // 首跳 1 + 循环内 10 跳（hops < 10 封顶）——这是跳数防护的唯一观测窗口
    expect(hitsOf('/loop')).toBe(11);

    const evs = await s.kernel.call('run:events', { projectId: s.projectId, runId });
    const entryEvs = entryEventsOf(evs, entryId);

    // 循环内的跳不产生 request_sent：落库恰 1 条
    const sent = entryEvs.filter((e) => e.kind === 'request_sent');
    expect(sent).toHaveLength(1);

    // 循环退出后读取的是末跳响应：response_received 恰 1 条且 status=302
    const resp = entryEvs.filter((e): e is Extract<RunEvent, { kind: 'response_received' }> => e.kind === 'response_received');
    expect(resp).toHaveLength(1);
    expect(resp[0]!.status).toBe(302);

    // 封顶是守卫截断，不是失败：无 step_errored，entry 判 passed
    expect(entryEvs.some((e) => e.kind === 'step_errored')).toBe(false);
    const results = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(results.entries[0]!.verdict).toBe('passed');

    // 停止后不再有新请求（留出事件循环空转余量复查命中数不变）
    await new Promise((r) => setTimeout(r, 100));
    expect(hitsOf('/loop')).toBe(11);
    s.kernel.close();
  });

  it('③ 302 无 Location 头：break 跳出而非报错——mock 命中恰 1 次，末跳 302 参与 response_received，entry 正常推进到断言', async () => {
    resetMock();
    const s = await setupProject();
    const env = envOf(s);
    const c = await adoptedCase(s, [
      { id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/no-location', followRedirects: true } },
      { id: 's1', seq: 1, kind: 'assert', config: { target: { kind: 'status' }, op: 'eq', expected: '302', severity: 'major' } },
    ]);
    const runId = await runPlan(s, [c], env);
    const entryId = `${c.id}#0`;

    expect(hitsOf('/no-location')).toBe(1);

    const evs = await s.kernel.call('run:events', { projectId: s.projectId, runId });
    const entryEvs = entryEventsOf(evs, entryId);
    expect(kindsOf(entryEvs)).toEqual(['entry_started', 'request_sent', 'response_received', 'assert_evaluated', 'entry_finished']);

    const resp = entryEvs.filter((e): e is Extract<RunEvent, { kind: 'response_received' }> => e.kind === 'response_received');
    expect(resp).toHaveLength(1);
    expect(resp[0]!.status).toBe(302);

    // break 是正常路径：无任何 step_errored，断言（status=302）通过 → passed
    expect(entryEvs.some((e) => e.kind === 'step_errored')).toBe(false);
    const results = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(results.entries[0]!.verdict).toBe('passed');
    expect(results.entries[0]!.failedAsserts).toBe(0);
    s.kernel.close();
  });

  it('④ {{secret.missing}} 供应商取不到：事件序 entry_started → step_errored(env_error) → entry_finished，零出站请求（mock 命中 0），entry 判 errored', async () => {
    resetMock();
    const s = await setupProject();
    // 编译期在册（validateRefs 过 secretNames），运行期供应商取不到 → env_error 路径
    const env = envOf(s, ['missing']);
    const c = await adoptedCase(s, [
      { id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/ok?t={{secret.missing}}' } },
    ]);
    const runId = await runPlan(s, [c], env, () => undefined);
    const entryId = `${c.id}#0`;

    // 缺凭据 → 根本不发请求（回归成「继续发无凭据请求」会打真实服务：命中数就是哨兵）
    expect(hitsOf('/ok')).toBe(0);

    const evs = await s.kernel.call('run:events', { projectId: s.projectId, runId });
    const entryEvs = entryEventsOf(evs, entryId);
    // entry_started 先发（runner 先锚定 entry 再折算 env_error）
    expect(kindsOf(entryEvs)).toEqual(['entry_started', 'step_errored', 'entry_finished']);

    const stepErr = entryEvs.find((e): e is Extract<RunEvent, { kind: 'step_errored' }> => e.kind === 'step_errored');
    expect(stepErr?.reason).toBe('env_error');
    expect(stepErr?.detail).toContain('missing');

    expect(entryEvs.some((e) => e.kind === 'request_sent')).toBe(false);

    const results = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(results.entries[0]!.verdict).toBe('errored');
    s.kernel.close();
  });

  it('⑤ 对照组：同一 secret 名出现在 url/body/headers 三处——provider 恰被取值一次（Set 收集+一次性取值），三处均以真实值发出', async () => {
    resetMock();
    const s = await setupProject();
    const env = envOf(s, ['apiToken']);
    const c = await adoptedCase(s, [
      {
        id: 's0',
        seq: 0,
        kind: 'request',
        config: {
          method: 'POST',
          url: '/echo?t={{secret.apiToken}}',
          headers: { 'content-type': 'application/json', authorization: 'Bearer {{secret.apiToken}}' },
          body: '{"token":"{{secret.apiToken}}"}',
        },
      },
      { id: 's1', seq: 1, kind: 'assert', config: { target: { kind: 'status' }, op: 'eq', expected: '200', severity: 'major' } },
    ]);

    const calls: string[] = [];
    const runId = await runPlan(s, [c], env, (n) => {
      calls.push(n);
      return n === 'apiToken' ? SECRET_VALUE : undefined;
    });
    const entryId = `${c.id}#0`;

    // 三个引用点只触发一次取值
    expect(calls).toEqual(['apiToken']);
    expect(hitsOf('/echo')).toBe(1);

    // 三处都解析为真实值（mock 收到后只做比对，secret 不回显、不落库）
    expect(received).toEqual({ auth: `Bearer ${SECRET_VALUE}`, q: SECRET_VALUE, token: SECRET_VALUE });

    const evs = await s.kernel.call('run:events', { projectId: s.projectId, runId });
    const entryEvs = entryEventsOf(evs, entryId);
    expect(kindsOf(entryEvs)).toEqual(['entry_started', 'request_sent', 'response_received', 'assert_evaluated', 'entry_finished']);

    const results = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(results.entries[0]!.verdict).toBe('passed');
    s.kernel.close();
  });
});
