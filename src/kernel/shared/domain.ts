/**
 * deepAutoTest 基座领域类型 —— 与设计文档 03（测试流程）/ 04（结果模型）一一对应。
 *
 * 三条不可让渡的纪律在类型层的体现：
 *  - P1 事实 = RunEvent（append-only）；其余都是投影
 *  - P4 判定 = reduce(events, policy) 纯函数；事件自足（expected/actual/severity 全在事件里）
 *  - flaky 是标记位而非第七个 verdict（保留"末次通过/失败"信息）
 *
 * 注意：事件只记「观测」，不记「结论」。03 §6.1 的 entry_finished 原稿带 verdict 字段，
 * 本基座依 04 §3.2（判定纯函数、可重判）将其修正为观测字段（attempts / durationMs）——
 * 若执行期写入 verdict，重判将自相矛盾。
 */

/* ─────────────────────────── 枚举（封闭集合） ─────────────────────────── */

/**
 * verdict 五值 + flaky 标记位（04 §3.1 / §3.4）。
 *  - passed    通过且稳定
 *  - degraded  仅 minor 断言失败（保护通过率可信度）
 *  - failed    被测对象不符合预期
 *  - errored   未能完成测试（连不上 ≠ 服务有 bug）
 *  - skipped   未执行（取消 / 依赖失败 / 豁免）
 */
export type Verdict = 'passed' | 'degraded' | 'failed' | 'errored' | 'skipped';

/** 断言严重度五级（03 §2.6）。 */
export type Severity = 'blocker' | 'critical' | 'major' | 'minor' | 'info';

export const SEVERITY_ORDER: readonly Severity[] = ['info', 'minor', 'major', 'critical', 'blocker'];

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

/**
 * 步骤错误原因（封闭枚举，03 §6.1 step_errored）。
 * http_5xx / assert_failed 只作为 retry_scheduled 的原因出现（响应已到达、断言已求值，
 * 不是 step_errored——它们不把 attempt 变成 errored，只触发重试决策）。
 */
export type StepErrorReason =
  | 'connect_failed'
  | 'dns_failed'
  | 'tls_error'
  | 'timed_out'
  | 'script_error'
  | 'script_timeout'
  | 'db_check_error'
  | 'host_crash'
  | 'env_error'
  | 'plan_invalid'
  | 'http_5xx'
  | 'assert_failed'
  | 'ui_driver_unavailable'
  | 'ui_navigation_failed'
  | 'ui_selector_not_found'
  | 'ui_timeout';

/** 判定层自产的错误语义（不进入事件，judge 内部使用，04 §3.5）。 */
export type CorruptionKind = 'incomplete' | 'seq_gap' | 'hash_mismatch';

/** Run 生命周期状态（03 §4.1）。completed ≠ 全通过。 */
export type RunStatus = 'planning' | 'running' | 'completed' | 'cancelled' | 'errored';

/** P3 状态机：AI 生成 ≠ 生效。 */
export type ReviewStatus = 'proposed' | 'adopted' | 'rejected';

/** 人工裁决动作（07 §5）。 */
export type ReviewAction = 'adopt' | 'edit' | 'reject';

/** 参数行意图（03 §2.3）——让报告能说"4 个边界值中 1 个未按预期拒绝"。 */
export type ParamIntent =
  | 'baseline'
  | 'boundary_low'
  | 'boundary_high'
  | 'invalid'
  | 'empty'
  | 'malformed'
  | 'extreme';

export type ParamKind = 'single' | 'boundary' | 'pair' | 'matrix' | 'sequence';

/**
 * 步骤类型。db_check 属采样层（M3 前编译期拒绝）；ui_* 属 UI 测试族
 * （一个用例的步骤必须同族：HTTP 或 UI，编译期强制——见 execution/plan-compiler）。
 */
export type StepKind =
  | 'request'
  | 'extract'
  | 'assert'
  | 'wait'
  | 'script'
  | 'db_check'
  | 'ui_navigate'
  | 'ui_click'
  | 'ui_fill'
  | 'ui_press'
  | 'ui_wait_for'
  | 'ui_see'
  | 'ui_screenshot';

/* ─────────────────────────── 判定策略（04 §2.3 快照语义） ─────────────────────────── */

export interface RetryPolicy {
  /** 总尝试次数上限（1 = 不重试）。 */
  maxAttempts: number;
  /** 哪些错误重试；'any' 表示全部。 */
  on: StepErrorReason[] | 'any';
  backoff: 'fixed' | 'exponential';
  jitter: boolean;
}

