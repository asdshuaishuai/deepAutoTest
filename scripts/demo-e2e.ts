/**
 * deepAutoTest 全链路演示（headless）
 *
 * 源码仓库 → S2/S3 索引 → 人机门 → S5 边界用例合成 → 人机门 →
 * 编译 → 真实执行 → 判定 → 反馈指标（原则检出 / 零检出 / 覆盖率）。
 *
 * 演示里的"被测服务"故意有一个 bug：源码写 amount ≤ 50000，实现却只在 > 60000 拒绝。
 * 全链路的终点就是把这个 bug 变成一个带 file:line 溯源的红色断言。
 *
 * 运行：npm run demo:e2e
 */

import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, defaultRunPolicy } from '../src/kernel/index.ts';
import { indexLocalSource } from '../src/analysis/index.ts';
import { synthesizeAndPropose } from '../src/synthesis/index.ts';
import { compilePlan } from '../src/execution/plan-compiler.ts';
import { executePlan } from '../src/execution/runner.ts';

const line = (t: string) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`);

async function main(): Promise<void> {
  // ── 被测服务：amount 上限实现成 60000（源码说 50000，有 bug）
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/orders') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { amount?: number };
        const json = (code: number, payload: unknown) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if ((parsed.amount ?? 0) > 60000) return json(400, { error: 'AMOUNT_EXCEEDED' });
        return json(201, { data: { id: 'o_1' } });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  // ── 被测源码仓库（zod 约束 + Express 路由）
  const repo = mkdtempSync(join(tmpdir(), 'dat-e2e-repo-'));
  mkdirSync(join(repo, 'src', 'routes'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'routes', 'orders.ts'),
    `import { Router } from 'express';
export const router = Router();
router.post('/orders', async (req, res) => { res.status(201).json({}); });
`,
  );
  writeFileSync(
    join(repo, 'src', 'schemas.ts'),
    `import { z } from 'zod';
export const CreateOrderSchema = z.object({
  amount: z.number().int().max(50000),
});
`,
  );

  const dir = mkdtempSync(join(tmpdir(), 'dat-e2e-db-'));
  const kernel = createKernel({ dataDir: dir });
  const project = await kernel.call('project:create', { name: 'order-service', sourceType: 'local', localPath: repo });
  const env = await kernel.call('env:create', { projectId: project.id, name: 'staging', baseUrl: `http://127.0.0.1:${port}` });

  line('① 源码接入（S1-local，只读）');
  const scan = await indexLocalSource(kernel, project.id, repo);
  console.log(`  扫描 ${scan.fileCount} 文件，框架: ${scan.frameworks.join(', ')}`);
  console.log(`  路由候选 ${scan.routesInserted}，原则 ${scan.principlesInserted}（全部 proposed）`);

  line('② API 发现 + 原则提取（S2/S3，带 file:line 溯源）');
  const routes = await kernel.call('route:list', { projectId: project.id });
  const principles = await kernel.call('principle:list', { projectId: project.id });
  for (const r of routes) console.log(`  ${r.method} ${r.path}   (${r.framework}, ${r.confidence}, ${r.handlerFile}:${r.handlerLine})`);
  for (const p of principles) console.log(`  原则 ${p.subject}: ${p.rule}   ← ${p.sourceFile}:${p.sourceLine}`);

  line('③ 人机门（P3：AI/分析器不能直接生效）');
  await kernel.call('route:review', { projectId: project.id, routeId: routes[0]!.id, action: 'adopt', actor: 'kel' });
  for (const p of principles) {
    await kernel.call('principle:review', { projectId: project.id, principleId: p.id, action: 'adopt', actor: 'kel' });
  }
  console.log(`  人工采纳：路由 ${routes.length} 条，原则 ${principles.length} 条`);

  line('④ 用例合成（S5 确定性通道：原则 → 边界参数行）');
  const synth = await synthesizeAndPropose(kernel, project.id);
  const proposed = await kernel.call('case:list', { projectId: project.id, status: 'proposed' });
  for (const c of proposed) {
    const rows = c.params.rows.map((r) => r.label).join(' | ');
    console.log(`  「${c.name}」`);
    console.log(`      参数行: ${rows}`);
    console.log(`      溯源: 原则#${c.provenance.principles[0]!.principleId} ← ${c.provenance.principles[0]!.source}`);
  }
  console.log(`  合成 ${synth.casesInserted} 个用例（proposed，待人工复核）`);

  line('⑤ 人工复核用例 → 采纳 → 编译计划');
  for (const c of proposed) {
    await kernel.call('case:review', { projectId: project.id, caseId: c.id, action: 'adopt', actor: 'kel' });
  }
  const policy = defaultRunPolicy();
  const cases = await kernel.call('case:list', { projectId: project.id, status: 'adopted' });
  const plan = await compilePlan({ cases, env, policy, seed: 1, nowMs: Date.now() });
  console.log(`  ${cases.length} 用例 → ${plan.entries.length} 个 entry（编译期校验通过）`);

  line('⑥ 真实执行 + 判定');
  const { runId } = await kernel.call('run:begin', { projectId: project.id, envId: env.id, policy, seed: 1, plan });
  await executePlan({ kernel, projectId: project.id, runId, plan, env });
  await kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });

  const results = await kernel.call('run:results', { projectId: project.id, runId });
  const byLabel = new Map(cases.map((c) => [c.id, c.name]));
  for (const e of results.entries) {
    const icon = e.verdict === 'passed' ? '✓' : e.verdict === 'failed' ? '✗' : '?';
    console.log(`  ${icon} ${e.verdict.padEnd(7)} ${e.paramRowLabel}   [${byLabel.get(e.caseId)}]`);
  }
  const failed = results.asserts.find((a) => !a.passed);
  if (failed !== undefined) {
    console.log(`\n  ★ 抓到实现违反源码约束：`);
    console.log(`    expected=${failed.expected} actual=${failed.actual}`);
    console.log(`    依据: ${failed.sourceFile}:${failed.sourceLine}（原则#${failed.principleId}）`);
    console.log(`    → "金额上限"在源码里是 50000，实现却接受到了 60000`);
  }

  line('⑦ 反馈回路（查询期派生，P2）');
  const coverage = await kernel.call('metrics:coverage', { projectId: project.id });
  console.log(`  覆盖率: ${coverage.covered}/${coverage.eligible}（未覆盖 ${coverage.uncovered.length}）`);
  const eff = await kernel.call('metrics:principleEffectiveness', { projectId: project.id });
  for (const r of eff.rows) {
    console.log(`  原则#${r.principleId} ${r.subject}: 引用 ${r.casesReferencing} 个用例，检出 ${r.violationsDetected} 次${r.zeroDetection ? '  ⚠ 零检出（需人工确认）' : ''}`);
  }

  const run = await kernel.call('run:get', { projectId: project.id, runId });
  console.log(`\n  run=${runId} counters=${JSON.stringify(run!.counters)}`);
  console.log(`  chainHash=${run!.chainHash!.slice(0, 16)}… events=${run!.eventCount}`);

  kernel.close();
  server.close();
  console.log(`\n数据目录（可删除）: ${dir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
