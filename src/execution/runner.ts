/**
 * 执行引擎（03 §5）—— undici + 事件发射器。
 *
 * 分层纪律：runner 只产生**观测**（事件），不产生**结论**（verdict）。
 * 所有事件经 kernel 的 run:appendEvents 写入门落库（seq/脱敏/投影同事务），
 * 判定由 judge 纯函数完成——因此执行引擎可以随时替换（回放器 / 分布式 / 录制），
 * 结果模型不变。
 *
 * 已知边界（如实）：
 *  - in-flight entry 在 live 投影中短暂显示 errored（无 entry_finished），
 *    run 结束后自愈；呈现层可按 run.status 区分（05 的职责）
 *  - urlguard 在请求前校验，连接层未钉死 IP（TOCTOU 残余，见 urlguard.ts）
 *  - db_check 需要显式传入 dbChecker（sampling 层桥）；缺省判 errored（诚实拒绝）
 */

import { request, Agent, type Dispatcher } from 'undici';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import type { Kernel } from '../kernel/service.ts';
import type { EnvRecord, RunEventInput, StepErrorReason } from '../kernel/shared/domain.ts';
import { checkUrl } from './urlguard.ts';
import { parseRefs, resolveTemplate } from './template.ts';
import { evaluateAssert, resolveTarget, type ObservedResponse } from './evaluate.ts';
import { runScript } from './sandbox.ts';
import { executeUiStep } from './ui/steps.ts';
import type { DbChecker } from '../sampling/index.ts';
import type { UiDriver, UiDriverFactory } from './ui/driver.ts';
import type { PlanEntry, RunPlan, StepSpec, UiStepSpec } from './plan-types.ts';

const BODY_CAP_BYTES = 10 * 1024 * 1024;
const ARTIFACT_INLINE_MAX = 64 * 1024;

export type SecretProvider = (name: string) => string | undefined;

export interface ExecutePlanOptions {
  kernel: Kernel;
  projectId: number;
  runId: number;
  plan: RunPlan;
  env: EnvRecord;
  /** 凭据按名取值（从 OS 钥匙串来）；值只进内存，永不落库。 */
  secrets?: SecretProvider;
  signal?: AbortSignal;
  /**
   * UI 驱动工厂（UI 步骤族用）。缺省 = Playwright（系统 Chrome）。
   * 不可用时 UI 用例判 errored(ui_driver_unavailable)，HTTP 用例不受影响。
   */
  uiDriver?: UiDriverFactory;
  /** db_check 采样器（sampling 层提供；缺省 = db_check 判 errored，诚实拒绝）。 */
  dbChecker?: DbChecker;
}

export interface ExecuteResult {
  executed: number;
}

export async function executePlan(opts: ExecutePlanOptions): Promise<ExecuteResult> {
  const { kernel, projectId, runId, plan, env } = opts;
  const dispatcher: Dispatcher | undefined = env.allowSelfSigned
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : undefined;

  const groups: string[] = [];
  const byGroup = new Map<string, PlanEntry[]>();
  for (const entry of plan.entries) {
    if (!byGroup.has(entry.group)) {
      byGroup.set(entry.group, []);
      groups.push(entry.group);
    }
    byGroup.get(entry.group)!.push(entry);
  }

  let cursor = 0;
  let executed = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor++;
      if (idx >= groups.length) return;
      if (opts.signal?.aborted) return;
      for (const entry of byGroup.get(groups[idx]!)!) {
        if (opts.signal?.aborted) return;
        await runEntry(opts, dispatcher, entry);
        executed += 1;
      }
    }
  };
  const lanes = Math.max(1, Math.min(plan.concurrency, groups.length));
  try {
    await Promise.all(Array.from({ length: lanes }, () => worker()));
    return { executed };
  } finally {
    if (dispatcher !== undefined) await dispatcher.close().catch(() => {});
  }
}

/* ─────────────── 单 entry ─────────────── */

