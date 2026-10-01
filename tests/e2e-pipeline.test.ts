/**
 * ★★ 全链路 e2e：源码 → 原则 → 用例 → 执行 → 判定 → 反馈指标。
 *
 * 这是产品的完整价值链在一次测试里的兑现：
 *   ① fixture 源码仓库（Express 路由 + zod 约束）
 *   ② S2/S3 索引：路由候选 + 原则（file:line 溯源）
 *   ③ 人机门：人工采纳路由与原则（P3）
 *   ④ S5 合成：原则 → 边界用例（proposed）→ 人工采纳
 *   ⑤ 编译计划（拒绝式校验）→ 真实 HTTP 执行（mock 服务）
 *   ⑥ 判定：源码说 ≤50000，实现却接受 50001 → 越界用例失败（violation）
 *   ⑦ 反馈：原则触发率/检出、未覆盖接口——回到 S3/S5 的闭环
 */

import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { indexLocalSource } from '../src/analysis/scan.ts';
import { synthesizeAndPropose } from '../src/synthesis/index.ts';
import { compilePlan } from '../src/execution/plan-compiler.ts';
import { executePlan } from '../src/execution/runner.ts';
import { defaultRunPolicy } from '../src/kernel/shared/domain.ts';
import { testKernel, type KernelHandle } from './helpers.ts';

let server: Server;
let port = 0;
const handles: KernelHandle[] = [];
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const h of handles) h.dispose();
});

beforeAll(async () => {
  // 被测"服务"：金额约束被实现成 >60000 才拒绝（源码说 50000 —— 有 bug）；
  // note 的长度约束实现正确（1..200）
  server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/orders') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { amount?: number; note?: string };
        if (parsed.amount !== undefined && parsed.amount > 60000) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end('{"error":"AMOUNT_EXCEEDED"}');
          return;
        }
        if (parsed.note !== undefined && (parsed.note.length < 1 || parsed.note.length > 200)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end('{"error":"NOTE_LENGTH"}');
          return;
        }
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"data":{"id":"o_1"}}');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

