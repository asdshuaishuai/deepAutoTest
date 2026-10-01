/**
 * deepAutoTest · PRD → 用例 + UI 测试演示（headless，真浏览器）
 *
 * 一份 PRD（字段约束表 + UI 登录流协议）→ 解析 → 合成（proposed）→ 人机门 →
 * 编译 → 执行：HTTP 边界用例打 mock API，UI 流用系统 Chrome 真实驱动本地页面。
 *
 * 被测服务故意有一个 bug：PRD 写 amount ≤ 50000，实现只在 > 60000 拒绝。
 *
 * 前置：playwright-core（optionalDependency，已随包安装）+ 系统 Chrome。
 * 运行：npm run demo:prd
 */

import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, defaultRunPolicy } from '../src/kernel/index.ts';
import { indexPrd } from '../src/prd/index.ts';
import { compilePlan } from '../src/execution/plan-compiler.ts';
import { executePlan } from '../src/execution/runner.ts';
import { PlaywrightUiDriverFactory } from '../src/execution/ui/driver.ts';

const line = (t: string) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 54 - t.length))}`);

const PRD = `# 订单工作台 PRD

## 下单接口

接口: POST /orders

| 字段 | 类型 | 约束 |
|------|------|------|
| amount | 整数 | 0 ≤ amount ≤ 50000 |
| channel | 枚举 | 枚举：APP、H5、MINI |

## 登录流程

### 管理员登录成功
- 打开 /login
- 填写 #username = "admin"
- 填写 #password = "secret123"
- 点击 button[type=submit]
- 应看到 "欢迎回来, admin"
- 截图 after-login
`;

async function main(): Promise<void> {
  // ── 被测服务（单源）：/login 出登录页；POST /orders 是 API（上限实现成 60000，PRD 说 50000，有 bug）
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (code: number, payload: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'GET' && url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <h1>订单工作台</h1>
        <form onsubmit="event.preventDefault(); document.getElementById('out').textContent='欢迎回来, ' + document.getElementById('username').value;">
          <input id="username"/><input id="password" type="password"/>
          <button type="submit">登录</button>
        </form>
        <div id="out"></div>
      </body></html>`);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/orders') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { amount } = JSON.parse(body) as { amount: number };
        if (amount > 60000) return json(400, { error: 'AMOUNT_EXCEEDED' });
        return json(201, { data: { id: 'o_1' } });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  // ── PRD 落盘
  const prdDir = mkdtempSync(join(tmpdir(), 'dat-prd-demo-'));
  mkdirSync(prdDir, { recursive: true });
  writeFileSync(join(prdDir, 'workbench.md'), PRD);

  const dir = mkdtempSync(join(tmpdir(), 'dat-prd-db-'));
  const kernel = createKernel({ dataDir: dir });
  const project = await kernel.call('project:create', { name: 'workbench', sourceType: 'local' });
  const env = await kernel.call('env:create', { projectId: project.id, name: 'local', baseUrl: `http://127.0.0.1:${port}` });

  line('① PRD 解析 + 合成（确定性；prose 需求如实上报不装懂）');
  const prd = await indexPrd(kernel, project.id, prdDir);
  console.log(`  解析 ${prd.filesParsed.join(', ')}：UI 流 ${prd.uiFlowCount}，合成 ${prd.casesInserted} 用例`);
  for (const s of prd.skipped) console.log(`  ⚠ 跳过（${s.file}:${s.line}）：${s.reason}`);

  line('② 人机门（P3）：逐条人工采纳');
  const proposed = await kernel.call('case:list', { projectId: project.id, status: 'proposed' });
  for (const c of proposed) {
    console.log(`  「${c.name}」 params=${c.params.rows.map((r) => r.label).join(' | ') || '-'}`);
    await kernel.call('case:review', { projectId: project.id, caseId: c.id, action: 'adopt', actor: 'kel' });
  }

  line('③ 编译 + 执行（HTTP 边界 + 真浏览器 UI 流）');
  const cases = await kernel.call('case:list', { projectId: project.id, status: 'adopted' });
  const policy = defaultRunPolicy();
  const plan = await compilePlan({ cases, env, policy, seed: 1, nowMs: Date.now() });
  console.log(`  ${cases.length} 用例 → ${plan.entries.length} entry（HTTP ${plan.entries.filter((e) => e.family === 'http').length} + UI ${plan.entries.filter((e) => e.family === 'ui').length}）`);

  const { runId } = await kernel.call('run:begin', { projectId: project.id, envId: env.id, policy, seed: 1, plan });
  const factory = new PlaywrightUiDriverFactory();
  if (!factory.available()) console.log(`  ✗ UI 驱动不可用：${factory.unavailableReason()}（HTTP 用例不受影响）`);
  await executePlan({ kernel, projectId: project.id, runId, plan, env, uiDriver: factory });
  await kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });

  line('④ 判定');
  const results = await kernel.call('run:results', { projectId: project.id, runId });
  const nameOf = new Map(cases.map((c) => [c.id, c.name]));
  for (const e of results.entries) {
    const icon = e.verdict === 'passed' ? '✓' : e.verdict === 'failed' ? '✗' : '?';
    console.log(`  ${icon} ${e.verdict.padEnd(7)} ${e.paramRowLabel}  [${nameOf.get(e.caseId)}]`);
  }
  const failed = results.asserts.find((a) => !a.passed);
  if (failed !== undefined) {
    console.log(`\n  ★ HTTP 边界抓到实现违反 PRD：expected=${failed.expected} actual=${failed.actual}（依据 ${failed.sourceFile}:${failed.sourceLine}）`);
  }
  const shot = results.steps.find((s) => s.kind === 'ui_screenshot');
  if (shot !== undefined && shot.responseRef !== null) {
    const art = await kernel.call('artifact:get', { sha256: shot.responseRef });
    console.log(`  📷 UI 截图已落 artifact：${shot.responseRef.slice(0, 12)}…（${Buffer.from(art.contentBase64, 'base64').length} bytes 真图）`);
  }

  const run = await kernel.call('run:get', { projectId: project.id, runId });
  console.log(`\n  run counters=${JSON.stringify(run!.counters)}  events=${run!.eventCount}`);

  kernel.close();
  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
