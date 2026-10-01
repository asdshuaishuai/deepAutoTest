/**
 * Agent 子进程宿主：libfx 唯一运行地（W1：子进程路径成立）。
 *
 * stdio JSON lines。工具调用经 tool_call/tool_result 桥回父进程
 * （kernel 与 pid 绑定都在父进程——子进程崩溃不伤数据）。
 *
 * 运行：node src/agent/host.ts [--probe]
 * 依赖：libfx（optionalDependency）。不可加载时 exit(3) 并输出原因。
 */

import { createRequire } from 'node:module';
import { stdin, stdout, exit } from 'node:process';

interface Msg {
  t: string;
  [k: string]: unknown;
}

function emit(msg: Msg): void {
  stdout.write(JSON.stringify(msg) + '\n');
}

function loadLibfx(): ReturnType<typeof createRequire> {
  try {
    const req = createRequire(import.meta.url);
    return req('libfx') as never;
  } catch (err) {
    emit({ t: 'error', message: `libfx 加载失败：${String((err as Error).message).split('\n')[0]}` });
    exit(3);
  }
}

async function main(): Promise<void> {
  const fx = loadLibfx() as unknown as {
    getBackendInfo(o: { surface: string; backend: string }): Promise<{ backend: string; reason: string | null; attempts?: { available: boolean; reason: string | null }[] }>;
    createFxAgent(o: Record<string, unknown>): Promise<{ prompt(input: string): { events: AsyncIterable<Record<string, unknown>>; result: Promise<Record<string, unknown>> }; checkpoint(): Promise<Uint8Array>; close(): Promise<void> }>;
  };

  // --probe：只探测后端，不读凭据不发请求（07 §1.3）
  if (process.argv.includes('--probe')) {
    const info = await fx.getBackendInfo({ surface: 'agent', backend: 'auto' });
    const failed = info.attempts?.find((a: { available: boolean; reason: string | null }) => !a.available);
    emit({ t: 'probe', backend: info.backend, reason: failed?.reason ?? null });
    exit(0);
  }

  let agent: Awaited<ReturnType<typeof fx.createFxAgent>> | null = null;

  for await (const line of stdin) {
    let msg: Msg;
    try {
      msg = JSON.parse(String(line)) as Msg;
    } catch {
      continue;
    }
    switch (msg['t']) {
      case 'create': {
        try {
          const tools = (msg['tools'] as unknown[] | undefined) ?? [];
          agent = await fx.createFxAgent({
            apiKey: msg['apiKey'],
            model: msg['model'],
            instructions: msg['instructions'],
            tools,
            ...(typeof msg['checkpointBase64'] === 'string' ? { checkpoint: new Uint8Array(Buffer.from(msg['checkpointBase64'] as string, 'base64')) } : {}),
          });
          emit({ t: 'ready' });
        } catch (err) {
          emit({ t: 'error', message: String((err as Error).message) });
          exit(4);
        }
        break;
      }
      case 'prompt': {
        if (agent === null) {
          emit({ t: 'error', message: 'session not created' });
          break;
        }
        void (async () => {
          try {
            const turn = agent!.prompt(String(msg['input'] ?? ''));
            for await (const ev of turn.events) {
              const e = ev as { type?: string; text?: string; name?: string; ok?: boolean };
              if (e.type === 'text_delta') emit({ t: 'event', type: 'text_delta', text: e.text ?? '' });
              else if (e.type === 'tool_start') emit({ t: 'event', type: 'tool_start', name: e.name });
              else if (e.type === 'tool_result') emit({ t: 'event', type: 'tool_result', name: e.name, ok: e.ok ?? true });
              // libfx 的工具桥：本地 tools 数组为空（工具桥走 libfx 内置 client tool 形态时）
              else if (e.type !== undefined) emit({ t: 'event', type: String(e.type), name: e.name, ok: e.ok });
            }
            const result = (await turn.result) as { stopReason?: string; usage?: { input?: number; output?: number } };
            emit({ t: 'result', stopReason: result.stopReason ?? null, tokensIn: result.usage?.input, tokensOut: result.usage?.output });
          } catch (err) {
            emit({ t: 'error', message: String((err as Error).message) });
          }
        })();
        break;
      }
      case 'checkpoint': {
        if (agent === null) {
          emit({ t: 'error', message: 'session not created' });
          break;
        }
        try {
          const cp = await agent.checkpoint();
          emit({ t: 'checkpoint', base64: Buffer.from(cp).toString('base64') });
        } catch (err) {
          emit({ t: 'error', message: String((err as Error).message) });
        }
        break;
      }
      case 'close':
        await agent?.close().catch(() => {});
        exit(0);
        break;
      default:
        break;
    }
  }
}

main().catch((err) => {
  emit({ t: 'error', message: String((err as Error).message) });
  exit(1);
});
