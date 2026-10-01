/**
 * 运行与事件仓储。
 * run_event 的写入只经 domain/eventlog（seq/atMs/脱敏/投影同事务在那里保证）；
 * 本文件只提供行级读写原语与读取查询。
 */

import type { Db } from '../db.ts';
import { KernelError, canonicalJson, chainEvent } from '../../shared/util.ts';
import type { ProjectScope } from '../../shared/ids.ts';
import type {
  AssertResultRow,
  EntryJudgment,
  ProgressSummary,
  RunCounters,
  RunEvent,
  RunEventInput,
  RunPolicy,
  RunRecord,
  RunStatus,
  StepResultRow,
} from '../../shared/domain.ts';

type RunRow = {
  id: number;
  project_id: number;
  env_id: number;
  policy_json: string;
  seed: number;
  status: string;
  triggered_by: string;
  started_at_ms: number;
  finished_at_ms: number | null;
  event_count: number;
  chain_hash: string | null;
  counters_json: string | null;
  voided: number;
};

export interface BeginRunInput {
  envId: number;
  policy: RunPolicy;
  seed: number;
  triggeredBy: RunRecord['triggeredBy'];
}

export function insertRun(db: Db, scope: ProjectScope, input: BeginRunInput, nowMs: number): number {
  const envOk = db
    .prepare('SELECT 1 FROM env WHERE id = ? AND project_id = ?')
    .get(input.envId, scope.projectId);
  if (envOk === undefined) throw new KernelError('not_found', `环境 ${input.envId} 不在当前项目内`);
  const r = db
    .prepare(
      `INSERT INTO run (project_id, env_id, policy_json, seed, status, triggered_by, started_at_ms, event_count, voided)
       VALUES (?, ?, ?, ?, 'running', ?, ?, 0, 0)`,
    )
    .run(scope.projectId, input.envId, canonicalJson(input.policy), input.seed, input.triggeredBy, nowMs);
  return Number(r.lastInsertRowid);
}

export function getRun(db: Db, scope: ProjectScope, runId: number): RunRecord | undefined {
  const row = db
    .prepare('SELECT * FROM run WHERE id = ? AND project_id = ?')
    .get(runId, scope.projectId) as RunRow | undefined;
  return row === undefined ? undefined : toRun(row);
}

export function listRuns(db: Db, scope: ProjectScope, limit: number): RunRecord[] {
  const rows = db
    .prepare('SELECT * FROM run WHERE project_id = ? ORDER BY started_at_ms DESC, id DESC LIMIT ?')
    .all(scope.projectId, limit) as RunRow[];
  return rows.map(toRun);
}

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    envId: row.env_id,
    policy: JSON.parse(row.policy_json) as RunPolicy,
    seed: row.seed,
    status: row.status as RunStatus,
    triggeredBy: row.triggered_by as RunRecord['triggeredBy'],
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms,
    eventCount: row.event_count,
    chainHash: row.chain_hash,
    counters: row.counters_json === null ? null : (JSON.parse(row.counters_json) as RunCounters),
    voided: row.voided === 1,
  };
}

/* ─────────────────────────── 事件原语 ─────────────────────────── */

type EventRow = {
  run_id: number;
  seq: number;
  at_ms: number;
  kind: string;
  entry_id: string | null;
  case_id: number | null;
  payload: string;
};

