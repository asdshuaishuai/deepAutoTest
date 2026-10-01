/**
 * ScriptedFxDriver —— 进程内确定性驱动（测试与无凭据演示模式）。
 *
 * 与真驱动的同一契约（FxDriver）；工具桥直接调 executeTool 回调。
 * 脚本化的目的：不依赖外部凭据即可验证 manager 全链路（turn/工具/落库/checkpoint）。
 * 真实链路由 LibFxDriver 承担（W1 已验证加载与失败形态）。
 */

import { KernelError } from '../kernel/shared/util.ts';
import type { FxAgentSession, FxDriver, FxCreateOptions, FxStreamEvent, FxTurnResult } from './fx-driver.ts';

export interface ScriptedTurn {
  /** 依序产生的事件（text_delta / tool_start / tool_result）。 */
  events: FxStreamEvent[];
  result: FxTurnResult;
  /** turn 结束后的 checkpoint 内容（缺省不产生）。 */
  checkpoint?: Uint8Array;
  /** prompt 收到的输入（供断言）。 */
  receivedInput?: string;
}

export class ScriptedFxDriver implements FxDriver {
  readonly createdSessions: { instructions: string; checkpoint: Uint8Array | undefined }[] = [];
  private readonly turns: ScriptedTurn[];
  private readonly opts: { available?: boolean; reason?: string; backend?: string };
  private turnIndex = 0;

  constructor(turns: ScriptedTurn[], opts: { available?: boolean; reason?: string; backend?: string } = {}) {
    this.turns = turns;
    this.opts = opts;
  }

  available(): boolean {
    return this.opts.available ?? true;
  }

  unavailableReason(): string {
    return this.opts.reason ?? 'scripted unavailable';
  }

  async probe(): Promise<{ backend: string; reason: string | null }> {
    if (!(this.opts.available ?? true)) {
      return { backend: 'unavailable', reason: this.opts.reason ?? 'scripted unavailable' };
    }
    return { backend: this.opts.backend ?? 'scripted', reason: null };
  }

  async create(options: FxCreateOptions): Promise<FxAgentSession> {
    this.createdSessions.push({ instructions: options.instructions, checkpoint: options.checkpoint });
    const driver = this;
    const session: FxAgentSession = {
      prompt(input: string) {
        const turn = driver.turns[driver.turnIndex];
        driver.turnIndex += 1;
        if (turn === undefined) {
          const result: FxTurnResult = { stopReason: 'end_turn' };
          return {
            events: (async function* () {})(),
            result: Promise.resolve(result),
          };
        }
        turn.receivedInput = input;
        const events = (async function* () {
          for (const ev of turn.events) yield ev;
        })();
        return { events, result: Promise.resolve(turn.result) };
      },
      async checkpoint() {
        const turn = driver.turns[driver.turnIndex - 1];
        if (turn === undefined || turn.checkpoint === undefined) {
          throw new KernelError('fx_turn_failed', '脚本未提供 checkpoint');
        }
        return turn.checkpoint;
      },
      close: async () => {},
    };
    return session;
  }

  private lastTurn(): (typeof this.turns)[number] | undefined {
    return this.turns[this.turnIndex - 1];
  }
}
