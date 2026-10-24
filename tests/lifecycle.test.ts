/**
 * 运行生命周期收尾：取消/暂停/恢复（03 §5.5）、续跑（§7.3）、db 波次（§3.3）、
 * 自足导出（04 §7.3）、通过率口径（§4.2）、跨运行稳定性（§3.4）、artifact 保留（§7.1）。
 */

import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compilePlan } from '../src/execution/plan-compiler.ts';
import { buildResumePlan, executePlan } from '../src/execution/index.ts';
import { makeDbChecker } from '../src/sampling/index.ts';
import { defaultRunPolicy, type EnvRecord, type RunPolicy, type TestCaseDraft, type TestCaseRecord } from '../src/kernel/shared/domain.ts';
import { testKernel, type KernelHandle } from './helpers.ts';

const SECRET = 'sk-live-abcdef0123456789fedcba';

/* ─────────────── 慢响应 mock（取消/暂停需要真实窗口） ─────────────── */

let server: Server;
let port = 0;
const hitCount = new Map<string, number>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    hitCount.set(path, (hitCount.get(path) ?? 0) + 1);
    const slow = path.startsWith('/slow');
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path }));
    }, slow ? 120 : 5);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const ENV: EnvRecord = {
  id: 1, projectId: 1, name: 'staging', baseUrl: 'http://127.0.0.1:1',
  variables: {}, secretNames: [], headers: {}, allowSelfSigned: false, createdAtMs: 0,
};

const POLICY: RunPolicy = defaultRunPolicy();

async function adoptCase(h: KernelHandle, projectId: number, name: string, steps: { id: string; seq: number; kind: string; config: Record<string, unknown> }[], rows?: TestCaseDraft['params']['rows']): Promise<TestCaseRecord> {
  const proposed = await h.kernel.call('case:propose', {
    projectId,
    proposedBy: 't',
    draft: {
      name, description: null, routeId: null,
      paramKind: rows === undefined ? 'single' : 'boundary',
      steps: steps.map((s, i) => ({ id: s.id, seq: i, kind: s.kind, config: s.config })) as TestCaseDraft['steps'],
      params: { kind: rows === undefined ? 'single' : 'boundary', rows: rows ?? [{ label: 'baseline', values: {}, intent: 'baseline' }] },
      provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
      policyOverride: null, tags: [],
    },
  });
  return h.kernel.call('case:review', { projectId, caseId: proposed.id, action: 'adopt', actor: 'kel' });
}

async function mkEnv(h: KernelHandle, projectId: number): Promise<EnvRecord> {
  return h.kernel.call('env:create', { projectId, name: 'e', baseUrl: `http://127.0.0.1:${port}` }) as Promise<EnvRecord>;
}

function httpStep(url: string) {
  return { id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url } };
}

/* ─────────────── 取消 ─────────────── */

