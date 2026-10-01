/**
 * 计划编译器（03 §3）—— 用户不执行用例，执行的是计划。
 *
 * 编译期完成全部静态校验，**一律拒绝编译而非跳过**：
 * 一个静默被跳过的步骤会让报告说谎。宁可跑不起来，不可跑出错的结果。
 *
 * 快照语义：entry 内嵌步骤与参数行；执行期不读 test_case 表，
 * 用例此后被人工修改不影响已编译计划的语义（与 04 §2.2 同源）。
 */

import { KernelError } from '../kernel/shared/util.ts';
import type { EnvRecord, RunPolicy, Severity, TestCaseRecord } from '../kernel/shared/domain.ts';
import { maskTemplate, validateRefs } from './template.ts';
import { guardReadOnlySql } from '../sampling/guard.ts';
import { checkUrl } from './urlguard.ts';
import {
  PLAN_MAX_ENTRIES,
  PLAN_MAX_STEPS_PER_CASE,
  PLAN_MAX_TOTAL_STEPS,
  type AssertOp,
  type AssertTarget,
  type DbCheckStepSpec,
  type ExtractStepSpec,
  type PlanEntry,
  type RunPlan,
  type StepSpec,
} from './plan-types.ts';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const ASSERT_OPS: readonly AssertOp[] = [
  'eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'not_contains', 'exists', 'not_exists', 'matches', 'type_is',
];

export interface CompilePlanInput {
  cases: TestCaseRecord[];
  env: EnvRecord;
  policy: RunPolicy;
  seed: number;
  nowMs: number;
  /** SSRF 前置检查：env.baseUrl 必须可达可解析（08 §2.4）。 */
  baseUrlCheck?: boolean;
}

export async function compilePlan(input: CompilePlanInput): Promise<RunPlan> {
  const { cases, env, policy } = input;

  // ① 环境与 baseUrl 前置检查（编译期 SSRF 拦截，03 §3.2）
  const baseCheck = await checkUrl(env.baseUrl, 'permissive');
  if (input.baseUrlCheck !== false && !baseCheck.ok) {
    throw new KernelError('env_url_rejected', `环境 ${env.name} 的 baseUrl 未通过 urlguard（${baseCheck.reason}）`);
  }
  const baseOrigin = new URL(env.baseUrl).origin;

  const entries: PlanEntry[] = [];
  const caseNames: Record<number, string> = {};
  let totalSteps = 0;

  for (const c of cases) {
    caseNames[c.id] = c.name;
    // P3：只有 adopted 的用例可执行——AI 提议未经人工裁决不该被打出去
    if (c.status !== 'adopted') {
      throw new KernelError('case_not_adopted', `用例 ${c.id}（${c.name}）状态为 ${c.status}；只有 adopted 用例可编译进计划`);
    }
    if (c.steps.length === 0 || c.steps.length > PLAN_MAX_STEPS_PER_CASE) {
      throw new KernelError('steps_invalid', `用例 ${c.name} 步骤数为 ${c.steps.length}（须 1–${PLAN_MAX_STEPS_PER_CASE}）`);
    }
    totalSteps += c.steps.length * c.params.rows.length;
    if (totalSteps > PLAN_MAX_TOTAL_STEPS) {
      throw new KernelError('plan_too_large', `计划总步骤数超过 ${PLAN_MAX_TOTAL_STEPS}；请缩小范围`);
    }

    // ② matrix 行数硬上限（03 §2.3：静默截断会让人误以为覆盖完整）
    if (c.params.kind === 'matrix') {
      const max = c.params.maxRows ?? 32;
      if (c.params.rows.length > Math.min(max, 256)) {
        throw new KernelError('matrix_rows_exceeded', `用例 ${c.name} matrix 行数 ${c.params.rows.length} 超过 maxRows=${max}`);
      }
    }

    // ③ 步骤形状提升（宽松 config → 强类型规格）+ 模板引用校验（逐行参数键集）
    const specSteps = compileSteps(c, env);
    const hasHttp = specSteps.some((st) => st.kind === 'request' || st.kind === 'extract' || st.kind === 'assert' || st.kind === 'wait' || st.kind === 'script' || st.kind === 'db_check');
    const hasUi = specSteps.some((st) => st.kind.startsWith('ui_'));
    if (hasHttp && hasUi) {
      throw new KernelError('step_invalid', `用例 ${c.name}：HTTP 步骤与 UI 步骤不可混用（一个用例一个步骤族）`);
    }
    const family: 'http' | 'ui' = hasUi ? 'ui' : 'http';

    for (let rowIdx = 0; rowIdx < c.params.rows.length; rowIdx++) {
      const row = c.params.rows[rowIdx]!;
      const paramKeys = new Set(Object.keys(row.values));
      const definedVars = new Set<string>();
      for (const step of specSteps) {
        const texts = templateTextsOf(step);
        for (const text of texts) {
          validateRefs(text, { envKeys: new Set(Object.keys(env.variables)), secretKeys: new Set(env.secretNames), paramKeys, definedVars }, `用例 ${c.name} 步骤 ${step.kind}`);
        }
        if (step.kind === 'extract') definedVars.add(step.name);
      }

      entries.push({
        entryId: `${c.id}#${rowIdx}`,
        caseId: c.id,
        caseName: c.name,
        paramRowLabel: row.label,
        intent: row.intent,
        paramValues: row.values,
        steps: specSteps,
        family,
        group: `case:${c.id}`,
      });
    }
  }

  if (entries.length > PLAN_MAX_ENTRIES) {
    throw new KernelError('plan_too_large', `计划 entry 数 ${entries.length} 超过 ${PLAN_MAX_ENTRIES}`);
  }

  return {
    version: 1,
    envId: env.id,
    policy,
    seed: input.seed,
    concurrency: policy.concurrency,
    entries,
    compiledAtMs: input.nowMs,
    source: { caseIds: cases.map((c) => c.id), caseNames },
  };
}

