/**
 * UI 步骤执行器：驱动页面动作 → 观测事件。
 *
 * 事件纪律与 HTTP runner 一致：只产观测（ui_action / assert_evaluated / step_errored），
 * 不产结论。ui_see 是断言 → assert_evaluated → verdict 纯函数照常工作
 * （UI 用例免费获得 failed/degraded/flaky 语义）。
 *
 * 模板：ui_navigate.url / ui_fill.text 支持 {{env|var|secret|param.x}}——入口先经
 * ctx.resolve 解析（与 HTTP 步骤同一 ctx），再做同源校验/驱动动作；解析失败 → plan_invalid。
 *
 * 驱动不可用 → ui_driver_unavailable（诚实拒绝，不静默；run 内其它用例继续）。
 */

import { performance } from 'node:perf_hooks';
import type { Kernel } from '../../kernel/service.ts';
import type { RunEventInput, StepErrorReason, StepKind } from '../../kernel/shared/domain.ts';
import type { UiDriver } from './driver.ts';
import type { UiStepSpec } from '../plan-types.ts';

export interface UiStepContext {
  kernel: Kernel;
  projectId: number;
  entryId: string;
  /** 环境基址（同源校验 + 相对导航展开）。 */
  baseUrl: string;
  defaultTimeoutMs: number;
  signal: { aborted: boolean } | undefined;
  /** 模板解析（与 HTTP 步骤同一 ctx）：{{env|var|secret|param.x}} → 运行期值；未定义引用抛错。 */
  resolve: (text: string) => string;
}

export type UiStepOutcome =
  | { ok: true; events: RunEventInput[]; failedAssert: boolean }
  | { ok: false; reason: StepErrorReason; detail: string; events: RunEventInput[] };

