/**
 * P3 人机协同状态机：AI 生成 ≠ 生效。
 */

import { describe, expect, it } from 'vitest';
import { setupProject, testKernel } from './helpers.ts';
import { applyEditsToPrinciple, applyEditsToRoute } from '../src/kernel/domain/review.ts';
import type { PrincipleRecord, RouteCandidateRecord } from '../src/kernel/shared/domain.ts';

/** 同步抛错的错误码提取（domain 纯函数用 code 断言，而不是匹配消息文案）。 */
function errCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? '(no code)';
  }
  return '(did not throw)';
}

const ROUTE: RouteCandidateRecord = {
  id: 1,
  projectId: 1,
  sourceIndexId: 1,
  method: 'GET',
  path: '/v1/orders',
  handlerFile: 'src/orders.ts',
  handlerLine: 10,
  framework: 'express',
  confidence: 'medium',
  status: 'proposed',
  docDrift: false,
  docMissing: false,
  proposedBy: 'ts-morph',
  reviewedBy: null,
  reviewedAtMs: null,
  diff: null,
};

const PRINCIPLE: PrincipleRecord = {
  id: 1,
  projectId: 1,
  subject: '订单金额为正数',
  rule: 'amount > 0',
  valueJson: { type: 'number', min: 1 },
  sourceFile: 'src/orders.ts',
  sourceLine: 42,
  layer: 'validation',
  confidence: 'high',
  status: 'proposed',
  conflictJson: null,
  proposedBy: 'fx-agent',
  reviewedBy: null,
  reviewedAtMs: null,
  diff: null,
};

const DRAFT = {
  name: '订单幂等性验证',
  description: null as string | null,
  routeId: null as number | null,
  paramKind: 'single' as const,
  steps: [{ id: 's1', seq: 0, kind: 'request' as const, config: {} }],
  params: { kind: 'single' as const, rows: [{ label: 'baseline', values: {}, intent: 'baseline' as const }] },
  provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
  policyOverride: null,
  tags: [],
};

