/**
 * 数据库连接仓储（06 §2.1 db_connection 表）。
 * DSN 加密落库（secrets.ts）；读取分「记录」（不含 DSN）与「揭示」（解密，仅 sampling 层用）。
 */

import type { Db } from '../db.ts';
import { KernelError } from '../../shared/util.ts';
import type { ProjectScope } from '../../shared/ids.ts';

export type DbDialect = 'mysql' | 'postgres' | 'sqlite';

export interface DbConnectionRecord {
  id: number;
  projectId: number;
  name: string;
  dialect: DbDialect;
  readOnly: boolean;
  createdAtMs: number;
}

type ConnRow = {
  id: number;
  project_id: number;
  name: string;
  dialect: string;
  dsn_encrypted: Uint8Array;
  read_only: number;
  created_at_ms: number;
};

export function insertConnection(db: Db, scope: ProjectScope, name: string, dialect: DbDialect, dsnEncrypted: Uint8Array, readOnly: boolean, nowMs: number): DbConnectionRecord {
  const exists = db
    .prepare('SELECT 1 FROM db_connection WHERE project_id = ? AND name = ?')
    .get(scope.projectId, name);
  if (exists !== undefined) throw new KernelError('duplicate_connection', `连接名「${name}」已存在`);

  const r = db
    .prepare('INSERT INTO db_connection (project_id, name, dialect, dsn_encrypted, read_only, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .run(scope.projectId, name, dialect, dsnEncrypted, readOnly ? 1 : 0, nowMs);
  return { id: Number(r.lastInsertRowid), projectId: scope.projectId, name, dialect, readOnly, createdAtMs: nowMs };
}

export function listConnections(db: Db, scope: ProjectScope): DbConnectionRecord[] {
  const rows = db
    .prepare('SELECT * FROM db_connection WHERE project_id = ? ORDER BY id')
    .all(scope.projectId) as ConnRow[];
  return rows.map(toRecord);
}

export function getConnectionRow(db: Db, scope: ProjectScope, connId: number): { record: DbConnectionRecord; dsnEncrypted: Uint8Array } | undefined {
  const row = db
    .prepare('SELECT * FROM db_connection WHERE id = ? AND project_id = ?')
    .get(connId, scope.projectId) as ConnRow | undefined;
  if (row === undefined) return undefined;
  return { record: toRecord(row), dsnEncrypted: row.dsn_encrypted };
}

export function deleteConnection(db: Db, scope: ProjectScope, connId: number): void {
  const changes = db
    .prepare('DELETE FROM db_connection WHERE id = ? AND project_id = ?')
    .run(connId, scope.projectId).changes;
  if (changes === 0) throw new KernelError('not_found', `连接 ${connId} 不存在`);
}

function toRecord(row: ConnRow): DbConnectionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    dialect: row.dialect as DbDialect,
    readOnly: row.read_only === 1,
    createdAtMs: row.created_at_ms,
  };
}
