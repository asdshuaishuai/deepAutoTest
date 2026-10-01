/**
 * deepAutoTest 执行层 · headless 演示
 *
 * 起一个本地 mock 服务，走完整闭环：
 * 用例（人工写）→ 计划编译（拒绝式校验）→ undici 执行 → 事件经写入门落库
 * → 判定（含 flaky / 边界失败定位）→ RunDiff 对账两次运行。
 *
 * 运行：npm run demo:exec
 */

import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, defaultRunPolicy } from '../src/kernel/index.ts';
import { compilePlan } from '../src/execution/plan-compiler.ts';
import { executePlan } from '../src/execution/runner.ts';

const line = (t: string) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);

async function main(): Promise<void> {
  // 被"测"的 mock 服务：>50000 拒绝；/flaky 前两次 500（模拟间歇故障）
  let flakyCounter = 0;
  const server = createServer((req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    if (req.method === 'POST' && p === '/orders') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { amount } = JSON.parse(body) as { amount: number };
        if (amount > 50000) return json(400, { error: 'AMOUNT_EXCEEDED' });
        return json(201, { data: { id: `o_${Math.random().toString(36).slice(2, 8)}` } });
      });
      return;
    }
    if (req.method === 'GET' && p === '/flaky') {
      flakyCounter += 1;
      if (flakyCounter % 3 !== 0) return json(500, { error: 'temporarily_unavailable' });
      return json(200, { ok: true });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  const dir = mkdtempSync(join(tmpdir(), 'dat-exec-'));
  const kernel = createKernel({ dataDir: dir });
  const project = await kernel.call('project:create', { name: 'order-service', sourceType: 'local' });
  const env = await kernel.call('env:create', { projectId: project.id, name: 'staging', baseUrl: `http://127.0.0.1:${port}` });

  line('① 人工写用例（P3：人写的也走 proposed → adopt）');
  const draft = (name: string, steps: { id: string; seq: number; kind: string; config: Record<string, unknown> }[], rows?: { label: string; values: Record<string, unknown>; intent: string }[]) => ({
    name, description: null as string | null, routeId: null as number | null,
    paramKind: rows === undefined ? 'single' as const : 'boundary' as const,
    steps,
    params: { kind: rows === undefined ? 'single' as const : 'boundary' as const, rows: rows ?? [{ label: 'baseline', values: {}, intent: 'baseline' as const }] },
    provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
    policyOverride: null, tags: [],
  });
  const boundary = await kernel.call('case:propose', {
    projectId: project.id, proposedBy: 'kel',
    draft: draft('下单金额边界', [
      { id: 's0', seq: 0, kind: 'request', config: { method: 'POST', url: '/orders', headers: { 'content-type': 'application/json' }, body: '{"amount":{{param.amount}}}' } },
      { id: 's1', seq: 1, kind: 'assert', config: { target: { kind: 'status' }, op: 'eq', expected: '{{param.expected}}', severity: 'critical', principleId: 7, sourceFile: 'order.controller.ts', sourceLine: 88 } },
    ], [
      { label: '金额=49999（边界内）', values: { amount: 49999, expected: '201' }, intent: 'baseline' },
      { label: '金额=50000（恰在边界）', values: { amount: 50000, expected: '400' }, intent: 'boundary_high' },
      { label: '金额=50001（超限）', values: { amount: 50001, expected: '400' }, intent: 'boundary_high' },
    ]),
  });
  const flaky = await kernel.call('case:propose', {
    projectId: project.id, proposedBy: 'kel',
    draft: draft('健康检查稳定性', [
      { id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/flaky' } },
      { id: 's1', seq: 1, kind: 'assert', config: { target: { kind: 'status' }, op: 'eq', expected: '200', severity: 'major' } },
    ]),
  });
  for (const c of [boundary, flaky]) {
    await kernel.call('case:review', { projectId: project.id, caseId: c.id, action: 'adopt', actor: 'kel' });
  }
  console.log(`采纳 ${2} 个用例（含 1 个三行边界参数化 + 1 个稳定性）`);

  line('② 编译计划（编译期校验：URL 归属/引用存在/matrix 上限…）');
  const cases = await kernel.call('case:list', { projectId: project.id, status: 'adopted' });
  const policy = { ...defaultRunPolicy(), retry: { ...defaultRunPolicy().retry, maxAttempts: 3, on: ['http_5xx', 'assert_failed'] as ('http_5xx' | 'assert_failed')[] } };
  const plan = await compilePlan({ cases, env, policy, seed: 42, nowMs: Date.now() });
  console.log(`编译通过：${plan.entries.length} 个 entry（${cases.length} 用例 × 参数行），并发度 ${plan.concurrency}`);

  const runOnce = async (): Promise<number> => {
    const { runId } = await kernel.call('run:begin', { projectId: project.id, envId: env.id, policy, seed: 42, plan });
    await executePlan({ kernel, projectId: project.id, runId, plan, env });
    await kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });
    return runId;
  };

  line('③ 第一次运行（真实 HTTP 执行，事件落库）');
  const run1 = await runOnce();
  const results1 = await kernel.call('run:results', { projectId: project.id, runId: run1 });
  for (const e of results1.entries) {
    console.log(`  ${(e.verdict + (e.flaky ? '+flaky' : '')).padEnd(12)} attempts=${e.attempts}  ${e.paramRowLabel}`);
  }
  const runRec1 = await kernel.call('run:get', { projectId: project.id, runId: run1 });
  console.log(`  counters=${JSON.stringify(runRec1!.counters)}`);
  console.log(`  ★ 边界定位：金额=50000 未被拒绝（服务端只拒 >50000）——断言溯源 order.controller.ts:88`);

  line('④ 第二次运行 + 对账（RunDiff：看变化，不看红绿灯）');
  const run2 = await runOnce();
  const diff = await kernel.call('run:diff', { projectId: project.id, baseRunId: run1, headRunId: run2 });
  console.log(`  新失败=${diff.newFailures.length}  已修复=${diff.fixedCases.length}  新不稳定=${diff.newlyFlaky.length}  已稳定=${diff.stabilizedCases.length}`);
  console.log(`  verdict 变化=${diff.verdictChanged.length}（两次同构 → 0 是预期）`);

  line('⑤ 完整性 + 投影重建');
  const verify = await kernel.call('run:verify', { projectId: project.id, runId: run1 });
  console.log(`  链哈希校验 ok=${verify.ok}（${verify.eventCount} 条事件）`);
  await kernel.call('run:rebuildProjections', { projectId: project.id, runId: run1 });
  const rebuilt = await kernel.call('run:results', { projectId: project.id, runId: run1 });
  console.log(`  删投影重建后逐字段一致=${JSON.stringify(rebuilt.entries) === JSON.stringify(results1.entries)}`);

  kernel.close();
  server.close();
  console.log(`\n数据目录（可删除）: ${dir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
