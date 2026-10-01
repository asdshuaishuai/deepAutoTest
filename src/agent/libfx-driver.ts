/**
 * LibFxDriver —— spawn 子进程跑 libfx（W1 已验证子进程路径成立）。
 *
 * stdio 协议（JSON lines，07 §1.3 的 4 命令族 + 工具桥）：
 *   父→子: {t:'create'|'tool_result'|'close'}
 *   子→父: {t:'ready'|'event'|'result'|'tool_call'|'checkpoint'|'error'}
 *
 * 子进程崩溃不影响调用方：spawn error / 非零退出 → 会话错误（结果已在库）。
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { KernelError } from '../kernel/shared/util.ts';
import type { FxAgentSession, FxDriver, FxCreateOptions, FxStreamEvent, FxTurnResult } from './fx-driver.ts';

const require = createRequire(import.meta.url);

function hostScriptPath(): string {
  // 开发态：TS 经 node strip-only 直接跑；打包态：编译后的 js
  const here = new URL('.', import.meta.url).pathname;
  return join(here, 'host.ts');
}

export class LibFxDriver implements FxDriver {
  private loadError: string | null = null;

  available(): boolean {
    try {
      require.resolve('libfx');
      return true;
    } catch (err) {
      this.loadError = `libfx 未安装或不可加载：${String((err as Error).message).split('\n')[0]}`;
      void err;
      return false;
    }
  }

  unavailableReason(): string {
    return this.loadError ?? 'libfx 不可用';
  }

  async probe(): Promise<{ backend: string; reason: string | null }> {
    const child = spawn(process.execPath, [hostScriptPath(), '--probe'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await new Promise<{ backend: string; reason: string | null }>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      child.on('error', reject);
      child.on('exit', (code) => {
        try {
          resolve(JSON.parse(out.trim().split('\n').pop() ?? '{}'));
        } catch {
          reject(new KernelError('agent_probe_failed', `探测子进程退出（code=${String(code)}）：${out.slice(0, 200)}`));
        }
      });
    });
    child.kill();
    return result;
  }

  async create(options: FxCreateOptions): Promise<FxAgentSession> {
    const child = spawn(process.execPath, [hostScriptPath()], { stdio: ['pipe', 'pipe', 'pipe'] });
    const send = (msg: unknown): void => {
      child.stdin.write(JSON.stringify(msg) + '\n');
    };

    const waiters = new Map<number, { resolve: (v: { ok: boolean; data?: unknown; error?: string }) => void }>();
    let eventSink: ((ev: FxStreamEvent) => void) | null = null;
    let resultResolve: ((r: FxTurnResult) => void) | null = null;
    let fail: ((err: Error) => void) | null = null;

    child.on('error', (err) => fail?.(new KernelError('agent_crashed', `Agent 子进程错误：${String(err.message)}`)));
    child.on('exit', (code) => {
      if (code !== null && code !== 0) fail?.(new KernelError('agent_crashed', `Agent 子进程退出（code=${String(code)}）——已提交的对话历史都在库中`));
    });

    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim() === '') continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        switch (msg['t']) {
          case 'event':
            eventSink?.(msg as unknown as FxStreamEvent);
            break;
          case 'result':
            resultResolve?.({ stopReason: (msg['stopReason'] as string | null) ?? null, tokensIn: (msg['tokensIn'] as number | null) ?? null, tokensOut: (msg['tokensOut'] as number | null) ?? null });
            break;
          case 'tool_call': {
            const id = msg['id'] as number;
            options
              .executeTool(msg['name'] as string, (msg['args'] ?? {}) as Record<string, unknown>)
              .then((outcome) => {
                send({ t: 'tool_result', id, ...(outcome.ok ? { ok: true, data: outcome.data } : { ok: false, error: `${outcome.code}: ${outcome.message}` }) });
              })
              .catch((err: Error) => send({ t: 'tool_result', id, ok: false, error: String(err.message) }));
            break;
          }
          case 'error':
            fail?.(new KernelError('fx_turn_failed', String(msg['message'] ?? 'agent error')));
            break;
          default:
            break;
        }
      }
    });

    // 创建会话（等待 ready）
    await new Promise<void>((resolve, reject) => {
      fail = reject;
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg['t'] === 'ready') {
            child.stdout.off('data', onData);
            resolve();
            return;
          }
          if (msg['t'] === 'error') {
            child.stdout.off('data', onData);
            reject(new KernelError('fx_backend_unavailable', String(msg['message'])));
            return;
          }
        }
      };
      child.stdout.on('data', onData);
      send({
        t: 'create',
        apiKey: options.apiKey,
        model: options.model,
        instructions: options.instructions,
        ...(options.checkpoint === undefined ? {} : { checkpointBase64: Buffer.from(options.checkpoint).toString('base64') }),
      });
    });
    void waiters;

    return {
      prompt(input: string) {
        return {
          events: {
            [Symbol.asyncIterator](): AsyncIterator<FxStreamEvent> {
              const queue: FxStreamEvent[] = [];
              let wake: (() => void) | null = null;
              let done = false;
              eventSink = (ev) => {
                queue.push(ev);
                wake?.();
              };
              resultResolve = (r) => {
                void r;
                done = true;
                wake?.();
              };
              fail = (err) => {
                done = true;
                void err;
                wake?.();
              };
              send({ t: 'prompt', input });
              return {
                next(): Promise<IteratorResult<FxStreamEvent>> {
                  if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
                  if (done) return Promise.resolve({ value: undefined, done: true });
                  return new Promise((resolve) => {
                    wake = () => {
                      wake = null;
                      if (queue.length > 0) resolve({ value: queue.shift()!, done: false });
                      else resolve({ value: undefined, done: true });
                    };
                  });
                },
              };
            },
          },
          result: new Promise<FxTurnResult>((resolve, reject) => {
            resultResolve = resolve;
            fail = reject;
            // result 由子进程的 result 消息 resolve；失败经 fail 拒绝
          }),
        };
      },
      async checkpoint() {
        const cp = await new Promise<Uint8Array>((resolve, reject) => {
          const onData = (chunk: Buffer): void => {
            buffer += chunk.toString();
            const idx = buffer.indexOf('\n');
            if (idx === -1) return;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            child.stdout.off('data', onData);
            const msg = JSON.parse(line) as { t: string; base64?: string; message?: string };
            if (msg.t === 'checkpoint' && msg.base64 !== undefined) resolve(new Uint8Array(Buffer.from(msg.base64, 'base64')));
            else reject(new KernelError('fx_turn_failed', msg.message ?? 'checkpoint 不可用'));
          };
          child.stdout.on('data', onData);
          send({ t: 'checkpoint' });
        });
        return cp;
      },
      async close() {
        send({ t: 'close' });
        child.stdin.end();
        await new Promise<void>((resolve) => child.on('exit', () => resolve()));
      },
    };
  }
}
