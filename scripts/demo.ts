/**
 * deepAutoTest 基座 · headless 演示
 *
 * 不开窗口、不起服务——纯 Node 进程跑完「提议 → 人机门 → 执行留痕 → 判定 → 重判」
 * 的完整闭环。这本身就是「基座是上层无关的」的证明：今天它被这个脚本驱动，
 * 明天它被 webview 的 SAB 桥驱动，调用的是同一个 kernel.call。
 *
 * 运行：npm run demo
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, defaultRunPolicy, type RunEventInput, type RunPolicy } from '../src/kernel/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'dat-demo-'));
const kernel = createKernel({ dataDir: dir });

const line = (t: string) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);

async function main(): Promise<void> {
  line('① 项目域（P5：一切挂 projectId）');
  const project = await kernel.call('project:create', { name: 'order-service', sourceType: 'local', localPath: '/tmp/repo' });
  const env = await kernel.call('env:create', { projectId: project.id, name: 'staging', baseUrl: 'http://127.0.0.1:3000' });
  console.log(`project=${project.id} (${project.name})  env=${env.id} (${env.name} → ${env.baseUrl})`);

  line('② 人机门（P3：Agent 提议 → 只能 proposed）');
  const draft = {
    name: '下单金额边界',
    description: '验证 amount ≤ 50000 的边界行为',
    routeId: null,
    paramKind: 'boundary',
    steps: [{ id: 's1', seq: 0, kind: 'request', config: { method: 'POST', url: '{{env.baseUrl}}/orders' } }],
    params: {
      kind: 'boundary',
      rows: [
        { label: '金额=49999（边界内）', values: { amount: 49999 }, intent: 'baseline' },
        { label: '金额=50001（超限）', values: { amount: 50001 }, intent: 'boundary_high' },
      ],
    },
    provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
    policyOverride: null,
    tags: ['smoke'],
  };
  const proposed = await kernel.call('case:propose', { projectId: project.id, proposedBy: 'fx-agent', draft });
  console.log(`Agent 提议 #${proposed.id} → status=${proposed.status}（AI 生成 ≠ 生效）`);
  const adopted = await kernel.call('case:review', {
    projectId: project.id,
    caseId: proposed.id,
    action: 'edit',
    actor: 'kel',
    edits: [{ path: 'params.rows[1].values.amount', from: 50001, to: 50002 }],
  });
  console.log(`人工编辑后采纳 → status=${adopted.status}，diff 留痕 ${adopted.diff!.fields.length} 处`);

  line('③ 执行留痕（事件即事实，判定不在执行期）');
  const policy: RunPolicy = { ...defaultRunPolicy(), retry: { ...defaultRunPolicy().retry, maxAttempts: 2 } };
  const { runId } = await kernel.call('run:begin', { projectId: project.id, envId: env.id, policy, seed: 42 });

  const batch: RunEventInput[] = [
    { kind: 'entry_started', entryId: 'amount=49999', caseId: adopted.id, paramRowLabel: '金额=49999（边界内）', intent: 'baseline' },
    { kind: 'request_sent', entryId: 'amount=49999', stepSeq: 0, method: 'POST', url: 'http://127.0.0.1:3000/orders', headerNames: ['content-type'] },
    { kind: 'response_received', entryId: 'amount=49999', stepSeq: 0, status: 200, durationMs: 43, bodyRef: null, bodySha256: null },
    { kind: 'assert_evaluated', entryId: 'amount=49999', assertSeq: 0, stepSeq: 0, severity: 'blocker', expected: '200', actual: '200', passed: true, principleId: null, sourceFile: null, sourceLine: null },
    { kind: 'entry_finished', entryId: 'amount=49999', attempts: 1, durationMs: 50 },

    // 超限行：第一次断言失败，重试后服务端正确拒绝 → passed + flaky
    { kind: 'entry_started', entryId: 'amount=50002', caseId: adopted.id, paramRowLabel: '金额=50002（超限）', intent: 'boundary_high' },
    { kind: 'request_sent', entryId: 'amount=50002', stepSeq: 0, method: 'POST', url: 'http://127.0.0.1:3000/orders', headerNames: ['content-type'] },
    { kind: 'response_received', entryId: 'amount=50002', stepSeq: 0, status: 200, durationMs: 88, bodyRef: null, bodySha256: null },
    { kind: 'assert_evaluated', entryId: 'amount=50002', assertSeq: 0, stepSeq: 0, severity: 'critical', expected: '400', actual: '200', passed: false, principleId: 7, sourceFile: 'order.controller.ts', sourceLine: 88 },
    { kind: 'retry_scheduled', entryId: 'amount=50002', attempt: 2, reason: 'timed_out', delayMs: 200 },
    { kind: 'response_received', entryId: 'amount=50002', stepSeq: 0, status: 400, durationMs: 95, bodyRef: null, bodySha256: null },
    { kind: 'assert_evaluated', entryId: 'amount=50002', assertSeq: 0, stepSeq: 0, severity: 'critical', expected: '400', actual: '400', passed: true, principleId: 7, sourceFile: 'order.controller.ts', sourceLine: 88 },
    { kind: 'entry_finished', entryId: 'amount=50002', attempts: 2, durationMs: 190 },

    // 连不上的行 → errored（不是 failed：没测成 ≠ 被测错了）
    { kind: 'entry_started', entryId: 'amount=0', caseId: adopted.id, paramRowLabel: '金额=0（空值）', intent: 'empty' },
    { kind: 'request_sent', entryId: 'amount=0', stepSeq: 0, method: 'POST', url: 'http://127.0.0.1:9999/orders', headerNames: [] },
    { kind: 'step_errored', entryId: 'amount=0', stepSeq: 0, stepKind: 'request', reason: 'connect_failed', detail: 'ECONNREFUSED' },
    { kind: 'entry_finished', entryId: 'amount=0', attempts: 1, durationMs: 3 },
  ];
  await kernel.call('run:appendEvents', { projectId: project.id, runId, events: batch });
  await kernel.call('run:note', { projectId: project.id, runId, text: '9999 端口的服务当时没起', by: 'kel' });
  const run = await kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });

  line('④ 判定（verdict = reduce(events, policy)，纯函数）');
  const results = await kernel.call('run:results', { projectId: project.id, runId });
  for (const e of results.entries) {
    const flags = [e.flaky && 'flaky', e.waived && 'waived'].filter(Boolean).join(',') || '-';
    console.log(
      `  ${e.verdict.padEnd(8)} ${flags.padEnd(6)} attempts=${e.attempts} ${e.failedAsserts}条失败断言  ${e.paramRowLabel}`,
    );
  }
  console.log(`  run status=${run.status}（completed ≠ 全通过）`);
  console.log(`  counters=${JSON.stringify(run.counters)}`);
  console.log(`  chainHash=${run.chainHash!.slice(0, 16)}…  events=${run.eventCount}`);

  line('⑤ 完整性与投影重建（P1 的证明）');
  const verify = await kernel.call('run:verify', { projectId: project.id, runId });
  console.log(`  完整性: ok=${verify.ok} (${verify.eventCount} 条事件连续且链哈希一致)`);
  const before = await kernel.call('run:results', { projectId: project.id, runId });
  kernel.db.exec('DELETE FROM case_result; DELETE FROM step_result; DELETE FROM assert_result;');
  const { rebuilt } = await kernel.call('run:rebuildProjections', { projectId: project.id, runId });
  const after = await kernel.call('run:results', { projectId: project.id, runId });
  console.log(`  删除投影 → 从事件重建 ${rebuilt} 条 → 与原投影逐字段一致：${JSON.stringify(after.entries) === JSON.stringify(before.entries)}`);

  line('⑥ 重判（规则演进，不重跑）');
  const newPolicy: RunPolicy = { ...policy, degradedOnSeverity: 'major' };
  const preview = await kernel.call('run:rejudge', { projectId: project.id, runId, policy: newPolicy, mode: 'preview', actor: 'kel' });
  console.log(`  preview: ${preview.changes.length} 处会变化，库未动`);
  const applied = await kernel.call('run:rejudge', { projectId: project.id, runId, policy: newPolicy, mode: 'apply', actor: 'kel' });
  console.log(`  apply:   ${applied.changes.length} 处已更新（事件不动，只覆盖投影）`);

  line('⑦ 写时脱敏（落库前，不是读时）');
  await kernel.call('run:note', { projectId: project.id, runId, text: '复现手机号 13812345678', by: 'kel' });
  const evs = await kernel.call('run:events', { projectId: project.id, runId });
  const note = evs.filter((e) => e.kind === 'note').map((e) => (e as { text: string }).text).join(' / ');
  console.log(`  库里的备注: ${note}`);

  kernel.close();
  console.log(`\n数据目录（可删除）: ${dir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  kernel.close();
});
