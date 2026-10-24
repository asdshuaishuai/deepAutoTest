/**
 * 事件日志写入门：append-only 纪律、生命周期守卫、原子性、链哈希防篡改。
 */

import { describe, expect, it } from 'vitest';
import { assert, beginRun, entry, finished, policy, request, response, setupProject } from './helpers.ts';

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

describe('真相层守卫加固（P1）', () => {
  it('伪造保留键 seq/runId/atMs：静默剥离，仍按 MAX+1 落库，完整性不受损', async () => {
    const s = await setupProject(1);
    const runId = await beginRun(s);
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId,
      events: [entry('e1', s.caseIds[0]!), request('e1')],
    });
    // 带合法 text/by（str 校验先于剥离）；seq:99 若透传将造成永久 seq_gap
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId,
      events: [{ kind: 'note', entryId: null, seq: 99, runId: 777, atMs: 1, text: '伪造 seq', by: 'attacker' }],
    });
    const events = await s.kernel.call('run:events', { projectId: s.projectId, runId });
    // run_started + entry_started + request_sent + note = 4 条；note 落在 MAX+1=4，99 未透传
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(events[events.length - 1]!.kind).toBe('note');
    const v = await s.kernel.call('run:verify', { projectId: s.projectId, runId });
    expect(v.ok).toBe(true);
    s.kernel.close();
  });

  it('伪造他项目 runId：走私键被剥离，受害 run 的事件数与完整性不变（P5）', async () => {
    const s = await setupProject(1);
    const other = await s.kernel.call('project:create', { name: 'victim', sourceType: 'local' });
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
    const victimRun = await s.kernel.call('run:begin', {
      projectId: other.id,
      envId: otherEnv.id,
      policy: policy({ concurrency: 1 }),
      seed: 1,
    });

    const runId = await beginRun(s);
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId,
      events: [entry('e1', s.caseIds[0]!), { ...response('e1'), runId: victimRun.runId }],
    });

    // A 的事件全部落在 A 自己的 runId 上
    const evA = await s.kernel.call('run:events', { projectId: s.projectId, runId });
    expect(evA.length).toBeGreaterThan(0);
    expect(evA.every((e) => e.runId === runId)).toBe(true);
    // 受害 run 只有 run_started，未被走私污染
    const evB = await s.kernel.call('run:events', { projectId: other.id, runId: victimRun.runId });
    expect(evB.map((e) => e.kind)).toEqual(['run_started']);
    const vB = await s.kernel.call('run:verify', { projectId: other.id, runId: victimRun.runId });
    expect(vB.ok).toBe(true);
    s.kernel.close();
  });

  it('entry 终态守卫：entry_finished 后拒绝同 entry 观测与重复 entry_started，标注仍放行', async () => {
    const s = await setupProject(1);
    const runId = await beginRun(s);
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId,
      events: [entry('e1', s.caseIds[0]!), response('e1'), assert('e1'), finished('e1')],
    });

    // 终态后补写失败断言 → 拒绝，投影 verdict 不翻转
    await expect(
      s.kernel.call('run:appendEvents', {
        projectId: s.projectId,
        runId,
        events: [assert('e1', { passed: false, actual: '500' })],
      }),
    ).rejects.toMatchObject({ code: 'entry_already_finished' });
    const results = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(results.entries[0]!.verdict).toBe('passed');

    // 重复 entry_started → 拒绝
    await expect(
      s.kernel.call('run:appendEvents', {
        projectId: s.projectId,
        runId,
        events: [entry('e1', s.caseIds[0]!)],
      }),
    ).rejects.toMatchObject({ code: 'entry_already_finished' });

    // 批内累积：同一批 entry_finished 之后的观测 → 拒绝且整批不入库
    const before = (await s.kernel.call('run:events', { projectId: s.projectId, runId })).length;
    await expect(
      s.kernel.call('run:appendEvents', {
        projectId: s.projectId,
        runId,
        events: [entry('e2', s.caseIds[0]!), finished('e2'), response('e2')],
      }),
    ).rejects.toMatchObject({ code: 'entry_already_finished' });
    expect((await s.kernel.call('run:events', { projectId: s.projectId, runId })).length).toBe(before);

    // 标注类（note 带 entryId）仍放行
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId,
      events: [{ kind: 'note', entryId: 'e1', text: '事后补注', by: 'kel' }],
    });
    s.kernel.close();
  });

  it('未知字段拒绝：白名单外的键抛 invalid_params', async () => {
    const s = await setupProject(1);
    const runId = await beginRun(s);
    await expect(
      s.kernel.call('run:appendEvents', {
        projectId: s.projectId,
        runId,
        events: [{ kind: 'note', entryId: null, text: 'x', by: 'y', smuggled: { verdict: 'passed' } }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    s.kernel.close();
  });

  it('policy 跨字段约束：degraded 门槛严于 fail 门槛（倒序）→ 拒绝；等值=关闭降级，放行', async () => {
    const s = await setupProject(1);
    // 严格倒序：fail 门槛(minor) 低于 degraded 门槛(major) → degraded 层不可达，invalid_params
    await expect(
      s.kernel.call('run:begin', {
        projectId: s.projectId,
        envId: s.envId,
        policy: policy({ failOnSeverity: 'minor', degradedOnSeverity: 'major' }),
        seed: 1,
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    // 等值：『关闭降级』的合法语义
    const eq = await s.kernel.call('run:begin', {
      projectId: s.projectId,
      envId: s.envId,
      policy: policy({ failOnSeverity: 'blocker', degradedOnSeverity: 'blocker' }),
      seed: 1,
    });
    expect(eq.runId).toBeGreaterThan(0);
    // 正常序：fail 门槛(critical) 高于 degraded 门槛(minor)
    const ok = await s.kernel.call('run:begin', {
      projectId: s.projectId,
      envId: s.envId,
      policy: policy({ failOnSeverity: 'critical', degradedOnSeverity: 'minor' }),
      seed: 1,
    });
    expect(ok.runId).toBeGreaterThan(0);
    // 重判通道同样受约束
    const runId = await beginRun(s);
    await expect(
      s.kernel.call('run:rejudge', {
        projectId: s.projectId,
        runId,
        policy: policy({ failOnSeverity: 'minor', degradedOnSeverity: 'major' }),
        mode: 'preview',
        actor: 'kel',
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    s.kernel.close();
  });

  it('status 上限放宽到 [100,999]：response_received(999) 端到端落库，run 正常 finish，判定不受影响', async () => {
    const s = await setupProject(1);
    const runId = await beginRun(s);
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId,
      events: [entry('e1', s.caseIds[0]!), request('e1'), response('e1', 999), assert('e1'), finished('e1')],
    });
    await s.kernel.call('run:finish', { projectId: s.projectId, runId, status: 'completed' });

    const events = await s.kernel.call('run:events', { projectId: s.projectId, runId });
    expect(events.some((e) => e.kind === 'response_received' && (e as { status: number }).status === 999)).toBe(true);
    const results = await s.kernel.call('run:results', { projectId: s.projectId, runId });
    expect(results.entries[0]!.verdict).toBe('passed'); // status 只是观测，不参与判定
    const run = await s.kernel.call('run:get', { projectId: s.projectId, runId });
    expect(run!.status).toBe('completed');
    const v = await s.kernel.call('run:verify', { projectId: s.projectId, runId });
    expect(v.ok).toBe(true);
    s.kernel.close();
  });
});