/**
 * RunPolicy 在 run_started 事件里快照（不引用"当前项目设置"）。
 * 任何人改项目默认策略都不会追溯改变历史运行的结论——要应用新规则走显式重判。
 */
export interface RunPolicy {
  version: 1;
  /** 此级别及以上断言失败 → failed。 */
  failOnSeverity: Severity;
  /** 此级别断言失败（且无更高级失败）→ degraded。 */
  degradedOnSeverity: Severity;
  retry: RetryPolicy;
  flakyDetection: { enabled: boolean; windowSize: number };
  timeoutMs: number;
  concurrency: number;
  /** 已知豁免的用例（判 skipped(waived)）。 */
  ignoreCaseIds: number[];
  scriptTimeoutMs: number;
}

export function defaultRunPolicy(): RunPolicy {
  return {
    version: 1,
    failOnSeverity: 'major',
    degradedOnSeverity: 'minor',
    retry: { maxAttempts: 1, on: 'any', backoff: 'exponential', jitter: true },
    flakyDetection: { enabled: true, windowSize: 10 },
    timeoutMs: 30_000,
    concurrency: 1,
    ignoreCaseIds: [],
    scriptTimeoutMs: 5_000,
  };
}

/* ─────────────────────────── 事件（事实层，04 §2） ─────────────────────────── */

export type RunEventKind =
  | 'run_started'
  | 'entry_started'
  | 'request_sent'
  | 'response_received'
  | 'assert_evaluated'
  | 'var_extracted'
  | 'step_errored'
  | 'retry_scheduled'
  | 'entry_finished'
  | 'run_finished'
  | 'note'
  | 'run_paused'
  | 'run_resumed'
  | 'case_waived'
  | 'case_overridden'
  | 'run_voided'
  | 'rejudged'
  | 'ui_action'
  | 'db_checked';

/** 事件载荷（判别联合）。写入前 payload 中的字符串一律过写时脱敏（08 §4）。 */
export type RunEventPayload =
  | { kind: 'run_started'; policy: RunPolicy; envId: number | null; concurrency: number; seed: number; planSnapshot?: unknown }
  | { kind: 'entry_started'; caseId: number; paramRowLabel: string; intent: ParamIntent | null }
  | { kind: 'request_sent'; stepSeq: number; method: string; url: string; headerNames: string[] }
  | { kind: 'response_received'; stepSeq: number; status: number; durationMs: number; bodyRef: string | null; bodySha256: string | null }
  | { kind: 'assert_evaluated'; assertSeq: number; stepSeq: number; severity: Severity; expected: string; actual: string; passed: boolean; principleId: number | null; sourceFile: string | null; sourceLine: number | null }
  | { kind: 'var_extracted'; name: string; value: string }
  | { kind: 'step_errored'; stepSeq: number | null; stepKind: StepKind | null; reason: StepErrorReason; detail: string | null }
  | { kind: 'retry_scheduled'; attempt: number; reason: StepErrorReason; delayMs: number }
  | { kind: 'entry_finished'; attempts: number; durationMs: number }
  | { kind: 'run_finished'; status: RunStatus }
  | { kind: 'note'; text: string; by: string }
  | { kind: 'run_paused'; by: string }
  | { kind: 'run_resumed'; by: string }
  | { kind: 'case_waived'; caseId: number; reason: string; by: string; expiresAtMs: number | null }
  | { kind: 'case_overridden'; caseId: number; from: Verdict; to: Verdict; reason: string; by: string }
  | { kind: 'run_voided'; reason: string; by: string }
  | { kind: 'rejudged'; policy: RunPolicy; by: string; note: string | null }
  /** UI 动作观测（点击/填写/导航…）。断言类 UI 步骤（ui_see）仍发 assert_evaluated。 */
  | { kind: 'ui_action'; stepSeq: number; stepKind: StepKind; action: string; target: string | null; durationMs: number; detail: string | null; screenshotRef: string | null }
  /** db_check 副本侧证观测（03 §2.4：防假通过）。断言发 assert_evaluated。 */
  | { kind: 'db_checked'; stepSeq: number; connection: string; rowCount: number; durationMs: number; firstRowSample: string | null };

/**
 * 写入侧的事件输入：不含 runId / seq / atMs（由事件日志分配）。
 * entryId 在有归属的事件上必填。
 *
 * 分配式条件类型保证「union 交叉 object」仍是可判别的 union（switch kind 可收窄）。
 */
type Distribute<T, E> = T extends unknown ? T & E : never;

export type RunEventInput = Distribute<RunEventPayload, { entryId: string | null }>;

/** 存储侧的完整事件（事实）。 */
export type RunEvent = Distribute<RunEventInput, { runId: number; seq: number; atMs: number }>;

