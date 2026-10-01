/**
 * Agent 会话仓储（06 §2.8）：会话/轮次/checkpoint。
 * 轮次内容由 service 层脱敏后写入（08 §4：对话记录也是落库路径）。
 */

import type { Db } from '../db.ts';
import { KernelError } from '../../shared/util.ts';
import type { ProjectScope } from '../../shared/ids.ts';

export type AgentSessionKind = 'api_discovery' | 'principle_extract' | 'case_synth' | 'prd_extract';

export interface AgentSessionRecord {
  id: number;
  projectId: number;
  kind: AgentSessionKind;
  turnCount: number;
  /** checkpoint 存在（不外泄内容）。 */
  hasCheckpoint: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

type SessionRow = {
  id: number;
  project_id: number;
  kind: string;
  checkpoint: Uint8Array | null;
  turn_count: number;
  created_at_ms: number;
  updated_at_ms: number;
};

export function insertSession(db: Db, scope: ProjectScope, kind: AgentSessionKind, nowMs: number): AgentSessionRecord {
  const r = db
    .prepare('INSERT INTO agent_session (project_id, kind, turn_count, created_at_ms, updated_at_ms) VALUES (?, ?, 0, ?, ?)')
    .run(scope.projectId, kind, nowMs, nowMs);
  return { id: Number(r.lastInsertRowid), projectId: scope.projectId, kind, turnCount: 0, hasCheckpoint: false, createdAtMs: nowMs, updatedAtMs: nowMs };
}

export function getSession(db: Db, scope: ProjectScope, sessionId: number): AgentSessionRecord | undefined {
  const row = db.prepare('SELECT * FROM agent_session WHERE id = ? AND project_id = ?').get(sessionId, scope.projectId) as SessionRow | undefined;
  return row === undefined ? undefined : toRecord(row);
}

export function listSessions(db: Db, scope: ProjectScope): AgentSessionRecord[] {
  const rows = db.prepare('SELECT * FROM agent_session WHERE project_id = ? ORDER BY id').all(scope.projectId) as SessionRow[];
  return rows.map(toRecord);
}

function toRecord(row: SessionRow): AgentSessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as AgentSessionKind,
    turnCount: row.turn_count,
    hasCheckpoint: row.checkpoint !== null,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

/* ─────────────── 轮次 ─────────────── */

export interface AgentTurnRecord {
  turnSeq: number;
  role: string;
  content: string;
  toolName: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  atMs: number;
}

export function appendTurn(db: Db, scope: ProjectScope, sessionId: number, turn: { role: string; content: string; toolName?: string | null; tokensIn?: number | null; tokensOut?: number | null; atMs: number }): AgentTurnRecord {
  const session = db.prepare('SELECT 1 FROM agent_session WHERE id = ? AND project_id = ?').get(sessionId, scope.projectId);
  if (session === undefined) throw new KernelError('not_found', `会话 ${sessionId} 不在当前项目内`);
  const next = db.prepare('SELECT COALESCE(MAX(turn_seq), 0) + 1 AS next FROM agent_turn WHERE session_id = ?').get(sessionId) as { next: number };
  db.prepare(
    'INSERT INTO agent_turn (session_id, turn_seq, role, content, tool_name, tokens_in, tokens_out, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(sessionId, next.next, turn.role, turn.content, turn.toolName ?? null, turn.tokensIn ?? null, turn.tokensOut ?? null, turn.atMs);
  db.prepare('UPDATE agent_session SET turn_count = turn_count + 1, updated_at_ms = ? WHERE id = ?').run(turn.atMs, sessionId);
  return { turnSeq: next.next, role: turn.role, content: turn.content, toolName: turn.toolName ?? null, tokensIn: turn.tokensIn ?? null, tokensOut: turn.tokensOut ?? null, atMs: turn.atMs };
}

export function listTurns(db: Db, scope: ProjectScope, sessionId: number): AgentTurnRecord[] {
  const ok = db.prepare('SELECT 1 FROM agent_session WHERE id = ? AND project_id = ?').get(sessionId, scope.projectId);
  if (ok === undefined) throw new KernelError('not_found', `会话 ${sessionId} 不在当前项目内`);
  const rows = db
    .prepare('SELECT turn_seq, role, content, tool_name, tokens_in, tokens_out, at_ms FROM agent_turn WHERE session_id = ? ORDER BY turn_seq')
    .all(sessionId) as { turn_seq: number; role: string; content: string; tool_name: string | null; tokens_in: number | null; tokens_out: number | null; at_ms: number }[];
  return rows.map((r) => ({ turnSeq: r.turn_seq, role: r.role, content: r.content, toolName: r.tool_name, tokensIn: r.tokens_in, tokensOut: r.tokens_out, atMs: r.at_ms }));
}

/* ─────────────── checkpoint ─────────────── */

export function saveCheckpoint(db: Db, scope: ProjectScope, sessionId: number, blob: Uint8Array, nowMs: number): void {
  const changes = db
    .prepare('UPDATE agent_session SET checkpoint = ?, updated_at_ms = ? WHERE id = ? AND project_id = ?')
    .run(blob, nowMs, sessionId, scope.projectId).changes;
  if (changes === 0) throw new KernelError('not_found', `会话 ${sessionId} 不在当前项目内`);
}

export function loadCheckpoint(db: Db, scope: ProjectScope, sessionId: number): Uint8Array | null {
  const row = db.prepare('SELECT checkpoint FROM agent_session WHERE id = ? AND project_id = ?').get(sessionId, scope.projectId) as { checkpoint: Uint8Array | null } | undefined;
  if (row === undefined) throw new KernelError('not_found', `会话 ${sessionId} 不在当前项目内`);
  return row.checkpoint;
}
