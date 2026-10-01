/**
 * 无依赖的小工具。基座运行时零依赖（仅 node:sqlite），这些工具保持同样克制。
 */

import { createHash } from 'node:crypto';

/** 键排序的规范化 JSON —— chainHash 与一切"同一输入同一输出"的基础。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = sortValue(obj[key]);
  return out;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 事件链哈希（04 §2.4）：hash_0 = ''（约定）；hash_n = sha256(hash_{n-1} + '\n' + canonicalJson(event_n))。
 * 非密码学防篡改，威胁模型是误操作与意外截断——让"日志是否完整"变成可回答的问题。
 */
export function chainEvent(prevHash: string, canonicalEvent: string): string {
  return sha256Hex(prevHash + '\n' + canonicalEvent);
}

/**
 * 时钟注入：判定层只读事件（04 §3.2），但写入层需要 atMs（墙钟）。
 * 测试注入假时钟保证可复现；生产注入真实时钟。
 */
export interface Clock {
  nowMs(): number;
}

export const realClock: Clock = { nowMs: () => Date.now() };

export function assertNever(x: never): never {
  throw new Error(`assert_never:${String(x)}`);
}

/** 基座统一错误：封闭 code + 人类可读 message。传输层（未来的 RPC）原样映射。 */
export class KernelError extends Error {
  readonly code: string;
  readonly detail?: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'KernelError';
    this.code = code;
    this.detail = detail;
  }
}

/** 深拷贝 + 冻结（事件快照防外部引用被改动）。 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}
