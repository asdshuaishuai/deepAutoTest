/**
 * 采样层：四层只读防护（白名单穷举 / 会话级只读真库验证 / 采样接口化 / 脱敏）
 * + schema 内省漂移 + db_check 防假通过 e2e。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guardReadOnlySql, guardIdentifier, sessionReadOnlyStatements, stripSqlComments } from '../src/sampling/guard.ts';
import { openSqlite, sampleRows, runReadOnlyQuery, introspectSchema } from '../src/sampling/sampler.ts';
import { checkDrift } from '../src/sampling/drift.ts';
import { makeDbChecker } from '../src/sampling/index.ts';
import type { Server } from 'node:http';
import type { TestCaseRecord } from '../src/kernel/shared/domain.ts';
import { testKernel } from './helpers.ts';
import type { PrincipleRecord } from '../src/kernel/shared/domain.ts';

describe('SQL 只读白名单（08 §3.1 第④层）', () => {
  it('允许：查询形态', () => {
    for (const sql of [
      'SELECT * FROM users',
      'SELECT 1;',
      'WITH t AS (SELECT 1 AS n) SELECT * FROM t',
      'EXPLAIN SELECT * FROM orders',
      "SHOW TABLES",
      'DESCRIBE users',
      "SELECT * FROM t WHERE note = '含分号; 的文本'",
      'SELECT 1 /* 注释里有 ; DROP TABLE x */',
    ]) {
      expect(guardReadOnlySql(sql).ok, sql).toBe(true);
    }
  });

  it('拒绝：写 / DDL / 锁 / 外带 / 多语句 / 注释藏匿', () => {
    for (const [sql, reason] of [
      ['DELETE FROM users', 'DELETE'],
      ['UPDATE users SET a = 1', 'UPDATE'],
      ['INSERT INTO users VALUES (1)', 'INSERT'],
      ['DROP TABLE users', 'DROP'],
      ['CREATE TABLE t (a INT)', 'CREATE'],
      ['TRUNCATE orders', 'TRUNCATE'],
      ['CALL do_thing()', 'CALL'],
      ['SELECT * FROM users FOR UPDATE', 'FOR UPDATE'],
      ['SELECT * FROM users LOCK IN SHARE MODE', 'LOCK'],
      ["SELECT * INTO OUTFILE '/tmp/x' FROM users", 'INTO OUTFILE'],
      ['SELECT 1; DROP TABLE users', 'multiple_statements'],
      ['SELECT 1 ;DELETE FROM users', 'multiple_statements'],
      ['SET @x = 1', 'SET'],
      ['ATTACH DATABASE "x" AS y', 'ATTACH'],
      ['REPLACE INTO users VALUES (1)', 'REPLACE'],
      ['-- 注释\nDROP TABLE x', 'not_a_read_statement'],
      ['SELECT 1; ', 'ok-尾分号除外'], // 尾分号允许（见允许组），这里只是占位防漏
    ] as [string, string][]) {
      const result = guardReadOnlySql(sql);
      if (reason === 'ok-尾分号除外') {
        expect(result.ok, sql).toBe(true);
      } else {
        expect(result.ok, `${sql} → ${result.reason}`).toBe(false);
      }
    }
  });

  it('标识符白名单：表采样接口不接受任意 SQL 形态', () => {
    expect(guardIdentifier('users').ok).toBe(true);
    expect(guardIdentifier('app.users').ok).toBe(true);
    expect(guardIdentifier('users; DROP TABLE x').ok).toBe(false);
    expect(guardIdentifier('"users"').ok).toBe(false);
    expect(guardIdentifier('1users').ok).toBe(false);
  });

  it('会话只读语句：三方言各就各位', () => {
    expect(sessionReadOnlyStatements('mysql')).toEqual(['SET SESSION TRANSACTION READ ONLY']);
    expect(sessionReadOnlyStatements('postgres')).toEqual(['SET default_transaction_read_only = on']);
    expect(sessionReadOnlyStatements('sqlite')).toEqual(['PRAGMA query_only = ON']);
  });

  it('注释剥除', () => {
    expect(stripSqlComments('SELECT 1 -- tail').trim()).toBe('SELECT 1');
    expect(stripSqlComments('SELECT /* mid ; drop */ 1')).toBe('SELECT   1');
  });
});

