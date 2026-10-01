/**
 * PRD → 用例草稿合成（S0 输入源 → S5）。
 *
 * 字段约束 → 边界用例（复用 synthesis 的 boundaryValues / buildRequestStep——
 * 同一套「应通过 / 应拒绝 + file:line 溯源」纪律，溯源指向 PRD）；
 * UI 流协议 → UI 族用例（步骤树直接映射）。
 * 两者一律 proposed（P3），provenance.prd 记录出处。
 */

import type { ParamRow, Step, TestCaseDraft } from '../kernel/shared/domain.ts';
import { boundaryValues, type GeneratedRow } from '../synthesis/boundary.ts';
import { buildRequestStep } from '../synthesis/case-synth.ts';
import type { PrdFieldConstraint, PrdParseResult, PrdUiFlow } from './parse.ts';

const PASS_ASSERT = { op: 'lt', expected: '300', severity: 'major' } as const;
const REJECT_ASSERT = { op: 'gte', expected: '400', severity: 'critical' } as const;

export interface PrdSynthesis {
  cases: TestCaseDraft[];
  /** 有约束但因无 API/无路由而未合成的字段（诚实上报）。 */
  fieldSkips: { field: string; reason: string }[];
}

export function synthesizeFromPrd(parsed: PrdParseResult): PrdSynthesis {
  const cases: TestCaseDraft[] = [];
  const fieldSkips: PrdSynthesis['fieldSkips'] = [];

  for (const field of parsed.fields) {
    if (field.api === null) continue; // parse 层已 skip，防御
    const values = boundaryValues(field.field, field.valueJson);
    if (values.valid.length === 0 && values.invalid.length === 0) {
      fieldSkips.push({ field: field.field, reason: `约束不可生成边界值（${JSON.stringify(field.valueJson)}）` });
      continue;
    }
    const method = field.api.method;
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      fieldSkips.push({ field: field.field, reason: `不支持的接口方法 ${method}` });
      continue;
    }
    const source = `${parsed.file}:${field.line}`;
    const paramName = field.field;

    if (values.valid.length > 0) {
      cases.push(buildFieldCase({
        name: `[PRD边界] ${method} ${field.api.path} · ${field.field}（应通过）`,
        field, paramName, method, rows: values.valid,
        assertSpec: PASS_ASSERT, source, intent: 'boundary',
      }));
    }
    if (values.invalid.length > 0) {
      cases.push(buildFieldCase({
        name: `[PRD边界] ${method} ${field.api.path} · ${field.field}（应拒绝）`,
        field, paramName, method, rows: values.invalid,
        assertSpec: REJECT_ASSERT, source, intent: 'boundary',
      }));
    }
  }

  for (const flow of parsed.uiFlows) {
    if (flow.steps.length === 0) continue;
    const steps: Step[] = flow.steps.map((st, idx) => ({ id: `s${idx}`, seq: idx, kind: st.kind as Step['kind'], config: st.config }));
    cases.push({
      name: `[UI] ${flow.title}`,
      description: `来自 PRD UI 流（${flow.file}:${flow.line}）`,
      routeId: null,
      paramKind: 'single',
      steps,
      params: { kind: 'single', rows: [{ label: 'baseline', values: {}, intent: 'baseline' }] },
      provenance: {
        principles: [],
        samples: [],
        agentSession: null,
        agentTurn: null,
        prd: [{ file: flow.file, line: flow.line, requirement: flow.title }],
      },
      policyOverride: null,
      tags: ['auto-synth', 'ui', 'prd'],
    });
  }

  return { cases, fieldSkips };
}

interface FieldCaseInput {
  name: string;
  field: PrdFieldConstraint;
  paramName: string;
  method: string;
  rows: GeneratedRow[];
  assertSpec: { op: string; expected: string; severity: string };
  source: string;
  intent: string;
}

function buildFieldCase(input: FieldCaseInput): TestCaseDraft {
  const params: ParamRow[] = input.rows.map((r) => ({
    label: r.label,
    values: { [input.paramName]: r.value },
    intent: r.intent,
  }));

  const requestStep = buildRequestStep(input.method, input.field.api!.path, input.paramName, input.field.valueJson);
  const assertStep: Step = {
    id: 's1',
    seq: 1,
    kind: 'assert',
    config: {
      target: { kind: 'status' },
      op: input.assertSpec.op,
      expected: input.assertSpec.expected,
      severity: input.assertSpec.severity,
      sourceFile: parsedFileOf(input.source),
      sourceLine: parsedLineOf(input.source),
    },
  };

  return {
    name: input.name,
    description: `由 PRD 约束推导（${input.source}）`,
    routeId: null,
    paramKind: 'boundary',
    steps: [requestStep, assertStep],
    params: { kind: 'boundary', rows: params },
    provenance: {
      principles: [],
      samples: [],
      agentSession: null,
      agentTurn: null,
      prd: [{ file: parsedFileOf(input.source), line: parsedLineOf(input.source), requirement: `${input.field.field}: ${JSON.stringify(input.field.valueJson)}` }],
    },
    policyOverride: null,
    tags: ['auto-synth', 'boundary', 'prd'],
  };
}

function parsedFileOf(source: string): string {
  const idx = source.lastIndexOf(':');
  return idx === -1 ? source : source.slice(0, idx);
}

function parsedLineOf(source: string): number {
  const idx = source.lastIndexOf(':');
  return idx === -1 ? 1 : Number.parseInt(source.slice(idx + 1), 10) || 1;
}
