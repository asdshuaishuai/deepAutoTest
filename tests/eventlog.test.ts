/**
 * 事件日志写入门：append-only 纪律、生命周期守卫、原子性、链哈希防篡改。
 */

import { describe, expect, it } from 'vitest';
import { assert, beginRun, entry, finished, request, response, setupProject } from './helpers.ts';

describe('事件日志写入门', () => {
  it('run_finished / run_started 不能经普通 append 写入', async () => {
    const s = await setupProject(1);
    const runId = await beginRun(s);
    await expect(
      s.kernel.call('run:appendEvents', {
        projectId: s.projectId,
        runId,
        events: [{ kind: 'run_finished', entryId: null, status: 'completed' }],
      }),
    ).rejects.toMatchObject({ code: 'lifecycle_event_reserved' });
    s.kernel.close();
  });

  it('entry 事件必须先 entry_started', async () => {
    const s = await setupProject(1);
    const runId = await beginRun(s);
    await expect(
      s.kernel.call('run:appendEvents', { projectId: s.projectId, runId, events: [response('ghost')] }),
    ).rejects.toMatchObject({ code: 'entry_not_started' });
    s.kernel.close();
  });

  it('批次中任一事件非法 → 整批不入库（验证先于写入）', async () => {
    const s = await setupProject(1);
    const runId = await beginRun(s);
    const before = (await s.kernel.call('run:events', { projectId: s.projectId, runId })).length;
    await expect(
      s.kernel.call('run:appendEvents', {
        projectId: s.projectId,
        runId,
        events: [entry('e1', s.caseIds[0]!), response('ghost-2')],
      }),
    ).rejects.toBeTruthy();
    const after = (await s.kernel.call('run:events', { projectId: s.projectId, runId })).length;
    expect(after).toBe(before); // 一条都没进来（含合法的 e1）
    s.kernel.close();
  });

  it('引用其它项目的用例 → 拒绝（P5）', async () => {
    const s = await setupProject(1);
    const other = await s.kernel.call('project:create', { name: 'another', sourceType: 'local' });
    const otherEnv = await s.kernel.call('env:create', { projectId: other.id, name: 'e', baseUrl: 'http://x' });
    const otherCase = await s.kernel.call('case:propose', {
      projectId: other.id,
      proposedBy: 'x',
      draft: {
        name: 'c', description: null, routeId: null, paramKind: 'single',
        steps: [{ id: 's', seq: 0, kind: 'request', config: {} }],
        params: { kind: 'single', rows: [{ label: 'l', values: {}, intent: 'baseline' }] },
        provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
        policyOverride: null, tags: [],
      },
    });
    void otherEnv;
    const runId = await beginRun(s);
    await expect(
      s.kernel.call('run:appendEvents', { projectId: s.projectId, runId, events: [entry('e1', otherCase.id)] }),
    ).rejects.toMatchObject({ code: 'case_not_in_project' });
    s.kernel.close();
  });

  it('终态运行只接受标注类事件', async () => {
    const s = await setupProject(1);
    const runId = await beginRun(s);
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId,
      events: [entry('e1', s.caseIds[0]!), response('e1'), assert('e1'), finished('e1')],
    });
    await s.kernel.call('run:finish', { projectId: s.projectId, runId, status: 'completed' });
    await expect(
      s.kernel.call('run:appendEvents', { projectId: s.projectId, runId, events: [entry('e2', s.caseIds[0]!)] }),
    ).rejects.toMatchObject({ code: 'run_not_active' });
    // note 仍可（事后标注是合法的）
    const r = await s.kernel.call('run:note', { projectId: s.projectId, runId, text: '这次是因为发版', by: 'kel' });
    expect(r.seq).toBeGreaterThan(0);
    s.kernel.close();
  });

  it('seq 严格单调连续；篡改（删行）被完整性校验检出', async () => {
    const s = await setupProject(1);
    const runId = await beginRun(s);
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId,
      events: [entry('e1', s.caseIds[0]!), request('e1'), response('e1'), assert('e1'), finished('e1')],
    });
    await s.kernel.call('run:finish', { projectId: s.projectId, runId, status: 'completed' });

    const events = await s.kernel.call('run:events', { projectId: s.projectId, runId });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

    const ok = await s.kernel.call('run:verify', { projectId: s.projectId, runId });
    expect(ok.ok).toBe(true);

    // 模拟误删中间事件（append-only 的对立面）
    s.kernel.db.prepare('DELETE FROM run_event WHERE run_id = ? AND seq = 3').run(runId);
    const broken = await s.kernel.call('run:verify', { projectId: s.projectId, runId });
    expect(broken.ok).toBe(false);
    expect(broken.reason).toBe('seq_gap');
    // 投影不可重建、不可重判
    await expect(s.kernel.call('run:rebuildProjections', { projectId: s.projectId, runId })).rejects.toMatchObject({ code: 'integrity_failed' });
    s.kernel.close();
  });

  it('篡改 payload（改写历史）被链哈希检出', async () => {
    const s = await setupProject(1);
    const runId = await beginRun(s);
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId,
      events: [entry('e1', s.caseIds[0]!), response('e1'), assert('e1'), finished('e1')],
    });
    await s.kernel.call('run:finish', { projectId: s.projectId, runId, status: 'completed' });

    // 把 actual=200 篡改为 999（事实被追溯修改）
    const row = s.kernel.db.prepare('SELECT seq, payload FROM run_event WHERE run_id = ? AND kind = ?').get(runId, 'assert_evaluated') as { seq: number; payload: string };
    const tampered = row.payload.replace('"actual":"200"', '"actual":"999"');
    s.kernel.db.prepare('UPDATE run_event SET payload = ? WHERE run_id = ? AND seq = ?').run(tampered, runId, row.seq);

    const v = await s.kernel.call('run:verify', { projectId: s.projectId, runId });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('hash_mismatch');
    s.kernel.close();
  });

  it('run 作废：追加 run_voided 事件并置位（不是删除）', async () => {
    const s = await setupProject(1);
    const runId = await beginRun(s);
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId,
      events: [entry('e1', s.caseIds[0]!), response('e1'), assert('e1'), finished('e1')],
    });
    await s.kernel.call('run:finish', { projectId: s.projectId, runId, status: 'completed' });
    await s.kernel.call('run:void', { projectId: s.projectId, runId, reason: '跑在了错误的环境上', by: 'kel' });

    const run = await s.kernel.call('run:get', { projectId: s.projectId, runId });
    expect(run!.voided).toBe(true);
    const kinds = (await s.kernel.call('run:events', { projectId: s.projectId, runId })).map((e) => e.kind);
    expect(kinds[kinds.length - 1]).toBe('run_voided'); // 事件仍在（撤销≠删除）
    s.kernel.close();
  });
});
