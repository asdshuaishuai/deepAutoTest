/**
 * 目标取值 + 断言求值（纯函数）。
 *
 * 判定仍是 kernel/judge 的事；这里只负责把「观测到的响应」变成
 * assert_evaluated 事件所需的 actual / passed——工具问题不算被测问题，
 * 因此取值/求值自身的异常由 runner 归为 step_errored(script_error 语义)。
 */

import type { AssertOp, AssertTarget } from './plan-types.ts';

export interface ObservedResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  durationMs: number;
  parsedBody: unknown;
}

/** 按 path 取 JSON 值：`data.items[0].id`。找不到返回 undefined。 */
export function jsonPath(value: unknown, path: string): unknown {
  const tokens = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((t) => t.length > 0);
  let cur = value;
  for (const token of tokens) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[token];
  }
  return cur;
}

export function resolveTarget(target: AssertTarget, res: ObservedResponse | null): { found: boolean; value: unknown } {
  if (res === null) return { found: false, value: undefined };
  switch (target.kind) {
    case 'status':
      return { found: true, value: res.status };
    case 'header': {
      const key = Object.keys(res.headers).find((k) => k.toLowerCase() === target.name.toLowerCase());
      return key === undefined ? { found: false, value: undefined } : { found: true, value: res.headers[key] };
    }
    case 'body_json': {
      const v = jsonPath(res.parsedBody, target.path);
      return v === undefined ? { found: false, value: undefined } : { found: true, value: v };
    }
    case 'duration_ms':
      return { found: true, value: res.durationMs };
  }
}

export interface AssertEvaluation {
  passed: boolean;
  actual: string;
}

/**
 * 仅纯十进制字面量（trim 后）才参与数值比较。
 * 语义收紧说明（相对旧实现 Number() 全量强转）：'0x10' / '1e3' / 'Infinity'
 * 等不再被当作数值，一律走字符串比较。
 */
const DECIMAL_LITERAL = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;

function numeric(v: string): number | null {
  const s = v.trim();
  return DECIMAL_LITERAL.test(s) ? Number(s) : null;
}

/** eq 的共享判定。ne = 对它取反，保证 eq/ne 对同一对操作数恰好一真一假。 */
function compareEq(actual: string, expected: string | undefined): AssertEvaluation {
  const a = numeric(actual);
  const b = numeric(expected ?? '');
  if (a !== null && b !== null) return { passed: a === b, actual };
  return { passed: actual === expected, actual };
}

export function evaluateAssert(op: AssertOp, expected: string | undefined, actualValue: unknown, found: boolean): AssertEvaluation {
  const actual = stringify(actualValue);

  switch (op) {
    case 'exists':
      return { passed: found && actualValue !== null && actualValue !== undefined, actual };
    case 'not_exists':
      return { passed: !found || actualValue === null || actualValue === undefined, actual };
    case 'type_is': {
      const t = typeof actualValue;
      const isArr = Array.isArray(actualValue);
      const type = actualValue === null ? 'null' : isArr ? 'array' : t === 'object' ? 'object' : t;
      return { passed: type === expected, actual: type };
    }
    case 'eq':
      return compareEq(actual, expected);
    case 'ne':
      return { passed: !compareEq(actual, expected).passed, actual };
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const a = numeric(actual);
      const b = numeric(expected ?? '');
      if (a === null || b === null) return { passed: false, actual };
      const pass = op === 'lt' ? a < b : op === 'lte' ? a <= b : op === 'gt' ? a > b : a >= b;
      return { passed: pass, actual };
    }
    case 'contains':
      return { passed: found && actual.includes(expected ?? ''), actual };
    case 'not_contains':
      return { passed: !found || !actual.includes(expected ?? ''), actual };
    case 'matches': {
      if (expected === undefined) return { passed: false, actual };
      try {
        return { passed: new RegExp(expected).test(actual), actual };
      } catch {
        return { passed: false, actual };
      }
    }
  }
}

function stringify(v: unknown): string {
  if (v === undefined) return '∅';
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
