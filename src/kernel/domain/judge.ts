/**
 * ★ 判定纯函数（04 §3）—— 基座的核心。
 *
 * verdict = reduce(events, policy)
 *   不读时钟、不读网络、不读数据库、不使用随机 —— 同一输入必然同一输出
 *   事件自足（expected/actual/severity 全在事件里，04 §2.2）
 *
 * 因此判定可穷举测试（04 §3.5），可对历史重算（re-judge），
 * 可在不重跑的前提下演进规则。
 *
 * 三层折叠（04 §3.3）：entry（含重试历史）→ case（参数行折叠）→ run（counters 投影）
 */

import {
  defaultRunPolicy,
  severityRank,
  type CaseJudgment,
  type EntryJudgment,
  type RunCounters,
  type RunEvent,
  type RunJudgment,
  type RunPolicy,
  type Severity,
  type StepErrorReason,
  type Verdict,
} from '../shared/domain.ts';
import { canonicalJson, chainEvent } from '../shared/util.ts';
import { splitEntryEvents, type EntrySplit } from './derive.ts';

export interface JudgeOptions {
  /** 期望链哈希（来自 run 行）。提供且不符 → corrupt='hash_mismatch'。 */
  expectedChainHash?: string | null;
  /** 预览重判：显式指定策略，不改事件。 */
  policyOverride?: RunPolicy;
}

export interface EntryJudgeContext {
  policy: RunPolicy;
  runCancelled: boolean;
  waivedCaseIds: Set<number>;
}

interface AttemptOutcome {
  kind: Verdict;
  failedAsserts: number;
  maxFailedSeverity: Severity | null;
  errorReason: StepErrorReason | null;
  hasObservation: boolean;
}

export function judgeRun(runId: number, events: readonly RunEvent[], opts: JudgeOptions = {}): RunJudgment {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  // ① 完整性：seq 必须从 1 起连续（04 §3.5 乱序/截断 → corrupt）
  let corrupt: RunJudgment['corrupt'] = null;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]!.seq !== i + 1) {
      corrupt = 'seq_gap';
      break;
    }
  }

  // ② 链哈希（04 §2.4）：corrupt 判定优先于策略解析
  if (corrupt === null && typeof opts.expectedChainHash === 'string') {
    let hash = '';
    for (const ev of sorted) {
      const { runId: _r, seq: _s, atMs: _a, kind: _k, entryId: _e, ...payload } = ev;
      hash = chainEvent(hash, canonicalJson(payload));
    }
    if (hash !== opts.expectedChainHash) corrupt = 'hash_mismatch';
  }

  // ③ 生效策略：run_started 快照，被 rejudged 事件覆盖（04 §5.2）
  let policy: RunPolicy | null = null;
  let runFinished = false;
  let runCancelled = false;
  let voided = false;
  const waivedCaseIds = new Set<number>();
  const overrides = new Map<number, { from: Verdict; to: Verdict }>();

  for (const ev of sorted) {
    switch (ev.kind) {
      case 'run_started':
      case 'rejudged':
        if (opts.policyOverride === undefined) policy = ev.policy;
        break;
      case 'run_finished':
        runFinished = true;
        runCancelled = ev.status === 'cancelled';
        break;
      case 'run_voided':
        voided = true;
        break;
      case 'case_waived':
        waivedCaseIds.add(ev.caseId);
        break;
      case 'case_overridden':
        overrides.set(ev.caseId, { from: ev.from, to: ev.to });
        break;
      default:
        break;
    }
  }
  if (opts.policyOverride !== undefined) policy = opts.policyOverride;

  const effectivePolicy = policy ?? defaultRunPolicy();
  const incomplete = !runFinished || policy === null;

  // ④ entry 判定
  const ctx: EntryJudgeContext = { policy: effectivePolicy, runCancelled, waivedCaseIds };
  const grouped = groupByEntry(sorted);
  const entries: EntryJudgment[] = [];
  for (const [entryId, evs] of grouped) {
    entries.push(judgeEntry(entryId, evs, ctx));
  }
  entries.sort((a, b) => a.firstSeq - b.firstSeq);

  // ⑤ case 折叠（errored > failed > flaky > degraded > skipped > passed）
  const caseMap = new Map<number, EntryJudgment[]>();
  for (const e of entries) {
    const list = caseMap.get(e.caseId);
    if (list === undefined) caseMap.set(e.caseId, [e]);
    else list.push(e);
  }
  const cases: CaseJudgment[] = [];
  for (const [caseId, list] of caseMap) {
    let verdict = foldVerdicts(list);
    const override = overrides.get(caseId);
    if (override !== undefined) {
      // 人工覆盖是人的意志而非可推导的规则：重判时保留覆盖（04 §6.3）
      verdict = override.to;
      for (const e of list) e.overriddenTo = override.to;
    }
    cases.push({
      caseId,
      verdict,
      flaky: list.some((e) => e.flaky),
      entries: list,
      executed: list.filter((e) => e.verdict !== 'skipped').length,
      total: list.length,
    });
  }
  cases.sort(
    (a, b) => Math.min(...a.entries.map((e) => e.firstSeq)) - Math.min(...b.entries.map((e) => e.firstSeq)),
  );

  // ⑥ counters：投影的投影，永远可从事件重算（P2）
  const counters: RunCounters = {
    total: cases.length,
    passed: 0,
    failed: 0,
    degraded: 0,
    errored: 0,
    skipped: 0,
    flaky: 0,
  };
  for (const c of cases) {
    counters[c.verdict] += 1;
    if (c.flaky) counters.flaky += 1;
  }

  return { runId, policy: effectivePolicy, entries, cases, counters, incomplete, corrupt, voided };
}