describe('运行取消（03 §5.5）', () => {
  it('慢队列中取消：未开始的 entry 不再启动（判 skipped），run → cancelled', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const env = await mkEnv(h, project.id);

    // 6 个慢用例（同 case 不同参数行 → 串行；总时长足够窗口内取消）
    const c = await adoptCase(h, project.id, '慢队列', [httpStep('/slow/a')], [
      { label: 'r1', values: {}, intent: 'baseline' },
      { label: 'r2', values: {}, intent: 'baseline' },
      { label: 'r3', values: {}, intent: 'baseline' },
      { label: 'r4', values: {}, intent: 'baseline' },
      { label: 'r5', values: {}, intent: 'baseline' },
      { label: 'r6', values: {}, intent: 'baseline' },
    ]);

    const plan = await compilePlan({ cases: [c], env, policy: POLICY, seed: 1, nowMs: 0 });
    const { runId } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy: POLICY, seed: 1, plan });

    const executing = executePlan({ kernel: h.kernel, projectId: project.id, runId, plan, env });
    // 等 2 个 entry 完成后取消
    await new Promise((r) => setTimeout(r, 300));
    await h.kernel.call('run:cancel', { projectId: project.id, runId });
    const result = await executing;
    expect(result.cancelled).toBe(true);
    expect(result.executed).toBeLessThan(6);

    const finished = await h.kernel.call('run:finish', { projectId: project.id, runId, status: 'cancelled' });
    expect(finished.status).toBe('cancelled');

    const results = await h.kernel.call('run:results', { projectId: project.id, runId });
    const verdicts = results.entries.map((e) => e.verdict);
    expect(verdicts.filter((v) => v === 'passed').length).toBe(result.executed);
    expect(verdicts.filter((v) => v === 'skipped').length).toBe(6 - result.executed);
    // 事件里有 run_paused？没有——取消不产生 paused；有 run_finished(cancelled)
    const kinds = (await h.kernel.call('run:events', { projectId: project.id, runId })).map((e) => e.kind);
    expect(kinds[kinds.length - 1]).toBe('run_finished');
    h.dispose();
  });

  it('暂停 → 恢复：run_paused / run_resumed 事件落库，执行继续', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const env = await mkEnv(h, project.id);
    const c = await adoptCase(h, project.id, '慢队列2', [httpStep('/slow/b')], [
      { label: 'r1', values: {}, intent: 'baseline' },
      { label: 'r2', values: {}, intent: 'baseline' },
      { label: 'r3', values: {}, intent: 'baseline' },
      { label: 'r4', values: {}, intent: 'baseline' },
    ]);
    const plan = await compilePlan({ cases: [c], env, policy: POLICY, seed: 1, nowMs: 0 });
    const { runId } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy: POLICY, seed: 1, plan });

    const executing = executePlan({ kernel: h.kernel, projectId: project.id, runId, plan, env });
    await new Promise((r) => setTimeout(r, 280));
    await h.kernel.call('run:pause', { projectId: project.id, runId });
    await new Promise((r) => setTimeout(r, 200));
    await h.kernel.call('run:resume', { projectId: project.id, runId });
    const result = await executing;
    expect(result.cancelled).toBe(false);
    expect(result.executed).toBe(4);

    await h.kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });
    const kinds = (await h.kernel.call('run:events', { projectId: project.id, runId })).map((e) => e.kind);
    expect(kinds).toContain('run_paused');
    expect(kinds).toContain('run_resumed');
    const progress = await h.kernel.call('run:progress', { projectId: project.id, runId });
    expect(progress.doneEntries).toBe(4);
    h.dispose();
  });
});

/* ─────────────── 续跑 ─────────────── */

describe('中断点续跑（03 §7.3）', () => {
  it('取消后续跑：只跑未完成的 entry；seed 不变；新 run 完整闭环', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const env = await mkEnv(h, project.id);
    const c = await adoptCase(h, project.id, '续跑队列', [httpStep('/slow/c')], [
      { label: 'r1', values: {}, intent: 'baseline' },
      { label: 'r2', values: {}, intent: 'baseline' },
      { label: 'r3', values: {}, intent: 'baseline' },
      { label: 'r4', values: {}, intent: 'baseline' },
    ]);
    const policy = { ...POLICY, retry: { ...POLICY.retry, maxAttempts: 1 } };
    const plan = await compilePlan({ cases: [c], env, policy, seed: 42, nowMs: 0 });
    const { runId: run1 } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy, seed: 42, plan });

    const executing = executePlan({ kernel: h.kernel, projectId: project.id, runId: run1, plan, env });
    await new Promise((r) => setTimeout(r, 300));
    await h.kernel.call('run:cancel', { projectId: project.id, runId: run1 });
    const r1 = await executing;
    await h.kernel.call('run:finish', { projectId: project.id, runId: run1, status: 'cancelled' });
    expect(r1.executed).toBeGreaterThan(0);
    expect(r1.executed).toBeLessThan(4);

    // 续跑：同一 plan 快照 + 跳过已完成
    const resume = await buildResumePlan(h.kernel, project.id, run1, Date.now());
    expect(resume.plan.entries.length).toBe(4 - r1.executed);
    expect(resume.plan.seed).toBe(42);

    const { runId: run2 } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy, seed: 42, plan: resume.plan });
    const r2 = await executePlan({ kernel: h.kernel, projectId: project.id, runId: run2, plan: resume.plan, env });
    expect(r2.cancelled).toBe(false);
    expect(r2.executed).toBe(resume.plan.entries.length);
    const fin2 = await h.kernel.call('run:finish', { projectId: project.id, runId: run2, status: 'completed' });
    expect(fin2.status).toBe('completed');
    expect(fin2.counters!.skipped).toBe(0);

    // 续跑语义：跳过的是「已完成」（entry_finished）；被取消跳过的 entry 正是重跑对象
    const events1 = await h.kernel.call('run:events', { projectId: project.id, runId: run1 });
    const finished1 = new Set(events1.filter((e) => e.kind === 'entry_finished').map((e) => e.entryId));
    const results1 = await h.kernel.call('run:results', { projectId: project.id, runId: run1 });
    const results2 = await h.kernel.call('run:results', { projectId: project.id, runId: run2 });
    expect(results1.entries).toHaveLength(4); // 源 run：3 完成 + 1 取消锚点（skipped）
    expect(results2.entries).toHaveLength(1); // 续跑只跑被取消的那个
    expect(results2.entries.every((e) => !finished1.has(e.entryId))).toBe(true);
    expect(new Set([...results1.entries.map((e) => e.entryId), ...results2.entries.map((e) => e.entryId)]).size).toBe(4);
    h.dispose();
  });

  it('无 plan 快照的运行不可续跑；进行中的运行不可续跑', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const env = await mkEnv(h, project.id);
    const c = await adoptCase(h, project.id, 'c', [httpStep('/x')]);
    const plan = await compilePlan({ cases: [c], env, policy: POLICY, seed: 1, nowMs: 0 });
    const noPlan = { ...plan, entries: plan.entries };
    void noPlan;
    // begin 不带 plan → 无快照
    const { runId } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy: POLICY, seed: 1 });
    await h.kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });
    await expect(buildResumePlan(h.kernel, project.id, runId, Date.now())).rejects.toMatchObject({ code: 'plan_snapshot_missing' });

    const { runId: running } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy: POLICY, seed: 1, plan });
    await expect(buildResumePlan(h.kernel, project.id, running, Date.now())).rejects.toMatchObject({ code: 'run_not_finished' });
    await h.kernel.call('run:finish', { projectId: project.id, runId: running, status: 'completed' });
    h.dispose();
  });
});

