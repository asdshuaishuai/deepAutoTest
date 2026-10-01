/**
 * SQLite 封装（node:sqlite，零原生依赖 —— W4 首选路径）。
 *
 * 纪律（06 §1）：
 *  - 迁移只增不改；已应用迁移的 checksum 不符 → 拒绝启动（不是静默用错的 schema 跑）
 *  - 事件与投影同事务（03 §6.3 / 06 §4.2）
 */

import { DatabaseSync } from 'node:sqlite';
import { KernelError, sha256Hex } from '../shared/util.ts';
import { MIGRATIONS } from './migrations/index.ts';

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migration (
      name           TEXT    PRIMARY KEY,
      checksum       TEXT    NOT NULL,
      applied_at_ms  INTEGER NOT NULL
    ) STRICT;
  `);

  for (const m of MIGRATIONS) {
    const applied = db
      .prepare('SELECT name, checksum FROM _migration WHERE name = ?')
      .get(m.name) as { name: string; checksum: string } | undefined;

    if (applied === undefined) {
      tx(db, () => {
        db.exec(m.sql);
        db.prepare('INSERT INTO _migration (name, checksum, applied_at_ms) VALUES (?, ?, ?)').run(
          m.name,
          sha256Hex(m.sql),
          Date.now(),
        );
      });
      continue;
    }

    if (applied.checksum !== sha256Hex(m.sql)) {
      // 已发布的迁移被编辑 → 数据不可信，宁可拒绝启动
      throw new KernelError(
        'migration_checksum_mismatch',
        `迁移 ${m.name} 在发布后被修改过；历史数据不可再生，拒绝启动。请新增迁移而不是编辑旧的。`,
      );
    }
  }
}

let txDepth = 0;

/** 同步事务。node:sqlite 全同步，事务即普通的 BEGIN/COMMIT。 */
export function tx<T>(db: Db, fn: () => T): T {
  if (txDepth > 0) return fn();
  txDepth += 1;
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 连接已坏时 ROLLBACK 可能再抛，吞掉保留原始错误 */
    }
    throw err;
  } finally {
    txDepth -= 1;
  }
}

/** 内存库（测试与投影重建用）。 */
export function openMemoryDb(): Db {
  return openDb(':memory:');
}
