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
import type { ReviewAction, ReviewDiff, TestCaseRecord } from '../shared/domain.ts';

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
