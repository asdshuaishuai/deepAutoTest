/**
 * 合成编排：拉取（adopted 原则 + 可测路由）→ 合成 → 经 kernel `case:propose` 落库。
 *
 * 与 analysis/scan 同样式：生产者在上层，产物一律 proposed（P3），kernel 只负责真相与门。
 */

import type { Kernel } from '../kernel/service.ts';
import type { PrincipleRecord, RouteCandidateRecord } from '../kernel/shared/domain.ts';
import { synthesizeBoundaryCases, type SynthesisSkip } from './case-synth.ts';

export interface SynthesizeResult {
  casesInserted: number;
  skipped: SynthesisSkip[];
  /** 参与合成的已采纳原则数。 */
  adoptedPrinciples: number;
}

export async function synthesizeAndPropose(kernel: Kernel, projectId: number, actor = 'synth:boundary'): Promise<SynthesizeResult> {
  const routes = await kernel.call('route:list', { projectId });
  const principles = await kernel.call('principle:list', { projectId });
  const adopted = principles.filter((p) => p.status === 'adopted');

  // 可测路由：已采纳，或 high 置信度（与 06 §3 uncoveredRoutes 的口径一致）
  const eligible = routes.filter((r) => r.status !== 'rejected' && (r.status === 'adopted' || r.confidence === 'high'));

  const skipped: SynthesisSkip[] = [];
  let casesInserted = 0;

  for (const route of eligible) {
    const result = synthesizeBoundaryCases(route as RouteCandidateRecord, adopted as PrincipleRecord[]);
    skipped.push(...result.skipped);
    for (const synth of result.cases) {
      await kernel.call('case:propose', {
        projectId,
        proposedBy: actor,
        draft: {
          ...synth.draft,
          description: synth.draft.description,
        },
      });
      casesInserted += 1;
    }
  }

  return { casesInserted, skipped, adoptedPrinciples: adopted.length };
}

export { synthesizeBoundaryCases, type SynthesizedCase, type SynthesisSkip } from './case-synth.ts';
export { boundaryValues, type BoundaryValues, type GeneratedRow } from './boundary.ts';
