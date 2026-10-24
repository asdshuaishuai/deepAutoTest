/**
 * 自足报告导出（04 §7.3）：从事件日志生成脱离工具仍可判读的报告。
 *
 * 纪律：导出必须自带策略快照与事件计数——"通过率 92%"若不说口径与规则，
 * 等于一个无法追问的数字。三种格式全部查询期渲染（P2）。
 */

import { canonicalJson } from '../shared/util.ts';
import type {
  EntryJudgment,
  RunEvent,
  RunJudgment,
  RunRecord,
} from '../shared/domain.ts';

export type ExportFormat = 'json' | 'markdown' | 'csv';

export interface ExportInput {
  run: RunRecord;
  events: RunEvent[];
  judgment: RunJudgment;
  envName: string | null;
}

export function renderExport(format: ExportFormat, input: ExportInput): string {
  switch (format) {
    case 'json':
      return renderJson(input);
    case 'markdown':
      return renderMarkdown(input);
    case 'csv':
      return renderCsv(input);
  }
}

/* ─────────────── JSON：机器消费，跨系统对账 ─────────────── */

function renderJson(input: ExportInput): string {
  const { run, events, judgment, envName } = input;
  return canonicalJson({
    format: 'deepautotest-run-export',
    version: 1,
    exportedWithPolicy: run.policy, // ★ 策略快照（判定语境随报告走）
    integrity: { eventCount: run.eventCount, chainHash: run.chainHash }, // ★ 完整性可验证
    run: {
      id: run.id,
      status: run.status,
      voided: run.voided,
      triggeredBy: run.triggeredBy,
      env: envName,
      seed: run.seed,
      startedAtMs: run.startedAtMs,
      finishedAtMs: run.finishedAtMs,
    },
    counters: run.counters,
    passRate: {
      defaultBasis: 'excluding_errored',
      value: passRateOf(judgment, 'excluding_errored'),
      strict: passRateOf(judgment, 'strict'),
      lenient: passRateOf(judgment, 'lenient'),
    },
    cases: judgment.cases.map((c) => ({
      caseId: c.caseId,
      verdict: c.verdict,
      flaky: c.flaky,
      executed: `${c.executed}/${c.total}`,
      entries: c.entries.map((e) => ({
        entryId: e.entryId,
        label: e.paramRowLabel,
        intent: e.intent,
        verdict: e.verdict,
        flaky: e.flaky,
        waived: e.waived,
        overriddenTo: e.overriddenTo,
        attempts: e.attempts,
        durationMs: e.durationMs,
      })),
    })),
    events: events.map((e) => ({ seq: e.seq, atMs: e.atMs, kind: e.kind, entryId: e.entryId, payload: payloadOf(e) })),
  });
}

function payloadOf(ev: RunEvent): Record<string, unknown> {
  const { runId: _r, seq: _s, atMs: _a, kind: _k, entryId: _e, ...payload } = ev;
  return payload as Record<string, unknown>;
}

function passRateOf(j: RunJudgment, basis: 'strict' | 'lenient' | 'excluding_errored'): number | null {
  const c = j.counters;
  let numerator: number;
  let denominator: number;
  if (basis === 'strict') {
    numerator = c.passed;
    denominator = c.total;
  } else if (basis === 'lenient') {
    numerator = c.passed + c.degraded;
    denominator = c.total;
  } else {
    numerator = c.passed;
    denominator = c.total - c.errored;
  }
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : null;
}

/* ─────────────── Markdown：人读摘要（贴 PR / 周报） ─────────────── */

function renderMarkdown(input: ExportInput): string {
  const { run, judgment, envName, events } = input;
  const c = judgment.counters;
  const lines: string[] = [];
  lines.push(`# 运行报告 #${run.id}`);
  lines.push('');
  lines.push(`- 状态：**${run.status}**（completed ≠ 全通过）${run.voided ? ' · **已作废**' : ''}`);
  lines.push(`- 环境：${envName ?? '?'} · 触发：${run.triggeredBy} · seed=${run.seed}`);
  lines.push(`- 事件：${run.eventCount} 条${run.chainHash !== null ? ` · chainHash \`${run.chainHash.slice(0, 12)}…\`` : ''}`);
  lines.push(`- 判定策略：failOn≥${run.policy.failOnSeverity} · degradedOn≥${run.policy.degradedOnSeverity} · retry.maxAttempts=${run.policy.retry.maxAttempts}（快照随报告）`);
  lines.push(
    `- 用例：${c.total} · ✅ ${c.passed} · ⚠️ degraded ${c.degraded} · ❌ failed ${c.failed} · 🚫 errored ${c.errored} · ⏭ skipped ${c.skipped} · flaky ${c.flaky}`,
  );
  const rate = passRateOf(judgment, 'excluding_errored');
  lines.push(`- 通过率（口径：**排除 errored** = passed/(total−errored)）：**${rate === null ? 'N/A' : `${(rate * 100).toFixed(1)}%`}**`);
  lines.push('');

  const failedCases = judgment.cases.filter((x) => x.verdict === 'failed' || x.verdict === 'errored');
  if (failedCases.length > 0) {
    lines.push('## 未通过');
    lines.push('');
    lines.push('| 用例 | 判定 | 参数行 | attempts |');
    lines.push('|---|---|---|---|');
    for (const x of failedCases) {
      for (const e of x.entries) {
        if (e.verdict === 'failed' || e.verdict === 'errored') {
          lines.push(`| #${x.caseId} | ${e.verdict}${e.flaky ? ' +flaky' : ''} | ${e.paramRowLabel} | ${e.attempts} |`);
        }
      }
    }
    lines.push('');
  }

  const flaky = collectEntries(judgment.cases, (e) => e.flaky);
  if (flaky.length > 0) {
    lines.push('## 不稳定（flaky：重试历史不一致，通过也不可信）');
    lines.push('');
    for (const e of flaky) lines.push(`- #${e.caseId} ${e.paramRowLabel}（${e.attempts} 次尝试后 ${e.verdict}）`);
    lines.push('');
  }

  const waived = collectEntries(judgment.cases, (e) => e.waived);
  if (waived.length > 0) {
    lines.push('## 豁免（不计入分母）');
    lines.push('');
    for (const e of waived) lines.push(`- #${e.caseId} ${e.paramRowLabel}`);
    lines.push('');
  }

  lines.push(`---`);
  lines.push(`*由 deepAutoTest 引擎从 ${events.length} 条事件渲染；事件日志为真源，本报告可随时重算。*`);
  return lines.join('\n') + '\n';
}

function collectEntries(cases: { caseId: number; entries: EntryJudgment[] }[], pred: (e: EntryJudgment) => boolean): EntryJudgment[] {
  const out: EntryJudgment[] = [];
  for (const c of cases) for (const e of c.entries) if (pred(e)) out.push(e);
  return out;
}

/* ─────────────── CSV：表格分析 ─────────────── */

function renderCsv(input: ExportInput): string {
  const { judgment } = input;
  const lines: string[] = ['case_id,entry_id,label,intent,verdict,flaky,waived,attempts,duration_ms,failed_asserts'];
  for (const c of judgment.cases) {
    for (const e of c.entries) {
      lines.push(
        [c.caseId, e.entryId, e.paramRowLabel, e.intent ?? '', e.verdict, e.flaky ? '1' : '0', e.waived ? '1' : '0', String(e.attempts), String(e.durationMs), String(e.failedAsserts)]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return lines.join('\n') + '\n';
}

function csvCell(v: unknown): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