/* ─────────────── 步骤编译 ─────────────── */

function compileSteps(c: TestCaseRecord, env: EnvRecord): StepSpec[] {
  const baseOrigin = new URL(env.baseUrl).origin;
  const specs: StepSpec[] = [];
  const extractNames = new Set<string>();

  for (let i = 0; i < c.steps.length; i++) {
    const raw = c.steps[i]!;
    if (raw.seq !== i) {
      throw new KernelError('steps_invalid', `用例 ${c.name} 步骤 seq 必须从 0 连续（第 ${i} 位是 ${raw.seq}）`);
    }
    const cfg = raw.config as Record<string, unknown>;

    switch (raw.kind) {
      case 'request': {
        const method = strField(c, cfg, 'method', i).toUpperCase();
        if (!HTTP_METHODS.has(method)) throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：不支持的 HTTP 方法 ${method}`);
        const url = strField(c, cfg, 'url', i);

        // URL 归属检查（07 §3.3：Agent 合成的用例若目标在 env 域名之外 → 拒绝编译）
        const staticUrl = url.startsWith('/') ? env.baseUrl + url : maskTemplate(url);
        let resolved: URL;
        try {
          resolved = new URL(staticUrl);
        } catch {
          throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：URL 模板静态解析失败（${url}）`);
        }
        if (resolved.origin !== baseOrigin) {
          throw new KernelError(
            'url_outside_env',
            `用例 ${c.name} 步骤 ${i}：目标 ${resolved.origin} 不在环境 baseUrl（${baseOrigin}）之内——可能的注入用例，强制人工复核`,
          );
        }

        const spec: StepSpec = { kind: 'request', method, url };
        if (cfg['headers'] !== undefined) {
          const headers = cfg['headers'];
          if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
            throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：headers 必须是对象`);
          }
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
            if (typeof v !== 'string') throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：header ${k} 的值必须是字符串`);
            out[k] = v;
          }
          spec.headers = out;
        }
        if (cfg['body'] !== undefined) {
          if (typeof cfg['body'] !== 'string') throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：body 必须是字符串（JSON 自行序列化）`);
          spec.body = cfg['body'];
        }
        if (cfg['timeoutMs'] !== undefined) {
          spec.timeoutMs = numField(c, cfg, 'timeoutMs', i, 1, 3_600_000);
        }
        if (cfg['followRedirects'] !== undefined) {
          if (typeof cfg['followRedirects'] !== 'boolean') throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：followRedirects 必须是布尔`);
          spec.followRedirects = cfg['followRedirects'];
        }
        specs.push(spec);
        break;
      }

      case 'extract': {
        const name = strField(c, cfg, 'name', i);
        if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：变量名 ${name} 不合法`);
        if (extractNames.has(name)) throw new KernelError('step_invalid', `用例 ${c.name}：变量 ${name} 被重复 extract`);
        extractNames.add(name);
        const from = cfg['from'];
        specs.push({ kind: 'extract', name, from: parseSource(c, i, from, ['status', 'header', 'body_json', 'body_text']) as ExtractStepSpec['from'] });
        break;
      }

      case 'assert': {
        const target = parseSource(c, i, cfg['target'], ['status', 'header', 'body_json', 'duration_ms']) as AssertTarget;
        const op = cfg['op'];
        if (typeof op !== 'string' || !ASSERT_OPS.includes(op as AssertOp)) {
          throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：未知断言操作 ${String(op)}`);
        }
        const spec: StepSpec = {
          kind: 'assert',
          target,
          op: op as AssertOp,
          severity: (typeof cfg['severity'] === 'string' ? cfg['severity'] : 'major') as Severity,
        };
        if (cfg['expected'] !== undefined) {
          if (typeof cfg['expected'] !== 'string' && typeof cfg['expected'] !== 'number' && typeof cfg['expected'] !== 'boolean') {
            throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：expected 必须是标量`);
          }
          spec.expected = String(cfg['expected']);
        } else if (op !== 'exists' && op !== 'not_exists' && op !== 'type_is') {
          throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：op=${op} 需要 expected`);
        }
        if (cfg['principleId'] !== undefined) spec.principleId = numField(c, cfg, 'principleId', i, 1);
        if (cfg['sourceFile'] !== undefined) spec.sourceFile = strField(c, cfg, 'sourceFile', i);
        if (cfg['sourceLine'] !== undefined) spec.sourceLine = numField(c, cfg, 'sourceLine', i, 0);
        specs.push(spec);
        break;
      }

      case 'wait': {
        specs.push({ kind: 'wait', ms: numField(c, cfg, 'ms', i, 0, 300_000) });
        break;
      }

      case 'script': {
        const code = strField(c, cfg, 'code', i, 1_000_000);
        const spec: StepSpec = { kind: 'script', code };
        if (cfg['timeoutMs'] !== undefined) spec.timeoutMs = numField(c, cfg, 'timeoutMs', i, 100, 30_000);
        if (cfg['severity'] !== undefined) spec.severity = strField(c, cfg, 'severity', i) as Severity;
        specs.push(spec);
        break;
      }

      // ───────── UI 步骤族（与 HTTP 不可混用，末尾统一检查） ─────────
      case 'ui_navigate': {
        const url = strField(c, cfg, 'url', i, 4096);
        // 与 HTTP 步骤同一同源纪律（07 §3.3 / 08 §2.4）
        const staticUrl = url.startsWith('/') ? env.baseUrl + url : maskTemplate(url);
        let resolved: URL;
        try {
          resolved = new URL(staticUrl);
        } catch {
          throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：导航 URL 静态解析失败（${url}）`);
        }
        if (resolved.origin !== baseOrigin) {
          throw new KernelError('url_outside_env', `用例 ${c.name} 步骤 ${i}：导航目标 ${resolved.origin} 不在环境 baseUrl（${baseOrigin}）之内`);
        }
        specs.push({ kind: 'ui_navigate', url });
        break;
      }
      case 'ui_click': {
        const spec: Extract<StepSpec, { kind: 'ui_click' }> = { kind: 'ui_click', selector: strField(c, cfg, 'selector', i, 2048) };
        if (cfg['timeoutMs'] !== undefined) spec.timeoutMs = numField(c, cfg, 'timeoutMs', i, 10, 60_000);
        specs.push(spec);
        break;
      }
      case 'ui_fill': {
        const spec: Extract<StepSpec, { kind: 'ui_fill' }> = {
          kind: 'ui_fill',
          selector: strField(c, cfg, 'selector', i, 2048),
          text: strField(c, cfg, 'text', i, 65_536),
        };
        if (cfg['timeoutMs'] !== undefined) spec.timeoutMs = numField(c, cfg, 'timeoutMs', i, 10, 60_000);
        specs.push(spec);
        break;
      }
      case 'ui_press':
        specs.push({ kind: 'ui_press', key: strField(c, cfg, 'key', i, 64) });
        break;
      case 'ui_wait_for': {
        const spec: Extract<StepSpec, { kind: 'ui_wait_for' }> = { kind: 'ui_wait_for', selector: strField(c, cfg, 'selector', i, 2048) };
        if (cfg['timeoutMs'] !== undefined) spec.timeoutMs = numField(c, cfg, 'timeoutMs', i, 10, 60_000);
        if (cfg['state'] !== undefined) {
          const state = cfg['state'];
          if (state !== 'visible' && state !== 'hidden') throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：state 必须是 visible | hidden`);
          spec.state = state;
        }
        specs.push(spec);
        break;
      }
      case 'ui_see': {
        const selector = cfg['selector'];
        const contains = cfg['contains'];
        if ((selector === undefined || selector === null) && (contains === undefined || contains === null)) {
          throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：ui_see 需要 selector 或 contains 至少其一`);
        }
        const spec: Extract<StepSpec, { kind: 'ui_see' }> = {
          kind: 'ui_see',
          ...(selector === undefined || selector === null ? {} : { selector: strField(c, cfg, 'selector', i, 2048) }),
          ...(contains === undefined || contains === null ? {} : { contains: strField(c, cfg, 'contains', i, 65_536) }),
        };
        if (cfg['severity'] !== undefined) {
          const sev = cfg['severity'];
          if (typeof sev !== 'string' || !['blocker', 'critical', 'major', 'minor', 'info'].includes(sev)) {
            throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：非法 severity ${String(sev)}`);
          }
          spec.severity = sev as Severity;
        }
        specs.push(spec);
        break;
      }
      case 'ui_screenshot': {
        const spec: Extract<StepSpec, { kind: 'ui_screenshot' }> = { kind: 'ui_screenshot' };
        if (cfg['name'] !== undefined) spec.name = strField(c, cfg, 'name', i, 200);
        specs.push(spec);
        break;
      }

      case 'db_check': {
        const connection = strField(c, cfg, 'connection', i, 200);
        const query = strField(c, cfg, 'query', i, 65_536);
        // 编译期静态白名单（运行期连接后再过一次——同 SSRF 的两道闸，08 §2.4）
        const guard = guardReadOnlySql(query);
        if (!guard.ok) {
          throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：db_check 查询未过只读白名单（${guard.reason}）`);
        }
        const expectRows = cfg['expectRows'];
        if (typeof expectRows !== 'object' || expectRows === null || Array.isArray(expectRows)) {
          throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：db_check 需要 expectRows（{ eq | gte | lte }）`);
        }
        const er = expectRows as Record<string, unknown>;
        const spec: DbCheckStepSpec = { kind: 'db_check', connection, query, expectRows: {} };
        const bounds: { eq?: number; gte?: number; lte?: number } = {};
        let hasBound = false;
        for (const key of ['eq', 'gte', 'lte'] as const) {
          const v = er[key];
          if (v === undefined) continue;
          if (typeof v !== 'number' || !Number.isInteger(v)) {
            throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：expectRows.${key} 必须是整数`);
          }
          bounds[key] = v;
          hasBound = true;
        }
        if (!hasBound) throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：expectRows 至少一个 eq/gte/lte`);
        spec.expectRows = bounds;
        specs.push(spec);
        break;
      }

      default:
        throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：未知步骤类型 ${String(raw.kind)}`);
    }
  }
  return specs;
}

type SourceKind = 'status' | 'header' | 'body_json' | 'body_text' | 'duration_ms';

function parseSource(c: TestCaseRecord, i: number, from: unknown, allowed: readonly SourceKind[]): Record<string, unknown> & { kind: SourceKind } {
  if (typeof from !== 'object' || from === null || Array.isArray(from)) {
    throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：target/from 必须是 { kind, ... } 对象`);
  }
  const obj = { ...(from as Record<string, unknown>) };
  const kind = obj['kind'];
  if (typeof kind !== 'string' || !allowed.includes(kind as SourceKind)) {
    throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：target/from.kind 必须是 ${allowed.join(' | ')} 之一`);
  }
  if (kind === 'header' && typeof obj['name'] !== 'string') {
    throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：header 目标需要 name`);
  }
  if (kind === 'body_json' && typeof obj['path'] !== 'string') {
    throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：body_json 目标需要 path（如 data.items[0].id）`);
  }
  return obj as Record<string, unknown> & { kind: SourceKind };
}

function templateTextsOf(step: StepSpec): string[] {
  if (step.kind === 'request') {
    const texts = [step.url, step.body ?? '', ...Object.values(step.headers ?? {})];
    return texts.filter((t) => t.includes('{{'));
  }
  return [];
}

function strField(c: TestCaseRecord, cfg: Record<string, unknown>, key: string, i: number, maxLen = 8192): string {
  const v = cfg[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：${key} 必须是非空字符串`);
  }
  if (v.length > maxLen) throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：${key} 超过最大长度`);
  return v;
}

function numField(c: TestCaseRecord, cfg: Record<string, unknown>, key: string, i: number, min: number, max?: number): number {
  const v = cfg[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || (max !== undefined && v > max)) {
    throw new KernelError('step_invalid', `用例 ${c.name} 步骤 ${i}：${key} 必须是整数${max === undefined ? ` ≥${min}` : ` ∈[${min},${max}]`}`);
  }
  return v;
}
