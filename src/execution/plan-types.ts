/**
 * 执行层类型：步骤规格（strict 形状）与 RunPlan。
 *
 * 基座里的 TestCaseDraft.steps 只存宽松的 `config: Record<string, unknown>`
 * （存储层不解释语义）；**解释与校验发生在这里**——计划编译器把宽松形状
 * 提升为强类型规格，任何不符合规格的步骤在编译期被拒绝（03 §3.2）。
 */

import type { ParamIntent, RunPolicy, Severity, StepKind } from '../kernel/shared/domain.ts';

/* ─────────────── 步骤规格 ─────────────── */

export interface RequestStepSpec {
  kind: 'request';
  /** 以 `/` 开头则拼接 env.baseUrl；否则必须以 {{env.baseUrl}} 开头。 */
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  followRedirects?: boolean;
}

export interface ExtractStepSpec {
  kind: 'extract';
  /** 变量名（后续步骤以 {{var.name}} 引用；case 内唯一）。 */
  name: string;
  from:
    | { kind: 'status' }
    | { kind: 'header'; name: string }
    | { kind: 'body_json'; path: string }
    | { kind: 'body_text' };
}

/** 断言目标：status / header / body_json.path / duration_ms。 */
export type AssertTarget =
  | { kind: 'status' }
  | { kind: 'header'; name: string }
  | { kind: 'body_json'; path: string }
  | { kind: 'duration_ms' };

export type AssertOp =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'not_contains'
  | 'exists'
  | 'not_exists'
  | 'matches'
  | 'type_is';

export interface AssertStepSpec {
  kind: 'assert';
  target: AssertTarget;
  op: AssertOp;
  /** 期望值（exists/not_exists/type_is 可省）。 */
  expected?: string;
  severity: Severity;
  /** 溯源：断言依据的原则（写进 assert_result / assert_evaluated，原则触发率依赖它）。 */
  principleId?: number;
  sourceFile?: string;
  sourceLine?: number;
}

export interface WaitStepSpec {
  kind: 'wait';
  ms: number;
}

export interface ScriptStepSpec {
  kind: 'script';
  code: string;
  timeoutMs?: number;
  severity?: Severity;
}

/* ─────────────── UI 步骤规格（引擎层 UI 测试族） ─────────────── */

/**
 * UI 用例 = 全部 ui_* 步骤（与 HTTP 步骤不可混用，编译期强制）。
 * 目标 origin = env.baseUrl（与 HTTP 步骤同一 SSRF/同源纪律）。
 * ui_see 是断言：发 assert_evaluated 事件 → 判定/flaky/降级语义全部复用。
 */
export type UiStepSpec =
  | { kind: 'ui_navigate'; url: string }
  | { kind: 'ui_click'; selector: string; timeoutMs?: number }
  | { kind: 'ui_fill'; selector: string; text: string; timeoutMs?: number }
  | { kind: 'ui_press'; key: string }
  | { kind: 'ui_wait_for'; selector: string; timeoutMs?: number; state?: 'visible' | 'hidden' }
  | { kind: 'ui_see'; selector?: string; contains?: string; severity?: Severity }
  | { kind: 'ui_screenshot'; name?: string };

/** db_check（03 §2.4）：查测试库验证副作用——「返回 200 但库里没写」是典型假通过。 */
export interface DbCheckStepSpec {
  kind: 'db_check';
  /** 连接名（dbconn:create 时的 name；运行期在项目内解析）。 */
  connection: string;
  /** 只读查询（编译期 + 运行期都过四层白名单）。 */
  query: string;
  /** 行数期望（唯一支持的断言形态：可数的副作用）。 */
  expectRows: { eq?: number; gte?: number; lte?: number };
}

export type StepFamily = 'http' | 'ui';

export type StepSpec = RequestStepSpec | ExtractStepSpec | AssertStepSpec | WaitStepSpec | ScriptStepSpec | UiStepSpec | DbCheckStepSpec;

export const SUPPORTED_STEP_KINDS: readonly StepKind[] = [
  'request', 'extract', 'assert', 'wait', 'script', 'db_check',
  'ui_navigate', 'ui_click', 'ui_fill', 'ui_press', 'ui_wait_for', 'ui_see', 'ui_screenshot',
];

/* ─────────────── RunPlan（03 §3.1：编译产物，快照语义） ─────────────── */

/**
 * 计划是编译产物：用例集 → 扁平 entry 列表。
 * entry 内嵌步骤与参数行快照——执行期不再读 test_case 表，
 * 用例被人工修改不影响已编译计划的语义（与 04 §2.2 同一条快照纪律）。
 */
export interface PlanEntry {
  entryId: string;
  caseId: number;
  caseName: string;
  paramRowLabel: string;
  intent: ParamIntent | null;
  /** 参数行值（模板 {{param.x}} 的来源）。 */
  paramValues: Record<string, unknown>;
  steps: StepSpec[];
  /** 步骤族：一个用例的步骤必须同族（编译期强制）。 */
  family: StepFamily;
  /** 并发分组（同组串行；同 case 的参数行默认同组，03 §3.3）。 */
  group: string;
}

export interface RunPlan {
  version: 1;
  envId: number;
  policy: RunPolicy;
  seed: number;
  concurrency: number;
  entries: PlanEntry[];
  compiledAtMs: number;
  /** 编译来源摘要（审计用：哪些用例、什么状态）。 */
  source: { caseIds: number[]; caseNames: Record<number, string> };
}

/** 计划规模硬上限：宁可跑不起来，不可跑出错的结果（03 §3.2 最后一行）。 */
export const PLAN_MAX_ENTRIES = 10_000;
export const PLAN_MAX_STEPS_PER_CASE = 100;
export const PLAN_MAX_TOTAL_STEPS = 100_000;
