/**
 * 运行时入参校验。
 *
 * 为什么不用 TS 类型就够：TypeScript 类型在运行时不存在（02 §7.1）。
 * 页面 / Agent / 未来任何传输层都是半可信输入，落库前必须校验形状。
 * 手写校验保持基座零依赖。
 */

import { KernelError } from '../shared/util.ts';
import type { RunEventInput, StepErrorReason, Verdict } from '../shared/domain.ts';

type Unknown = Record<string, unknown>;

function isObj(v: unknown): v is Unknown {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown, name: string, maxLen = 100_000): string {
  if (typeof v !== 'string' || v.length === 0) throw new KernelError('invalid_params', `${name} 必须是非空字符串`);
  if (v.length > maxLen) throw new KernelError('invalid_params', `${name} 超过最大长度 ${maxLen}`);
  return v;
}
function optStr(v: unknown, name: string, maxLen = 100_000): string | null {
  return v === undefined || v === null ? null : str(v, name, maxLen);
}
function int(v: unknown, name: string, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new KernelError('invalid_params', `${name} 必须是 [${min}, ${max}] 内的整数`);
  }
  return v;
}
function bool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') throw new KernelError('invalid_params', `${name} 必须是布尔值`);
  return v;
}
function enumOf<T extends string>(v: unknown, name: string, values: readonly T[]): T {
  if (typeof v !== 'string' || !values.includes(v as T)) {
    throw new KernelError('invalid_params', `${name} 必须是 ${values.join(' | ')} 之一`);
  }
  return v as T;
}
function strArray(v: unknown, name: string, maxItems = 1000): string[] {
  if (!Array.isArray(v) || v.length > maxItems) throw new KernelError('invalid_params', `${name} 必须是数组（≤${maxItems}）`);
  return v.map((item) => str(item, `${name}[]`, 10_000));
}

/* ─────────────────────────── RunEventInput 形状校验 ─────────────────────────── */

const VERDICTS = ['passed', 'degraded', 'failed', 'errored', 'skipped'] as const;
const SEVERITIES = ['blocker', 'critical', 'major', 'minor', 'info'] as const;
const STEP_KINDS = [
  'request', 'extract', 'assert', 'wait', 'script', 'db_check',
  'ui_navigate', 'ui_click', 'ui_fill', 'ui_press', 'ui_wait_for', 'ui_see', 'ui_screenshot',
] as const;
const STEP_REASONS = [
  'connect_failed',
  'dns_failed',
  'tls_error',
  'timed_out',
  'script_error',
  'script_timeout',
  'db_check_error',
  'host_crash',
  'env_error',
  'plan_invalid',
  'http_5xx',
  'assert_failed',
  'ui_driver_unavailable',
  'ui_navigation_failed',
  'ui_selector_not_found',
  'ui_timeout',
] as const;
const INTENTS = ['baseline', 'boundary_low', 'boundary_high', 'invalid', 'empty', 'malformed', 'extreme', null] as const;

function optSeverity(v: unknown): 'blocker' | 'critical' | 'major' | 'minor' | 'info' {
  return enumOf(v, 'severity', SEVERITIES);
}

function checkPolicy(v: unknown): void {
  if (!isObj(v)) throw new KernelError('invalid_params', 'policy 必须是对象');
  if (v['version'] !== 1) throw new KernelError('invalid_params', 'policy.version 必须是 1');
  optSeverity(v['failOnSeverity']);
  optSeverity(v['degradedOnSeverity']);
  if (!isObj(v['retry'])) throw new KernelError('invalid_params', 'policy.retry 必须是对象');
  int(v['retry']['maxAttempts'], 'policy.retry.maxAttempts', 1, 10);
  int(v['timeoutMs'], 'policy.timeoutMs', 1, 3_600_000);
  int(v['concurrency'], 'policy.concurrency', 1, 256);
  int(v['scriptTimeoutMs'], 'policy.scriptTimeoutMs', 100, 30_000);
  if (Array.isArray(v['ignoreCaseIds'])) {
    for (const id of v['ignoreCaseIds']) int(id, 'policy.ignoreCaseIds[]', 1);
  }
}