export function judgeEntry(entryId: string, evs: RunEvent[], ctx: EntryJudgeContext): EntryJudgment {
  const split: EntrySplit = splitEntryEvents(evs);
  const started = split.started;
  const caseId = started?.caseId ?? firstCaseId(evs) ?? 0;
  const firstSeq = evs.length > 0 ? evs[0]!.seq : 0;

  const attempts = split.attemptEvents.map((attempt) => judgeAttempt(attempt, ctx.policy));
  const last = attempts.length > 0 ? attempts[attempts.length - 1]! : null;
  const attemptsTotal = Math.max(split.finished?.attempts ?? 0, split.retryCount + 1, 1);
  const paramRowLabel = started?.paramRowLabel ?? entryId;
  const intent = started?.intent ?? null;

  // 豁免：不计入分母，单列显示（04 §6.1）。策略豁免同语义但不标 waived。
  const waived = ctx.waivedCaseIds.has(caseId);
  if (waived || ctx.policy.ignoreCaseIds.includes(caseId)) {
    return {
      entryId,
      caseId,
      paramRowLabel,
      intent,
      verdict: 'skipped',
      flaky: false,
      attempts: attemptsTotal,
      durationMs: split.finished?.durationMs ?? 0,
      failedAsserts: 0,
      firstSeq,
      waived,
      overriddenTo: null,
    };
  }

  let verdict: Verdict;
  let flaky = false;
  let failedAsserts = 0;

  if (split.finished === null) {
    // 没有终态：被取消 → skipped；否则 errored(incomplete)（04 §3.5）
    verdict = ctx.runCancelled ? 'skipped' : 'errored';
  } else if (last === null || !last.hasObservation) {
    // 有 entry_finished 但零观测 → 事实不完整
    verdict = 'errored';
  } else {
    verdict = last.kind;
    failedAsserts = last.failedAsserts;
    // flaky：一等标记位，不覆盖 verdict（04 §3.4）
    if (ctx.policy.flakyDetection.enabled && attempts.length > 1) {
      const signatures = new Set(
        attempts.map((a) => `${a.kind}:${a.errorReason ?? ''}:${a.failedAsserts > 0}`),
      );
      flaky = signatures.size > 1;
    }
  }

  return {
    entryId,
    caseId,
    paramRowLabel,
    intent,
    verdict,
    flaky,
    attempts: attemptsTotal,
    durationMs: split.finished?.durationMs ?? 0,
    failedAsserts,
    firstSeq,
    waived: false,
    overriddenTo: null,
  };
}

function judgeAttempt(attempt: RunEvent[], policy: RunPolicy): AttemptOutcome {
  let failedAsserts = 0;
  let maxFailedSeverity: Severity | null = null;
  let hasAssert = false;
  let errorReason: StepErrorReason | null = null;
  let hasObservation = false;

  for (const ev of attempt) {
    switch (ev.kind) {
      case 'assert_evaluated': {
        hasAssert = true;
        hasObservation = true;
        // info 永不参与判定（03 §2.6）
        if (!ev.passed && ev.severity !== 'info') {
          failedAsserts += 1;
          if (maxFailedSeverity === null || severityRank(ev.severity) > severityRank(maxFailedSeverity)) {
            maxFailedSeverity = ev.severity;
          }
        }
        break;
      }
      case 'response_received':
      case 'var_extracted':
      case 'ui_action':
      case 'db_checked':
        hasObservation = true;
        break;
      case 'step_errored':
        hasObservation = true;
        errorReason = ev.reason;
        break;
      default:
        break;
    }
  }

  if (errorReason !== null) {
    return { kind: 'errored', failedAsserts, maxFailedSeverity, errorReason, hasObservation };
  }
  if (maxFailedSeverity !== null && severityRank(maxFailedSeverity) >= severityRank(policy.failOnSeverity)) {
    return { kind: 'failed', failedAsserts, maxFailedSeverity, errorReason, hasObservation };
  }
  if (maxFailedSeverity !== null && severityRank(maxFailedSeverity) >= severityRank(policy.degradedOnSeverity)) {
    return { kind: 'degraded', failedAsserts, maxFailedSeverity, errorReason, hasObservation };
  }
  return { kind: 'passed', failedAsserts, maxFailedSeverity, errorReason, hasObservation: hasAssert || hasObservation };
}

function firstCaseId(evs: RunEvent[]): number | null {
  for (const ev of evs) {
    if ('caseId' in ev && typeof (ev as { caseId?: unknown }).caseId === 'number') {
      return (ev as { caseId: number }).caseId;
    }
  }
  return null;
}

function groupByEntry(events: RunEvent[]): Map<string, RunEvent[]> {
  const map = new Map<string, RunEvent[]>();
  for (const ev of events) {
    if (ev.entryId === null || ev.entryId === undefined) continue;
    const list = map.get(ev.entryId);
    if (list === undefined) map.set(ev.entryId, [ev]);
    else list.push(ev);
  }
  return map;
}

const VERDICT_RANK: Record<Verdict, number> = { passed: 0, skipped: 1, degraded: 2, failed: 4, errored: 5 };
const FLAKY_RANK = 3;

function foldVerdicts(entries: EntryJudgment[]): Verdict {
  let best: Verdict = 'skipped';
  let bestRank = -1;
  for (const e of entries) {
    let rank = VERDICT_RANK[e.verdict];
    if (e.flaky && rank < FLAKY_RANK) rank = FLAKY_RANK;
    if (rank > bestRank) {
      bestRank = rank;
      best = e.verdict;
    }
  }
  return best;
}
