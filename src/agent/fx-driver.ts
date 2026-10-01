/**
 * FxDriver 抽象 —— Agent 层对 libfx 的唯一依赖面。
 *
 * 两个实现：
 *  - LibFxDriver（host.ts）：spawn 子进程跑 libfx（W1 已验证），stdio 4 命令协议（07 §1.3）
 *  - ScriptedFxDriver（测试）：进程内确定性脚本——工具桥直接走回调，验证 manager 全链路
 *
 * 降级纪律（07 §1.4）：驱动不可用 = Agent 功能不可用，其余功能全部可用。
 */

export interface FxStreamEvent {
  type: 'text_delta' | 'tool_start' | 'tool_result';
  text?: string;
  name?: string;
  ok?: boolean;
}

export interface FxTurnResult {
  stopReason: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

export type FxToolOutcome = { ok: true; data: unknown } | { ok: false; code: string; message: string };

export interface FxAgentSession {
  prompt(input: string): { events: AsyncIterable<FxStreamEvent>; result: Promise<FxTurnResult> };
  /** 仅空闲时可调用（07 §2.3）。 */
  checkpoint(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface FxCreateOptions {
  apiKey: string;
  model: string;
  instructions: string;
  checkpoint?: Uint8Array;
  /** 工具执行桥：manager 持有 kernel 与 pid 绑定，驱动只传名字与参数。 */
  executeTool(name: string, args: Record<string, unknown>): Promise<FxToolOutcome>;
}

export interface FxDriver {
  available(): boolean;
  unavailableReason(): string;
  /** 后端探测（不读凭据不发请求，07 §1.3）。 */
  probe(): Promise<{ backend: string; reason: string | null }>;
  create(options: FxCreateOptions): Promise<FxAgentSession>;
}

/** libfx 的 stopReason → 设计的错误码（07 §2.2 封闭枚举）。 */
export function mapStopReason(stopReason: string | null): string | null {
  switch (stopReason) {
    case 'refused':
      return 'fx_auth_refused';
    case null:
    case 'end_turn':
    case 'stop':
      return null;
    default:
      return 'fx_turn_failed';
  }
}
