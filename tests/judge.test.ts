/**
 * ★ 判定纯函数穷举测试 —— 04 §3.5 的十个用例 + 补充边界。
 * 纯函数的红利：无网络、无数据库、毫秒级。
 */

import { describe, expect, it } from 'vitest';
import { judgeRun } from '../src/kernel/domain/judge.ts';
import { POLICY, assert, entry, ev, finished, policy, request, response, retry, runFinished, runStarted, stepErrored } from './helpers.ts';

/** 标准包装：run_started + 事件 + run_finished，seq 自动编号。 */
function run(...inputs: ReturnType<typeof entry>[]): ReturnType<typeof judgeRun> {
  const all = [runStarted(), ...inputs, runFinished()];
  return judgeRun(1, all.map((e, i) => ev(i + 1, e)));
}

function verdictOf(j: ReturnType<typeof judgeRun>, entryId: string) {
  const e = j.entries.find((x) => x.entryId === entryId);
  if (e === undefined) throw new Error(`entry ${entryId} 不存在`);
  return e;
}

describe('04 §3.5 十个基准用例', () => {
  it('空事件 → incomplete（errored 语义）', () => {
    const j = judgeRun(1, []);
    expect(j.incomplete).toBe(true);
    expect(j.counters.total).toBe(0);
  });

  it('只有 run_started → incomplete', () => {
    const j = judgeRun(1, [ev(1, runStarted())]);
    expect(j.incomplete).toBe(true);
  });

  it('事件乱序 / seq 跳过 → corrupt=seq_gap', () => {
    const j = judgeRun(1, [ev(1, runStarted()), ev(3, entry('e1', 1))]);
    expect(j.corrupt).toBe('seq_gap');
  });

  it('一次通过 → passed', () => {
    const j = run(entry('e1', 1), response('e1'), assert('e1'), finished('e1'));
    expect(verdictOf(j, 'e1').verdict).toBe('passed');
    expect(verdictOf(j, 'e1').flaky).toBe(false);
  });

  it('fail 后 pass → passed + flaky', () => {
    const j = run(
      entry('e1', 1),
      response('e1'),
      assert('e1', { passed: false, actual: '500' }),
      retry('e1', 2),
      response('e1'),
      assert('e1', { passed: true }),
      finished('e1', 2),
    );
    const e = verdictOf(j, 'e1');
    expect(e.verdict).toBe('passed');
    expect(e.flaky).toBe(true);
  });

  it('三次 fail → failed（不 flaky）', () => {
    const j = run(
      entry('e1', 1),
      response('e1'),
      assert('e1', { passed: false }),
      retry('e1', 2),
      response('e1'),
      assert('e1', { passed: false }),
      retry('e1', 3),
      response('e1'),
      assert('e1', { passed: false }),
      finished('e1', 3),
    );
    const e = verdictOf(j, 'e1');
    expect(e.verdict).toBe('failed');
    expect(e.flaky).toBe(false);
    expect(e.attempts).toBe(3);
  });

  it('minor fail → degraded（不是 failed）', () => {
    const j = run(entry('e1', 1), response('e1'), assert('e1', { severity: 'minor', passed: false }), finished('e1'));
    expect(verdictOf(j, 'e1').verdict).toBe('degraded');
  });

  it('connect_failed → errored（★ 不是 failed：连不上 ≠ 服务有 bug）', () => {
    const j = run(entry('e1', 1), request('e1'), stepErrored('e1', 'connect_failed'), finished('e1'));
    expect(verdictOf(j, 'e1').verdict).toBe('errored');
  });

  it('被跳过 → skipped（run 取消且 entry 未完成）', () => {
    const all = [runStarted(), entry('e1', 1), runFinished('cancelled')];
    const j = judgeRun(1, all.map((e, i) => ev(i + 1, e)));
    expect(verdictOf(j, 'e1').verdict).toBe('skipped');
  });

  it('chainHash 不符 → corrupt=hash_mismatch', () => {
    const all = [runStarted(), entry('e1', 1), runFinished()];
    const j = judgeRun(1, all.map((e, i) => ev(i + 1, e)), { expectedChainHash: 'deadbeef' });
    expect(j.corrupt).toBe('hash_mismatch');
  });
});

