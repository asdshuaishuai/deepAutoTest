/**
 * P5 项目即边界：跨项目读写返回空 / 拒绝，删除级联。
 */

import { describe, expect, it } from 'vitest';
import { assert, beginRun, entry, finished, response, setupProject } from './helpers.ts';

describe('P5 项目隔离', () => {
  it('跨项目查询返回空', async () => {
    const s = await setupProject(2);
    const other = await s.kernel.call('project:create', { name: 'user-service', sourceType: 'local' });

    const otherCases = await s.kernel.call('case:list', { projectId: other.id });
    expect(otherCases).toEqual([]);

    const otherRuns = await s.kernel.call('run:list', { projectId: other.id });
    expect(otherRuns).toEqual([]);

    const otherEnvs = await s.kernel.call('env:list', { projectId: other.id });
    expect(otherEnvs).toEqual([]);

    // A 项目的数据对 B 不可见（按 id 直查也为空）
    const stolen = await s.kernel.call('case:get', { projectId: other.id, caseId: s.caseIds[0]! });
    expect(stolen).toBeNull();
    s.kernel.close();
  });

  it('跨项目的 run 操作被拒绝', async () => {
    const s = await setupProject(1);
    const other = await s.kernel.call('project:create', { name: 'user-service', sourceType: 'local' });
    const runId = await beginRun(s);

    await expect(s.kernel.call('run:get', { projectId: other.id, runId })).resolves.toBeNull();
    await expect(
      s.kernel.call('run:appendEvents', { projectId: other.id, runId, events: [entry('e1', s.caseIds[0]!)] }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.kernel.call('run:finish', { projectId: other.id, runId, status: 'completed' })).rejects.toMatchObject({ code: 'not_found' });
    s.kernel.close();
  });

  it('删除项目 → 级联清理，无残留', async () => {
    const s = await setupProject(2);
    const runId = await beginRun(s);
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId,
      events: [
        entry('e1', s.caseIds[0]!),
        response('e1'),
        assert('e1'),
        finished('e1'),
        entry('e2', s.caseIds[1]!),
        response('e2'),
        assert('e2'),
        finished('e2'),
      ],
    });
    await s.kernel.call('run:finish', { projectId: s.projectId, runId, status: 'completed' });

    s.kernel.db.prepare('DELETE FROM project WHERE id = ?').run(s.projectId);

    const residue = {
      env: s.kernel.db.prepare('SELECT COUNT(*) AS n FROM env WHERE project_id = ?').get(s.projectId) as { n: number },
      cases: s.kernel.db.prepare('SELECT COUNT(*) AS n FROM test_case WHERE project_id = ?').get(s.projectId) as { n: number },
      runs: s.kernel.db.prepare('SELECT COUNT(*) AS n FROM run WHERE project_id = ?').get(s.projectId) as { n: number },
      events: s.kernel.db.prepare('SELECT COUNT(*) AS n FROM run_event WHERE run_id = ?').get(runId) as { n: number },
      results: s.kernel.db.prepare('SELECT COUNT(*) AS n FROM case_result WHERE run_id = ?').get(runId) as { n: number },
    };
    expect(residue.env.n).toBe(0);
    expect(residue.cases.n).toBe(0);
    expect(residue.runs.n).toBe(0);
    expect(residue.events.n).toBe(0);
    expect(residue.results.n).toBe(0);
    s.kernel.close();
  });
});