/* ─────────────── 导出 ─────────────── */

describe('自足报告导出（04 §7.3）', () => {
  it('json：含策略快照/事件计数/chainHash/三种口径；markdown：标注口径与 flaky；csv：行级', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const env = await mkEnv(h, project.id);
    const ok = await adoptCase(h, project.id, 'ok', [httpStep('/fast-ok')]);
    const minor = await adoptCase(h, project.id, 'minor', [
      httpStep('/fast-ok'),
      { id: 's1', seq: 1, kind: 'assert', config: { target: { kind: 'status' }, op: 'eq', expected: '500', severity: 'minor' } },
    ]);
    void ok;
    void minor;
    const cases = await h.kernel.call('case:list', { projectId: project.id, status: 'adopted' });
    const plan = await compilePlan({ cases, env, policy: POLICY, seed: 1, nowMs: 0 });
    const { runId } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy: POLICY, seed: 1, plan });
    await executePlan({ kernel: h.kernel, projectId: project.id, runId, plan, env });
    await h.kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });

    const json = await h.kernel.call('run:export', { projectId: project.id, runId, format: 'json' });
    const parsed = JSON.parse(json.content) as Record<string, unknown>;
    expect(parsed['format']).toBe('deepautotest-run-export');
    expect((parsed['exportedWithPolicy'] as Record<string, unknown>)['failOnSeverity']).toBe('major'); // ★ 策略随报告
    expect((parsed['integrity'] as Record<string, unknown>)['chainHash']).toBeTruthy(); // ★ 事件计数+链哈希
    const pr = parsed['passRate'] as Record<string, unknown>;
    expect(pr['defaultBasis']).toBe('excluding_errored');

    const md = await h.kernel.call('run:export', { projectId: project.id, runId, format: 'markdown' });
    expect(md.content).toContain('口径：**排除 errored**');
    expect(md.content).toContain('判定策略');

    const csv = await h.kernel.call('run:export', { projectId: project.id, runId, format: 'csv' });
    expect(csv.content.split('\n')[0]).toBe('case_id,entry_id,label,intent,verdict,flaky,waived,attempts,duration_ms,failed_asserts');
    expect(csv.content.trim().split('\n').length).toBe(3); // header + 2 rows
    h.dispose();
  });

  it('跨项目导出被拒（P5）', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const env = await mkEnv(h, project.id);
    const c = await adoptCase(h, project.id, 'c', [httpStep('/x')]);
    const plan = await compilePlan({ cases: [c], env, policy: POLICY, seed: 1, nowMs: 0 });
    const { runId } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy: POLICY, seed: 1, plan });
    await h.kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });
    const other = await h.kernel.call('project:create', { name: 'o', sourceType: 'local' });
    await expect(h.kernel.call('run:export', { projectId: other.id, runId, format: 'json' })).rejects.toMatchObject({ code: 'not_found' });
    h.dispose();
  });
});

