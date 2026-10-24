/**
 * 中断点续跑（03 §7.3）：用**同一个 plan 快照**（seed 不变，参数化一致）+ 跳过已完成 entry。
 *
 * 已完成的判定依据：源运行里有 `entry_finished` 事件的 entry（无论 verdict——
 * failed 的也不重跑；重跑失败项是 retry 的语义，不是 resume 的语义）。
 * 续跑产出一个**新的 run**（事件日志 append-only：新事实写新日志，不改旧日志）。
 */

import type { Kernel } from '../kernel/service.ts';
import { KernelError } from '../kernel/shared/util.ts';
import type { PlanEntry, RunPlan } from './plan-types.ts';

export interface ResumeBuildResult {
  plan: RunPlan;
  sourceRunId: number;
  skippedDone: number;
}

export async function buildResumePlan(kernel: Kernel, projectId: number, sourceRunId: number, nowMs: number): Promise<ResumeBuildResult> {
  const run = await kernel.call('run:get', { projectId, runId: sourceRunId });
  if (run === null) throw new KernelError('not_found', `运行 ${sourceRunId} 不在当前项目内`);
  if (run.status === 'running') throw new KernelError('run_not_finished', '运行仍在进行；先取消或等待结束再续跑');

  const events = await kernel.call('run:events', { projectId, runId: sourceRunId, limit: 100_000 });
  const started = events.find((e) => e.kind === 'run_started') as { planSnapshot?: unknown } | undefined;
  const snapshot = started?.planSnapshot as RunPlan | undefined;
  if (snapshot === undefined || (snapshot as { version?: number }).version !== 1 || !Array.isArray((snapshot as { entries?: unknown }).entries)) {
    throw new KernelError('plan_snapshot_missing', `运行 ${sourceRunId} 没有 plan 快照（旧版运行或经 append 直建），无法续跑`);
  }

  const done = new Set(
    events.filter((e) => e.kind === 'entry_finished' && e.entryId !== null).map((e) => e.entryId as string),
  );
  const remaining = (snapshot.entries as PlanEntry[]).filter((e) => !done.has(e.entryId));

  const plan: RunPlan = {
    ...(snapshot as RunPlan),
    entries: remaining,
    compiledAtMs: nowMs,
    source: { ...snapshot.source, caseIds: [...new Set(remaining.map((e) => e.caseId))].sort((a, b) => a - b) },
  };

  return { plan, sourceRunId, skippedDone: done.size };
}