describe('sqlite 真库（第②层会话只读 + 采样 + 脱敏）', () => {
  function makeDb(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dat-sql-'));
    const path = join(dir, 'app.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, phone TEXT, note TEXT)');
    db.prepare('INSERT INTO users (phone, note) VALUES (?, ?)').run('13812345678', 'hello');
    db.prepare('INSERT INTO users (phone, note) VALUES (?, ?)').run('13998765432', 'world');
    db.close();
    return path;
  }

  it('采样：脱敏生效、limit 上限 20、等值 where', async () => {
    const conn = await openSqlite(makeDb());
    const rows = await sampleRows(conn, { table: 'users', where: [{ column: 'id', value: 1 }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!['phone']).toBe('138****5678'); // ★ 写时脱敏（源头）

    const capped = await sampleRows(conn, { table: 'users', limit: 999 });
    expect(capped).toHaveLength(2); // 上限 20；表只有 2 行

    await expect(sampleRows(conn, { table: 'users; DROP TABLE users' })).rejects.toMatchObject({ code: 'sql_rejected' });
    await conn.close();
  });

  it('原始查询过白名单；表名注入被拒', async () => {
    const conn = await openSqlite(makeDb());
    const rows = await runReadOnlyQuery(conn, 'SELECT COUNT(*) AS n FROM users');
    expect(rows[0]!['n']).toBe(2);
    await expect(runReadOnlyQuery(conn, 'DELETE FROM users')).rejects.toMatchObject({ code: 'sql_rejected' });
    await conn.close();
  });

  it('会话级只读（第②层）：连接上执行写被 SQLite 拒绝（白名单之后的最后防线）', async () => {
    const path = makeDb();
    const direct = new DatabaseSync(path);
    for (const stmt of sessionReadOnlyStatements('sqlite')) direct.exec(stmt);
    expect(() => direct.prepare('UPDATE users SET note = ? WHERE id = 1').run('x')).toThrowError(/read-only|readonly/i);
    direct.close();
  });

  it('内省：SELECT 形态的 pragma_table_info（白名单对内省同样生效）', async () => {
    const conn = await openSqlite(makeDb());
    const cols = await introspectSchema(conn);
    const users = cols.filter((c) => c.table === 'users');
    expect(users.map((c) => c.column).sort()).toEqual(['id', 'note', 'phone']);
    await conn.close();
  });
});

describe('schema 漂移检测（vs Prisma 持久层原则）', () => {
  it('长度/类型不一致检出；一致的零漂移', () => {
    const principle = (subject: string, valueJson: Record<string, unknown>): PrincipleRecord => ({
      id: 1, projectId: 1, subject, rule: 'r', valueJson,
      sourceFile: 'schema.prisma', sourceLine: 3, layer: 'persistence', confidence: 'high',
      status: 'adopted', conflictJson: null, proposedBy: 't', reviewedBy: 'k', reviewedAtMs: 1, diff: null,
    });
    const columns = [
      { table: 'User', column: 'phone', dataType: 'varchar', maxLength: 50 },
      { table: 'User', column: 'age', dataType: 'text', maxLength: null },
      { table: 'User', column: 'ok_field', dataType: 'varchar', maxLength: 20 },
    ];
    const principles = [
      principle('User.phone', { type: 'string', maxLength: 20 }),   // 漂移：20 vs 50
      principle('User.age', { type: 'number' }),                     // 漂移：number vs text
      principle('User.ok_field', { type: 'string', maxLength: 20 }), // 一致
      principle('CreateUserDto.age', { type: 'number' }),            // validation 层：不参与（subject 不在库中）
    ];
    const drift = checkDrift(columns, principles);
    expect(drift).toHaveLength(2);
    expect(drift[0]).toMatchObject({ subject: 'User.phone', kind: 'length_mismatch', expected: 'maxLength=20', actual: 'maxLength=50' });
    expect(drift[1]).toMatchObject({ subject: 'User.age', kind: 'type_mismatch' });
  });
});

describe('db_check 防假通过（03 §2.4）', () => {
  it('接口 201 但库里没写 → failed（假通过被侧证抓到）；写了 → passed', async () => {
    const { createServer } = await import('node:http');
    const { compilePlan } = await import('../src/execution/plan-compiler.ts');
    const { executePlan } = await import('../src/execution/runner.ts');
    const { defaultRunPolicy } = await import('../src/kernel/shared/domain.ts');

    // 被测系统：写不写库由 URL 决定（/orders 写库；/fake 只回 201 不写库 —— 模拟假通过）
    const dir = mkdtempSync(join(tmpdir(), 'dat-dbcheck-'));
    const dbPath = join(dir, 'app.db');
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, amount INTEGER)');
    seed.close();

    let server: Server | undefined;
    const port = await new Promise<number>((resolve) => {
      server = createServer((req, res) => {
        if (req.method === 'POST') {
          const writes = new URL(req.url ?? '/', 'http://x').pathname === '/orders';
          if (writes) {
            const db = new DatabaseSync(dbPath);
            db.prepare('INSERT INTO orders (amount) VALUES (?)').run(100);
            db.close();
          }
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end('{"data":{"id":"o_1"}}');
          return;
        }
        res.writeHead(404);
        res.end();
      });
      server.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port));
    });

    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'orders', sourceType: 'local' });
    const env = await h.kernel.call('env:create', { projectId: project.id, name: 'e', baseUrl: `http://127.0.0.1:${port}` });
    const connRec = await h.kernel.call('dbconn:create', { projectId: project.id, name: 'appdb', dialect: 'sqlite', dsn: dbPath });
    void connRec;

    // DSN 加密 + 诚实标注
    const raw = h.kernel.db.prepare('SELECT dsn_encrypted FROM db_connection').get() as { dsn_encrypted: Uint8Array };
    expect(Buffer.from(raw.dsn_encrypted).toString('utf8')).not.toContain(dbPath);
    const revealed = await h.kernel.call('dbconn:getDsn', { projectId: project.id, connId: connRec.id });
    expect(revealed.dsn).toBe(dbPath);
    expect(revealed.protection).toContain('非系统钥匙串');

    const mkCase = async (name: string, url: string, expectRows: { eq?: number; gte?: number }): Promise<TestCaseRecord> => {
      const proposed = await h.kernel.call('case:propose', {
        projectId: project.id, proposedBy: 't',
        draft: {
          name, description: null, routeId: null, paramKind: 'single',
          steps: [
            { id: 's0', seq: 0, kind: 'request', config: { method: 'POST', url } },
            { id: 's1', seq: 1, kind: 'db_check', config: { connection: 'appdb', query: 'SELECT id, amount FROM orders', expectRows } },
          ],
          params: { kind: 'single', rows: [{ label: 'baseline', values: {}, intent: 'baseline' }] },
          provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
          policyOverride: null, tags: [],
        },
      });
      return h.kernel.call('case:review', { projectId: project.id, caseId: proposed.id, action: 'adopt', actor: 'kel' });
    };
    const wrote = await mkCase('真写库（≥1 行）', '/orders', { gte: 1 });
    const faked = await mkCase('假通过（恰好 999 行）', '/fake', { eq: 999 });

    const policy = defaultRunPolicy();
    const plan = await compilePlan({ cases: [wrote, faked], env, policy, seed: 1, nowMs: 0 });
    const { runId } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy, seed: 1, plan });
    await executePlan({ kernel: h.kernel, projectId: project.id, runId, plan, env, dbChecker: makeDbChecker(h.kernel) });
    await h.kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });

    const results = await h.kernel.call('run:results', { projectId: project.id, runId });
    const byCase = new Map(results.entries.map((e) => [e.caseId, e.verdict]));
    expect(byCase.get(wrote.id)).toBe('passed');   // 201 + 库里真有行
    expect(byCase.get(faked.id)).toBe('failed');   // ★ 201 但行数不对——假通过被侧证抓到

    // db_check 观测落了步骤行 + 断言行
    expect(results.steps.find((s) => s.kind === 'db_check')).toBeTruthy();
    const dbAssert = results.asserts.find((a) => !a.passed)!;
    expect(dbAssert.expected).toBe('{"eq":999}');
    expect(dbAssert.actual).toBe('1'); // 写库 case 已插入 1 行，999 不符

    // 跨项目隔离（P5）
    const other = await h.kernel.call('project:create', { name: 'other', sourceType: 'local' });
    await expect(makeDbChecker(h.kernel).query(other.id, 'appdb', 'SELECT 1')).rejects.toMatchObject({ message: expect.stringContaining('dbconn_not_found') });

    // 缺 dbChecker：诚实拒绝而不是静默跳过
    const { runId: r2 } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy, seed: 1, plan });
    const { executePlan: runAgain } = await import('../src/execution/runner.ts');
    await runAgain({ kernel: h.kernel, projectId: project.id, runId: r2, plan, env });
    await h.kernel.call('run:finish', { projectId: project.id, runId: r2, status: 'completed' });
    const res2 = await h.kernel.call('run:results', { projectId: project.id, runId: r2 });
    expect(res2.entries.every((e) => e.verdict === 'errored')).toBe(true);

    if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
    h.dispose();
  });
});