/* ─────────────────────────── 判定输出（04 §3.3 三层折叠） ─────────────────────────── */

export interface EntryJudgment {
  entryId: string;
  caseId: number;
  paramRowLabel: string;
  intent: ParamIntent | null;
  verdict: Verdict;
  flaky: boolean;
  attempts: number;
  durationMs: number;
  /** 末次尝试中失败的断言数。 */
  failedAsserts: number;
  /** 该 entry 首个事件的 seq（排序锚点）。 */
  firstSeq: number;
  /** 被豁免（waived）时为 true，verdict 为 skipped。 */
  waived: boolean;
  /** 被人工覆盖时记录覆盖目标。 */
  overriddenTo: Verdict | null;
}

export interface CaseJudgment {
  caseId: number;
  verdict: Verdict;
  flaky: boolean;
  entries: EntryJudgment[];
  executed: number;
  total: number;
}

export interface RunCounters {
  total: number;
  passed: number;
  failed: number;
  degraded: number;
  errored: number;
  skipped: number;
  flaky: number;
}

export interface RunJudgment {
  runId: number;
  /** 生效策略：run_started 快照，被 rejudged 事件覆盖。 */
  policy: RunPolicy;
  entries: EntryJudgment[];
  cases: CaseJudgment[];
  counters: RunCounters;
  /** 事件流不完整（无 run_finished / 无 entry 终态）时为 true，整体降级 errored。 */
  incomplete: boolean;
  /** 事件序号有洞或链哈希不符时为 true（04 §3.5）。 */
  corrupt: CorruptionKind | null;
  voided: boolean;
}

/* ─────────────────────────── 明细投影行（06 §2.6） ─────────────────────────── */

export interface StepResultRow {
  runId: number;
  entryId: string;
  stepSeq: number;
  kind: StepKind;
  status: 'ok' | 'failed' | 'errored' | 'skipped';
  durationMs: number;
  requestRef: string | null;
  responseRef: string | null;
}

export interface AssertResultRow {
  runId: number;
  entryId: string;
  /** 末次尝试内单调；重试的前几轮不留 assert 行（观测保留在事件里）。 */
  assertSeq: number;
  stepSeq: number;
  severity: Severity;
  expected: string;
  actual: string;
  passed: boolean;
  principleId: number | null;
  sourceFile: string | null;
  sourceLine: number | null;
}

/* ─────────────────────────── 重判与对账（04 §5） ─────────────────────────── */

export interface VerdictChange {
  caseId: number;
  entryId: string;
  paramRowLabel: string;
  from: Verdict;
  to: Verdict;
}

export interface RejudgeDiff {
  runId: number;
  changes: VerdictChange[];
  countersBefore: RunCounters;
  countersAfter: RunCounters;
}

export interface RunDiff {
  baseRunId: number;
  headRunId: number;
  /** 新失败永远排最前——新出现的失败才是当务之急。 */
  newFailures: { caseId: number; entryId: string; label: string; verdict: Verdict }[];
  fixedCases: { caseId: number; entryId: string; label: string }[];
  newlyFlaky: { caseId: number; entryId: string; label: string }[];
  stabilizedCases: { caseId: number; entryId: string; label: string }[];
  verdictChanged: VerdictChange[];
  duration: { medianDeltaMs: number; p95DeltaMs: number };
}

/* ─────────────────────────── 用例模型（03 §2） ─────────────────────────── */

export interface ParamRow {
  label: string;
  values: Record<string, unknown>;
  intent: ParamIntent;
}

export interface ParamSet {
  kind: ParamKind;
  rows: ParamRow[];
  /** matrix 必须声明 maxRows（默认 32，上限 256），超限拒绝编译。 */
  maxRows?: number;
}

export interface ProvenanceRef {
  principles: { principleId: number; source: string; rule: string; usedAs: string }[];
  samples: { table: string; pk: string; field: string }[];
  agentSession: number | null;
  agentTurn: number | null;
  /** PRD 需求溯源（PRD 是与源码并列的真相源）。 */
  prd?: { file: string; line: number; requirement: string }[];
}

/** 步骤树的最小表达（基座只存取与校验，不解释语义——执行是后续 runner 层的事）。 */
export interface Step {
  id: string;
  seq: number;
  kind: StepKind;
  config: Record<string, unknown>;
}

export interface TestCaseDraft {
  name: string;
  description: string | null;
  routeId: number | null;
  paramKind: ParamKind;
  steps: Step[];
  params: ParamSet;
  provenance: ProvenanceRef;
  policyOverride: RunPolicy | null;
  tags: string[];
}

