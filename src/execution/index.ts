/**
 * 执行层公共出口 —— 基座（kernel）之上的第一层：合成计划与执行。
 * 仍然 headless：不含 GUI / webview / React；被未来的壳（桌面 / CLI）调用。
 */

export { compilePlan, type CompilePlanInput } from './plan-compiler.ts';
export type { PlanEntry, RunPlan, StepSpec, RequestStepSpec, ExtractStepSpec, AssertStepSpec, WaitStepSpec, ScriptStepSpec, AssertOp, AssertTarget } from './plan-types.ts';
export { PLAN_MAX_ENTRIES, PLAN_MAX_STEPS_PER_CASE, PLAN_MAX_TOTAL_STEPS, SUPPORTED_STEP_KINDS } from './plan-types.ts';
export { checkUrl, privateRange, type UrlGuardMode, type UrlCheckResult } from './urlguard.ts';
export { parseRefs, resolveTemplate, validateRefs, maskTemplate, type TemplateContext, type TemplateRef } from './template.ts';
export { jsonPath, resolveTarget, evaluateAssert, type ObservedResponse, type AssertEvaluation } from './evaluate.ts';
export { runScript, type SandboxInput, type ScriptOutcome } from './sandbox.ts';
export { executePlan, type ExecutePlanOptions, type ExecuteResult, type SecretProvider } from './runner.ts';
