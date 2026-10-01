/**
 * 项目与环境仓储 —— P5：一切查询以 scope 首参。
 * scope 只能经 mintScopeFor 铸造（校验项目存在）。
 */

import type { Db } from '../db.ts';
import { KernelError } from '../../shared/util.ts';
import { mintProjectScope, type ProjectScope } from '../../shared/ids.ts';
import type { EnvRecord, ProjectRecord, SourceType } from '../../shared/domain.ts';

type ProjectRow = {
  id: number;
  name: string;
  source_type: string;
  repo_url: string | null;
  local_path: string | null;
  git_ref: string | null;
  status: string;
  created_at_ms: number;
  updated_at_ms: number;
};

export interface CreateProjectInput {
  name: string;
  sourceType: SourceType;
  repoUrl: string | null;
  localPath: string | null;
  gitRef: string | null;
}

export function createProject(db: Db, input: CreateProjectInput, nowMs: number): ProjectRecord {
  const r = db
    .prepare(
      `INSERT INTO project (name, source_type, repo_url, local_path, git_ref, status, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(input.name, input.sourceType, input.repoUrl, input.localPath, input.gitRef, nowMs, nowMs);
  return getProjectRow(db, Number(r.lastInsertRowid))!;
}

export function getProjectRow(db: Db, projectId: number): ProjectRecord | undefined {
  const row = db.prepare('SELECT * FROM project WHERE id = ?').get(projectId) as ProjectRow | undefined;
  return row === undefined ? undefined : toProject(row);
}

function toProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.source_type as SourceType,
    repoUrl: row.repo_url,
    localPath: row.local_path,
    gitRef: row.git_ref,
    status: row.status as ProjectRecord['status'],
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export function listProjects(db: Db): ProjectRecord[] {
  const rows = db.prepare('SELECT * FROM project ORDER BY id').all() as ProjectRow[];
  return rows.map(toProject);
}

export function archiveProject(db: Db, projectId: number, nowMs: number): ProjectRecord {
  const changes = db
    .prepare("UPDATE project SET status = 'archived', updated_at_ms = ? WHERE id = ? AND status = 'active'")
    .run(nowMs, projectId).changes;
  if (changes === 0) throw new KernelError('not_found', `项目 ${projectId} 不存在或已归档`);
  return getProjectRow(db, projectId)!;
}

/** scope 的唯一铸造点：项目必须存在。 */
export function mintScopeFor(db: Db, projectId: number): ProjectScope {
  const exists = db.prepare('SELECT 1 FROM project WHERE id = ?').get(projectId);
  if (exists === undefined) throw new KernelError('not_found', `项目 ${projectId} 不存在`);
  return mintProjectScope(projectId);
}

/* ─────────────────────────── env ─────────────────────────── */

type EnvRow = {
  id: number;
  project_id: number;
  name: string;
  base_url: string;
  variables: string;
  secret_names: string;
  headers: string;
  allow_self_signed: number;
  created_at_ms: number;
};

export interface CreateEnvInput {
  name: string;
  baseUrl: string;
  variables: Record<string, unknown>;
  secretNames: string[];
  headers: Record<string, string>;
  allowSelfSigned: boolean;
}

export function createEnv(db: Db, scope: ProjectScope, input: CreateEnvInput, nowMs: number): EnvRecord {
  const r = db
    .prepare(
      `INSERT INTO env (project_id, name, base_url, variables, secret_names, headers, allow_self_signed, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scope.projectId,
      input.name,
      input.baseUrl,
      JSON.stringify(input.variables),
      JSON.stringify(input.secretNames),
      JSON.stringify(input.headers),
      input.allowSelfSigned ? 1 : 0,
      nowMs,
    );
  return getEnv(db, scope, Number(r.lastInsertRowid))!;
}

export function getEnv(db: Db, scope: ProjectScope, envId: number): EnvRecord | undefined {
  const row = db
    .prepare('SELECT * FROM env WHERE id = ? AND project_id = ?')
    .get(envId, scope.projectId) as EnvRow | undefined;
  return row === undefined ? undefined : toEnv(row);
}

export function listEnvs(db: Db, scope: ProjectScope): EnvRecord[] {
  const rows = db
    .prepare('SELECT * FROM env WHERE project_id = ? ORDER BY id')
    .all(scope.projectId) as EnvRow[];
  return rows.map(toEnv);
}

function toEnv(row: EnvRow): EnvRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    baseUrl: row.base_url,
    variables: JSON.parse(row.variables) as Record<string, unknown>,
    secretNames: JSON.parse(row.secret_names) as string[],
    headers: JSON.parse(row.headers) as Record<string, string>,
    allowSelfSigned: row.allow_self_signed === 1,
    createdAtMs: row.created_at_ms,
  };
}