async function runEntry(opts: ExecutePlanOptions, dispatcher: Dispatcher | undefined, entry: PlanEntry): Promise<void> {
  const { kernel, projectId, runId, plan } = opts;
  const startedAt = performance.now();
  const maxAttempts = plan.policy.retry.maxAttempts;
  const retryOn = plan.policy.retry.on;

  // 提前收集本 entry 需要的 secret 名，一次性取值（不逐请求取）
  const secretNames = new Set<string>();
  for (const step of entry.steps) {
    if (step.kind !== 'request') continue;
    for (const text of [step.url, step.body ?? '', ...Object.values(step.headers ?? {})]) {
      for (const ref of parseRefs(text)) {
        if (ref.ns === 'secret') secretNames.add(ref.name);
      }
    }
  }
  const secrets: Record<string, string> = {};
  for (const name of secretNames) {
    const value = opts.secrets?.(name);
    if (value === undefined) {
      await append(opts, [{ kind: 'entry_started', entryId: entry.entryId, caseId: entry.caseId, paramRowLabel: entry.paramRowLabel, intent: entry.intent }]);
      await append(opts, [
        { kind: 'step_errored', entryId: entry.entryId, stepSeq: null, stepKind: null, reason: 'env_error', detail: `secret ${name} 未提供（钥匙串缺失？）` },
        { kind: 'entry_finished', entryId: entry.entryId, attempts: 1, durationMs: 0 },
      ]);
      return;
    }
    secrets[name] = value;
  }

  await append(opts, [
    { kind: 'entry_started', entryId: entry.entryId, caseId: entry.caseId, paramRowLabel: entry.paramRowLabel, intent: entry.intent },
  ]);

  // 每 entry 一个独立驱动实例（页面隔离：一个用例一个干净会话）
  const uiState: { driver: UiDriver | null } = { driver: null };

  let attempt = 0;
  try {
    for (;;) {
      attempt += 1;
      const outcome = await runAttempt(opts, dispatcher, entry, secrets, uiState);
      if (outcome.stepError === null && attempt < maxAttempts && shouldRetry(retryOn, outcome.retryReason)) {
        await append(opts, [
          { kind: 'retry_scheduled', entryId: entry.entryId, attempt: attempt + 1, reason: outcome.retryReason!, delayMs: backoffMs(plan, attempt) },
        ]);
        continue;
      }
      await append(opts, [
        { kind: 'entry_finished', entryId: entry.entryId, attempts: attempt, durationMs: Math.round(performance.now() - startedAt) },
      ]);
      return;
    }
  } finally {
    if (uiState.driver !== null) await uiState.driver.close().catch(() => {});
  }
}

interface AttemptOutcome {
  /** step 级错误（connect_failed 等）→ attempt 为 errored。 */
  stepError: StepErrorReason | null;
  /** 重试原因（stepError 或 http_5xx / assert_failed）。 */
  retryReason: StepErrorReason | null;
}

