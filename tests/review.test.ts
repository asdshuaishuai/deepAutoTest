/**
 * P3 人机协同状态机：AI 生成 ≠ 生效。
 */

import { describe, expect, it } from 'vitest';
import { setupProject } from './helpers.ts';

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

  it('人工修改后采纳 → 必须携带结构化 diff', async () => {
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
      edits: [
        { path: 'steps[0].expected', from: '"金额超限"', to: '"AMOUNT_EXCEEDED"' },
        { path: 'steps[0].severity', from: 'major', to: 'critical' },
      ],
    });
    expect(edited.status).toBe('adopted');
    expect(edited.diff).toMatchObject({
      editedBy: 'kel',
      fields: [
        { path: 'steps[0].expected', from: '"金额超限"', to: '"AMOUNT_EXCEEDED"' },
        { path: 'steps[0].severity', from: 'major', to: 'critical' },
      ],
    });
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