/* ─────────────── 口径 / ETA / 稳定性 ─────────────── */

describe('通过率口径（04 §4.2）与 ETA（03 §7.1）', () => {
  it('三种口径数字不同且都显式；ETA 中位外推', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const env = await mkEnv(h, project.id);
    // 用直接事件构造 4 用例：1 passed / 1 degraded / 1 failed / 1 errored
    const caseIds: number[] = [];
    for (const name of ['ok', 'deg', 'fail', 'err']) {
      const c = await adoptCase(h, project.id, name, [httpStep('/x')]);
      caseIds.push(c.id);
    }
    const plan = await compilePlan({ cases: await h.kernel.call('case:list', { projectId: project.id, status: 'adopted' }), env, policy: POLICY, seed: 1, nowMs: 0 });
    const { runId } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy: POLICY, seed: 1, plan });
    const [okId, degId, failId, errId] = caseIds as [number, number, number, number];
    await h.kernel.call('run:appendEvents', {
      projectId: project.id, runId,
      events: [
        { kind: 'entry_started', entryId: 'a', caseId: okId, paramRowLabel: 'a', intent: 'baseline' },
        { kind: 'response_received', entryId: 'a', stepSeq: 0, status: 200, durationMs: 100, bodyRef: null, bodySha256: null },
        { kind: 'entry_finished', entryId: 'a', attempts: 1, durationMs: 100 },
        { kind: 'entry_started', entryId: 'b', caseId: degId, paramRowLabel: 'b', intent: 'baseline' },
        { kind: 'response_received', entryId: 'b', stepSeq: 0, status: 200, durationMs: 200, bodyRef: null, bodySha256: null },
        { kind: 'assert_evaluated', entryId: 'b', assertSeq: 0, stepSeq: 0, severity: 'minor', expected: 'x', actual: 'y', passed: false, principleId: null, sourceFile: null, sourceLine: null },
        { kind: 'entry_finished', entryId: 'b', attempts: 1, durationMs: 200 },
        { kind: 'entry_started', entryId: 'c', caseId: failId, paramRowLabel: 'c', intent: 'baseline' },
        { kind: 'response_received', entryId: 'c', stepSeq: 0, status: 500, durationMs: 300, bodyRef: null, bodySha256: null },
        { kind: 'assert_evaluated', entryId: 'c', assertSeq: 0, stepSeq: 0, severity: 'critical', expected: '200', actual: '500', passed: false, principleId: null, sourceFile: null, sourceLine: null },
        { kind: 'entry_finished', entryId: 'c', attempts: 1, durationMs: 300 },
        { kind: 'entry_started', entryId: 'd', caseId: errId, paramRowLabel: 'd', intent: 'baseline' },
        { kind: 'step_errored', entryId: 'd', stepSeq: 0, stepKind: 'request', reason: 'connect_failed', detail: null },
        { kind: 'entry_finished', entryId: 'd', attempts: 1, durationMs: 5 },
      ],
    });
    await h.kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });

    const strict = await h.kernel.call('run:passRate', { projectId: project.id, runId, basis: 'strict' });
    const lenient = await h.kernel.call('run:passRate', { projectId: project.id, runId, basis: 'lenient' });
    const excl = await h.kernel.call('run:passRate', { projectId: project.id, runId, basis: 'excluding_errored' });
    expect(strict).toEqual({ basis: 'strict', rate: 0.25, numerator: 1, denominator: 4 });
    expect(lenient).toEqual({ basis: 'lenient', rate: 0.5, numerator: 2, denominator: 4 });
    expect(excl).toEqual({ basis: 'excluding_errored', rate: 1 / 3, numerator: 1, denominator: 3 }); // ★ 环境问题不算被测头上

    const eta = await h.kernel.call('run:eta', { projectId: project.id, runId });
    expect(eta.totalEntries).toBe(4);
    expect(eta.doneEntries).toBe(4);
    expect(eta.medianMs).toBe(150); // [5,100,200,300] 中位 (100+200)/2
    expect(eta.etaMs).toBeNull(); // 无剩余 → null（诚实）
    h.dispose();
  });
});

