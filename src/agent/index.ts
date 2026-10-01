/**
 * Agent 层公共出口。降级纪律：Agent 不可用 = 仅 Agent 功能不可用（07 §1.4）。
 */

export { AgentManager, instructionsFor, type AgentManagerOptions, type ProbeResult, type TurnSummary } from './manager.ts';
export { LibFxDriver } from './libfx-driver.ts';
export { ScriptedFxDriver, type ScriptedTurn } from './scripted-driver.ts';
export { AGENT_TOOLS, executeTool, toolByName, type ToolDef, type ToolContext } from './tools.ts';
export { mapStopReason, type FxDriver, type FxAgentSession, type FxStreamEvent, type FxTurnResult, type FxToolOutcome } from './fx-driver.ts';
export { applyPrdExtraction, type PrdExtractionOutcome } from './prd-task.ts';
