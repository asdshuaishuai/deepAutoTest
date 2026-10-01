/**
 * 事件日志写入门 —— 一切「真相变更」的唯一通道。
 *
 * 职责（03 §6.3 / 06 §4.2）：
 *  1. seq 分配（同一事务内 MAX(seq)+1，严格单调）
 *  2. 写时脱敏（落库前，08 §4）
 *  3. 结构校验（entry 必须先 started；用例必须属于当前项目）
 *  4. 事件 + 投影行**同事务**提交（不能出现"事件有了投影没有"的中间态）
 *
 * run_started / run_finished / rejudged 是生命周期事件，只能经
 * beginRun / finishRun / rejudgeRun 进入——普通 append 一律拒绝。
 */

import type { Db, } from '../store/db.ts';
import { tx } from '../store/db.ts';
import {
  deleteProjections,
  finalizeRun,
  getRun,
  insertRun,
  readCaseResultRows,
  readEntryEvents,
  readEvents,
  recomputeChainHash,
  replaceAssertRows,
  replaceStepRows,
  upsertEntryProjection,
  writeEventRow,
  type BeginRunInput,
} from '../store/repos/runs.ts';
import type { ProjectScope } from '../shared/ids.ts';
import { KernelError, type Clock } from '../shared/util.ts';
import {
  defaultRunPolicy,
  type RejudgeDiff,
  type RunEvent,
  type RunEventInput,
  type RunPolicy,
  type RunRecord,
  type RunStatus,
  type Verdict,
} from '../shared/domain.ts';
import { redactDeep, type RedactOptions } from './redact.ts';
import { judgeEntry, judgeRun, type EntryJudgeContext } from './judge.ts';
import { deriveEntryRows } from './derive.ts';
import { validateRunEventInput } from './validate.ts';

export interface EventLogDeps {
  db: Db;
  clock: Clock;
  redact: RedactOptions;
}

const ANNOTATION_KINDS = new Set<RunEventInput['kind']>([
  'note',
  'case_waived',
  'case_overridden',
  'run_voided',
]);

/* ─────────────────────────── begin / append / finish ─────────────────────────── */

export function beginRun(deps: EventLogDeps, scope: ProjectScope, input: BeginRunInput & { planSnapshot?: unknown }): number {
  return tx(deps.db, () => {
    const runId = insertRun(deps.db, scope, input, deps.clock.nowMs());
    writeLifecycleEvent(deps, runId, {
      kind: 'run_started',
      entryId: null,
      policy: input.policy,
      envId: input.envId,
      concurrency: input.policy.concurrency,
      seed: input.seed,
      ...(input.planSnapshot === undefined ? {} : { planSnapshot: input.planSnapshot }),
    });
    return runId;
  });
}

export function appendEvents(deps: EventLogDeps, scope: ProjectScope, runId: number, inputs: RunEventInput[]): RunEvent[] {
  if (inputs.length === 0) return [];
  const run = requireRun(deps.db, scope, runId);
  const finished = run.status !== 'running';

  const knownEntries = new Set(
    (
      deps.db
        .prepare('SELECT DISTINCT entry_id FROM run_event WHERE run_id = ?')
        .all(runId) as { entry_id: string }[]
    ).map((r) => r.entry_id),
  );

  for (const raw of inputs) {
    const input = validateRunEventInput(raw);
    if (finished && !ANNOTATION_KINDS.has(input.kind)) {
      throw new KernelError('run_not_active', `运行 ${runId} 已 ${run.status}，只接受标注类事件`);
    }
    if (input.kind === 'run_started' || input.kind === 'run_finished' || input.kind === 'rejudged') {
      throw new KernelError('lifecycle_event_reserved', `${input.kind} 只能经 begin/finish/rejudge 通道写入`);
    }
    if (!runStartedExists(deps.db, runId)) {
      throw new KernelError('run_not_started', `运行 ${runId} 尚无 run_started（应经 run:begin 创建）`);
    }
    if (input.kind === 'entry_started') {
      const caseOk = deps.db
        .prepare('SELECT 1 FROM test_case WHERE id = ? AND project_id = ?')
        .get(input.caseId, scope.projectId);
      if (caseOk === undefined) {
        throw new KernelError('case_not_in_project', `用例 ${input.caseId} 不在当前项目内（P5）`);
      }
      if (input.entryId === null) throw new KernelError('invalid_params', 'entry_started 必须带 entryId');
      knownEntries.add(input.entryId);
    } else if (input.entryId !== null && !knownEntries.has(input.entryId)) {
      throw new KernelError('entry_not_started', `entry ${input.entryId} 尚未 entry_started，不能接受 ${input.kind}`);
    }
  }

  return tx(deps.db, () => {
    const written: RunEvent[] = [];
    for (const input of inputs) {
      written.push(writeNormalEvent(deps, runId, input));
    }
    // 事件 + 投影同事务（06 §4.2）
    updateTouchedProjections(deps, runId, inputs);
    return written;
  });
}

