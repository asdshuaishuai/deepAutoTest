/**
 * 源码索引 / API 候选 / 原则仓储（06 §2.2–2.3）。
 *
 * P3：分析器（ts-morph 适配器）只能 propose——所有写入经 insertXxx（status='proposed'），
 * 终态只经 applyReviewResult（domain/review 的产物）。
 * 原则的 source_file/source_line 非空：没有溯源的原则无法被验证（03 §2.5）。
 */

import type { Db } from '../db.ts';
import { tx } from '../db.ts';
import { KernelError } from '../../shared/util.ts';
import type { ProjectScope } from '../../shared/ids.ts';
import type {
  PrincipleDraft,
  PrincipleLayer,
  PrincipleRecord,
  ReviewDiff,
  ReviewStatus,
  RouteCandidateDraft,
  RouteCandidateRecord,
  SourceIndexRecord,
} from '../../shared/domain.ts';

/* ─────────────────────────── source_index ─────────────────────────── */

export function recordSourceIndex(db: Db, scope: ProjectScope, gitRef: string | null, fileCount: number, frameworks: string[], nowMs: number): SourceIndexRecord {
  const r = db
    .prepare('INSERT INTO source_index (project_id, git_ref, file_count, frameworks, indexed_at_ms) VALUES (?, ?, ?, ?, ?)')
    .run(scope.projectId, gitRef, fileCount, JSON.stringify(frameworks), nowMs);
  return { id: Number(r.lastInsertRowid), projectId: scope.projectId, gitRef, fileCount, frameworks, indexedAtMs: nowMs };
}

/* ─────────────────────────── route_candidate ─────────────────────────── */

export function insertRoutes(
  db: Db,
  scope: ProjectScope,
  sourceIndexId: number,
  drafts: RouteCandidateDraft[],
  proposedBy: string,
): number {
  return tx(db, () => {
    const stmt = db.prepare(
      `INSERT INTO route_candidate (project_id, source_index_id, method, path, handler_file, handler_line,
                                    framework, confidence, status, doc_drift, doc_missing, proposed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 0, 0, ?)`,
    );
    let inserted = 0;
    for (const d of drafts) {
      // 幂等重索引：同项目同 method+path 已存在（任意状态）则跳过
      const exists = db
        .prepare('SELECT 1 FROM route_candidate WHERE project_id = ? AND method = ? AND path = ?')
        .get(scope.projectId, d.method, d.path);
      if (exists !== undefined) continue;
      stmt.run(scope.projectId, sourceIndexId, d.method, d.path, d.handlerFile, d.handlerLine, d.framework, d.confidence, proposedBy);
      inserted += 1;
    }
    return inserted;
  });
}

export function listRoutes(db: Db, scope: ProjectScope, status?: ReviewStatus): RouteCandidateRecord[] {
  const rows =
    status === undefined
      ? db.prepare('SELECT * FROM route_candidate WHERE project_id = ? ORDER BY id').all(scope.projectId)
      : db.prepare('SELECT * FROM route_candidate WHERE project_id = ? AND status = ? ORDER BY id').all(scope.projectId, status);
  return (rows as RouteRow[]).map(toRoute);
}

export function getRoute(db: Db, scope: ProjectScope, routeId: number): RouteCandidateRecord | undefined {
  const row = db.prepare('SELECT * FROM route_candidate WHERE id = ? AND project_id = ?').get(routeId, scope.projectId) as RouteRow | undefined;
  return row === undefined ? undefined : toRoute(row);
}

export function applyRouteReview(
  db: Db,
  scope: ProjectScope,
  routeId: number,
  next: { status: ReviewStatus; diff: ReviewDiff | null; reviewedBy: string; reviewedAtMs: number },
): RouteCandidateRecord {
  const changes = db
    .prepare('UPDATE route_candidate SET status = ?, reviewed_by = ?, reviewed_at_ms = ?, diff = ? WHERE id = ? AND project_id = ?')
    .run(next.status, next.reviewedBy, next.reviewedAtMs, next.diff === null ? null : JSON.stringify(next.diff), routeId, scope.projectId).changes;
  if (changes === 0) throw new KernelError('not_found', `路由候选 ${routeId} 不存在`);
  return getRoute(db, scope, routeId)!;
}

type RouteRow = {
  id: number; project_id: number; source_index_id: number; method: string; path: string;
  handler_file: string; handler_line: number; framework: string; confidence: string; status: string;
  doc_drift: number; doc_missing: number; proposed_by: string; reviewed_by: string | null;
  reviewed_at_ms: number | null; diff: string | null;
};