async function runAttempt(
  opts: ExecutePlanOptions,
  dispatcher: Dispatcher | undefined,
  entry: PlanEntry,
  secrets: Record<string, string>,
  uiState: { driver: UiDriver | null },
): Promise<AttemptOutcome> {
  const events: RunEventInput[] = [];
  const vars: Record<string, string> = {};
  let response: ObservedResponse | null = null;
  let assertSeq = 0;
  let hasFailedAssert = false;

  const ctx = { env: opts.env.variables, vars, secrets, params: entry.paramValues };

  for (const step of entry.steps) {
    if (opts.signal?.aborted) throw new AbortError();
    switch (step.kind) {
      case 'request': {
        try {
          // 相对 URL 以 env.baseUrl 为底（编译器已静态校验归属）
          const rawUrl = step.url.startsWith('/') ? opts.env.baseUrl + step.url : step.url;
          const url = resolveTemplate(rawUrl, ctx);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(step.headers ?? {})) headers[k] = resolveTemplate(v, ctx);
          const body = step.body === undefined ? undefined : resolveTemplate(step.body, ctx);

          // 每个请求发出前再过一次 urlguard（模板变量运行期才有值，用例可能是 SSRF 载体，08 §2.4）
          const guard = await checkUrl(url, 'permissive');
          if (!guard.ok) {
            events.push({ kind: 'step_errored', entryId: entry.entryId, stepSeq: stepIndex(entry, step), stepKind: 'request', reason: 'plan_invalid', detail: `urlguard 拒绝：${guard.reason}` });
            return flushAndReturn(opts, events, 'plan_invalid');
          }

          const maskedUrl = maskSecretValues(url, secrets);
          events.push({
            kind: 'request_sent',
            entryId: entry.entryId,
            stepSeq: stepIndex(entry, step),
            method: step.method,
            url: maskedUrl,
            headerNames: Object.keys(headers),
          });

          const t0 = performance.now();
          const requestTimeoutMs = step.timeoutMs ?? opts.plan.policy.timeoutMs;
          const sendOnce = (u: string): Promise<Awaited<ReturnType<typeof request>>> => {
            const ro: NonNullable<Parameters<typeof request>[1]> = {
              method: step.method,
              headers,
              // undici 的 parser 超时粒度约 1s（官方文档明言），精确超时由下面的 race 保证；
              // 这里仍设 bodyTimeout 兜底长尾
              headersTimeout: requestTimeoutMs,
              bodyTimeout: requestTimeoutMs,
            };
            if (body !== undefined) ro.body = body;
            if (dispatcher !== undefined) ro.dispatcher = dispatcher;
            // 精确超时：AbortController + 定时器（覆盖建立连接到响应头到达的全过程）
            const ac = new AbortController();
            const timer = setTimeout(() => {
              const te = new Error(`request exceeded ${requestTimeoutMs}ms`);
              te.name = 'TimeoutError';
              ac.abort(te);
            }, requestTimeoutMs);
            const onOuterAbort = () => {
              const ae = new Error('aborted');
              ae.name = 'AbortError';
              ac.abort(ae);
            };
            opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
            const inflight = request(u, { ...ro, signal: ac.signal }).finally(() => {
              clearTimeout(timer);
              opts.signal?.removeEventListener('abort', onOuterAbort);
            });
            return inflight;
          };

          // 手动跟随重定向：每一跳都过 urlguard（重定向是 SSRF 的经典载体）
          let currentUrl = url;
          let hops = 0;
          let res = await sendOnce(currentUrl);
          while (step.followRedirects === true && res.statusCode >= 300 && res.statusCode < 400 && hops < 10) {
            const location = headerOf(res.headers, 'location');
            if (location === null) break;
            const next = new URL(location, currentUrl).toString();
            const hopGuard = await checkUrl(next, 'permissive');
            if (!hopGuard.ok) {
              events.push({ kind: 'step_errored', entryId: entry.entryId, stepSeq: stepIndex(entry, step), stepKind: 'request', reason: 'plan_invalid', detail: `重定向目标被 urlguard 拒绝：${hopGuard.reason}` });
              return flushAndReturn(opts, events, 'plan_invalid');
            }
            await res.body.dump().catch(() => {});
            currentUrl = next;
            hops += 1;
            res = await sendOnce(currentUrl);
          }

          const { text, truncated } = await readCapped(res.body);
          const durationMs = Math.round(performance.now() - t0);

          let parsedBody: unknown = undefined;
          try {
            parsedBody = JSON.parse(text);
          } catch {
            /* 非 JSON 响应是合法观测 */
          }

          const rawCt = res.headers['content-type'];
          const contentType = (Array.isArray(rawCt) ? rawCt[0] : rawCt) ?? null;
          let bodyRef: string | null = null;
          if (Buffer.byteLength(text) > ARTIFACT_INLINE_MAX) {
            const art = await opts.kernel.call('artifact:put', {
              contentType,
              contentBase64: Buffer.from(text, 'utf8').toString('base64'),
            });
            bodyRef = art.sha256;
          }
          response = {
            status: res.statusCode,
            headers: flattenHeaders(res.headers),
            bodyText: text,
            durationMs,
            parsedBody,
          };
          void truncated;
          events.push({
            kind: 'response_received',
            entryId: entry.entryId,
            stepSeq: stepIndex(entry, step),
            status: res.statusCode,
            durationMs,
            bodyRef,
            bodySha256: bodyRef ?? quickSha(text),
          });
        } catch (err) {
          if (opts.signal?.aborted) throw new AbortError();
          const reason = classifyTransportError(err);
          events.push({ kind: 'step_errored', entryId: entry.entryId, stepSeq: stepIndex(entry, step), stepKind: 'request', reason, detail: detailOf(err) });
          return flushAndReturn(opts, events, reason);
        }
        break;
      }

      case 'assert': {
        const target = resolveTarget(step.target, response);
        const expected = step.expected === undefined ? undefined : resolveTemplate(step.expected, ctx);
        const evaluation = evaluateAssert(step.op, expected, target.value, target.found);
        if (!evaluation.passed && step.severity !== 'info') hasFailedAssert = true;
        events.push({
          kind: 'assert_evaluated',
          entryId: entry.entryId,
          assertSeq: assertSeq++,
          stepSeq: stepIndex(entry, step),
          severity: step.severity,
          expected: expected ?? '',
          actual: maskSecretValues(evaluation.actual, secrets), // 服务端可能回显凭据
          passed: evaluation.passed,
          principleId: step.principleId ?? null,
          sourceFile: step.sourceFile ?? null,
          sourceLine: step.sourceLine ?? null,
        });
        break;
      }

      case 'extract': {
        if (response === null) {
          events.push({ kind: 'step_errored', entryId: entry.entryId, stepSeq: stepIndex(entry, step), stepKind: 'extract', reason: 'plan_invalid', detail: 'extract 之前没有可用的响应' });
          return flushAndReturn(opts, events, 'plan_invalid');
        }
        const value = extractValue(step.from, response);
        vars[step.name] = value;
        // 写入门做模式脱敏；这里先做已知 secret 值掩码（08 §4.3 特例②：审计可读，传值在内存）
        events.push({ kind: 'var_extracted', entryId: entry.entryId, name: step.name, value: maskSecretValues(value, secrets) });
        break;
      }

      case 'wait': {
        await sleep(step.ms, opts.signal);
        break;
      }

      case 'script': {
        if (response === null) {
          events.push({ kind: 'step_errored', entryId: entry.entryId, stepSeq: stepIndex(entry, step), stepKind: 'script', reason: 'plan_invalid', detail: 'script 之前没有可用的响应' });
          return flushAndReturn(opts, events, 'plan_invalid');
        }
        const outcome = runScript(step.code, { response: toSandboxResponse(response), vars }, step.timeoutMs ?? opts.plan.policy.scriptTimeoutMs);
        if (!outcome.ok) {
          events.push({ kind: 'step_errored', entryId: entry.entryId, stepSeq: stepIndex(entry, step), stepKind: 'script', reason: outcome.reason, detail: outcome.detail });
          return flushAndReturn(opts, events, outcome.reason);
        }
        if (!outcome.returned) {
          hasFailedAssert = true;
          events.push({
            kind: 'assert_evaluated',
            entryId: entry.entryId,
            assertSeq: assertSeq++,
            stepSeq: stepIndex(entry, step),
            severity: step.severity ?? 'major',
            expected: 'truthy',
            actual: JSON.stringify(outcome.returned),
            passed: false,
            principleId: null,
            sourceFile: null,
            sourceLine: null,
          });
        }
        break;
      }

      case 'db_check': {
        if (opts.dbChecker === undefined) {
          events.push({ kind: 'step_errored', entryId: entry.entryId, stepSeq: stepIndex(entry, step), stepKind: 'db_check', reason: 'db_check_error', detail: '未配置数据库采样器（dbChecker）' });
          return flushAndReturn(opts, events, 'db_check_error');
        }
        const dbT0 = performance.now();
        try {
          const result = await opts.dbChecker.query(opts.projectId, step.connection, step.query);
          const durationMs = Math.round(performance.now() - dbT0);
          const er = step.expectRows;
          let passed = true;
          if (er.eq !== undefined && result.rowCount !== er.eq) passed = false;
          if (er.gte !== undefined && result.rowCount < er.gte) passed = false;
          if (er.lte !== undefined && result.rowCount > er.lte) passed = false;
          if (!passed) hasFailedAssert = true;
          events.push({
            kind: 'db_checked',
            entryId: entry.entryId,
            stepSeq: stepIndex(entry, step),
            connection: step.connection,
            rowCount: result.rowCount,
            durationMs,
            firstRowSample: result.firstRow === null ? null : JSON.stringify(result.firstRow).slice(0, 2000),
          });
          events.push({
            kind: 'assert_evaluated',
            entryId: entry.entryId,
            assertSeq: assertSeq++,
            stepSeq: stepIndex(entry, step),
            severity: 'major',
            expected: JSON.stringify(er),
            actual: String(result.rowCount),
            passed,
            principleId: null,
            sourceFile: null,
            sourceLine: null,
          });
        } catch (err) {
          events.push({ kind: 'step_errored', entryId: entry.entryId, stepSeq: stepIndex(entry, step), stepKind: 'db_check', reason: 'db_check_error', detail: String((err as Error).message).slice(0, 4000) });
          return flushAndReturn(opts, events, 'db_check_error');
        }
        break;
      }

      default: {
        // UI 步骤族（编译器已保证同族；防御：response 分支不会进入这里）
        if (!step.kind.startsWith('ui_')) throw new Error(`unhandled step kind: ${String(step.kind)}`);
        if (opts.uiDriver === undefined) {
          events.push({ kind: 'step_errored', entryId: entry.entryId, stepSeq: stepIndex(entry, step), stepKind: step.kind, reason: 'ui_driver_unavailable', detail: '未配置 UI 驱动（uiDriver）' });
          return flushAndReturn(opts, events, 'ui_driver_unavailable');
        }
        if (uiState.driver === null) {
          try {
            uiState.driver = await opts.uiDriver.create();
          } catch (err) {
            events.push({ kind: 'step_errored', entryId: entry.entryId, stepSeq: stepIndex(entry, step), stepKind: step.kind, reason: 'ui_driver_unavailable', detail: String((err as Error).message).slice(0, 4000) });
            return flushAndReturn(opts, events, 'ui_driver_unavailable');
          }
        }
        const uiCtx = {
          kernel: opts.kernel,
          projectId: opts.projectId,
          entryId: entry.entryId,
          baseUrl: opts.env.baseUrl,
          defaultTimeoutMs: opts.plan.policy.timeoutMs,
          signal: opts.signal === undefined ? undefined : { get aborted(): boolean { return opts.signal!.aborted; } },
        };
        const outcome = await executeUiStep(uiCtx, uiState.driver, step as UiStepSpec, stepIndex(entry, step), assertSeq, secrets);
        if (outcome.ok) {
          for (const ev of outcome.events) {
            events.push(ev);
            if (ev.kind === 'assert_evaluated') assertSeq += 1;
          }
          if (outcome.failedAssert) hasFailedAssert = true;
        } else {
          if (outcome.events.length > 0) events.push(...outcome.events);
          events.push({ kind: 'step_errored', entryId: entry.entryId, stepSeq: stepIndex(entry, step), stepKind: step.kind, reason: outcome.reason, detail: outcome.detail });
          return flushAndReturn(opts, events, outcome.reason);
        }
        break;
      }
    }
  }

  await append(opts, events);
  const retryReason: StepErrorReason | null = response !== null && response.status >= 500 ? 'http_5xx' : hasFailedAssert ? 'assert_failed' : null;
  return { stepError: null, retryReason };
}

