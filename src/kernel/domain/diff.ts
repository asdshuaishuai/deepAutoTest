/**
 * RunDiff（04 §5.3）—— 两次运行的对账。与重判 preview 共用同一套 diff 思想：
 * 同一批事件两套策略（重判） vs 两批事件同一套策略（对账）。
 *
 * 排序原则：newFailures 永远排最前——修复了的和一直失败的都不是当务之急，
 * 新出现的失败才是。
 */

import type { RunDiff, RunJudgment, Verdict } from '../shared/domain.ts';
import { median, percentile } from '../shared/util.ts';

export function diffRuns(base: RunJudgment, head: RunJudgment): RunDiff {
  const baseByEntry = new Map(base.entries.map((e) => [entryKey(e.entryId), e]));
  const headByEntry = new Map(head.entries.map((e) => [entryKey(e.entryId), e]));

  const newFailures: RunDiff['newFailures'] = [];
  const fixedCases: RunDiff['fixedCases'] = [];
  const newlyFlaky: RunDiff['newlyFlaky'] = [];
  const stabilizedCases: RunDiff['stabilizedCases'] = [];
  const verdictChanged: RunDiff['verdictChanged'] = [];

  for (const [key, h] of headByEntry) {
    const b = baseByEntry.get(key);
    if (b === undefined) continue;
    const label = labelOf(b.paramRowLabel, h.paramRowLabel);

    if (h.verdict === 'failed' && b.verdict !== 'failed') {
      newFailures.push({ caseId: h.caseId, entryId: h.entryId, label, verdict: h.verdict });
    }
    if (b.verdict === 'failed' && (h.verdict === 'passed' || h.verdict === 'degraded')) {
      fixedCases.push({ caseId: h.caseId, entryId: h.entryId, label });
    }
    if (h.flaky && !b.flaky) newlyFlaky.push({ caseId: h.caseId, entryId: h.entryId, label });
    if (b.flaky && !h.flaky) stabilizedCases.push({ caseId: h.caseId, entryId: h.entryId, label });
    if (b.verdict !== h.verdict) {
      verdictChanged.push({
        caseId: h.caseId,
        entryId: h.entryId,
        paramRowLabel: label,
        from: b.verdict,
        to: h.verdict,
      });
    }
  }

  const common = [...headByEntry.values()].filter((h) => baseByEntry.has(entryKey(h.entryId)));
  const medianDeltaMs = median(common.map((h) => h.durationMs)) - median(common.map((h) => baseByEntry.get(entryKey(h.entryId))!.durationMs));
  const p95DeltaMs =
    percentile(common.map((h) => h.durationMs), 95) -
    percentile(common.map((h) => baseByEntry.get(entryKey(h.entryId))!.durationMs), 95);

  return { baseRunId: base.runId, headRunId: head.runId, newFailures, fixedCases, newlyFlaky, stabilizedCases, verdictChanged, duration: { medianDeltaMs, p95DeltaMs } };
}

function entryKey(entryId: string): string {
  return entryId;
}

function labelOf(a: string, b: string): string {
  return a === b ? a : `${a} → ${b}`;
}

export type { Verdict };
