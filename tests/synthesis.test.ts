/**
 * 合成器单测：value_json → 边界行；路由×原则 → 用例草稿。
 */

import { describe, expect, it } from 'vitest';
import { boundaryValues } from '../src/synthesis/boundary.ts';
import { synthesizeBoundaryCases } from '../src/synthesis/case-synth.ts';
import type { PrincipleRecord, RouteCandidateRecord } from '../src/kernel/shared/domain.ts';

function principle(overrides: Partial<PrincipleRecord> = {}): PrincipleRecord {
  return {
    id: 7,
    projectId: 1,
    subject: 'CreateOrderSchema.amount',
    rule: '≤ 50000',
    valueJson: { type: 'number', integer: true, max: 50000 },
    sourceFile: 'src/schemas.ts',
    sourceLine: 4,
    layer: 'validation',
    confidence: 'high',
    status: 'adopted',
    conflictJson: null,
    proposedBy: 'ts-morph',
    reviewedBy: 'kel',
    reviewedAtMs: 1,
    diff: null,
    ...overrides,
  };
}

function route(overrides: Partial<RouteCandidateRecord> = {}): RouteCandidateRecord {
  return {
    id: 3,
    projectId: 1,
    sourceIndexId: 1,
    method: 'POST',
    path: '/orders',
    handlerFile: 'src/routes/orders.ts',
    handlerLine: 5,
    framework: 'express',
    confidence: 'high',
    status: 'proposed',
    docDrift: false,
    docMissing: false,
    proposedBy: 'ts-morph',
    reviewedBy: null,
    reviewedAtMs: null,
    diff: null,
    ...overrides,
  };
}

describe('边界值生成（语义严格对齐约束方向）', () => {
  it('数值上界：≤50000 → 49999/50000 合法，50001 越界', () => {
    const { valid, invalid } = boundaryValues('amount', { type: 'number', integer: true, max: 50000 });
    expect(valid.map((r) => r.value)).toEqual([49999, 50000]);
    expect(valid.map((r) => r.intent)).toEqual(['boundary_low', 'boundary_high']);
    expect(invalid.map((r) => r.value)).toEqual([50001]);
    expect(invalid[0]!.intent).toBe('invalid');
  });

  it('数值下界：min → 下界/上界内合法，低于下界越界', () => {
    const { valid, invalid } = boundaryValues('age', { type: 'number', min: 18 });
    expect(valid.map((r) => r.value)).toEqual([18, 19]);
    expect(invalid.map((r) => r.value)).toEqual([17]);
  });

  it('数值区间：min+max 双侧都生成', () => {
    const { valid, invalid } = boundaryValues('score', { type: 'number', min: 0, max: 100 });
    expect(valid.map((r) => r.value)).toEqual([99, 100, 0, 1]);
    expect(invalid.map((r) => r.value)).toEqual([101, -1]);
  });

  it('字符串长度：恰在上限合法，超长越界；恰在下限合法，过短越界（空串标 empty）', () => {
    const note = boundaryValues('note', { type: 'string', minLength: 1, maxLength: 200 });
    expect(note.valid.map((r) => String(r.value).length)).toEqual([200, 1]);
    expect(note.invalid.map((r) => String(r.value).length)).toEqual([201, 0]);
    expect(note.invalid[1]!.intent).toBe('empty');

    const min3 = boundaryValues('code', { type: 'string', minLength: 3 });
    expect(min3.invalid[0]!.value).toBe('xx'); // 长度 2 < 3
    expect(min3.invalid[0]!.intent).toBe('invalid');
  });

  it('枚举：成员逐行 + 域外值', () => {
    const ch = boundaryValues('channel', { type: 'enum', enum: ['APP', 'H5', 'MINI'] });
    expect(ch.valid.map((r) => r.value)).toEqual(['APP', 'H5', 'MINI']);
    expect(ch.invalid.map((r) => r.value)).toEqual(['__NOT_IN_ENUM__']);
  });

  it('邮箱：合法 + 非法形态', () => {
    const email = boundaryValues('email', { email: true });
    expect(email.valid[0]!.value).toBe('tester@example.com');
    expect(email.invalid[0]!.intent).toBe('malformed');
  });

  it('手机号正则：可生成；不可逆向的正则：不臆造（空）', () => {
    const phone = boundaryValues('phone', { type: 'string', pattern: '/^1[3-9]\\d{9}$/' });
    expect(phone.valid[0]!.value).toBe('13800000000');
    expect(phone.invalid[0]!.value).toBe('12345');

    const opaque = boundaryValues('sig', { type: 'string', pattern: '/^[A-Z0-9]{32}$/i' });
    expect(opaque.valid).toEqual([]);
    expect(opaque.invalid).toEqual([]);
  });

  it('无约束（valueJson=null）→ 空，不噪声', () => {
    expect(boundaryValues('x', null)).toEqual({ valid: [], invalid: [] });
  });
});