function fixtureRepo(): string {
  const dir = join(tmpdir(), `dat-e2e-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, 'src', 'routes'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'routes', 'orders.ts'),
    `import { Router } from 'express';
export const router = Router();
router.post('/orders', async (req, res) => { res.status(201).json({}); });
`,
  );
  writeFileSync(
    join(dir, 'src', 'schemas.ts'),
    `import { z } from 'zod';

export const CreateOrderSchema = z.object({
  amount: z.number().int().max(50000),
  note: z.string().min(1).max(200),
});
`,
  );
  return dir;
}

describe('全链路：源码 → 原则 → 用例 → 执行 → 反馈', () => {
  it('端到端跑通，且抓到"实现未遵循源码约束"', async () => {
    const h = testKernel();
    handles.push(h);
    const kernel = h.kernel;

    /* ① 项目 + 环境（指向 mock 服务） */
    const project = await kernel.call('project:create', { name: 'order-service', sourceType: 'local', localPath: fixtureRepo() });
    const env = await kernel.call('env:create', { projectId: project.id, name: 'staging', baseUrl: `http://127.0.0.1:${port}` });

    /* ② 索引：路由 + 原则 */
    const scan = await indexLocalSource(kernel, project.id, project.localPath!);
    expect(scan.routesInserted).toBe(1);
    expect(scan.principlesInserted).toBeGreaterThanOrEqual(2);

    /* ③ 人机门：人工采纳路由与两条原则 */
    const routes = await kernel.call('route:list', { projectId: project.id });
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /orders']);
    await kernel.call('route:review', { projectId: project.id, routeId: routes[0]!.id, action: 'adopt', actor: 'kel' });

    const principles = await kernel.call('principle:list', { projectId: project.id });
    const amountPrinciple = principles.find((p) => p.subject === 'CreateOrderSchema.amount')!;
    const notePrinciple = principles.find((p) => p.subject === 'CreateOrderSchema.note')!;
    expect(amountPrinciple.valueJson).toMatchObject({ type: 'number', max: 50000 });
    expect(amountPrinciple.sourceFile).toBe('src/schemas.ts');
    for (const p of [amountPrinciple, notePrinciple]) {
      await kernel.call('principle:review', { projectId: project.id, principleId: p.id, action: 'adopt', actor: 'kel' });
    }

    /* ④ 合成：原则 → 边界用例（proposed），人工采纳 */
    const synth = await synthesizeAndPropose(kernel, project.id);
    // amount: 应通过 + 应拒绝；note: 应通过 + 应拒绝 → 4 个
    expect(synth.casesInserted).toBe(4);
    expect(synth.skipped).toEqual([]);

    const proposedCases = await kernel.call('case:list', { projectId: project.id, status: 'proposed' });
    expect(proposedCases).toHaveLength(4);
    expect(proposedCases.every((c) => c.tags.includes('auto-synth'))).toBe(true);
    expect(proposedCases.every((c) => c.provenance.principles.length === 1)).toBe(true);
    for (const c of proposedCases) {
      await kernel.call('case:review', { projectId: project.id, caseId: c.id, action: 'adopt', actor: 'kel' });
    }

    /* ⑤ 编译 + 执行 */
    const adoptedCases = await kernel.call('case:list', { projectId: project.id, status: 'adopted' });
    const policy = defaultRunPolicy();
    const plan = await compilePlan({ cases: adoptedCases, env, policy, seed: 7, nowMs: Date.now() });
    expect(plan.entries).toHaveLength(7); // amount: 合法2行(49999/50000)+越界1行(50001)；note: 合法2行(长度1/200)+越界2行(长度201/空串)
    const { runId } = await kernel.call('run:begin', { projectId: project.id, envId: env.id, policy, seed: 7, plan });
    await executePlan({ kernel, projectId: project.id, runId, plan, env });
    await kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });

    /* ⑥ 判定：amount 越界行被抓（实现接受 50001），note 的边界行全过 */
    const results = await kernel.call('run:results', { projectId: project.id, runId });
    const amountRejectCase = adoptedCases.find((c) => c.name.includes('amount') && c.name.includes('应拒绝'))!;
    const amountPassCase = adoptedCases.find((c) => c.name.includes('amount') && c.name.includes('应通过'))!;
    const noteRejectCase = adoptedCases.find((c) => c.name.includes('note') && c.name.includes('应拒绝'))!;

    const verdictOf = (caseId: number): string => {
      const entry = results.entries.find((e) => e.caseId === caseId)!;
      return entry.verdict;
    };
    expect(verdictOf(amountRejectCase.id)).toBe('failed'); // ★ 源码说 ≤50000，实现却接受 50001
    expect(verdictOf(amountPassCase.id)).toBe('passed');
    expect(verdictOf(noteRejectCase.id)).toBe('passed'); // note 的实现是对的

    // 失败断言的溯源链：断言 → 原则 → file:line
    const failedAssert = results.asserts.find((a) => !a.passed)!;
    expect(failedAssert.principleId).toBe(amountPrinciple.id);
    expect(failedAssert.sourceFile).toBe('src/schemas.ts');
    expect(failedAssert.expected).toBe('400');
    expect(Number(failedAssert.actual)).toBe(201);

    /* ⑦ 反馈指标（查询期派生，P2） */
    const coverage = await kernel.call('metrics:coverage', { projectId: project.id });
    expect(coverage.eligible).toBe(1);
    expect(coverage.covered).toBe(1);
    expect(coverage.uncovered).toEqual([]);

    const effectiveness = await kernel.call('metrics:principleEffectiveness', { projectId: project.id });
    const amountRow = effectiveness.rows.find((r) => r.principleId === amountPrinciple.id)!;
    const noteRow = effectiveness.rows.find((r) => r.principleId === notePrinciple.id)!;
    expect(amountRow.casesReferencing).toBe(2);
    expect(amountRow.violationsDetected).toBeGreaterThanOrEqual(1); // ★ 检出
    expect(amountRow.zeroDetection).toBe(false);
    expect(noteRow.casesReferencing).toBe(2);
    expect(noteRow.violationsDetected).toBe(0);
    expect(noteRow.zeroDetection).toBe(true); // 可疑信号：需人工确认（可能约束写错或测试值没打到位）
    expect(effectiveness.unreferenced).toEqual([]);
  });

  it('重跑闭环：修好实现后重跑，flaky 之外的判定与指标变化可对账', async () => {
    const h = testKernel();
    handles.push(h);
    const kernel = h.kernel;
    const project = await kernel.call('project:create', { name: 'p', sourceType: 'local', localPath: fixtureRepo() });
    const env = await kernel.call('env:create', { projectId: project.id, name: 'e', baseUrl: `http://127.0.0.1:${port}` });
    await indexLocalSource(kernel, project.id, project.localPath!);
    const principles = await kernel.call('principle:list', { projectId: project.id });
    for (const p of principles) {
      await kernel.call('principle:review', { projectId: project.id, principleId: p.id, action: 'adopt', actor: 'kel' });
    }
    await synthesizeAndPropose(kernel, project.id);
    const cases = await kernel.call('case:list', { projectId: project.id, status: 'proposed' });
    for (const c of cases) {
      await kernel.call('case:review', { projectId: project.id, caseId: c.id, action: 'adopt', actor: 'kel' });
    }

    const policy = defaultRunPolicy();
    const plan = await compilePlan({ cases: await kernel.call('case:list', { projectId: project.id, status: 'adopted' }), env, policy, seed: 1, nowMs: Date.now() });
    const runOnce = async (): Promise<number> => {
      const { runId } = await kernel.call('run:begin', { projectId: project.id, envId: env.id, policy, seed: 1, plan });
      await executePlan({ kernel, projectId: project.id, runId, plan, env });
      await kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });
      return runId;
    };
    const run1 = await runOnce();
    const run2 = await runOnce();

    // 两次运行同构（实现没变）→ diff 无新增失败；同 case 判定一致
    const diff = await kernel.call('run:diff', { projectId: project.id, baseRunId: run1, headRunId: run2 });
    expect(diff.newFailures).toEqual([]);
    expect(diff.verdictChanged).toEqual([]);

    // 两次运行都检出同一个原则违反 → 检出计数累积（不同 run 的 assert_result 行相加）
    const effectiveness = await kernel.call('metrics:principleEffectiveness', { projectId: project.id });
    const amountRow = effectiveness.rows.find((r) => r.subject === 'CreateOrderSchema.amount')!;
    expect(amountRow.violationsDetected).toBeGreaterThanOrEqual(2);
  });
});