export function finishRun(deps: EventLogDeps, scope: ProjectScope, runId: number, status: Extract<RunStatus, 'completed' | 'cancelled' | 'errored'>): RunRecord {
  const run = requireRun(deps.db, scope, runId);
  if (run.status !== 'running') throw new KernelError('run_not_active', `运行 ${runId} 已是终态 ${run.status}`);

  tx(deps.db, () => {
    writeLifecycleEvent(deps, runId, { kind: 'run_finished', entryId: null, status });
    const chain = recomputeChainHash(deps.db, runId);
    const events = readEvents(deps.db, runId, 0, 10_000_000);
    const judgment = judgeRun(runId, events);
    finalizeRun(deps.db, runId, {
      status,
      finishedAtMs: deps.clock.nowMs(),
      eventCount: chain.count,
      chainHash: chain.hash,
      counters: judgment.counters,
    });
  });
  return requireRun(deps.db, scope, runId);
}

/* ─────────────────────────── 完整性 / 重建 / 重判 ─────────────────────────── */

export interface IntegrityReport {
  ok: boolean;
  reason: 'seq_gap' | 'hash_mismatch' | null;
  eventCount: number;
  chainHash: string;
}

export function verifyIntegrity(deps: EventLogDeps, scope: ProjectScope, runId: number): IntegrityReport {
  const run = requireRun(deps.db, scope, runId);
  const chain = recomputeChainHash(deps.db, runId);
  if (!chain.contiguous) return { ok: false, reason: 'seq_gap', eventCount: chain.count, chainHash: chain.hash };
  if (run.chainHash !== null && run.chainHash !== chain.hash) {
    return { ok: false, reason: 'hash_mismatch', eventCount: chain.count, chainHash: chain.hash };
  }
  return { ok: true, reason: null, eventCount: chain.count, chainHash: chain.hash };
}

export function rebuildProjections(deps: EventLogDeps, scope: ProjectScope, runId: number): { rebuilt: number } {
  const run = requireRun(deps.db, scope, runId);
  const integrity = internalIntegrity(deps.db, runId);
  if (!integrity.ok) {
    throw new KernelError('integrity_failed', `事件日志不完整（${integrity.reason}），投影重建无意义（04 §5.4）`);
  }
  const rebuilt = rebuildAll(deps, runId);
  finalizeRun(deps.db, runId, {
    status: run.status,
    finishedAtMs: run.finishedAtMs ?? deps.clock.nowMs(),
    eventCount: integrity.count,
    chainHash: integrity.hash,
    counters: rebuilt.counters,
  });
  return { rebuilt: rebuilt.count };
}

export function rejudgeRun(
  deps: EventLogDeps,
  scope: ProjectScope,
  runId: number,
  policy: RunPolicy,
  mode: 'preview' | 'apply',
  actor: string,
): RejudgeDiff {
  const run = requireRun(deps.db, scope, runId);
  const integrity = internalIntegrity(deps.db, runId);
  if (!integrity.ok) {
    throw new KernelError('integrity_failed', `事件日志不完整（${integrity.reason}），不可重判（04 §5.4）`);
  }

  const before = readCaseResultRows(deps.db, runId);
  const events = readEvents(deps.db, runId, 0, 10_000_000);

  if (mode === 'preview') {
    // preview：算出新结论与旧结论 diff，不写任何东西（04 §5.2）
    const previewJudgment = judgeRun(runId, events, { policyOverride: policy });
    return diffEntries(runId, before, previewJudgment.entries);
  }

  // apply：追加 rejudged 事件（append-only），事件本体不动，只覆盖投影
  tx(deps.db, () => {
    writeLifecycleEvent(deps, runId, { kind: 'rejudged', entryId: null, policy, by: actor, note: null });
    const rebuilt = rebuildAll(deps, runId);
    const integrityAfter = internalIntegrity(deps.db, runId);
    finalizeRun(deps.db, runId, {
      status: run.status,
      finishedAtMs: run.finishedAtMs ?? deps.clock.nowMs(),
      eventCount: integrityAfter.count,
      chainHash: integrityAfter.hash,
      counters: rebuilt.counters,
    });
  });
  const after = readCaseResultRows(deps.db, runId);
  return diffEntries(runId, before, after);
}