export interface TestCaseRecord extends TestCaseDraft {
  id: number;
  projectId: number;
  status: ReviewStatus;
  proposedBy: string;
  reviewedBy: string | null;
  reviewedAtMs: number | null;
  /** 人工编辑留痕（07 §5.2：结构化 diff，不是"已修改"一个布尔）。 */
  diff: ReviewDiff | null;
  createdAtMs: number;
}

/** 人工编辑留痕（07 §5.2：结构化 diff，不是"已修改"一个布尔）。 */
export interface ReviewDiff {
  fields: { path: string; from: unknown; to: unknown }[];
  editedAtMs: number;
  editedBy: string;
}

/* ─────────────────────────── 项目 / 环境（06 §2.1） ─────────────────────────── */

export type SourceType = 'git' | 'local' | 'zip';

export interface ProjectRecord {
  id: number;
  name: string;
  sourceType: SourceType;
  repoUrl: string | null;
  localPath: string | null;
  gitRef: string | null;
  status: 'active' | 'archived';
  createdAtMs: number;
  updatedAtMs: number;
}

export interface EnvRecord {
  id: number;
  projectId: number;
  name: string;
  baseUrl: string;
  variables: Record<string, unknown>;
  /** 敏感变量名（值只存 OS 钥匙串，永不进库）。 */
  secretNames: string[];
  headers: Record<string, string>;
  allowSelfSigned: boolean;
  createdAtMs: number;
}

export interface RunRecord {
  id: number;
  projectId: number;
  envId: number;
  policy: RunPolicy;
  seed: number;
  status: RunStatus;
  triggeredBy: 'human' | 'agent' | 'schedule' | 'retry';
  startedAtMs: number;
  finishedAtMs: number | null;
  eventCount: number;
  chainHash: string | null;
  counters: RunCounters | null;
  voided: boolean;
}

export interface ProgressSummary {
  doneEntries: number;
  passed: number;
  failed: number;
  errored: number;
  degraded: number;
  flaky: number;
  skipped: number;
}

/** 通过率口径必须显式（04 §4.2）——默认"排除出错"最接近被测对象真实质量。 */
export type PassRateBasis = 'strict' | 'lenient' | 'excluding_errored';

/* ─────────────────────────── API 候选与原则（S2 / S3，06 §2.2–2.3） ─────────────────────────── */

export interface RouteCandidateRecord {
  id: number;
  projectId: number;
  sourceIndexId: number;
  method: string;
  path: string;
  handlerFile: string;
  handlerLine: number;
  framework: string;
  confidence: 'high' | 'medium';
  status: ReviewStatus;
  docDrift: boolean;
  docMissing: boolean;
  proposedBy: string;
  reviewedBy: string | null;
  reviewedAtMs: number | null;
  diff: ReviewDiff | null;
}

export interface RouteCandidateDraft {
  method: string;
  path: string;
  handlerFile: string;
  handlerLine: number;
  framework: string;
  confidence: 'high' | 'medium';
}

export type PrincipleLayer = 'validation' | 'persistence' | 'sample' | 'comment';

/**
 * 原则（S3）：什么值算合法、什么值算边界。
 * value_json 是机器可读的约束（S3 → S5 的唯一接口）：
 *   { type, min?, max?, minLength?, maxLength?, pattern?, enum?, email?, url?, unique?, nullable? }
 */
export interface PrincipleRecord {
  id: number;
  projectId: number;
  subject: string;
  rule: string;
  valueJson: Record<string, unknown> | null;
  sourceFile: string;
  sourceLine: number;
  layer: PrincipleLayer;
  confidence: 'high' | 'medium';
  status: ReviewStatus;
  conflictJson: Record<string, unknown> | null;
  proposedBy: string;
  reviewedBy: string | null;
  reviewedAtMs: number | null;
  diff: ReviewDiff | null;
}

export interface PrincipleDraft {
  subject: string;
  rule: string;
  valueJson: Record<string, unknown> | null;
  sourceFile: string;
  sourceLine: number;
  layer: PrincipleLayer;
  confidence: 'high' | 'medium';
}

export interface SourceIndexRecord {
  id: number;
  projectId: number;
  gitRef: string | null;
  fileCount: number;
  frameworks: string[];
  indexedAtMs: number;
}

/* ─────────────────────────── 数据库连接（S4 采样层，06 §2.1） ─────────────────────────── */

export interface DbConnectionRecord {
  id: number;
  projectId: number;
  name: string;
  dialect: 'mysql' | 'postgres' | 'sqlite';
  /** 强制只读（四层防护之一；连接建立后另设会话级只读）。 */
  readOnly: boolean;
  createdAtMs: number;
}
