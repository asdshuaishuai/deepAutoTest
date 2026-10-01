/**
 * 只读采样器（S4）：sqlite 走内置 node:sqlite（零依赖）；mysql/pg 为可选依赖，
 * 不可用时诚实拒绝（与 UI 驱动同一纪律）。
 *
 * 建连即设会话级只读（第②层）+ 驱动禁多语句（第③层）；语句过 guard 白名单（第④层）。
 * 一切采样结果过写时脱敏（08 §4）再返回——落库路径统一在 kernel 写入门，这里是源头。
 */

import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { guardReadOnlySql, guardIdentifier, sessionReadOnlyStatements } from './guard.ts';
import { KernelError } from '../kernel/shared/util.ts';
import { redactDeep } from '../kernel/domain/redact.ts';

const require = createRequire(import.meta.url);

const SAMPLE_LIMIT_MAX = 20;
const QUERY_ROW_LIMIT = 1000;

export type Dialect = 'mysql' | 'postgres' | 'sqlite';

/** 打开的连接句柄（driver 无关的只读面）。 */
export interface SampleConnection {
  dialect: Dialect;
  /** 已过白名单的查询执行。 */
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

export async function openConnection(dialect: Dialect, dsn: string): Promise<SampleConnection> {
  switch (dialect) {
    case 'sqlite':
      return openSqlite(dsn);
    case 'mysql':
      return openMysql(dsn);
    case 'postgres':
      return openPostgres(dsn);
  }
}

/* ─────────────── sqlite（内置，零依赖） ─────────────── */

export function openSqlite(dbPath: string): SampleConnection {
  const path = dbPath.replace(/^file:\/\//, '').replace(/^sqlite:(\/\/)?/, '');
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    throw new KernelError('db_connect_failed', `sqlite 打开失败：${String((err as Error).message)}`);
  }
  for (const stmt of sessionReadOnlyStatements('sqlite')) db.exec(stmt);
  return {
    dialect: 'sqlite',
    async query(sql, params = []) {
      const guard = guardReadOnlySql(sql);
      if (!guard.ok) throw new KernelError('sql_rejected', guard.reason ?? 'rejected');
      try {
        return db.prepare(sql).all(...(params as string[])) as unknown as Record<string, unknown>[];
      } catch (err) {
        throw new KernelError('sql_failed', String((err as Error).message));
      }
    },
    async close() {
      db.close();
    },
  };
}

/* ─────────────── mysql / pg（可选依赖） ─────────────── */

async function openMysql(dsn: string): Promise<SampleConnection> {
  let mysql: typeof import('mysql2/promise');
  try {
    mysql = require('mysql2/promise');
  } catch {
    throw new KernelError('driver_unavailable', 'mysql2 未安装（npm i mysql2）');
  }
  let conn: import('mysql2/promise').Connection;
  try {
    conn = await mysql.createConnection({ uri: dsn, multipleStatements: false });
  } catch (err) {
    throw new KernelError('db_connect_failed', `mysql 连接失败：${String((err as Error).message).split('\n')[0]}`);
  }
  for (const stmt of sessionReadOnlyStatements('mysql')) await conn.query(stmt);
  return {
    dialect: 'mysql',
    async query(sql, params = []) {
      const guard = guardReadOnlySql(sql);
      if (!guard.ok) throw new KernelError('sql_rejected', guard.reason ?? 'rejected');
      const [rows] = await conn.query(sql, params as never);
      return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    },
    async close() {
      await conn.end();
    },
  };
}

async function openPostgres(dsn: string): Promise<SampleConnection> {
  type PgClient = { connect(): Promise<unknown>; query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> };
  let pg: { Client: new (cfg: { connectionString: string }) => PgClient };
  try {
    pg = require('pg');
  } catch {
    throw new KernelError('driver_unavailable', 'pg 未安装（npm i pg）');
  }
  const client = new pg.Client({ connectionString: dsn });
  try {
    await client.connect();
  } catch (err) {
    throw new KernelError('db_connect_failed', `postgres 连接失败：${String((err as Error).message).split('\n')[0]}`);
  }
  for (const stmt of sessionReadOnlyStatements('postgres')) await client.query(stmt);
  return {
    dialect: 'postgres',
    async query(sql, params = []) {
      const guard = guardReadOnlySql(sql);
      if (!guard.ok) throw new KernelError('sql_rejected', guard.reason ?? 'rejected');
      const res = await client.query(sql, params);
      return (res.rows ?? []) as Record<string, unknown>[];
    },
    async close() {
      await client.end();
    },
  };
}

/* ─────────────── 采样原语（Agent 接口约束，08 §3.2） ─────────────── */

export interface SampleOptions {
  table: string;
  /** 等值条件（只允许列=值形态，防 WHERE 1=1 全表拉取）。 */
  where?: { column: string; value: string | number }[];
  /** 硬上限 20（把表拉进上下文的防线）。 */
  limit?: number;
}

export async function sampleRows(conn: SampleConnection, opts: SampleOptions): Promise<Record<string, unknown>[]> {
  const idGuard = guardIdentifier(opts.table);
  if (!idGuard.ok) throw new KernelError('sql_rejected', idGuard.reason ?? 'rejected');
  const limit = Math.min(Math.max(1, opts.limit ?? SAMPLE_LIMIT_MAX), SAMPLE_LIMIT_MAX);

  const params: unknown[] = [];
  let where = '';
  if (opts.where !== undefined && opts.where.length > 0) {
    const clauses: string[] = [];
    for (const cond of opts.where) {
      const colGuard = guardIdentifier(cond.column);
      if (!colGuard.ok) throw new KernelError('sql_rejected', colGuard.reason ?? 'rejected');
      clauses.push(`"${cond.column}" = ?`);
      params.push(cond.value);
    }
    where = ` WHERE ${clauses.join(' AND ')}`;
  }

  const sql = `SELECT * FROM "${opts.table}"${where} LIMIT ${limit}`;
  const rows = await conn.query(sql, params);
  return redactDeep(rows) as Record<string, unknown>[];
}

export async function runReadOnlyQuery(conn: SampleConnection, sql: string): Promise<Record<string, unknown>[]> {
  const rows = await conn.query(sql);
  return redactDeep(rows.slice(0, QUERY_ROW_LIMIT)) as Record<string, unknown>[];
}

/* ─────────────── schema 内省（08 §3.3） ─────────────── */

export interface DbColumn {
  table: string;
  column: string;
  dataType: string;
  maxLength: number | null;
}

export async function introspectSchema(conn: SampleConnection): Promise<DbColumn[]> {
  switch (conn.dialect) {
    case 'sqlite': {
      const tables = await conn.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
      const out: DbColumn[] = [];
      // 注意：用 SELECT 形态的 pragma_table_info 而非 PRAGMA 语句——白名单对内省同样生效
      for (const t of tables) {
        const tableName = t['name'];
        if (typeof tableName !== 'string') continue;
        const cols = await conn.query('SELECT name, type FROM pragma_table_info(?)', [tableName]).catch(() => []);
        for (const c of cols) {
          out.push({ table: tableName, column: String(c['name'] ?? ''), dataType: String(c['type'] ?? ''), maxLength: null });
        }
      }
      return out;
    }
    case 'mysql': {
      const rows = await conn.query(
        `SELECT table_name, column_name, data_type, character_maximum_length
         FROM information_schema.columns WHERE table_schema = DATABASE()`,
      );
      return rows.map((r) => ({
        table: String(r['table_name'] ?? r['TABLE_NAME']),
        column: String(r['column_name'] ?? r['COLUMN_NAME']),
        dataType: String(r['data_type'] ?? r['DATA_TYPE'] ?? ''),
        maxLength: r['character_maximum_length'] === null || r['character_maximum_length'] === undefined ? null : Number(r['character_maximum_length']),
      }));
    }
    case 'postgres': {
      const rows = await conn.query(
        `SELECT table_name, column_name, data_type, character_maximum_length
         FROM information_schema.columns WHERE table_schema = 'public'`,
      );
      return rows.map((r) => ({
        table: String(r['table_name']),
        column: String(r['column_name']),
        dataType: String(r['data_type']),
        maxLength: r['character_maximum_length'] === null ? null : Number(r['character_maximum_length']),
      }));
    }
  }
}