export function readEvents(db: Db, runId: number, sinceSeq = 0, limit = 10_000): RunEvent[] {
  const rows = db
    .prepare('SELECT * FROM run_event WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
    .all(runId, sinceSeq, limit) as EventRow[];
  return rows.map(toEvent);
}

export function readEntryEvents(db: Db, runId: number, entryId: string): RunEvent[] {
  const rows = db
    .prepare('SELECT * FROM run_event WHERE run_id = ? AND entry_id = ? ORDER BY seq')
    .all(runId, entryId) as EventRow[];
  return rows.map(toEvent);
}

function toEvent(row: EventRow): RunEvent {
  return {
    runId: row.run_id,
    seq: row.seq,
    atMs: row.at_ms,
    entryId: row.entry_id,
    ...(JSON.parse(row.payload) as object),
    kind: row.kind as RunEvent['kind'],
  } as RunEvent;
}

export function readEventCount(db: Db, runId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM run_event WHERE run_id = ?').get(runId) as { n: number };
  return row.n;
}

/** 从库中事件重算链哈希（完整性校验，04 §2.4）。 */
export function recomputeChainHash(db: Db, runId: number): { hash: string; count: number; contiguous: boolean } {
  const rows = db
    .prepare('SELECT seq, payload FROM run_event WHERE run_id = ? ORDER BY seq')
    .all(runId) as { seq: number; payload: string }[];
  let hash = '';
  let expected = 1;
  let contiguous = true;
  for (const row of rows) {
    if (row.seq !== expected) contiguous = false;
    expected = row.seq + 1;
    hash = chainEvent(hash, canonicalJson(JSON.parse(row.payload)));
  }
  return { hash, count: rows.length, contiguous };
}

export function writeEventRow(db: Db, ev: RunEvent): void {
  // 存储的 payload 只含载荷字段（不含 runId/seq/atMs/kind/entryId）——链哈希对这部分规范化
  const { runId: _r, seq: _s, atMs: _a, kind: _k, entryId: _e, ...payload } = ev;
  const caseId = (payload as { caseId?: number | null }).caseId ?? null;
  db.prepare(
    'INSERT INTO run_event (run_id, seq, at_ms, kind, entry_id, case_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(ev.runId, ev.seq, ev.atMs, ev.kind, ev.entryId ?? null, caseId, canonicalJson(payload));
}

/* ─────────────────────────── 投影原语 ─────────────────────────── */

export function upsertEntryProjection(db: Db, runId: number, j: EntryJudgment): void {
  db.prepare(
    `INSERT INTO case_result (run_id, entry_id, case_id, param_row_label, intent, verdict, flaky, waived,
                              overridden_to, duration_ms, attempts, failed_asserts, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, entry_id) DO UPDATE SET
       verdict = excluded.verdict, flaky = excluded.flaky, waived = excluded.waived,
       overridden_to = excluded.overridden_to, duration_ms = excluded.duration_ms,
       attempts = excluded.attempts, failed_asserts = excluded.failed_asserts`,
  ).run(
    runId,
    j.entryId,
    j.caseId,
    j.paramRowLabel,
    j.intent,
    j.verdict,
    j.flaky ? 1 : 0,
    j.waived ? 1 : 0,
    j.overriddenTo,
    j.durationMs,
    j.attempts,
    j.failedAsserts,
    j.firstSeq,
  );
}

export function replaceStepRows(db: Db, runId: number, entryId: string, rows: Omit<StepResultRow, 'runId' | 'entryId'>[]): void {
  db.prepare('DELETE FROM step_result WHERE run_id = ? AND entry_id = ?').run(runId, entryId);
  const stmt = db.prepare(
    `INSERT INTO step_result (run_id, entry_id, step_seq, kind, status, duration_ms, request_ref, response_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    stmt.run(runId, entryId, row.stepSeq, row.kind, row.status, row.durationMs, row.requestRef, row.responseRef);
  }
}

export function replaceAssertRows(db: Db, runId: number, entryId: string, rows: Omit<AssertResultRow, 'runId' | 'entryId'>[]): void {
  db.prepare('DELETE FROM assert_result WHERE run_id = ? AND entry_id = ?').run(runId, entryId);
  const stmt = db.prepare(
    `INSERT INTO assert_result (run_id, entry_id, assert_seq, step_seq, severity, expected, actual, passed,
                                principle_id, source_file, source_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    stmt.run(
      runId,
      entryId,
      row.assertSeq,
      row.stepSeq,
      row.severity,
      row.expected,
      row.actual,
      row.passed ? 1 : 0,
      row.principleId,
      row.sourceFile,
      row.sourceLine,
    );
  }
}

type CaseResultRow = {
  run_id: number;
  entry_id: string;
  case_id: number;
  param_row_label: string;
  intent: string | null;
  verdict: string;
  flaky: number;
  waived: number;
  overridden_to: string | null;
  duration_ms: number;
  attempts: number;
  failed_asserts: number;
  seq: number;
};

export function readCaseResultRows(db: Db, runId: number): EntryJudgment[] {
  const rows = db
    .prepare('SELECT * FROM case_result WHERE run_id = ? ORDER BY seq')
    .all(runId) as CaseResultRow[];
  return rows.map((row) => ({
    entryId: row.entry_id,
    caseId: row.case_id,
    paramRowLabel: row.param_row_label,
    intent: row.intent as EntryJudgment['intent'],
    verdict: row.verdict as EntryJudgment['verdict'],
    flaky: row.flaky === 1,
    waived: row.waived === 1,
    overriddenTo: row.overridden_to as EntryJudgment['overriddenTo'],
    durationMs: row.duration_ms,
    attempts: row.attempts,
    failedAsserts: row.failed_asserts,
    firstSeq: row.seq,
  }));
}

export function readStepRows(db: Db, runId: number): StepResultRow[] {
  const rows = db
    .prepare('SELECT * FROM step_result WHERE run_id = ? ORDER BY entry_id, step_seq')
    .all(runId) as { run_id: number; entry_id: string; step_seq: number; kind: string; status: string; duration_ms: number; request_ref: string | null; response_ref: string | null }[];
  return rows.map((row) => ({
    runId: row.run_id,
    entryId: row.entry_id,
    stepSeq: row.step_seq,
    kind: row.kind as StepResultRow['kind'],
    status: row.status as StepResultRow['status'],
    durationMs: row.duration_ms,
    requestRef: row.request_ref,
    responseRef: row.response_ref,
  }));
}

export function readAssertRows(db: Db, runId: number): AssertResultRow[] {
  const rows = db
    .prepare('SELECT * FROM assert_result WHERE run_id = ? ORDER BY entry_id, assert_seq')
    .all(runId) as { run_id: number; entry_id: string; assert_seq: number; step_seq: number; severity: string; expected: string; actual: string; passed: number; principle_id: number | null; source_file: string | null; source_line: number | null }[];
  return rows.map((row) => ({
    runId: row.run_id,
    entryId: row.entry_id,
    assertSeq: row.assert_seq,
    stepSeq: row.step_seq,
    severity: row.severity as AssertResultRow['severity'],
    expected: row.expected,
    actual: row.actual,
    passed: row.passed === 1,
    principleId: row.principle_id,
    sourceFile: row.source_file,
    sourceLine: row.source_line,
  }));
}

export function deleteProjections(db: Db, runId: number): void {
  db.prepare('DELETE FROM case_result WHERE run_id = ?').run(runId);
  db.prepare('DELETE FROM step_result WHERE run_id = ?').run(runId);
  db.prepare('DELETE FROM assert_result WHERE run_id = ?').run(runId);
}

/* ─────────────────────────── run 行终态 ─────────────────────────── */

export interface FinalizeRunInput {
  status: RunStatus;
  finishedAtMs: number;
  eventCount: number;
  chainHash: string;
  counters: RunCounters | null;
}

export function finalizeRun(db: Db, runId: number, input: FinalizeRunInput): void {
  db.prepare(
    `UPDATE run SET status = ?, finished_at_ms = ?, event_count = ?, chain_hash = ?, counters_json = ? WHERE id = ?`,
  ).run(
    input.status,
    input.finishedAtMs,
    input.eventCount,
    input.chainHash,
    input.counters === null ? null : canonicalJson(input.counters),
    runId,
  );
}

export function setRunVoided(db: Db, runId: number): void {
  db.prepare('UPDATE run SET voided = 1 WHERE id = ?').run(runId);
}

/* ─────────────────────────── 派生查询（P2：查询期算） ─────────────────────────── */

export function progressSummary(db: Db, runId: number): ProgressSummary {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS done,
              SUM(CASE WHEN verdict = 'passed'   THEN 1 ELSE 0 END) AS passed,
              SUM(CASE WHEN verdict = 'failed'   THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN verdict = 'errored'  THEN 1 ELSE 0 END) AS errored,
              SUM(CASE WHEN verdict = 'degraded' THEN 1 ELSE 0 END) AS degraded,
              SUM(CASE WHEN flaky = 1            THEN 1 ELSE 0 END) AS flaky,
              SUM(CASE WHEN verdict = 'skipped'  THEN 1 ELSE 0 END) AS skipped
       FROM case_result WHERE run_id = ?`,
    )
    .get(runId) as {
    done: number;
    passed: number | null;
    failed: number | null;
    errored: number | null;
    degraded: number | null;
    flaky: number | null;
    skipped: number | null;
  };
  return {
    doneEntries: row.done,
    passed: row.passed ?? 0,
    failed: row.failed ?? 0,
    errored: row.errored ?? 0,
    degraded: row.degraded ?? 0,
    flaky: row.flaky ?? 0,
    skipped: row.skipped ?? 0,
  };
}
