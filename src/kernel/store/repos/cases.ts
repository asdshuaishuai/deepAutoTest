/**
 * 测试用例仓储。P3 纪律在代码结构上的强制：
 *  - insertCase 永远写 status='proposed' —— AI 与人都可以提议，但没有任何路径绕过人工门
 *  - 只有 applyReview（来自 domain/review 的纯函数产物）能写 adopted/rejected
 */

import type { Db } from '../db.ts';
import { KernelError } from '../../shared/util.ts';
import type { ProjectScope } from '../../shared/ids.ts';
import type { ReviewDiff, ReviewStatus, TestCaseDraft, TestCaseRecord } from '../../shared/domain.ts';

type CaseRow = {
  id: number;
  project_id: number;
  route_id: number | null;
  name: string;
  description: string | null;
  status: string;
  param_kind: string;
  steps_json: string;
  params_json: string;
  provenance_json: string;
  policy_json: string | null;
  tags: string;
  proposed_by: string;
  reviewed_by: string | null;
  reviewed_at_ms: number | null;
  diff: string | null;
  created_at_ms: number;
};

export function insertCase(
  db: Db,
  scope: ProjectScope,
  draft: TestCaseDraft,
  proposedBy: string,
  nowMs: number,
): TestCaseRecord {
  if (draft.params.kind === 'matrix') {
    const max = draft.params.maxRows ?? 32;
    if (draft.params.rows.length > max) {
      throw new KernelError(
        'matrix_rows_exceeded',
        `matrix 参数行 ${draft.params.rows.length} 超过声明的 maxRows=${max}；请缩小维度，不要静默截断。`,
      );
    }
  }
  const r = db
    .prepare(
      `INSERT INTO test_case (project_id, route_id, name, description, status, param_kind,
                              steps_json, params_json, provenance_json, policy_json, tags,
                              proposed_by, created_at_ms)
       VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scope.projectId,
      draft.routeId,
      draft.name,
      draft.description,
      draft.paramKind,
      JSON.stringify(draft.steps),
      JSON.stringify(draft.params),
      JSON.stringify(draft.provenance),
      draft.policyOverride === null ? null : JSON.stringify(draft.policyOverride),
      JSON.stringify(draft.tags),
      proposedBy,
      nowMs,
    );
  return getCase(db, scope, Number(r.lastInsertRowid))!;
}

export function getCase(db: Db, scope: ProjectScope, caseId: number): TestCaseRecord | undefined {
  const row = db
    .prepare('SELECT * FROM test_case WHERE id = ? AND project_id = ?')
    .get(caseId, scope.projectId) as CaseRow | undefined;
  return row === undefined ? undefined : toCase(row);
}

export function listCases(db: Db, scope: ProjectScope, status?: ReviewStatus): TestCaseRecord[] {
  const rows =
    status === undefined
      ? (db.prepare('SELECT * FROM test_case WHERE project_id = ? ORDER BY id').all(scope.projectId) as CaseRow[])
      : (db
          .prepare('SELECT * FROM test_case WHERE project_id = ? AND status = ? ORDER BY id')
          .all(scope.projectId, status) as CaseRow[]);
  return rows.map(toCase);
}

/** 唯一的终态写入口；next 必须来自 domain/review 的 applyReview（含 diff 留痕）。 */
export function applyReviewResult(
  db: Db,
  scope: ProjectScope,
  caseId: number,
  next: { status: ReviewStatus; diff: ReviewDiff | null; reviewedBy: string; reviewedAtMs: number },
): TestCaseRecord {
  const changes = db
    .prepare(
      `UPDATE test_case SET status = ?, reviewed_by = ?, reviewed_at_ms = ?, diff = ? WHERE id = ? AND project_id = ?`,
    )
    .run(
      next.status,
      next.reviewedBy,
      next.reviewedAtMs,
      next.diff === null ? null : JSON.stringify(next.diff),
      caseId,
      scope.projectId,
    ).changes;
  if (changes === 0) throw new KernelError('not_found', `用例 ${caseId} 不存在`);
  return getCase(db, scope, caseId)!;
}

function toCase(row: CaseRow): TestCaseRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    routeId: row.route_id,
    status: row.status as ReviewStatus,
    paramKind: row.param_kind as TestCaseRecord['paramKind'],
    steps: JSON.parse(row.steps_json) as TestCaseDraft['steps'],
    params: JSON.parse(row.params_json) as TestCaseDraft['params'],
    provenance: JSON.parse(row.provenance_json) as TestCaseDraft['provenance'],
    policyOverride: row.policy_json === null ? null : (JSON.parse(row.policy_json) as TestCaseRecord['policyOverride']),
    tags: JSON.parse(row.tags) as string[],
    proposedBy: row.proposed_by,
    reviewedBy: row.reviewed_by,
    reviewedAtMs: row.reviewed_at_ms,
    diff: row.diff === null ? null : (JSON.parse(row.diff) as TestCaseRecord['diff']),
    createdAtMs: row.created_at_ms,
  };
}
