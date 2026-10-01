/**
 * RunDiff（04 §5.3）：两次运行对账。newFailures 排最前。
 */

import { describe, expect, it } from 'vitest';
import { assert, beginRun, entry, finished, request, response, retry, setupProject, stepErrored } from './helpers.ts';

describe('RunDiff 对账', () => {
  it('新失败 / 已修复 / 新不稳定 / 已稳定 / 耗时漂移', async () => {
    const s = await setupProject(3);
    const [caseX, caseY, caseZ] = s.caseIds;

    // base：X 过、Y 败、Z 稳定过
    const baseId = await beginRun(s);
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId: baseId,
      events: [
        entry('x', caseX!), response('x', 200, 100), assert('x'), finished('x', 1, 110),
        entry('y', caseY!), response('y'), assert('y', { passed: false }), finished('y', 1, 60),
        entry('z', caseZ!), response('z', 200, 100), assert('z'), finished('z', 1, 110),
      ],
    });
    await s.kernel.call('run:finish', { projectId: s.projectId, runId: baseId, status: 'completed' });

    // head：X 败（新失败）、Y 过（已修复）、Z 重试后过（新不稳定）
    const headId = await beginRun(s);
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId: headId,
      events: [
        entry('x', caseX!), response('x'), assert('x', { passed: false }), finished('x', 1, 80),
        entry('y', caseY!), response('y'), assert('y'), finished('y', 1, 55),
        entry('z', caseZ!),
        request('z'), stepErrored('z', 'timed_out'), retry('z', 2),
        response('z', 200, 200), assert('z'), finished('z', 2, 260),
      ],
    });
    await s.kernel.call('run:finish', { projectId: s.projectId, runId: headId, status: 'completed' });

    const diff = await s.kernel.call('run:diff', { projectId: s.projectId, baseRunId: baseId, headRunId: headId });

    expect(diff.newFailures.map((f) => f.entryId)).toEqual(['x']);
    expect(diff.fixedCases.map((f) => f.entryId)).toEqual(['y']);
    expect(diff.newlyFlaky.map((f) => f.entryId)).toEqual(['z']);
    expect(diff.stabilizedCases).toEqual([]);
    expect(diff.verdictChanged.length).toBe(2);
    // 尾部变慢被 p95 捕获（中位数会被快用例拉平）
    expect(diff.duration.p95DeltaMs).toBeGreaterThan(0);

    // newFailures 永远排最前（结构上独立字段，排序纪律由呈现层保证）
    expect(diff.newFailures[0]!.caseId).toBe(caseX);
    s.kernel.close();
  });
});