/** 用两个 RunJudgment 做 diff（run:diff 服务用）。 */
export function judgeRunFromDb(deps: EventLogDeps, runId: number): ReturnType<typeof judgeRun> {
  const events = readEvents(deps.db, runId, 0, 10_000_000);
  const run = deps.db.prepare('SELECT chain_hash FROM run WHERE id = ?').get(runId) as { chain_hash: string | null };
  return judgeRun(runId, events, { expectedChainHash: run.chain_hash });
}

/* ─────────────────────────── 内部 ─────────────────────────── */

function requireRun(db: Db, scope: ProjectScope, runId: number): RunRecord {
  const run = getRun(db, scope, runId);
  if (run === undefined) throw new KernelError('not_found', `运行 ${runId} 不在当前项目内`);
  return run;
}

/** 生命周期事件写入（不触投影——它们在各自编排函数里统一处理）。 */
function writeLifecycleEvent(deps: EventLogDeps, runId: number, input: RunEventInput): RunEvent {
  return writeNormalEvent(deps, runId, input);
}

function writeNormalEvent(deps: EventLogDeps, runId: number, input: RunEventInput): RunEvent {
  const nextSeq = nextSeqFor(deps.db, runId);
  const { entryId, ...payload } = input;
  const redacted = redactDeep(payload, deps.redact) as typeof payload;
  const ev: RunEvent = {
    runId,
    seq: nextSeq,
    atMs: deps.clock.nowMs(),
    entryId: entryId ?? null,
    ...redacted,
  } as RunEvent;
  writeEventRow(deps.db, ev);
  return ev;
}

function nextSeqFor(db: Db, runId: number): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS max FROM run_event WHERE run_id = ?')
    .get(runId) as { max: number };
  return row.max + 1;
}

function runStartedExists(db: Db, runId: number): boolean {
  return db.prepare("SELECT 1 FROM run_event WHERE run_id = ? AND kind = 'run_started'").get(runId) !== undefined;
}

/** live 投影更新：只重算被本批触碰的 entry（同事务）。 */
function updateTouchedProjections(deps: EventLogDeps, runId: number, inputs: RunEventInput[]): void {
  const touched = new Set<string>();
  const caseTouched = new Set<number>();
  for (const input of inputs) {
    if (input.entryId !== null) touched.add(input.entryId);
    if (input.kind === 'case_waived' || input.kind === 'case_overridden') caseTouched.add(input.caseId);
  }
  for (const caseId of caseTouched) {
    const rows = deps.db
      .prepare('SELECT DISTINCT entry_id FROM run_event WHERE run_id = ? AND case_id = ? AND entry_id IS NOT NULL')
      .all(runId, caseId) as { entry_id: string }[];
    for (const r of rows) touched.add(r.entry_id);
  }
  if (touched.size === 0) return;

  const ctx = liveContext(deps, runId);
  for (const entryId of touched) {
    const evs = readEntryEvents(deps.db, runId, entryId);
    if (evs.length === 0) continue;
    const j = judgeEntry(entryId, evs, ctx);
    applyOverrideMarker(deps, runId, j);
    upsertEntryProjection(deps.db, runId, j);
    const rows = deriveEntryRows(entryId, evs, j);
    replaceStepRows(deps.db, runId, entryId, rows.stepRows);
    replaceAssertRows(deps.db, runId, entryId, rows.assertRows);
  }
}