/* ─────────────── 辅助 ─────────────── */

class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

function stepIndex(entry: PlanEntry, step: StepSpec): number {
  return entry.steps.indexOf(step);
}

/** 错误也必须留痕：先把本 attempt 已缓冲的观测落库，再返回结局（03 §5.2：先落盘再发事件）。 */
async function flushAndReturn(opts: ExecutePlanOptions, events: RunEventInput[], reason: StepErrorReason): Promise<AttemptOutcome> {
  await append(opts, events);
  return { stepError: reason, retryReason: reason };
}

async function append(opts: ExecutePlanOptions, events: RunEventInput[]): Promise<void> {
  if (events.length === 0) return;
  await opts.kernel.call('run:appendEvents', { projectId: opts.projectId, runId: opts.runId, events });
}

function shouldRetry(retryOn: StepErrorReason[] | 'any', reason: StepErrorReason | null): boolean {
  if (reason === null) return false;
  return retryOn === 'any' || retryOn.includes(reason);
}

function backoffMs(plan: RunPlan, attempt: number): number {
  const base = plan.policy.retry.backoff === 'exponential' ? 200 * 2 ** (attempt - 1) : 200;
  const capped = Math.min(base, 30_000);
  if (!plan.policy.retry.jitter) return capped;
  return Math.round(capped * (0.8 + Math.random() * 0.4));
}