export async function executeUiStep(
  ctx: UiStepContext,
  driver: UiDriver,
  step: UiStepSpec,
  stepSeq: number,
  assertSeq: number,
  secrets: Record<string, string>,
): Promise<UiStepOutcome> {
  const t0 = performance.now();
  const timeoutMs = stepTimeout(step) ?? ctx.defaultTimeoutMs;
  const mask = (s: string): string => maskSecrets(s, secrets);

  // 入口先解析模板字段（{{param.x}}/{{secret.y}}/{{env.x}}；存在性已由编译期 validateRefs 保证）：
  // 解析失败 → plan_invalid（诚实拒绝），绝不把 {{...}} 字面量带进驱动或同源校验。
  const resolveField = (text: string): { ok: true; value: string } | { ok: false; detail: string } => {
    try {
      return { ok: true, value: ctx.resolve(text) };
    } catch (err) {
      return { ok: false, detail: String((err as Error).message ?? err).slice(0, 4000) };
    }
  };

  const actionEvent = (detail: string | null, screenshotRef: string | null, durationMs: number, target: string | null = null): RunEventInput => ({
    kind: 'ui_action',
    entryId: ctx.entryId,
    stepSeq,
    stepKind: step.kind as StepKind,
    action: uiActionName(step),
    target: target === null ? null : mask(target),
    durationMs,
    detail: detail === null ? null : mask(detail).slice(0, 4000),
    screenshotRef,
  });

  try {
    switch (step.kind) {
      case 'ui_navigate': {
        // 先解析模板再同源校验（模板值运行期才有值；导航是 SSRF 经典载体）
        const tpl = resolveField(step.url);
        if (!tpl.ok) return { ok: false, reason: 'plan_invalid', detail: tpl.detail, events: [] };
        const rawUrl = tpl.value;
        const url = rawUrl.startsWith('/') ? ctx.baseUrl + rawUrl : rawUrl;
        const resolved = new URL(url);
        if (resolved.origin !== new URL(ctx.baseUrl).origin) {
          return { ok: false, reason: 'plan_invalid', detail: `导航目标 ${resolved.origin} 不在环境基址域内`, events: [] };
        }
        await driver.goto(maskSecretsUrl(url, secrets), timeoutMs);
        return { ok: true, events: [actionEvent(`→ ${maskSecretsUrl(url, secrets)}`, null, elapsed(t0))], failedAssert: false };
      }

      case 'ui_click':
        await driver.click(step.selector, timeoutMs);
        return { ok: true, events: [actionEvent('click', null, elapsed(t0), step.selector)], failedAssert: false };

      case 'ui_fill': {
        // 填写文本先解析模板（如 {{secret.x}} 取真值进输入框）；事件里掩码
        const tpl = resolveField(step.text);
        if (!tpl.ok) return { ok: false, reason: 'plan_invalid', detail: tpl.detail, events: [] };
        await driver.fill(step.selector, tpl.value, timeoutMs);
        return { ok: true, events: [actionEvent(`fill "${mask(tpl.value).slice(0, 100)}"`, null, elapsed(t0), step.selector)], failedAssert: false };
      }

      case 'ui_press':
        await driver.press(step.key);
        return { ok: true, events: [actionEvent(`press ${step.key}`, null, elapsed(t0))], failedAssert: false };

      case 'ui_wait_for':
        await driver.waitFor(step.selector, step.state ?? 'visible', timeoutMs);
        return { ok: true, events: [actionEvent(`wait ${step.state ?? 'visible'}`, null, elapsed(t0), step.selector)], failedAssert: false };

      case 'ui_see': {
        const actual = step.selector !== undefined ? await driver.textOf(step.selector, timeoutMs) : await driver.bodyText();
        let passed: boolean;
        if (step.selector !== undefined && actual === null) {
          passed = false; // 元素不存在 → 断言失败（不是错误：页面状态问题是被测对象的状态）
        } else if (step.contains !== undefined) {
          passed = actual !== null && actual.includes(step.contains);
        } else {
          passed = actual !== null && actual.trim().length > 0;
        }
        const event: RunEventInput = {
          kind: 'assert_evaluated',
          entryId: ctx.entryId,
          assertSeq,
          stepSeq,
          severity: step.severity ?? 'major',
          expected: step.contains ?? (step.selector !== undefined ? `<存在 ${step.selector}>` : '<非空>'),
          actual: actual === null ? '∅（元素不存在）' : mask(actual).slice(0, 500),
          passed,
          principleId: null,
          sourceFile: null,
          sourceLine: null,
        };
        return { ok: true, events: [event, actionEvent(passed ? 'see ✓' : 'see ✗', null, elapsed(t0), step.selector ?? null)], failedAssert: !passed };
      }

      case 'ui_screenshot': {
        const shot = await driver.screenshot();
        const art = await ctx.kernel.call('artifact:put', {
          contentType: 'image/png',
          contentBase64: shot.toString('base64'),
        });
        return { ok: true, events: [actionEvent(step.name ?? 'screenshot', art.sha256, elapsed(t0))], failedAssert: false };
      }
    }
  } catch (err) {
    if (ctx.signal?.aborted) {
      return { ok: false, reason: 'ui_timeout', detail: 'aborted', events: [] };
    }
    return { ok: false, reason: classifyUiError(err, step), detail: String((err as Error).message ?? err).slice(0, 4000), events: [] };
  }
}

function stepTimeout(step: UiStepSpec): number | undefined {
  switch (step.kind) {
    case 'ui_click':
    case 'ui_fill':
    case 'ui_wait_for':
      return step.timeoutMs;
    default:
      return undefined;
  }
}

function uiActionName(step: UiStepSpec): string {
  return step.kind.replace(/^ui_/, '');
}

function classifyUiError(err: unknown, step: UiStepSpec): StepErrorReason {
  const message = String((err as Error).message ?? err);
  if (step.kind === 'ui_navigate') return 'ui_navigation_failed';
  if (/timeout|timed out/i.test(message)) {
    return step.kind === 'ui_wait_for' || step.kind === 'ui_click' || step.kind === 'ui_fill' ? 'ui_selector_not_found' : 'ui_timeout';
  }
  return 'ui_timeout';
}

function elapsed(t0: number): number {
  return Math.round(performance.now() - t0);
}

function maskSecrets(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const value of Object.values(secrets)) {
    if (value.length >= 4) out = out.split(value).join('<secret>');
  }
  return out;
}

function maskSecretsUrl(url: string, secrets: Record<string, string>): string {
  return maskSecrets(url, secrets);
}