describe('P3 状态机', () => {
  it('Agent 提议 → 只能是 proposed；不存在任何参数能直接产出 adopted', async () => {
    const s = await setupProject();
    const c = await s.kernel.call('case:propose', { projectId: s.projectId, proposedBy: 'fx-agent', draft: DRAFT });
    expect(c.status).toBe('proposed');
    expect(c.proposedBy).toBe('fx-agent');
    expect(c.reviewedBy).toBeNull();
    // 契约里 case:propose 没有 status 参数——AI 提议路径结构上无法指定终态
    s.kernel.close();
  });

  it('人工采纳 → adopted + 留痕', async () => {
    const s = await setupProject();
    const c = await s.kernel.call('case:propose', { projectId: s.projectId, proposedBy: 'fx-agent', draft: DRAFT });
    const adopted = await s.kernel.call('case:review', { projectId: s.projectId, caseId: c.id, action: 'adopt', actor: 'kel' });
    expect(adopted.status).toBe('adopted');
    expect(adopted.reviewedBy).toBe('kel');
    expect(adopted.reviewedAtMs).toBeGreaterThan(0);
    s.kernel.close();
  });

  it('裁决必须具名（空 actor 拒绝）——匿名裁决不可审计', async () => {
    const s = await setupProject();
    const c = await s.kernel.call('case:propose', { projectId: s.projectId, proposedBy: 'fx-agent', draft: DRAFT });
    await expect(
      s.kernel.call('case:review', { projectId: s.projectId, caseId: c.id, action: 'adopt', actor: '' }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    // 领域层同样兜底：applyReview 拒绝空 actor
    const c2 = await s.kernel.call('case:propose', { projectId: s.projectId, proposedBy: 'fx-agent', draft: DRAFT });
    const record = await s.kernel.call('case:get', { projectId: s.projectId, caseId: c2.id });
    expect(record!.status).toBe('proposed');
    s.kernel.close();
  });

  it('人工修改后采纳 → diff 留痕且内容真实应用（07 §5.2 就地编辑）', async () => {
    const s = await setupProject();
    const c = await s.kernel.call('case:propose', { projectId: s.projectId, proposedBy: 'fx-agent', draft: DRAFT });

    await expect(
      s.kernel.call('case:review', { projectId: s.projectId, caseId: c.id, action: 'edit', actor: 'kel', edits: [] }),
    ).rejects.toMatchObject({ code: 'edits_required' });

    const edited = await s.kernel.call('case:review', {
      projectId: s.projectId,
      caseId: c.id,
      action: 'edit',
      actor: 'kel',
      edits: [{ path: 'name', from: '订单幂等性验证', to: '订单幂等性验证（人工修订）' }],
    });
    expect(edited.status).toBe('adopted');
    expect(edited.diff).toMatchObject({
      editedBy: 'kel',
      fields: [{ path: 'name', from: '订单幂等性验证', to: '订单幂等性验证（人工修订）' }],
    });
    // ★ 内容真的变了（不只是记录）
    expect(edited.name).toBe('订单幂等性验证（人工修订）');
    s.kernel.close();
  });

  it('拒绝是终态；复活须走新的 proposed 版本', async () => {
    const s = await setupProject();
    const c = await s.kernel.call('case:propose', { projectId: s.projectId, proposedBy: 'fx-agent', draft: DRAFT });
    const rejected = await s.kernel.call('case:review', { projectId: s.projectId, caseId: c.id, action: 'reject', actor: 'kel' });
    expect(rejected.status).toBe('rejected');

    await expect(
      s.kernel.call('case:review', { projectId: s.projectId, caseId: c.id, action: 'adopt', actor: 'kel' }),
    ).rejects.toMatchObject({ code: 'invalid_transition' });

    // 重提 = 新记录（新的 proposed）
    const c2 = await s.kernel.call('case:propose', { projectId: s.projectId, proposedBy: 'fx-agent', draft: DRAFT });
    expect(c2.id).not.toBe(c.id);
    expect(c2.status).toBe('proposed');
    s.kernel.close();
  });

  it('matrix 参数行超限 → 拒绝而不是静默截断（"测过了"必须是真话）', async () => {
    const s = await setupProject();
    const rows = Array.from({ length: 40 }, (_, i) => ({ label: `r${i}`, values: {}, intent: 'baseline' as const }));
    await expect(
      s.kernel.call('case:propose', {
        projectId: s.projectId,
        proposedBy: 'fx-agent',
        draft: { ...DRAFT, paramKind: 'matrix', params: { kind: 'matrix', rows } },
      }),
    ).rejects.toMatchObject({ code: 'matrix_rows_exceeded' });
    s.kernel.close();
  });
});

describe('P3 route/principle 就地编辑（applyEditsToRoute / applyEditsToPrinciple）', () => {
  it('route 白名单：path/method/confidence 可改；framework 等溯源字段拒绝', () => {
    const out = applyEditsToRoute(ROUTE, [
      { path: 'method', from: 'GET', to: 'POST' },
      { path: 'confidence', from: 'medium', to: 'high' },
    ]);
    expect(out).toMatchObject({ method: 'POST', confidence: 'high', path: '/v1/orders' });
    // 不可编辑字段原样带出，供整体重校验
    expect(out).toMatchObject({ handlerFile: 'src/orders.ts', handlerLine: 10, framework: 'express' });

    expect(errCode(() => applyEditsToRoute(ROUTE, [{ path: 'framework', from: 'express', to: 'fastify' }]))).toBe('invalid_edit');
    expect(errCode(() => applyEditsToRoute(ROUTE, [{ path: 'handlerFile', from: 'src/orders.ts', to: 'x.ts' }]))).toBe('invalid_edit');
    expect(errCode(() => applyEditsToRoute(ROUTE, [{ path: 'id', from: 1, to: 2 }]))).toBe('invalid_edit');
  });

  it('principle 白名单：subject/rule/valueJson 可改（含嵌套 valueJson.min）；溯源字段拒绝', () => {
    const out = applyEditsToPrinciple(PRINCIPLE, [
      { path: 'subject', from: '订单金额为正数', to: '订单金额 ≥ 0.01' },
      { path: 'valueJson.min', from: 1, to: 0.01 },
    ]);
    expect(out).toMatchObject({ subject: '订单金额 ≥ 0.01', rule: 'amount > 0' });
    expect(out.valueJson).toEqual({ type: 'number', min: 0.01 });
    expect(out).toMatchObject({ sourceFile: 'src/orders.ts', sourceLine: 42, layer: 'validation' });

    expect(errCode(() => applyEditsToPrinciple(PRINCIPLE, [{ path: 'sourceFile', from: 'src/orders.ts', to: 'x.ts' }]))).toBe('invalid_edit');
    expect(errCode(() => applyEditsToPrinciple(PRINCIPLE, [{ path: 'sourceLine', from: 42, to: 43 }]))).toBe('invalid_edit');
    expect(errCode(() => applyEditsToPrinciple(PRINCIPLE, [{ path: 'layer', from: 'validation', to: 'sample' }]))).toBe('invalid_edit');
  });

  it('stale_edit：from 与当前值不符即拒；多编辑中任一失败 → 输入记录不被部分改写（回滚语义）', () => {
    const snapshot = JSON.stringify(ROUTE);
    // 第一个编辑合法、第二个基线陈旧 → 整体失败，没有任何"半套用"的内容逃逸
    expect(errCode(() =>
      applyEditsToRoute(ROUTE, [
        { path: 'path', from: '/v1/orders', to: '/v2/orders' },
        { path: 'method', from: 'PUT', to: 'POST' },
      ]),
    )).toBe('stale_edit');
    expect(JSON.stringify(ROUTE)).toBe(snapshot);

    // 值级嵌套同样受基线保护：valueJson.min 当前是 1，基于 999 的编辑被拒
    expect(errCode(() => applyEditsToPrinciple(PRINCIPLE, [{ path: 'valueJson.min', from: 999, to: 0 }]))).toBe('stale_edit');
    // valueJson 为 null 时嵌套编辑无从谈起 → stale_edit（而不是静默当成 undefined 匹配）
    const noValue: PrincipleRecord = { ...PRINCIPLE, valueJson: null };
    expect(errCode(() => applyEditsToPrinciple(noValue, [{ path: 'valueJson.min', from: 1, to: 0.01 }]))).toBe('stale_edit');
  });

  it('重校验失败回滚（kernel 层）：edit 应用后草稿非法 → 整体拒绝且不落半成品', async () => {
    const h = testKernel();
    const p = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const idx = await h.kernel.call('source:recordIndex', { projectId: p.id, fileCount: 1, frameworks: ['express'] });
    await h.kernel.call('route:proposeBatch', {
      projectId: p.id,
      sourceIndexId: idx.id,
      proposedBy: 'ts-morph',
      routes: [{ method: 'POST', path: '/v1/orders', handlerFile: 'src/orders.ts', handlerLine: 10, framework: 'express', confidence: 'medium' }],
    });
    const r = (await h.kernel.call('route:list', { projectId: p.id }))[0]!;

    // 编辑面合法、基线也对，但产物 path 不以 / 开头 → validateRouteDraft 在持久化前拒绝
    await expect(
      h.kernel.call('route:review', {
        projectId: p.id, routeId: r.id, action: 'edit', actor: 'kel',
        edits: [{ path: 'path', from: '/v1/orders', to: 'orders-no-slash' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });

    const unchanged = await h.kernel.call('route:list', { projectId: p.id });
    expect(unchanged.find((x) => x.id === r.id)).toMatchObject({ status: 'proposed', path: '/v1/orders', diff: null });

    // principle 同构：subject 改空 → requireString 拒绝 → 记录原样
    await h.kernel.call('principle:proposeBatch', {
      projectId: p.id,
      proposedBy: 'fx-agent',
      principles: [
        { subject: '订单金额为正数', rule: 'amount > 0', valueJson: null, sourceFile: 'src/orders.ts', sourceLine: 42, layer: 'validation', confidence: 'high' },
      ],
    });
    const pr = (await h.kernel.call('principle:list', { projectId: p.id }))[0]!;
    await expect(
      h.kernel.call('principle:review', {
        projectId: p.id, principleId: pr.id, action: 'edit', actor: 'kel',
        edits: [{ path: 'subject', from: '订单金额为正数', to: '' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    const pAfter = await h.kernel.call('principle:list', { projectId: p.id });
    expect(pAfter.find((x) => x.id === pr.id)).toMatchObject({ status: 'proposed', subject: '订单金额为正数', diff: null });
    h.dispose();
  });
});