describe('补充边界', () => {
  it('info 断言失败永不改变 verdict', () => {
    const j = run(entry('e1', 1), response('e1'), assert('e1', { severity: 'info', passed: false }), finished('e1'));
    expect(verdictOf(j, 'e1').verdict).toBe('passed');
    expect(verdictOf(j, 'e1').failedAsserts).toBe(0);
  });

  it('blocker 失败 → failed（最高档）', () => {
    const j = run(entry('e1', 1), response('e1'), assert('e1', { severity: 'blocker', passed: false }), finished('e1'));
    expect(verdictOf(j, 'e1').verdict).toBe('failed');
  });

  it('自定义策略 failOn=critical：major 失败降为 degraded', () => {
    const all = [
      runStarted(policy({ failOnSeverity: 'critical' })),
      entry('e1', 1),
      response('e1'),
      assert('e1', { severity: 'major', passed: false }),
      finished('e1'),
      runFinished(),
    ];
    const j = judgeRun(1, all.map((e, i) => ev(i + 1, e)));
    expect(verdictOf(j, 'e1').verdict).toBe('degraded');
  });

  it('entry 有 finished 但零观测 → errored', () => {
    const j = run(entry('e1', 1), finished('e1'));
    expect(verdictOf(j, 'e1').verdict).toBe('errored');
  });

  it('run 未取消且 entry 无终态 → errored(incomplete)', () => {
    const j = run(entry('e1', 1), response('e1'));
    expect(verdictOf(j, 'e1').verdict).toBe('errored');
    expect(j.incomplete).toBe(false); // run_finished 存在；entry 级不完整
  });

  it('重试全失败但原因不同 → failed + flaky（不稳定失败）', () => {
    const j = run(
      entry('e1', 1),
      request('e1'),
      stepErrored('e1', 'timed_out'),
      retry('e1', 2),
      response('e1'),
      assert('e1', { passed: false }),
      finished('e1', 2),
    );
    const e = verdictOf(j, 'e1');
    expect(e.verdict).toBe('failed');
    expect(e.flaky).toBe(true);
  });

  it('间歇性连接问题重试耗尽（末次 errored）→ errored + flaky', () => {
    const j = run(
      entry('e1', 1),
      request('e1'),
      stepErrored('e1', 'connect_failed'),
      retry('e1', 2),
      request('e1'),
      stepErrored('e1', 'connect_failed'),
      finished('e1', 2),
    );
    const e = verdictOf(j, 'e1');
    expect(e.verdict).toBe('errored');
    expect(e.flaky).toBe(false); // 两次原因相同 → 不算不稳定
  });

  it('case 折叠：部分参数行被跳过 → skipped（不掩盖未覆盖，也不算失败）', () => {
    const all = [
      runStarted(),
      entry('a', 1, 'baseline'),
      entry('b', 1, 'boundary_low'),
      response('a'),
      assert('a'),
      finished('a'),
      runFinished('cancelled'), // b 未完成 → skipped
    ];
    const j = judgeRun(1, all.map((e, i) => ev(i + 1, e)));
    const c = j.cases.find((x) => x.caseId === 1)!;
    expect(c.verdict).toBe('skipped');
    expect(c.executed).toBe(1);
    expect(c.total).toBe(2);
  });

  it('case 折叠：一个 entry flaky-pass → case = passed + flaky', () => {
    const all = [
      runStarted(),
      entry('a', 1, 'r1'),
      entry('b', 1, 'r2'),
      response('a'),
      assert('a', { passed: false }),
      retry('a', 2),
      response('a'),
      assert('a', { passed: true }),
      finished('a', 2),
      response('b'),
      assert('b'),
      finished('b'),
      runFinished(),
    ];
    const j = judgeRun(1, all.map((e, i) => ev(i + 1, e)));
    const c = j.cases.find((x) => x.caseId === 1)!;
    expect(c.verdict).toBe('passed');
    expect(c.flaky).toBe(true);
  });

  it('豁免（case_waived）→ skipped + waived', () => {
    const all = [
      runStarted(),
      entry('a', 1),
      response('a'),
      assert('a'),
      finished('a'),
      { kind: 'case_waived', entryId: null, caseId: 1, reason: '已知缺陷', by: 'kel', expiresAtMs: null },
      runFinished(),
    ];
    const j = judgeRun(1, all.map((e, i) => ev(i + 1, e as never)));
    const e = verdictOf(j, 'a');
    expect(e.verdict).toBe('skipped');
    expect(e.waived).toBe(true);
  });

  it('人工覆盖（case_overridden）保留：failed → passed', () => {
    const all = [
      runStarted(),
      entry('a', 1),
      response('a'),
      assert('a', { passed: false }),
      finished('a'),
      { kind: 'case_overridden', entryId: null, caseId: 1, from: 'failed', to: 'passed', reason: '环境特殊', by: 'kel' },
      runFinished(),
    ];
    const j = judgeRun(1, all.map((e, i) => ev(i + 1, e as never)));
    const c = j.cases.find((x) => x.caseId === 1)!;
    expect(c.verdict).toBe('passed');
    expect(verdictOf(j, 'a').overriddenTo).toBe('passed');
    expect(verdictOf(j, 'a').verdict).toBe('failed'); // 自身判定保留，覆盖单独标记
  });

  it('策略豁免 ignoreCaseIds → skipped（不标 waived）', () => {
    const all = [
      runStarted(policy({ ignoreCaseIds: [1] })),
      entry('a', 1),
      response('a'),
      assert('a'),
      finished('a'),
      runFinished(),
    ];
    const j = judgeRun(1, all.map((e, i) => ev(i + 1, e)));
    const e = verdictOf(j, 'a');
    expect(e.verdict).toBe('skipped');
    expect(e.waived).toBe(false);
  });

  it('counters 按用例级聚合', () => {
    const all = [
      runStarted(),
      entry('a', 1),
      response('a'),
      assert('a', { severity: 'minor', passed: false }),
      finished('a'),
      entry('b', 2),
      request('b'),
      stepErrored('b', 'connect_failed'),
      finished('b'),
      entry('c', 3),
      response('c'),
      assert('c'),
      finished('c'),
      runFinished(),
    ];
    const j = judgeRun(1, all.map((e, i) => ev(i + 1, e)));
    expect(j.counters).toEqual({ total: 3, passed: 1, failed: 0, degraded: 1, errored: 1, skipped: 0, flaky: 0 });
  });

  it('同一输入两次判定结果完全一致（纯函数）', () => {
    const all = [
      runStarted(),
      entry('a', 1),
      response('a'),
      assert('a', { passed: false }),
      retry('a', 2),
      response('a'),
      assert('a'),
      finished('a', 2),
      runFinished(),
    ];
    const events = all.map((e, i) => ev(i + 1, e));
    expect(judgeRun(1, events)).toEqual(judgeRun(1, events));
  });
});
