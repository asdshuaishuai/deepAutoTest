/**
 * entry 事件流的切分与投影行派生（06 §2.6）。
 *
 * 关键架构性质：**live 写入与全量重建共用同一个纯函数**。
 * 因此"投影 = 事件 log 的确定函数"不是口号而是构造性事实——
 * 重建测试（tests/projection-rebuild.test.ts）逐字段比对的是同一个函数的两次调用。
 */

import type {
  AssertResultRow,
  EntryJudgment,
  RunEvent,
  StepKind,
  StepResultRow,
} from '../shared/domain.ts';

export interface EntrySplit {
  /** entry_started 的载荷；缺失（防御）时为 null。 */
  started: Extract<RunEvent, { kind: 'entry_started' }> | null;
  /** 每次尝试的事件（不含 retry_scheduled 边界与 entry_finished）。 */
  attemptEvents: RunEvent[][];
  retryCount: number;
  finished: Extract<RunEvent, { kind: 'entry_finished' }> | null;
}

export function splitEntryEvents(evs: RunEvent[]): EntrySplit {
  let started: EntrySplit['started'] = null;
  let finished: EntrySplit['finished'] = null;
  const attemptEvents: RunEvent[][] = [[]];
  let retryCount = 0;

  for (const ev of evs) {
    switch (ev.kind) {
      case 'entry_started':
        started = ev;
        break;
      case 'retry_scheduled':
        retryCount += 1;
        attemptEvents.push([]);
        break;
      case 'entry_finished':
        finished = ev;
        break;
      default:
        attemptEvents[attemptEvents.length - 1]!.push(ev);
        break;
    }
  }
  return { started, attemptEvents, retryCount, finished };
}

export interface DerivedEntryRows {
  entryJudgment: EntryJudgment;
  stepRows: Omit<StepResultRow, 'runId' | 'entryId'>[];
  assertRows: Omit<AssertResultRow, 'runId' | 'entryId'>[];
}

/**
 * 从 entry 的事件派生明细投影行。
 * step/assert 行取**末次尝试**（重试的中间观测保留在事件里，投影反映最终判定语境）。
 */
export function deriveEntryRows(entryId: string, evs: RunEvent[], judgment: EntryJudgment): DerivedEntryRows {
  const split = splitEntryEvents(evs);
  const lastAttempt = split.attemptEvents.length > 0 ? split.attemptEvents[split.attemptEvents.length - 1]! : [];

  const stepRows: Omit<StepResultRow, 'runId' | 'entryId'>[] = [];
  const assertRows: Omit<AssertResultRow, 'runId' | 'entryId'>[] = [];
  const erroredSteps = new Map<number, Extract<RunEvent, { kind: 'step_errored' }>>();
  const responseByStep = new Map<number, Extract<RunEvent, { kind: 'response_received' }>>();
  const requestByStep = new Map<number, Extract<RunEvent, { kind: 'request_sent' }>>();
  const uiByStep = new Map<number, Extract<RunEvent, { kind: 'ui_action' }>>();
  const dbByStep = new Map<number, Extract<RunEvent, { kind: 'db_checked' }>>();

  for (const ev of lastAttempt) {
    switch (ev.kind) {
      case 'request_sent':
        requestByStep.set(ev.stepSeq, ev);
        break;
      case 'ui_action':
        uiByStep.set(ev.stepSeq, ev);
        break;
      case 'db_checked': {
        // db_check 的观测 → 一行 ok 的 db_check 步骤行
        dbByStep.set(ev.stepSeq, ev);
        break;
      }
      case 'response_received':
        responseByStep.set(ev.stepSeq, ev);
        break;
      case 'step_errored':
        if (ev.stepSeq !== null) erroredSteps.set(ev.stepSeq, ev);
        break;
      case 'assert_evaluated':
        assertRows.push({
          assertSeq: ev.assertSeq,
          stepSeq: ev.stepSeq,
          severity: ev.severity,
          expected: ev.expected,
          actual: ev.actual,
          passed: ev.passed,
          principleId: ev.principleId,
          sourceFile: ev.sourceFile,
          sourceLine: ev.sourceLine,
        });
        break;
      default:
        break;
    }
  }

  const stepSeqs = new Set<number>([...requestByStep.keys(), ...responseByStep.keys(), ...erroredSteps.keys(), ...uiByStep.keys(), ...dbByStep.keys()]);
  for (const stepSeq of [...stepSeqs].sort((a, b) => a - b)) {
    const req = requestByStep.get(stepSeq);
    const res = responseByStep.get(stepSeq);
    const err = erroredSteps.get(stepSeq);
    const ui = uiByStep.get(stepSeq);
    const dbc = dbByStep.get(stepSeq);
    const kind: StepKind = err?.stepKind ?? ui?.stepKind ?? (dbc !== undefined ? 'db_check' : 'request');
    stepRows.push({
      stepSeq,
      kind,
      status: err !== undefined ? 'errored' : res !== undefined || ui !== undefined || dbc !== undefined ? 'ok' : 'skipped',
      durationMs: ui?.durationMs ?? dbc?.durationMs ?? res?.durationMs ?? 0,
      requestRef: null,
      responseRef: ui?.screenshotRef ?? res?.bodyRef ?? null,
    });
  }

  // entry 级错误（无 stepSeq，如 host_crash）落一行 status=errored 的标记行
  for (const ev of lastAttempt) {
    if (ev.kind === 'step_errored' && ev.stepSeq === null) {
      stepRows.push({
        stepSeq: -1,
        kind: ev.stepKind ?? 'request',
        status: 'errored',
        durationMs: 0,
        requestRef: null,
        responseRef: null,
      });
    }
  }

  return { entryJudgment: judgment, stepRows, assertRows };
}