function liveContext(deps: EventLogDeps, runId: number): EntryJudgeContext {
  // 生效策略：run 行快照，被 rejudged 事件覆盖
  const run = deps.db.prepare('SELECT policy_json, status FROM run WHERE id = ?').get(runId) as {
    policy_json: string;
    status: string;
  };
  let policy = JSON.parse(run.policy_json) as RunPolicy;
  const rejudged = deps.db
    .prepare("SELECT payload FROM run_event WHERE run_id = ? AND kind = 'rejudged' ORDER BY seq DESC LIMIT 1")
    .get(runId) as { payload: string } | undefined;
  if (rejudged !== undefined) policy = (JSON.parse(rejudged.payload) as { policy: RunPolicy }).policy;

  const waived = new Set(
    (
      deps.db
        .prepare("SELECT case_id FROM run_event WHERE run_id = ? AND kind = 'case_waived' AND case_id IS NOT NULL")
        .all(runId) as { case_id: number }[]
    ).map((r) => r.case_id),
  );
  return { policy, runCancelled: run.status === 'cancelled', waivedCaseIds: waived };
}

function applyOverrideMarker(deps: EventLogDeps, runId: number, j: { caseId: number; overriddenTo: string | null }): void {
  const rows = deps.db
    .prepare("SELECT payload FROM run_event WHERE run_id = ? AND kind = 'case_overridden' AND case_id = ? ORDER BY seq DESC LIMIT 1")
    .all(runId, j.caseId) as { payload: string }[];
  if (rows.length > 0) {
    const payload = JSON.parse(rows[0]!.payload) as { caseId: number; to: Verdict };
    if (payload.caseId === j.caseId) j.overriddenTo = payload.to;
  }
}

function internalIntegrity(db: Db, runId: number): { ok: boolean; reason: 'seq_gap' | 'hash_mismatch' | null; count: number; hash: string } {
  const chain = recomputeChainHash(db, runId);
  if (!chain.contiguous) return { ok: false, reason: 'seq_gap', count: chain.count, hash: chain.hash };
  const run = db.prepare('SELECT chain_hash FROM run WHERE id = ?').get(runId) as { chain_hash: string | null };
  if (run.chain_hash !== null && run.chain_hash !== chain.hash) {
    return { ok: false, reason: 'hash_mismatch', count: chain.count, hash: chain.hash };
  }
  return { ok: true, reason: null, count: chain.count, hash: chain.hash };
}

/** 全量重建：删投影 → judge → 逐 entry 写回。只在事务内调用。 */
function rebuildAll(deps: EventLogDeps, runId: number): { count: number; counters: ReturnType<typeof judgeRun>['counters'] } {
  const events = readEvents(deps.db, runId, 0, 10_000_000);
  const judgment = judgeRun(runId, events);
  deleteProjections(deps.db, runId);

  const byEntry = new Map<string, RunEvent[]>();
  for (const ev of events) {
    if (ev.entryId === null) continue;
    const list = byEntry.get(ev.entryId);
    if (list === undefined) byEntry.set(ev.entryId, [ev]);
    else list.push(ev);
  }
  for (const j of judgment.entries) {
    upsertEntryProjection(deps.db, runId, j);
    const evs = byEntry.get(j.entryId) ?? [];
    const rows = deriveEntryRows(j.entryId, evs, j);
    replaceStepRows(deps.db, runId, j.entryId, rows.stepRows);
    replaceAssertRows(deps.db, runId, j.entryId, rows.assertRows);
  }
  return { count: judgment.entries.length, counters: judgment.counters };
}

function diffEntries(runId: number, before: { entryId: string; caseId: number; paramRowLabel: string; verdict: Verdict }[], afterEntries: { entryId: string; caseId: number; paramRowLabel: string; verdict: Verdict }[]): RejudgeDiff {
  const beforeMap = new Map(before.map((e) => [e.entryId, e]));
  const changes: RejudgeDiff['changes'] = [];
  const countersBefore = { total: 0, passed: 0, failed: 0, degraded: 0, errored: 0, skipped: 0, flaky: 0 };
  for (const b of before) countersBefore[b.verdict] += 1;
  const countersAfter = { total: 0, passed: 0, failed: 0, degraded: 0, errored: 0, skipped: 0, flaky: 0 };
  for (const a of afterEntries) {
    countersAfter[a.verdict] += 1;
    const b = beforeMap.get(a.entryId);
    if (b !== undefined && b.verdict !== a.verdict) {
      changes.push({ caseId: a.caseId, entryId: a.entryId, paramRowLabel: a.paramRowLabel, from: b.verdict, to: a.verdict });
    }
  }
  return { runId, changes, countersBefore, countersAfter };
}

export { defaultRunPolicy };