async function readCapped(body: AsyncIterable<Uint8Array> & { destroy?: () => void }): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > BODY_CAP_BYTES) {
      truncated = true;
      chunks.push(Buffer.from(chunk.subarray(0, Math.max(0, BODY_CAP_BYTES - (size - chunk.byteLength)))));
      body.destroy?.();
      break;
    }
    chunks.push(Buffer.from(chunk));
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function headerOf(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  if (key === undefined) return null;
  const v = headers[key];
  return Array.isArray(v) ? (v[0] ?? null) : v ?? null;
}

function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = Array.isArray(v) ? v.join(', ') : v ?? '';
  }
  return out;
}

function extractValue(
  from: { kind: 'status' } | { kind: 'header'; name: string } | { kind: 'body_json'; path: string } | { kind: 'body_text' },
  res: ObservedResponse,
): string {
  switch (from.kind) {
    case 'status':
      return String(res.status);
    case 'header': {
      const key = Object.keys(res.headers).find((k) => k.toLowerCase() === from.name.toLowerCase());
      return key === undefined ? '' : res.headers[key]!;
    }
    case 'body_json': {
      const v = resolveTarget({ kind: 'body_json', path: from.path }, res);
      if (!v.found) return '';
      const value = v.value;
      // 标量直接字符串化（"o_123" 而不是 "\"o_123\""）；结构体保持 JSON
      return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    case 'body_text':
      return res.bodyText;
  }
}

function toSandboxResponse(res: ObservedResponse) {
  return { status: res.status, headers: res.headers, body: res.parsedBody, bodyText: res.bodyText, durationMs: res.durationMs };
}

function classifyTransportError(err: unknown): StepErrorReason {
  const e = err as NodeJS.ErrnoException & { name?: string; code?: string; cause?: { code?: string; name?: string; message?: string } };
  if (e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError' || String(e?.cause?.message ?? '').includes('request exceeded')) return 'timed_out';
  if (e?.name === 'AbortError') return 'connect_failed';
  const code = e?.code ?? e?.cause?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_failed';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EPIPE') return 'connect_failed';
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' || code === 'ETIMEDOUT' || e?.name === 'TimeoutError') return 'timed_out';
  if (code.includes('TLS') || code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'CERT_HAS_EXPIRED') return 'tls_error';
  return 'connect_failed';
}

function detailOf(err: unknown): string {
  const e = err as { message?: string; code?: string };
  return `${e?.code ?? ''} ${e?.message ?? String(err)}`.trim().slice(0, 4000);
}

function maskSecretValues(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const value of Object.values(secrets)) {
    if (value.length >= 4) out = out.split(value).join('<secret>');
  }
  return out;
}

function quickSha(text: string): string {
  // 仅作为响应体指纹（事件 payload）；artifact 内容寻址哈希在 artifact:put 内计算
  return createHash('sha256').update(text).digest('hex');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new AbortError());
      },
      { once: true },
    );
  });
}