function toRoute(row: RouteRow): RouteCandidateRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceIndexId: row.source_index_id,
    method: row.method,
    path: row.path,
    handlerFile: row.handler_file,
    handlerLine: row.handler_line,
    framework: row.framework,
    confidence: row.confidence as RouteCandidateRecord['confidence'],
    status: row.status as ReviewStatus,
    docDrift: row.doc_drift === 1,
    docMissing: row.doc_missing === 1,
    proposedBy: row.proposed_by,
    reviewedBy: row.reviewed_by,
    reviewedAtMs: row.reviewed_at_ms,
    diff: row.diff === null ? null : (JSON.parse(row.diff) as ReviewDiff),
  };
}

/* ─────────────────────────── principle ─────────────────────────── */

export function insertPrinciples(db: Db, scope: ProjectScope, drafts: PrincipleDraft[], proposedBy: string): number {
  return tx(db, () => {
    const stmt = db.prepare(
      `INSERT INTO principle (project_id, subject, rule, value_json, source_file, source_line, layer, confidence, status, conflict_json, proposed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, ?)`,
    );
    let inserted = 0;
    for (const d of drafts) {
      if (d.sourceFile.trim() === '' || d.sourceLine < 1) {
        throw new KernelError('provenance_required', `原则 ${d.subject} 缺少 file:line 溯源——没有溯源的原则无法被验证（03 §2.5）`);
      }
      // 幂等重索引：同项目同 subject+rule+来源已存在则跳过
      const exists = db
        .prepare('SELECT 1 FROM principle WHERE project_id = ? AND subject = ? AND rule = ? AND source_file = ? AND source_line = ?')
        .get(scope.projectId, d.subject, d.rule, d.sourceFile, d.sourceLine);
      if (exists !== undefined) continue;
      stmt.run(scope.projectId, d.subject, d.rule, d.valueJson === null ? null : JSON.stringify(d.valueJson), d.sourceFile, d.sourceLine, d.layer, d.confidence, proposedBy);
      inserted += 1;
    }
    return inserted;
  });
}

export function listPrinciples(db: Db, scope: ProjectScope, status?: ReviewStatus): PrincipleRecord[] {
  const rows =
    status === undefined
      ? db.prepare('SELECT * FROM principle WHERE project_id = ? ORDER BY id').all(scope.projectId)
      : db.prepare('SELECT * FROM principle WHERE project_id = ? AND status = ? ORDER BY id').all(scope.projectId, status);
  return (rows as PrincipleRow[]).map(toPrinciple);
}

export function getPrinciple(db: Db, scope: ProjectScope, principleId: number): PrincipleRecord | undefined {
  const row = db.prepare('SELECT * FROM principle WHERE id = ? AND project_id = ?').get(principleId, scope.projectId) as PrincipleRow | undefined;
  return row === undefined ? undefined : toPrinciple(row);
}

export function applyPrincipleReview(
  db: Db,
  scope: ProjectScope,
  principleId: number,
  next: { status: ReviewStatus; diff: ReviewDiff | null; reviewedBy: string; reviewedAtMs: number },
): PrincipleRecord {
  const changes = db
    .prepare('UPDATE principle SET status = ?, reviewed_by = ?, reviewed_at_ms = ?, diff = ? WHERE id = ? AND project_id = ?')
    .run(next.status, next.reviewedBy, next.reviewedAtMs, next.diff === null ? null : JSON.stringify(next.diff), principleId, scope.projectId).changes;
  if (changes === 0) throw new KernelError('not_found', `原则 ${principleId} 不存在`);
  return getPrinciple(db, scope, principleId)!;
}

type PrincipleRow = {
  id: number; project_id: number; subject: string; rule: string; value_json: string | null;
  source_file: string; source_line: number; layer: string; confidence: string; status: string;
  conflict_json: string | null; proposed_by: string; reviewed_by: string | null; reviewed_at_ms: number | null; diff: string | null;
};

function toPrinciple(row: PrincipleRow): PrincipleRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    subject: row.subject,
    rule: row.rule,
    valueJson: row.value_json === null ? null : (JSON.parse(row.value_json) as Record<string, unknown>),
    sourceFile: row.source_file,
    sourceLine: row.source_line,
    layer: row.layer as PrincipleLayer,
    confidence: row.confidence as PrincipleRecord['confidence'],
    status: row.status as ReviewStatus,
    conflictJson: row.conflict_json === null ? null : (JSON.parse(row.conflict_json) as Record<string, unknown>),
    proposedBy: row.proposed_by,
    reviewedBy: row.reviewed_by,
    reviewedAtMs: row.reviewed_at_ms,
    diff: row.diff === null ? null : (JSON.parse(row.diff) as ReviewDiff),
  };
}