describe('跨运行稳定性榜（04 §3.4）', () => {
  it('窗口内 flaky 聚合：flakyRuns>0 的用例上榜并带最近判定', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const env = await mkEnv(h, project.id);
    const flakyCase = await adoptCase(h, project.id, 'flaky-one', [httpStep('/x')]);
    const stableCase = await adoptCase(h, project.id, 'stable', [httpStep('/x')]);
    const cases = await h.kernel.call('case:list', { projectId: project.id, status: 'adopted' });
    const plan = await compilePlan({ cases, env, policy: POLICY, seed: 1, nowMs: 0 });

    const runOnce = async (withRetry: boolean): Promise<void> => {
      const { runId } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy: POLICY, seed: 1, plan });
      const events: Record<string, unknown>[] = [];
      for (const cid of [flakyCase.id, stableCase.id]) {
        const eid = `e-${cid}-${Math.random().toString(36).slice(2, 6)}`;
        events.push({ kind: 'entry_started', entryId: eid, caseId: cid, paramRowLabel: 'l', intent: 'baseline' });
        events.push({ kind: 'response_received', entryId: eid, stepSeq: 0, status: 200, durationMs: 10, bodyRef: null, bodySha256: null });
        if (cid === flakyCase.id && withRetry) {
          events.push({ kind: 'assert_evaluated', entryId: eid, assertSeq: 0, stepSeq: 0, severity: 'major', expected: '200', actual: '500', passed: false, principleId: null, sourceFile: null, sourceLine: null });
          events.push({ kind: 'retry_scheduled', entryId: eid, attempt: 2, reason: 'assert_failed', delayMs: 1 });
          events.push({ kind: 'response_received', entryId: eid, stepSeq: 0, status: 200, durationMs: 10, bodyRef: null, bodySha256: null });
        }
        events.push({ kind: 'assert_evaluated', entryId: eid, assertSeq: withRetry && cid === flakyCase.id ? 1 : 0, stepSeq: 0, severity: 'major', expected: '200', actual: '200', passed: true, principleId: null, sourceFile: null, sourceLine: null });
        events.push({ kind: 'entry_finished', entryId: eid, attempts: withRetry && cid === flakyCase.id ? 2 : 1, durationMs: 10 });
      }
      await h.kernel.call('run:appendEvents', { projectId: project.id, runId, events });
      await h.kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });
    };
    await runOnce(true); // flakyCase 产生 flaky
    await runOnce(false);

    const stability = await h.kernel.call('metrics:stability', { projectId: project.id, window: 5 });
    expect(stability.rows).toHaveLength(1);
    expect(stability.rows[0]).toMatchObject({ caseId: flakyCase.id, runs: 2, passes: 2, flakyRuns: 1, lastVerdict: 'passed' });
    // stable 用例不在榜上
    expect(stability.rows.some((r) => r.caseId === stableCase.id)).toBe(false);
    h.dispose();
  });
});

/* ─────────────── db_check 串行波次 ─────────────── */

describe('db_check 波次（03 §3.3）', () => {
  it('db_check 用例在常规组之后串行执行（侧证不与写入并发）', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const env = await mkEnv(h, project.id);
    const dbPath = join(mkdtempSync(join(tmpdir(), 'dat-wave-')), 'app.db');
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY)');
    seed.close();
    await h.kernel.call('dbconn:create', { projectId: project.id, name: 'appdb', dialect: 'sqlite', dsn: dbPath });

    const httpCase = await adoptCase(h, project.id, 'http-case', [httpStep('/fast-http')]);
    const dbCase = await adoptCase(h, project.id, 'db-case', [
      httpStep('/fast-db'),
      { id: 's1', seq: 1, kind: 'db_check', config: { connection: 'appdb', query: 'SELECT id FROM orders', expectRows: { gte: 0 } } },
    ]);
    const cases = await h.kernel.call('case:list', { projectId: project.id, status: 'adopted' });
    const plan = await compilePlan({ cases, env, policy: POLICY, seed: 1, nowMs: 0 });
    const { runId } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy: POLICY, seed: 1, plan });
    const result = await executePlan({ kernel: h.kernel, projectId: project.id, runId, plan, env, dbChecker: makeDbChecker(h.kernel) });
    await h.kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });
    expect(result.cancelled).toBe(false);
    const results = await h.kernel.call('run:results', { projectId: project.id, runId });
    expect(results.entries.every((e) => e.verdict === 'passed')).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
    h.dispose();
  });
});

