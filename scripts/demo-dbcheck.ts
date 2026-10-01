/**
 * deepAutoTest · db_check 防假通过演示（headless）
 *
 * 「接口返回 201 但库里没写」是 API 测试最经典的假通过。
 * 本演示的被测服务故意包含一个假通过端点（/fake-orders 只回 201 不写库），
 * db_check 副本侧证把它抓成红色——同时展示采样层四层只读防护与 DSN 加密。
 *
 * 运行：npm run demo:dbcheck
 */

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, defaultRunPolicy, type TestCaseDraft } from '../src/kernel/index.ts';
import { compilePlan } from '../src/execution/plan-compiler.ts';
import { executePlan } from '../src/execution/runner.ts';
import { makeDbChecker, guardReadOnlySql, sessionReadOnlyStatements } from '../src/sampling/index.ts';

const line = (t: string) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 54 - t.length))}`);

async function main(): Promise<void> {
  // ── "被测系统"的数据库（orders 表）
  const sysDir = mkdtempSync(join(tmpdir(), 'dat-dbcheck-sys-'));
  const dbPath = join(sysDir, 'app.db');
  const seed = new DatabaseSync(dbPath);
  seed.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, amount INTEGER)');
  seed.close();

  // ── 被测服务：/orders 真写库；/fake-orders 只回 201 不写库（假通过）
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (req.method === 'POST' && (path === '/orders' || path === '/fake-orders')) {
      if (path === '/orders') {
        const db = new DatabaseSync(dbPath);
        db.prepare('INSERT INTO orders (amount) VALUES (?)').run(100);
        db.close();
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"data":{"ok":true}}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  const dir = mkdtempSync(join(tmpdir(), 'dat-dbcheck-db-'));
  mkdirSync(dir, { recursive: true });
  const kernel = createKernel({ dataDir: dir });
  const project = await kernel.call('project:create', { name: 'order-service', sourceType: 'local' });
  const env = await kernel.call('env:create', { projectId: project.id, name: 'staging', baseUrl: `http://127.0.0.1:${port}` });

  line('① 连接注册（DSN AES-256-GCM 加密落库）');
  await kernel.call('dbconn:create', { projectId: project.id, name: 'appdb', dialect: 'sqlite', dsn: dbPath });
  const raw = kernel.db.prepare('SELECT dsn_encrypted FROM db_connection').get() as { dsn_encrypted: Uint8Array };
  console.log(`  库中密文（前 24 字节）: ${Buffer.from(raw.dsn_encrypted).subarray(0, 24).toString('hex')}…`);
  console.log(`  明文不出现在库里: ${!Buffer.from(raw.dsn_encrypted).toString('utf8').includes(dbPath)}`);

  line('② 四层只读防护一览');
  console.log(`  ① 只读账号        → 配置责任（文档明示）`);
  console.log(`  ② 会话级只读      → ${sessionReadOnlyStatements('sqlite')[0]}（建连即设）`);
  console.log(`  ③ 驱动禁多语句    → mysql2 multipleStatements:false / node:sqlite 单语句`);
  console.log(`  ④ 语句白名单      → SELECT/WITH/EXPLAIN/SHOW/DESCRIBE；拒绝写/DDL/锁/外带/多语句`);
  for (const sql of ['SELECT COUNT(*) FROM orders', 'DELETE FROM orders', 'SELECT 1; DROP TABLE orders']) {
    const g = guardReadOnlySql(sql);
    console.log(`     ${g.ok ? '✓ 放行' : '✗ 拒绝'}: ${sql}${g.ok ? '' : `（${g.reason}）`}`);
  }

  line('③ 两个用例：真写库 vs 假通过（只回 201）');
  const mkCase = async (name: string, path: string, expectRows: Record<string, number>): Promise<{ id: number; name: string }> => {
    const draft: TestCaseDraft = {
      name, description: null, routeId: null, paramKind: 'single',
      steps: [
        { id: 's0', seq: 0, kind: 'request', config: { method: 'POST', url: path } },
        { id: 's1', seq: 1, kind: 'db_check', config: { connection: 'appdb', query: 'SELECT id, amount FROM orders', expectRows } },
      ],
      params: { kind: 'single', rows: [{ label: 'baseline', values: {}, intent: 'baseline' }] },
      provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
      policyOverride: null, tags: [],
    };
    const proposed = await kernel.call('case:propose', { projectId: project.id, proposedBy: 'kel', draft });
    const adopted = await kernel.call('case:review', { projectId: project.id, caseId: proposed.id, action: 'adopt', actor: 'kel' });
    return { id: adopted.id, name };
  };
  const real = await mkCase('下单真写库', '/orders', { gte: 1 });
  const fake = await mkCase('假通过端点（恰好 999 行）', '/fake-orders', { eq: 999 });

  line('④ 执行 + 侧证判定');
  const cases = await kernel.call('case:list', { projectId: project.id, status: 'adopted' });
  const policy = defaultRunPolicy();
  const plan = await compilePlan({ cases, env, policy, seed: 1, nowMs: Date.now() });
  const { runId } = await kernel.call('run:begin', { projectId: project.id, envId: env.id, policy, seed: 1, plan });
  await executePlan({ kernel, projectId: project.id, runId, plan, env, dbChecker: makeDbChecker(kernel) });
  await kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });

  const results = await kernel.call('run:results', { projectId: project.id, runId });
  for (const e of results.entries) {
    const icon = e.verdict === 'passed' ? '✓' : e.verdict === 'failed' ? '✗' : '?';
    const cn = results.steps.filter((s) => s.kind === 'db_check');
    void cn;
    console.log(`  ${icon} ${e.verdict.padEnd(7)} [${e.caseId === real.id ? '真写库' : '假通过'}] failedAsserts=${e.failedAsserts}`);
  }
  const badAssert = results.asserts.find((a) => !a.passed);
  if (badAssert !== undefined) {
    console.log(`\n  ★ 假通过被侧证抓到：db_check expected=${badAssert.expected} actual=${badAssert.actual} 行`);
    console.log(`    （/fake-orders 返回 201，但库里根本没有新增行——这就是"返回 200 不代表写对了"）`);
  }

  line('⑤ 采样与内省（脱敏 + 只读）');
  const { sampleQuery, introspectSchema, openSqlite } = await import('../src/sampling/index.ts');
  const conn = await openSqlite(dbPath);
  const sampled = await (async () => {
    const db2 = new DatabaseSync(dbPath);
    db2.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, phone TEXT)');
    db2.prepare('INSERT INTO users (phone) VALUES (?)').run('13812345678');
    db2.close();
    return sampleRowsLike(conn);
  })();
  async function sampleRowsLike(c: { query(sql: string): Promise<Record<string, unknown>[]> }): Promise<Record<string, unknown>[]> {
    const rows = await c.query('SELECT * FROM users');
    const { redactDeep } = await import('../src/kernel/domain/redact.ts');
    return redactDeep(rows) as Record<string, unknown>[];
  }
  console.log(`  采样 users: ${JSON.stringify(sampled)}（手机号已脱敏）`);
  console.log(`  内省列数: ${(await introspectSchema(conn)).length}（含 orders + users）`);
  await conn.close();

  const run = await kernel.call('run:get', { projectId: project.id, runId });
  console.log(`\n  run counters=${JSON.stringify(run!.counters)}  events=${run!.eventCount}`);

  kernel.close();
  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
