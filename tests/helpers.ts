/**
 * 测试助手：假时钟 + kernel 工厂 + 事件构造器。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, type Kernel } from '../src/kernel/index.ts';
import type { Clock } from '../src/kernel/shared/util.ts';
import type { RunEvent, RunEventInput, RunPolicy } from '../src/kernel/shared/domain.ts';
import { defaultRunPolicy } from '../src/kernel/shared/domain.ts';

export interface TestClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

export function fakeClock(startMs = 1_750_000_000_000): TestClock {
  let now = startMs;
  return {
    nowMs: () => now,
    set: (ms) => {
      now = ms;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

export interface KernelHandle {
  kernel: Kernel;
  clock: TestClock;
  dir: string;
  dispose(): void;
}

export function testKernel(): KernelHandle {
  const dir = mkdtempSync(join(tmpdir(), 'dat-kernel-'));
  const clock = fakeClock();
  const kernel = createKernel({ dataDir: dir, clock, memory: true });
  return { kernel, clock, dir, dispose: () => kernel.close() };
}

export const POLICY = defaultRunPolicy();

export function policy(overrides: Partial<RunPolicy> = {}): RunPolicy {
  return { ...defaultRunPolicy(), ...overrides };
}

/* ─────────────── 事件构造器（judge 单测直接构造 RunEvent） ─────────────── */

export function ev(seq: number, input: RunEventInput): RunEvent {
  return { runId: 1, seq, atMs: seq * 10, ...input } as RunEvent;
}

export function runStarted(p: RunPolicy = POLICY): RunEventInput {
  return { kind: 'run_started', entryId: null, policy: p, envId: 1, concurrency: p.concurrency, seed: 42 };
}

export function runFinished(status: 'completed' | 'cancelled' | 'errored' = 'completed'): RunEventInput {
  return { kind: 'run_finished', entryId: null, status };
}

export interface AssertOpts {
  severity?: 'blocker' | 'critical' | 'major' | 'minor' | 'info';
  passed?: boolean;
  assertSeq?: number;
  expected?: string;
  actual?: string;
  principleId?: number | null;
  sourceFile?: string | null;
  sourceLine?: number | null;
}

export function entry(eid: string, caseId: number, label = eid, intent: 'baseline' | 'boundary_low' | 'boundary_high' | 'invalid' = 'baseline'): RunEventInput {
  return { kind: 'entry_started', entryId: eid, caseId, paramRowLabel: label, intent };
}

export function request(eid: string, stepSeq = 0, url = 'http://127.0.0.1:3000/api/orders'): RunEventInput {
  return { kind: 'request_sent', entryId: eid, stepSeq, method: 'GET', url, headerNames: ['content-type'] };
}

export function response(eid: string, status = 200, durationMs = 50, stepSeq = 0, bodyRef: string | null = null): RunEventInput {
  return { kind: 'response_received', entryId: eid, stepSeq, status, durationMs, bodyRef, bodySha256: bodyRef };
}

export function assert(eid: string, o: AssertOpts = {}): RunEventInput {
  return {
    kind: 'assert_evaluated',
    entryId: eid,
    assertSeq: o.assertSeq ?? 0,
    stepSeq: 0,
    severity: o.severity ?? 'major',
    expected: o.expected ?? '200',
    actual: o.actual ?? '200',
    passed: o.passed ?? true,
    principleId: o.principleId ?? null,
    sourceFile: o.sourceFile ?? null,
    sourceLine: o.sourceLine ?? null,
  };
}

export function retry(eid: string, attempt: number, reason: 'connect_failed' | 'timed_out' | 'dns_failed' | 'tls_error' = 'connect_failed'): RunEventInput {
  return { kind: 'retry_scheduled', entryId: eid, attempt, reason, delayMs: 100 };
}

export function stepErrored(eid: string, reason: 'connect_failed' | 'timed_out' | 'dns_failed' | 'tls_error' | 'script_error' | 'host_crash', stepSeq: number | null = 0): RunEventInput {
  return { kind: 'step_errored', entryId: eid, stepSeq, stepKind: stepSeq === null ? null : 'request', reason, detail: null };
}

export function finished(eid: string, attempts = 1, durationMs = 60): RunEventInput {
  return { kind: 'entry_finished', entryId: eid, attempts, durationMs };
}

/* ─────────────── kernel 场景搭建 ─────────────── */

export interface SetupResult {
  kernel: Kernel;
  clock: TestClock;
  projectId: number;
  envId: number;
  caseIds: number[];
}

export async function setupProject(caseCount = 1): Promise<SetupResult> {
  const h = testKernel();
  const project = await h.kernel.call('project:create', { name: 'order-service', sourceType: 'local', localPath: '/tmp/repo' });
  const env = await h.kernel.call('env:create', { projectId: project.id, name: 'staging', baseUrl: 'http://127.0.0.1:3000' });
  const caseIds: number[] = [];
  for (let i = 0; i < caseCount; i++) {
    const c = await h.kernel.call('case:propose', {
      projectId: project.id,
      proposedBy: 'fx-agent',
      draft: {
        name: `case-${i}`,
        description: null,
        routeId: null,
        paramKind: 'single',
        steps: [{ id: 's1', seq: 0, kind: 'request', config: {} }],
        params: { kind: 'single', rows: [{ label: 'baseline', values: {}, intent: 'baseline' }] },
        provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
        policyOverride: null,
        tags: [],
      },
    });
    caseIds.push(c.id);
  }
  return { kernel: h.kernel, clock: h.clock, projectId: project.id, envId: env.id, caseIds };
}

export async function beginRun(s: SetupResult, p: RunPolicy = POLICY): Promise<number> {
  const r = await s.kernel.call('run:begin', { projectId: s.projectId, envId: s.envId, policy: p, seed: 42 });
  return r.runId;
}
