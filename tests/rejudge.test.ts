/**
 * 重判（04 §5）：preview 不写任何东西；apply 只覆盖投影、事件不动；
 * 重建（从事件）与 apply 后的投影一致 —— rejudged 事件本身参与判定。
 */

import { describe, expect, it } from 'vitest';
import { assert, beginRun, entry, finished, POLICY, response, setupProject } from './helpers.ts';
import { defaultRunPolicy } from '../src/kernel/shared/domain.ts';

describe('重判', () => {
  it('preview：算出 diff 但不写库', async () => {
    const s = await setupProject(2);
    const runId = await beginRun(s);
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId,
      events: [
        entry('minor-fail', s.caseIds[0]!, 'minor'),
        response('minor-fail'),
        assert('minor-fail', { severity: 'minor', passed: false }),
        finished('minor-fail'),
        entry('ok', s.caseIds[1]!),
        response('ok'),
        assert('ok'),
        finished('ok'),
      ],
    });
    await s.kernel.call('run:finish', { projectId: s.projectId, runId, status: 'completed' });

    const resultsBefore = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    const eventsBefore = await s.kernel.call('run:events', { projectId: s.projectId, runId });
    const runBefore = await s.kernel.call('run:get', { projectId: s.projectId, runId });

    // 新策略：minor 失败不再降级（degraded 门槛抬到 major → minor 落入"不影响判定"区间）
    const newPolicy = { ...defaultRunPolicy(), degradedOnSeverity: 'major' as const };
    const diff = await s.kernel.call('run:rejudge', { projectId: s.projectId, runId, policy: newPolicy, mode: 'preview', actor: 'kel' });

    expect(diff.changes).toEqual([
      { caseId: s.caseIds[0], entryId: 'minor-fail', paramRowLabel: 'minor', from: 'degraded', to: 'passed' },
    ]);

    // 什么都没写
    expect(await s.kernel.call('run:results', { projectId: s.projectId, runId })).toEqual(resultsBefore);
    expect(await s.kernel.call('run:events', { projectId: s.projectId, runId })).toEqual(eventsBefore);
    expect(await s.kernel.call('run:get', { projectId: s.projectId, runId })).toEqual(runBefore);
    s.kernel.close();
  });

  it('apply：投影更新、事件追加 rejudged、原始观测不动', async () => {
    const s = await setupProject(1);
    const runId = await beginRun(s);
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId,
      events: [
        entry('e1', s.caseIds[0]!),
        response('e1'),
        assert('e1', { severity: 'minor', passed: false, expected: '"X-Request-Id"', actual: 'absent' }),
        finished('e1'),
      ],
    });
    await s.kernel.call('run:finish', { projectId: s.projectId, runId, status: 'completed' });

    const newPolicy = { ...defaultRunPolicy(), degradedOnSeverity: 'major' as const };
    const diff = await s.kernel.call('run:rejudge', { projectId: s.projectId, runId, policy: newPolicy, mode: 'apply', actor: 'kel' });
    expect(diff.changes.length).toBe(1);

    const results = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(results.entries[0]!.verdict).toBe('passed');

    const events = await s.kernel.call('run:events', { projectId: s.projectId, runId });
    expect(events[events.length - 1]!.kind).toBe('rejudged');
    // 原始观测（assert actual）未被动过
    const assertEv = events.find((e) => e.kind === 'assert_evaluated')!;
    expect(assertEv.actual).toBe('absent');

    // 重建（从事件，含 rejudged）与 apply 后的投影一致
    await s.kernel.call('run:rebuildProjections', { projectId: s.projectId, runId });
    const rebuilt = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(rebuilt.entries[0]!.verdict).toBe('passed');

    const verify = await s.kernel.call('run:verify', { projectId: s.projectId, runId });
    expect(verify.ok).toBe(true);
    s.kernel.close();
  });

  it('事件不完整的运行不可重判', async () => {
    const s = await setupProject(1);
    const runId = await beginRun(s);
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId,
      events: [entry('e1', s.caseIds[0]!), response('e1'), assert('e1'), finished('e1')],
    });
    await s.kernel.call('run:finish', { projectId: s.projectId, runId, status: 'completed' });
    s.kernel.db.prepare('DELETE FROM run_event WHERE run_id = ? AND seq = 2').run(runId);
    await expect(
      s.kernel.call('run:rejudge', { projectId: s.projectId, runId, policy: POLICY, mode: 'preview', actor: 'kel' }),
    ).rejects.toMatchObject({ code: 'integrity_failed' });
    s.kernel.close();
  });
});