describe('用例合成', () => {
  it('从 adopted 原则生成「应通过」+「应拒绝」两个意图，断言带溯源', () => {
    const { cases, skipped } = synthesizeBoundaryCases(route(), [principle()]);
    expect(skipped).toEqual([]);
    expect(cases).toHaveLength(2);

    const [pass, reject] = cases as [(typeof cases)[number], (typeof cases)[number]];
    expect(pass.draft.name).toContain('（应通过）');
    expect(pass.draft.steps[1]!.config).toMatchObject({ op: 'lt', expected: '300', severity: 'major', principleId: 7 });
    expect(reject.draft.name).toContain('（应拒绝）');
    expect(reject.draft.steps[1]!.config).toMatchObject({ op: 'gte', expected: '400', severity: 'critical', principleId: 7, sourceFile: 'src/schemas.ts', sourceLine: 4 });

    // 溯源：断言 → 原则 → file:line
    expect(pass.draft.provenance.principles[0]).toEqual({
      principleId: 7,
      source: 'src/schemas.ts:4',
      rule: '≤ 50000',
      usedAs: 'boundary',
    });

    // POST + number → JSON body 不加引号
    expect(pass.draft.steps[0]!.config).toMatchObject({
      method: 'POST',
      url: '/orders',
      body: '{"amount":{{param.amount}}}',
    });
    // 参数行：label 可读、values 用末段参数名
    expect(pass.draft.params.rows[0]!.values).toEqual({ amount: 49999 });
  });

  it('GET/DELETE → query 参数；字符串值加引号', () => {
    const get = synthesizeBoundaryCases(route({ method: 'GET', path: '/users' }), [principle({ subject: 'QuerySchema.age', valueJson: { type: 'number', max: 150 } })]);
    expect(get.cases[0]!.draft.steps[0]!.config['url']).toBe('/users?age={{param.age}}');

    const noteCase = synthesizeBoundaryCases(route(), [principle({ valueJson: { type: 'string', maxLength: 20 } })]);
    expect(noteCase.cases[0]!.draft.steps[0]!.config['body']).toBe('{"amount":"{{param.amount}}"}');
  });

  it('未采纳（proposed）的原则不参与合成（P3）', () => {
    expect(synthesizeBoundaryCases(route(), [principle({ status: 'proposed' })]).cases).toEqual([]);
    expect(synthesizeBoundaryCases(route(), [principle({ status: 'rejected' })]).cases).toEqual([]);
  });

  it('路径含参数的路由跳过并上报原因（不臆造 id）', () => {
    const r = synthesizeBoundaryCases(route({ path: '/orders/:id' }), [principle()]);
    expect(r.cases).toEqual([]);
    expect(r.skipped[0]!.reason).toContain('路径含参数');
  });

  it('不可机读的约束上报原因，不静默丢', () => {
    const r = synthesizeBoundaryCases(route(), [principle({ subject: 'Sig.value', valueJson: { pattern: '/^[A-F0-9]{64}$/' }, rule: '匹配十六进制签名' })]);
    expect(r.cases).toEqual([]);
    expect(r.skipped[0]!.reason).toContain('无法生成边界值');
  });

  it('intent 保留语义（报表能说"2 个越界值中 1 个未按预期拒绝"）', () => {
    const { cases } = synthesizeBoundaryCases(route(), [principle()]);
    const reject = cases[1]!;
    expect(reject.draft.params.rows.map((r) => r.intent)).toEqual(['invalid']);
  });
});
