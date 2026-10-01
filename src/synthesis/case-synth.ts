/**
 * 用例合成（S5 的确定性通道）：路由候选 × 已采纳原则 → 用例草稿。
 *
 * 与 Agent 合成的关系：Agent 是「加速器」，这里是「可从原则直接推导的那部分」——
 * 有 file:line 可查证的边界值优先用推导（03 §2.5 信任度：原则推导 = 高）。
 * 两者产出的都是 proposed，走同一个 P3 人机门。
 *
 * 两条纪律：
 *  1. 只从 **adopted** 原则合成（未裁决的原则是假设，不能煲进用例）
 *  2. 任何无法静态确定的东西（路径参数 :id、不可逆向的正则、无 body 形态信息）
 *     一律跳过并上报原因——宁可少合成，不可臆造（07 §3.4）
 */

import type { ParamRow, PrincipleRecord, RouteCandidateRecord, Step, TestCaseDraft } from '../kernel/shared/domain.ts';
import { boundaryValues, type GeneratedRow } from './boundary.ts';

export interface SynthesisSkip {
  routeId: number | null;
  path: string;
  reason: string;
}

export interface SynthesizedCase {
  draft: TestCaseDraft;
  principleId: number;
  source: string;
}

const PASS_ASSERT = { op: 'lt', expected: '300', severity: 'major' } as const; // 2xx：边界内应通过
const REJECT_ASSERT = { op: 'gte', expected: '400', severity: 'critical' } as const; // ≥400：越界应被拒绝

export function synthesizeBoundaryCases(route: RouteCandidateRecord, principles: PrincipleRecord[]): { cases: SynthesizedCase[]; skipped: SynthesisSkip[] } {
  const cases: SynthesizedCase[] = [];
  const skipped: SynthesisSkip[] = [];

  if (route.path.includes(':')) {
    skipped.push({ routeId: route.id, path: route.path, reason: '路径含参数（:id）：无法静态构造合法取值，跳过' });
    return { cases, skipped };
  }
  if (route.method === 'HEAD' || route.method === 'OPTIONS') {
    skipped.push({ routeId: route.id, path: route.path, reason: `${route.method} 无边界语义，跳过` });
    return { cases, skipped };
  }

  for (const principle of principles) {
    if (principle.status !== 'adopted') continue;
    const paramName = lastSegment(principle.subject);
    const values = boundaryValues(paramName, principle.valueJson);
    if (values.valid.length === 0 && values.invalid.length === 0) {
      // 原则存在但约束不可机读消费（如不可逆正则）——上报，不静默
      skipped.push({
        routeId: route.id,
        path: route.path,
        reason: `原则「${principle.subject}」的约束无法生成边界值（${principle.rule}）`,
      });
      continue;
    }

    const source = `${principle.sourceFile}:${principle.sourceLine}`;
    const baseName = `[边界] ${route.method} ${route.path} · ${principle.subject}`;

    if (values.valid.length > 0) {
      cases.push({
        draft: buildDraft({
          name: `${baseName}（应通过）`,
          route,
          paramName,
          rows: values.valid,
          assertSpec: PASS_ASSERT,
          principle,
          source,
          intent: 'boundary',
        }),
        principleId: principle.id,
        source,
      });
    }
    if (values.invalid.length > 0) {
      cases.push({
        draft: buildDraft({
          name: `${baseName}（应拒绝）`,
          route,
          paramName,
          rows: values.invalid,
          assertSpec: REJECT_ASSERT,
          principle,
          source,
          intent: 'boundary',
        }),
        principleId: principle.id,
        source,
      });
    }
  }

  return { cases, skipped };
}

interface BuildInput {
  name: string;
  route: RouteCandidateRecord;
  paramName: string;
  rows: GeneratedRow[];
  assertSpec: { op: string; expected: string; severity: string };
  principle: PrincipleRecord;
  source: string;
  intent: string;
}

function buildDraft(input: BuildInput): TestCaseDraft {
  const params: ParamRow[] = input.rows.map((r) => ({
    label: r.label,
    values: { [input.paramName]: r.value },
    intent: r.intent,
  }));

  const requestStep = buildRequestStep(input.route.method, input.route.path, input.paramName, input.principle.valueJson);
  const assertStep: Step = {
    id: 's1',
    seq: 1,
    kind: 'assert',
    config: {
      target: { kind: 'status' },
      op: input.assertSpec.op,
      expected: input.assertSpec.expected,
      severity: input.assertSpec.severity,
      // 溯源链：断言 → 原则 → 源码 file:line（04 §4.3 的三步追问）
      principleId: input.principle.id,
      sourceFile: input.principle.sourceFile,
      sourceLine: input.principle.sourceLine,
    },
  };

  return {
    name: input.name,
    description: `由原则「${input.principle.rule}」推导（${input.source}）`,
    routeId: input.route.id,
    paramKind: 'boundary',
    steps: [requestStep, assertStep],
    params: { kind: 'boundary', rows: params },
    provenance: {
      principles: [
        {
          principleId: input.principle.id,
          source: input.source,
          rule: input.principle.rule,
          usedAs: input.intent,
        },
      ],
      samples: [],
      agentSession: null,
      agentTurn: null,
    },
    policyOverride: null,
    tags: ['auto-synth', 'boundary'],
  };
}

/** 请求构造：GET/DELETE 走 query；其余走 JSON body（字段类型从 value_json 推断，字符串加引号）。PRD 合成器复用。 */
export function buildRequestStep(method: string, path: string, paramName: string, valueJson: Record<string, unknown> | null): Step {
  const ref = `{{param.${paramName}}}`;
  const type = typeof valueJson?.['type'] === 'string' ? (valueJson['type'] as string) : 'string';
  const isNumeric = type === 'number' || type === 'boolean';

  if (method === 'GET' || method === 'DELETE') {
    return {
      id: 's0',
      seq: 0,
      kind: 'request',
      config: { method, url: `${path}?${paramName}=${ref}` },
    };
  }
  const body = isNumeric ? `{"${paramName}":${ref}}` : `{"${paramName}":"${ref}"}`;
  return {
    id: 's0',
    seq: 0,
    kind: 'request',
    config: {
      method,
      url: path,
      headers: { 'content-type': 'application/json' },
      body,
    },
  };
}

function lastSegment(subject: string): string {
  const idx = subject.lastIndexOf('.');
  return idx === -1 ? subject : subject.slice(idx + 1);
}