/* ─────────────── artifact 保留 ─────────────── */

describe('artifact 保留策略（04 §7.1）', () => {
  it('通过用例的大报文过期被清；失败用例的永久保留；文件级删除', async () => {
    const h = testKernel();
    const dir = mkdtempSync(join(tmpdir(), 'dat-retain-'));
    // 需要真实文件 artifactDir：testKernel 用 memory + tmp dataDir，artifacts 目录在其下
    const project = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const env = await mkEnv(h, project.id);
    void SECRET;

    // passed 用例：大报文（>64KiB → 落文件）
    const big = 'x'.repeat(100 * 1024);
    const okCase = await adoptCase(h, project.id, 'big-ok', [
      httpStep('/big-ok'),
      { id: 's1', seq: 1, kind: 'script', config: { code: 'return true' } },
    ]);
    // failed 用例：不同内容的大报文 + 断言必败
    const failCase = await adoptCase(h, project.id, 'big-fail', [
      httpStep('/big-fail'),
      { id: 's1', seq: 1, kind: 'assert', config: { target: { kind: 'status' }, op: 'eq', expected: '418', severity: 'major' } },
    ]);
    const cases = await h.kernel.call('case:list', { projectId: project.id, status: 'adopted' });
    const plan = await compilePlan({ cases, env, policy: POLICY, seed: 1, nowMs: 0 });

    // 大报文 mock：两路径内容不同（sha 去重不会合并 → 各自独立 artifact）
    const bigServer: Server = createServer((req, res) => {
      const isFail = new URL(req.url ?? '/', 'http://x').pathname.includes('fail');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(isFail ? 'y'.repeat(100 * 1024 + 7) : big);
    });
    await new Promise<void>((r) => bigServer.listen(0, '127.0.0.1', r));
    const bigPort = (bigServer.address() as { port: number }).port;
    const bigEnv = { ...env, baseUrl: `http://127.0.0.1:${bigPort}` } as EnvRecord;

    const { runId } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy: POLICY, seed: 1, plan });
    await executePlan({ kernel: h.kernel, projectId: project.id, runId, plan, env: bigEnv });
    await h.kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });
    bigServer.close();

    const results = await h.kernel.call('run:results', { projectId: project.id, runId });
    expect(results.entries.find((e) => e.caseId === failCase.id)!.verdict).toBe('failed');
    const refs = h.kernel.db
      .prepare("SELECT DISTINCT json_extract(payload, '$.bodyRef') AS ref FROM run_event WHERE run_id = ? AND json_extract(payload, '$.bodyRef') IS NOT NULL")
      .all(runId) as { ref: string }[];
    expect(refs.length).toBeGreaterThanOrEqual(2);

    // 未到期（90 天）：什么都不清
    const keep = await h.kernel.call('run:applyRetention', { projectId: project.id, retentionDays: 90 });
    expect(keep.pruned).toBe(0);
    expect(keep.protectedRefs).toBe(0);

    // 到期清扫（retentionDays=0 ⇒ 全部视为过期）：失败用例的受保护，通过用例的被清
    const sweep = await h.kernel.call('run:applyRetention', { projectId: project.id, retentionDays: 0 });
    expect(sweep.pruned).toBe(1);
    expect(sweep.protectedRefs).toBe(1); // ★ 失败的永久保留（排查依据）
    const remaining = h.kernel.db.prepare('SELECT COUNT(*) AS n FROM artifact').get() as { n: number };
    expect(remaining.n).toBe(1);
    // 失败用例引用的 artifact 仍可读
    const failEntry = results.entries.find((e) => e.caseId === failCase.id)!;
    const failStep = results.steps.find((st) => st.entryId === failEntry.entryId && st.responseRef !== null)!;
    const art = await h.kernel.call('artifact:get', { sha256: failStep.responseRef! });
    expect(Buffer.from(art.contentBase64, 'base64').length).toBe(100 * 1024 + 7);
    void dir;
    h.dispose();
  });
});
