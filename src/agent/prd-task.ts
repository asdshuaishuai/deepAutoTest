/**
 * PRD 提取任务（Agent 的第一个真实任务）：prose PRD → 结构化需求 → 用例草稿。
 *
 * 产物信任边界（07 §3.3 / §3.4）：Agent 输出**严格校验**后才能进合成——
 * 未知步骤类型、缺 api 的字段、非 JSON 输出一律拒绝并如实上报，绝不静默放行。
 * 所有草稿经 case:propose 落库 = proposed（P3）。
 */

import type { Kernel } from '../kernel/service.ts';
import type { PrdParseResult } from '../prd/parse.ts';
import { parseConstraints } from '../prd/parse.ts';
import { synthesizeFromPrd } from '../prd/synth.ts';
import { KernelError } from '../kernel/shared/util.ts';

const UI_STEP_KINDS = new Set(['ui_navigate', 'ui_click', 'ui_fill', 'ui_press', 'ui_wait_for', 'ui_see', 'ui_screenshot']);

export interface PrdExtractionOutcome {
  casesInserted: number;
  /** 被拒的 Agent 产出（诚实上报，07 §3.4：无溯源/不合法的不要）。 */
  rejected: string[];
  skipped: string[];
}

function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced !== null ? fenced[1]! : text;
  return raw.trim();
}

export async function applyPrdExtraction(kernel: Kernel, projectId: number, assistantText: string): Promise<PrdExtractionOutcome> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stripFences(assistantText));
  } catch (err) {
    throw new KernelError('fx_turn_failed', `Agent 输出不是合法 JSON，已整批拒绝（不部分采纳）：${String((err as Error).message).slice(0, 200)}`);
  }
  if (typeof parsedJson !== 'object' || parsedJson === null) {
    throw new KernelError('fx_turn_failed', 'Agent 输出不是 JSON 对象，已整批拒绝');
  }
  const root = parsedJson as Record<string, unknown>;
  const rejected: string[] = [];

  // ── 字段约束（严格形状；不合法的逐条拒，不臆测修复）
  const fields: PrdParseResult['fields'] = [];
  if (Array.isArray(root['fields'])) {
    for (const raw of root['fields']) {
      if (typeof raw !== 'object' || raw === null) continue;
      const f = raw as Record<string, unknown>;
      const field = typeof f['field'] === 'string' ? f['field'] : null;
      const constraintsText = typeof f['constraintsText'] === 'string' ? f['constraintsText'] : null;
      const type = typeof f['type'] === 'string' ? f['type'] : '';
      const api = f['api'];
      if (field === null || constraintsText === null) {
        rejected.push(`字段缺 field/constraintsText：${JSON.stringify(raw).slice(0, 120)}`);
        continue;
      }
      if (typeof api !== 'object' || api === null || typeof (api as Record<string, unknown>)['method'] !== 'string' || typeof (api as Record<string, unknown>)['path'] !== 'string') {
        rejected.push(`字段「${field}」缺 api {method, path}——无法落为可执行用例`);
        continue;
      }
      const apiObj = api as Record<string, unknown>;
      fields.push({
        section: typeof f['section'] === 'string' ? f['section'] : '(agent)',
        field,
        type,
        valueJson: parseConstraints(constraintsText, type),
        line: typeof f['line'] === 'number' ? f['line'] : 1,
        api: { method: String(apiObj['method']).toUpperCase(), path: String(apiObj['path']) },
      });
    }
  }

  // ── UI 流（步骤类型白名单；config 键最小校验）
  const uiFlows: PrdParseResult['uiFlows'] = [];
  if (Array.isArray(root['uiFlows'])) {
    for (const raw of root['uiFlows']) {
      if (typeof raw !== 'object' || raw === null) continue;
      const flow = raw as Record<string, unknown>;
      const title = typeof flow['title'] === 'string' ? flow['title'] : '(未命名流)';
      const steps: { kind: string; config: Record<string, unknown> }[] = [];
      let flowValid = true;
      if (Array.isArray(flow['steps'])) {
        for (const st of flow['steps']) {
          if (typeof st !== 'object' || st === null) continue;
          const step = st as Record<string, unknown>;
          const kind = typeof step['kind'] === 'string' ? step['kind'] : '';
          const config = typeof step['config'] === 'object' && step['config'] !== null ? (step['config'] as Record<string, unknown>) : null;
          if (!UI_STEP_KINDS.has(kind) || config === null) {
            rejected.push(`UI 流「${title}」含未知步骤 ${kind || '(空)'}——整流拒绝`);
            flowValid = false;
            break;
          }
          steps.push({ kind, config });
        }
      }
      if (flowValid && steps.length > 0) {
        uiFlows.push({ section: '(agent)', title, steps, file: '(agent)', line: 1 });
      }
    }
  }

  const { cases } = synthesizeFromPrd({ file: '(agent)', fields, uiFlows, stories: [], skipped: [] });
  const existing = new Set((await kernel.call('case:list', { projectId })).map((c) => c.name));
  let casesInserted = 0;
  const skipped: string[] = [];
  for (const draft of cases) {
    if (existing.has(draft.name)) {
      skipped.push(`已存在：${draft.name}`);
      continue;
    }
    await kernel.call('case:propose', { projectId, proposedBy: 'fx-agent', draft });
    existing.add(draft.name);
    casesInserted += 1;
  }
  return { casesInserted, rejected, skipped };
}
