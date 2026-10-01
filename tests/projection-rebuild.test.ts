/**
 * ★★ 旗舰测试：投影必须可从事件重建（06 §4.1，M1 出口标准 ④）。
 *
 * ① 记录一次丰富的运行（多用例 / 多参数行 / 重试 / flaky / 各级断言 / 豁免 / 覆盖 / 备注）
 * ② 快照投影行
 * ③ 删除全部投影行
 * ④ 从事件重建
 * ⑤ 逐字段比对：必须完全一致
 *
 * 这条测试通过，就证明了 P1「投影可从事件日志重建」不是口号。
 * 它必须在基座就建立——等有几百个运行、schema 改过几轮之后再补就再也补不上了。
 */

import { describe, expect, it } from 'vitest';
import { assert, beginRun, entry, finished, POLICY, request, response, retry, setupProject, stepErrored } from './helpers.ts';
import type { RunEventInput } from '../src/kernel/shared/domain.ts';

describe('投影重建（P1 的证明）', () => {
  it('从事件日志完整重建 case/step/assert 投影与 run 计数', async () => {
    const s = await setupProject(4);
    const [caseOk, caseBoundary, caseFlaky, caseWaived] = s.caseIds as [number, number, number, number];
    const runId = await beginRun(s);

    const batch1: RunEventInput[] = [
      // case 1：baseline 通过
      entry('ok-1', caseOk, 'baseline'),
      request('ok-1'),
      response('ok-1', 200, 42),
      assert('ok-1', { assertSeq: 0, severity: 'blocker', passed: true, expected: '200', actual: '200' }),
      finished('ok-1', 1, 55),

      // case 2：三个边界参数行（49999 过 / 50000 过 / 50001 拒绝失败）
      entry('bnd-1', caseBoundary, '金额=49999(内)'),
      request('bnd-1'),
      response('bnd-1', 200, 30),
      assert('bnd-1', { assertSeq: 0, severity: 'critical', passed: true, expected: '200', actual: '200', principleId: 7, sourceFile: 'order.controller.ts', sourceLine: 88 }),
      finished('bnd-1', 1, 40),
      entry('bnd-2', caseBoundary, '金额=50000(边界)'),
      request('bnd-2'),
      response('bnd-2', 200, 31),
      assert('bnd-2', { assertSeq: 0, severity: 'critical', passed: true, expected: '200', actual: '200' }),
      finished('bnd-2', 1, 41),
      entry('bnd-3', caseBoundary, '金额=50001(超限)'),
      request('bnd-3'),
      response('bnd-3', 200, 29),
      assert('bnd-3', { assertSeq: 0, severity: 'critical', passed: false, expected: '400', actual: '200', principleId: 7, sourceFile: 'order.controller.ts', sourceLine: 88 }),
      finished('bnd-3', 1, 39),
    ];
    await s.kernel.call('run:appendEvents', { projectId: s.projectId, runId, events: batch1 });

    const batch2: RunEventInput[] = [
      // case 3：首次失败重试后通过 → flaky
      entry('flk-1', caseFlaky, 'baseline'),
      request('flk-1'),
      response('flk-1', 500, 120),
      assert('flk-1', { assertSeq: 0, severity: 'major', passed: false, expected: '200', actual: '500' }),
      retry('flk-1', 2),
      request('flk-1'),
      response('flk-1', 200, 90),
      assert('flk-1', { assertSeq: 0, severity: 'major', passed: true, expected: '200', actual: '200' }),
      finished('flk-1', 2, 230),

      // case 4：连接失败 → errored；先跑一次再豁免
      entry('wv-1', caseWaived, 'baseline'),
      request('wv-1'),
      stepErrored('wv-1', 'connect_failed'),
      finished('wv-1', 1, 5),
    ];
    await s.kernel.call('run:appendEvents', { projectId: s.projectId, runId, events: batch2 });

    // 人工动作：备注 + 豁免（追加为事件，参与判定）
    await s.kernel.call('run:note', { projectId: s.projectId, runId, text: '环境当时在重启', by: 'kel' });
    await s.kernel.call('run:waiveCase', { projectId: s.projectId, runId, caseId: caseWaived, reason: '服务未部署', by: 'kel' });

    const run = await s.kernel.call('run:finish', { projectId: s.projectId, runId, status: 'completed' });
    expect(run.status).toBe('completed');
    expect(run.chainHash).toBeTruthy();

    // ① 快照
    const before = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(before.entries.length).toBe(6);

    // ②③ 删除投影（直接 SQL，模拟投影层损坏/丢失）
    s.kernel.db.exec('DELETE FROM case_result');
    s.kernel.db.exec('DELETE FROM step_result');
    s.kernel.db.exec('DELETE FROM assert_result');
    const emptied = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(emptied.entries.length).toBe(0);

    // ④ 重建
    const rebuilt = await s.kernel.call('run:rebuildProjections', { projectId: s.projectId, runId });
    expect(rebuilt.rebuilt).toBe(6);

    // ⑤ 逐字段一致
    const after = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(after.entries).toEqual(before.entries);
    expect(after.steps).toEqual(before.steps);
    expect(after.asserts).toEqual(before.asserts);

    const runAfter = await s.kernel.call('run:get', { projectId: s.projectId, runId });
    expect(runAfter!.counters).toEqual(run.counters);
    expect(runAfter!.chainHash).toBe(run.chainHash);

    // 判定语义抽查：豁免后 wv-1 为 skipped(waived)；flk-1 为 passed+flaky；bnd case 折叠为 failed
    const wv = after.entries.find((e) => e.entryId === 'wv-1')!;
    expect(wv.verdict).toBe('skipped');
    expect(wv.waived).toBe(true);
    const flk = after.entries.find((e) => e.entryId === 'flk-1')!;
    expect(flk.verdict).toBe('passed');
    expect(flk.flaky).toBe(true);
    expect(runAfter!.counters).toEqual({ total: 4, passed: 2, failed: 1, degraded: 0, errored: 0, skipped: 1, flaky: 1 });

    // 完整性校验通过
    const verify = await s.kernel.call('run:verify', { projectId: s.projectId, runId });
    expect(verify.ok).toBe(true);
    s.kernel.close();
  });

  it('事件内容不因重建改变（真源只读）', async () => {
    const s = await setupProject(1);
    const runId = await beginRun(s);
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId,
      events: [entry('e1', s.caseIds[0]!!), request('e1'), response('e1'), assert('e1'), finished('e1')],
    });
    await s.kernel.call('run:finish', { projectId: s.projectId, runId, status: 'completed' });
    const eventsBefore = await s.kernel.call('run:events', { projectId: s.projectId, runId });

    await s.kernel.call('run:rebuildProjections', { projectId: s.projectId, runId });

    const eventsAfter = await s.kernel.call('run:events', { projectId: s.projectId, runId });
    expect(eventsAfter).toEqual(eventsBefore);
    s.kernel.close();
  });
});
