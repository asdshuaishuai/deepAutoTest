/**
 * script 步骤沙箱（03 §5.4 / 08 §6）。
 *
 * 诚实声明（与设计一致）：node:vm **不是安全边界**——它的作用是防误用
 * （脚本不小心 require('fs')）、限资源（超时）、提供干净求值环境。
 * 对手模型下的逃逸防御属于 M6（独立进程 + seccomp）。
 *
 * 能力边界：只读 response / vars + 纯计算；无 require / process / 网络 / 文件 / 定时器。
 * 超时 → script_timeout（判 errored，不是 failed：脚本坏了 ≠ 被测错了）。
 */

import vm from 'node:vm';
import type { ObservedResponse } from './evaluate.ts';

export interface SandboxInput {
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown; // 已解析的 JSON（若可解析），否则原始文本
    bodyText: string;
    durationMs: number;
  };
  vars: Record<string, string>;
}

export type ScriptOutcome =
  | { ok: true; returned: unknown }
  | { ok: false; reason: 'script_timeout' | 'script_error'; detail: string };

export function runScript(code: string, input: SandboxInput, timeoutMs: number): ScriptOutcome {
  const sandbox: Record<string, unknown> = {
    response: input.response,
    vars: input.vars,
    // 白名单纯量工具（无宿主 IO）
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Date,
    isNaN,
    parseInt,
    parseFloat,
  };
  try {
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    const returned = vm.runInContext(`(function(){ "use strict";\n${code}\n})()`, context, {
      timeout: timeoutMs,
      displayErrors: true,
    });
    return { ok: true, returned };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { message?: string; code?: string };
    if (e !== null && typeof e === 'object' && e.message !== undefined && /timed out|Script execution timed out/i.test(e.message)) {
      return { ok: false, reason: 'script_timeout', detail: `超过 ${timeoutMs}ms 被强制终止` };
    }
    return { ok: false, reason: 'script_error', detail: String(e.message ?? e).slice(0, 4000) };
  }
}
