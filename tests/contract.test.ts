/**
 * Kernel 契约：方法白名单、错误形状、确定性调用。
 */

import { describe, expect, it } from 'vitest';
import { testKernel, type KernelHandle } from './helpers.ts';
import type { RouteCandidateRecord } from '../src/kernel/shared/domain.ts';

describe('Kernel 入口', () => {
  it('未知方法被拒绝（RPC 白名单）', async () => {
    const h = testKernel();
    await expect(h.kernel.call('shell:rm' as never, {} as never)).rejects.toMatchObject({ code: 'unknown_method' });
    h.dispose();
  });

  it('app:ping 返回版本', async () => {
    const h = testKernel();
    const res = await h.kernel.call('app:ping', {});
    expect(res.pong).toBe(true);
    expect(res.version).toBeTruthy();
    h.dispose();
  });

  it('入参形状校验（运行时，不是类型断言）', async () => {
    const h = testKernel();
    await expect(h.kernel.call('project:create', { name: '', sourceType: 'local' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(h.kernel.call('project:create', { name: 'x', sourceType: 'ftp' } as never)).rejects.toMatchObject({ code: 'invalid_params' });
    h.dispose();
  });

  it('不存在的项目 → not_found（scope 铸造失败）', async () => {
    const h = testKernel();
    await expect(h.kernel.call('env:list', { projectId: 999 })).rejects.toMatchObject({ code: 'not_found' });
    h.dispose();
  });
});

describe('run:resume 归属校验（P5：与 run:pause 对齐）', () => {
  it('项目 B 身份不能解除项目 A 运行的暂停（跨项目 → not_found，暂停保持）', async () => {
    const h = testKernel();
    const pa = await h.kernel.call('project:create', { name: 'A', sourceType: 'local' });
    const pb = await h.kernel.call('project:create', { name: 'B', sourceType: 'local' });
    const ea = await h.kernel.call('env:create', { projectId: pa.id, name: 'e', baseUrl: 'http://127.0.0.1:9' });
    const { runId } = await h.kernel.call('run:begin', { projectId: pa.id, envId: ea.id });
    await h.kernel.call('run:pause', { projectId: pa.id, runId });
    expect((await h.kernel.call('run:control', { runId })).paused).toBe(true);

    // 修复前：这里返回假成功 {resumed:true} 且真的解除了暂停
    await expect(h.kernel.call('run:resume', { projectId: pb.id, runId })).rejects.toMatchObject({ code: 'not_found' });
    expect((await h.kernel.call('run:control', { runId })).paused).toBe(true);

    // 归属者自己可以续跑
    await h.kernel.call('run:resume', { projectId: pa.id, runId });
    expect((await h.kernel.call('run:control', { runId })).paused).toBe(false);
    h.dispose();
  });

  it('不存在的 runId=999999 → not_found（不再返回假成功 {resumed:true}）', async () => {
    const h = testKernel();
    const p = await h.kernel.call('project:create', { name: 'A', sourceType: 'local' });
    await expect(h.kernel.call('run:resume', { projectId: p.id, runId: 999999 })).rejects.toMatchObject({ code: 'not_found' });
    h.dispose();
  });
});

/* ─────────────── route/principle:review 就地编辑（契约补全 action=edit） ─────────────── */

async function seedRoutes(h: KernelHandle, projectId: number): Promise<RouteCandidateRecord[]> {
  const idx = await h.kernel.call('source:recordIndex', { projectId, fileCount: 2, frameworks: ['express'] });
  await h.kernel.call('route:proposeBatch', {
    projectId,
    sourceIndexId: idx.id,
    proposedBy: 'ts-morph',
    routes: [
      { method: 'POST', path: '/v1/orders', handlerFile: 'src/orders.ts', handlerLine: 10, framework: 'express', confidence: 'medium' },
      { method: 'GET', path: '/v1/orders/:id', handlerFile: 'src/orders.ts', handlerLine: 20, framework: 'express', confidence: 'high' },
    ],
  });
  return h.kernel.call('route:list', { projectId });
}

describe('route:review action=edit（修 openapi:reconcile 产出的 path/method 分叉）', () => {
  it('改 path → adopted + diff 留痕 + route:list 反映新路径', async () => {
    const h = testKernel();
    const p = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const routes = await seedRoutes(h, p.id);
    const r = routes.find((x) => x.path === '/v1/orders')!;

    const edited = await h.kernel.call('route:review', {
      projectId: p.id,
      routeId: r.id,
      action: 'edit',
      actor: 'kel',
      edits: [{ path: 'path', from: '/v1/orders', to: '/v2/orders' }],
    });
    expect(edited.status).toBe('adopted');
    expect(edited.reviewedBy).toBe('kel');
    expect(edited.diff).toMatchObject({ editedBy: 'kel', fields: [{ path: 'path', from: '/v1/orders', to: '/v2/orders' }] });
    expect(edited.path).toBe('/v2/orders');

    const after = await h.kernel.call('route:list', { projectId: p.id });
    expect(after.find((x) => x.id === r.id)!.path).toBe('/v2/orders');
    h.dispose();
  });

  it('改 method（method 分叉场景）与 confidence 也可编辑', async () => {
    const h = testKernel();
    const p = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const routes = await seedRoutes(h, p.id);
    const r = routes.find((x) => x.method === 'GET')!;

    const edited = await h.kernel.call('route:review', {
      projectId: p.id,
      routeId: r.id,
      action: 'edit',
      actor: 'kel',
      edits: [
        { path: 'method', from: 'GET', to: 'POST' },
        { path: 'confidence', from: 'high', to: 'medium' },
      ],
    });
    expect(edited.method).toBe('POST');
    expect(edited.confidence).toBe('medium');
    expect(edited.diff!.fields).toHaveLength(2);
    h.dispose();
  });

  it('from 不符 → stale_edit；白名单外字段（framework）→ invalid_edit；空 edits → edits_required；失败不落任何状态', async () => {
    const h = testKernel();
    const p = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const routes = await seedRoutes(h, p.id);
    const r = routes[0]!;

    await expect(
      h.kernel.call('route:review', {
        projectId: p.id, routeId: r.id, action: 'edit', actor: 'kel',
        edits: [{ path: 'path', from: '/nope', to: '/v2/orders' }],
      }),
    ).rejects.toMatchObject({ code: 'stale_edit' });

    await expect(
      h.kernel.call('route:review', {
        projectId: p.id, routeId: r.id, action: 'edit', actor: 'kel',
        edits: [{ path: 'framework', from: 'express', to: 'fastify' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_edit' });

    await expect(
      h.kernel.call('route:review', { projectId: p.id, routeId: r.id, action: 'edit', actor: 'kel', edits: [] }),
    ).rejects.toMatchObject({ code: 'edits_required' });

    // 三次失败后记录原样：既没 adopt 也没改内容
    const after = await h.kernel.call('route:list', { projectId: p.id });
    expect(after.find((x) => x.id === r.id)).toMatchObject({ status: 'proposed', path: r.path, diff: null });
    h.dispose();
  });
});

describe('principle:review action=edit（同构）', () => {
  async function seedPrinciple(h: KernelHandle, projectId: number) {
    await h.kernel.call('principle:proposeBatch', {
      projectId,
      proposedBy: 'fx-agent',
      principles: [
        {
          subject: '订单金额为正数',
          rule: 'amount > 0',
          valueJson: { type: 'number', min: 1 },
          sourceFile: 'src/orders.ts',
          sourceLine: 42,
          layer: 'validation',
          confidence: 'high',
        },
      ],
    });
    return (await h.kernel.call('principle:list', { projectId }))[0]!;
  }

  it('改 rule/valueJson → adopted + diff 留痕 + principle:list 反映新内容', async () => {
    const h = testKernel();
    const p = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const pr = await seedPrinciple(h, p.id);

    const edited = await h.kernel.call('principle:review', {
      projectId: p.id,
      principleId: pr.id,
      action: 'edit',
      actor: 'kel',
      edits: [
        { path: 'rule', from: 'amount > 0', to: 'amount >= 0.01' },
        { path: 'valueJson.min', from: 1, to: 0.01 },
      ],
    });
    expect(edited.status).toBe('adopted');
    expect(edited.diff).toMatchObject({
      editedBy: 'kel',
      fields: [
        { path: 'rule', from: 'amount > 0', to: 'amount >= 0.01' },
        { path: 'valueJson.min', from: 1, to: 0.01 },
      ],
    });
    expect(edited.rule).toBe('amount >= 0.01');
    expect(edited.valueJson).toEqual({ type: 'number', min: 0.01 });
    // 溯源字段不受影响
    expect(edited.sourceFile).toBe('src/orders.ts');

    const after = await h.kernel.call('principle:list', { projectId: p.id });
    expect(after.find((x) => x.id === pr.id)).toMatchObject({ rule: 'amount >= 0.01' });
    expect(after.find((x) => x.id === pr.id)!.valueJson).toEqual({ type: 'number', min: 0.01 });
    h.dispose();
  });

  it('from 不符 → stale_edit；越界字段（sourceFile）→ invalid_edit', async () => {
    const h = testKernel();
    const p = await h.kernel.call('project:create', { name: 'p', sourceType: 'local' });
    const pr = await seedPrinciple(h, p.id);

    await expect(
      h.kernel.call('principle:review', {
        projectId: p.id, principleId: pr.id, action: 'edit', actor: 'kel',
        edits: [{ path: 'rule', from: '旧的错基线', to: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'stale_edit' });

    await expect(
      h.kernel.call('principle:review', {
        projectId: p.id, principleId: pr.id, action: 'edit', actor: 'kel',
        edits: [{ path: 'sourceFile', from: 'src/orders.ts', to: 'elsewhere.ts' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_edit' });

    const after = await h.kernel.call('principle:list', { projectId: p.id });
    expect(after.find((x) => x.id === pr.id)).toMatchObject({ status: 'proposed', rule: 'amount > 0', diff: null });
    h.dispose();
  });
});
