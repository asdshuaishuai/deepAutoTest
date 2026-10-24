/**
 * P3 人机协同状态机（07 §5）：proposed → adopted | rejected。
 *
 * 「AI 生成 ≠ 生效」。三条纪律在这里强制：
 *  1. 提议路径（case:propose / agent draft_case）永远只能产出 proposed
 *  2. 只有本模块的 applyReview 能产出终态，且必须携带人工 actor
 *  3. 「人工修改后采纳」必须记录结构化 diff（不是"已修改"一个布尔）——
 *     采纳率反馈、diff 复核视图、instructions 调优都依赖它
 */

import { KernelError } from '../shared/util.ts';
import type { ReviewAction, ReviewDiff, TestCaseDraft, TestCaseRecord } from '../shared/domain.ts';

export interface FieldEdit {
  path: string;
  from: unknown;
  to: unknown;
}

export interface ReviewResult {
  status: TestCaseRecord['status'];
  diff: ReviewDiff | null;
  reviewedBy: string;
  reviewedAtMs: number;
}

export function applyReview(
  record: Pick<TestCaseRecord, 'id' | 'status'>,
  action: ReviewAction,
  actor: string,
  edits: FieldEdit[],
  nowMs: number,
): ReviewResult {
  if (actor.trim() === '') {
    throw new KernelError('actor_required', '裁决必须由具名的人工 actor 执行（P3：AI 生成 ≠ 生效）');
  }

  if (record.status === 'rejected') {
    throw new KernelError(
      'invalid_transition',
      `用例 ${record.id} 已被拒绝；重提请走新的 proposed 版本，而不是复活旧记录`,
    );
  }

  switch (action) {
    case 'adopt':
      return { status: 'adopted', diff: null, reviewedBy: actor, reviewedAtMs: nowMs };
    case 'reject':
      return { status: 'rejected', diff: null, reviewedBy: actor, reviewedAtMs: nowMs };
    case 'edit': {
      if (edits.length === 0) {
        throw new KernelError('edits_required', 'edit 裁决必须携带字段级 diff（留痕是强制的）');
      }
      const seen = new Set<string>();
      for (const e of edits) {
        if (e.path.trim() === '') throw new KernelError('invalid_edit', 'diff path 不能为空');
        if (seen.has(e.path)) throw new KernelError('invalid_edit', `diff path 重复：${e.path}`);
        seen.add(e.path);
      }
      return {
        status: 'adopted',
        diff: { fields: edits, editedAtMs: nowMs, editedBy: actor },
        reviewedBy: actor,
        reviewedAtMs: nowMs,
      };
    }
    default:
      throw new KernelError('invalid_action', `未知裁决动作：${String(action)}`);
  }
}

/* ─────────────── edit 的真实应用（07 §5.2：就地编辑，不只是记录） ─────────────── */

/**
 * 把字段级 diff 应用到用例草稿内容上。
 * 「from 不匹配当前值」→ 拒绝（陈旧编辑，防盲覆盖）；应用后整体重新校验草稿。
 * 允许的编辑面：name / description / steps / params / tags（routeId 不可编辑——
 * 路由归属变了等于换了个被测对象，应走新用例）。
 */
export function applyEditsToDraft(
  record: TestCaseRecord,
  edits: FieldEdit[],
): TestCaseDraft {
  const draft: Record<string, unknown> = {
    name: record.name,
    description: record.description,
    // 不可编辑字段原样带出（routeId 变更等于换被测对象；P3 编辑面仅限内容五域）
    routeId: record.routeId,
    paramKind: record.paramKind,
    provenance: structuredClone(record.provenance),
    policyOverride: record.policyOverride === null ? null : structuredClone(record.policyOverride),
    steps: structuredClone(record.steps),
    params: structuredClone(record.params),
    tags: [...record.tags],
  };
  const allowedRoots = new Set(['name', 'description', 'steps', 'params', 'tags']);

  for (const edit of edits) {
    const segments = parsePath(edit.path);
    if (segments.length === 0 || typeof segments[0] !== 'string' || !allowedRoots.has(segments[0])) {
      throw new KernelError('invalid_edit', `不可编辑的字段：${edit.path}（允许 name/description/steps/params/tags）`);
    }
    const current = getByPath(draft, segments);
    if (JSON.stringify(current) !== JSON.stringify(edit.from)) {
      throw new KernelError(
        'stale_edit',
        `编辑基线不符：${edit.path} 当前为 ${JSON.stringify(current)?.slice(0, 120)}，编辑基于 ${JSON.stringify(edit.from)?.slice(0, 120)}`,
      );
    }
    setByPath(draft, segments, edit.to);
  }
  return draft as unknown as TestCaseDraft;
}

function parsePath(path: string): (string | number)[] {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((seg) => seg.length > 0)
    .map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
}

function getByPath(obj: unknown, segments: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

function setByPath(obj: unknown, segments: (string | number)[], value: unknown): void {
  let cur: unknown = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = (cur as Record<string | number, unknown>)[seg];
    if (next === null || typeof next !== 'object') {
      throw new KernelError('invalid_edit', `路径不可解析：${segments.join('.')}`);
    }
    cur = next;
  }
  (cur as Record<string | number, unknown>)[segments[segments.length - 1]!] = value;
}