export function validateRunEventInput(input: unknown): RunEventInput {
  if (!isObj(input)) throw new KernelError('invalid_params', '事件必须是对象');
  const kind = enumOf(input['kind'], 'kind', [
    'run_started',
    'entry_started',
    'request_sent',
    'response_received',
    'assert_evaluated',
    'var_extracted',
    'step_errored',
    'retry_scheduled',
    'entry_finished',
    'run_finished',
    'note',
    'run_paused',
    'run_resumed',
    'case_waived',
    'case_overridden',
    'run_voided',
    'rejudged',
    'ui_action',
    'db_checked',
  ] as const);
  const entryId = input['entryId'] === null || input['entryId'] === undefined ? null : str(input['entryId'], 'entryId', 512);

  const p = input;
  switch (kind) {
    case 'run_started':
      checkPolicy(p['policy']);
      int(p['concurrency'], 'concurrency', 1, 256);
      int(p['seed'], 'seed', 0, Number.MAX_SAFE_INTEGER);
      break;
    case 'entry_started':
      int(p['caseId'], 'caseId', 1);
      str(p['paramRowLabel'], 'paramRowLabel', 512);
      if (p['intent'] !== null && p['intent'] !== undefined) {
        enumOf(p['intent'], 'intent', INTENTS.filter((x): x is Exclude<typeof x, null> => x !== null) as readonly Exclude<(typeof INTENTS)[number], null>[]);
      }
      break;
    case 'request_sent':
      int(p['stepSeq'], 'stepSeq', 0, 100_000);
      str(p['method'], 'method', 16);
      str(p['url'], 'url', 8192);
      strArray(p['headerNames'], 'headerNames', 100);
      break;
    case 'response_received':
      int(p['stepSeq'], 'stepSeq', 0, 100_000);
      int(p['status'], 'status', 100, 599);
      int(p['durationMs'], 'durationMs', 0, 3_600_000);
      optStr(p['bodyRef'], 'bodyRef', 128);
      optStr(p['bodySha256'], 'bodySha256', 128);
      break;
    case 'assert_evaluated':
      int(p['assertSeq'], 'assertSeq', 0, 100_000);
      int(p['stepSeq'], 'stepSeq', 0, 100_000);
      optSeverity(p['severity']);
      str(p['expected'], 'expected', 65_536);
      str(p['actual'], 'actual', 65_536);
      bool(p['passed'], 'passed');
      if (p['principleId'] !== null && p['principleId'] !== undefined) int(p['principleId'], 'principleId', 1);
      optStr(p['sourceFile'], 'sourceFile', 4096);
      if (p['sourceLine'] !== null && p['sourceLine'] !== undefined) int(p['sourceLine'], 'sourceLine', 0);
      break;
    case 'var_extracted':
      str(p['name'], 'name', 256);
      str(p['value'], 'value', 65_536);
      break;
    case 'step_errored':
      if (p['stepSeq'] !== null && p['stepSeq'] !== undefined) int(p['stepSeq'], 'stepSeq', -1, 100_000);
      if (p['stepKind'] !== null && p['stepKind'] !== undefined) enumOf(p['stepKind'], 'stepKind', STEP_KINDS);
      enumOf(p['reason'], 'reason', STEP_REASONS);
      optStr(p['detail'], 'detail', 65_536);
      break;
    case 'retry_scheduled':
      int(p['attempt'], 'attempt', 1, 10);
      enumOf(p['reason'], 'reason', STEP_REASONS);
      int(p['delayMs'], 'delayMs', 0, 600_000);
      break;
    case 'entry_finished':
      int(p['attempts'], 'attempts', 1, 10);
      int(p['durationMs'], 'durationMs', 0, 3_600_000);
      break;
    case 'run_finished':
      enumOf(p['status'], 'status', ['completed', 'cancelled', 'errored'] as const);
      break;
    case 'note':
      str(p['text'], 'text', 8192);
      str(p['by'], 'by', 256);
      break;
    case 'run_paused':
    case 'run_resumed':
      str(p['by'], 'by', 256);
      break;
    case 'case_waived':
      int(p['caseId'], 'caseId', 1);
      str(p['reason'], 'reason', 8192);
      str(p['by'], 'by', 256);
      if (p['expiresAtMs'] !== null && p['expiresAtMs'] !== undefined) int(p['expiresAtMs'], 'expiresAtMs', 0);
      break;
    case 'case_overridden':
      int(p['caseId'], 'caseId', 1);
      enumOf(p['from'], 'from', VERDICTS);
      enumOf(p['to'], 'to', VERDICTS);
      str(p['reason'], 'reason', 8192);
      str(p['by'], 'by', 256);
      break;
    case 'run_voided':
      str(p['reason'], 'reason', 8192);
      str(p['by'], 'by', 256);
      break;
    case 'rejudged':
      checkPolicy(p['policy']);
      str(p['by'], 'by', 256);
      optStr(p['note'], 'note', 8192);
      break;
    case 'ui_action':
      int(p['stepSeq'], 'stepSeq', 0, 100_000);
      enumOf(p['stepKind'], 'stepKind', STEP_KINDS);
      str(p['action'], 'action', 64);
      optStr(p['target'], 'target', 2048);
      int(p['durationMs'], 'durationMs', 0, 3_600_000);
      optStr(p['detail'], 'detail', 65_536);
      optStr(p['screenshotRef'], 'screenshotRef', 128);
      break;
    case 'db_checked':
      int(p['stepSeq'], 'stepSeq', 0, 100_000);
      str(p['connection'], 'connection', 200);
      int(p['rowCount'], 'rowCount', 0, 1_000_000_000);
      int(p['durationMs'], 'durationMs', 0, 3_600_000);
      optStr(p['firstRowSample'], 'firstRowSample', 65_536);
      break;
  }
  return input as unknown as RunEventInput;
}

export { enumOf, int, str as requireString, bool, strArray, isObj, checkPolicy };
export type { Verdict, StepErrorReason };
