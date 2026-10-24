/**
 * OpenAPI 对账（S2 收尾）：源码路由 vs 文档，落 doc_drift / doc_missing 两类标记。
 *
 * 这两类是设计里的「高测试价值点」（06 §2.2）：
 *  - doc_missing = 1：源码有、文档没有——实现走在了文档前面，行为无契约
 *  - doc_drift  = 1：路径在文档中存在但 method 对不上——契约与实现分叉
 *  - docOnly：文档有、源码无——不落库（route 表没有"文档路由"实体），报告返回
 *
 * 路径模板归一：`/orders/:id`（express）≡ `/orders/{id}`（OpenAPI）；
 * 参数段只比位置与「是参数」，不比名字（`:id` vs `{orderId}` 算对齐）。
 */

import type { RouteCandidateRecord } from '../shared/domain.ts';
import { KernelError } from '../shared/util.ts';

export interface DocOnlyEndpoint {
  method: string;
  path: string;
}

export interface ReconcileOutcome {
  compared: number;
  aligned: number;
  /** 需要置位的路由（调用方落 doc_drift / doc_missing 列，其余清零）。 */
  flags: Map<number, { drift: boolean; missing: boolean }>;
  drift: { routeId: number; method: string; path: string; docMethods: string[] }[];
  missing: { routeId: number; method: string; path: string }[];
  docOnly: DocOnlyEndpoint[];
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** 解析调用方传入的 spec：对象（已解析）或 JSON 字符串。YAML 请先自行转换——基座零依赖。 */
export function parseSpec(spec: unknown): Record<string, { [method: string]: unknown }> {
  let obj: unknown = spec;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      throw new KernelError('spec_invalid', 'spec 是字符串但不是合法 JSON；YAML 请先解析为对象再传入（基座零依赖，不内置 YAML 解析）');
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new KernelError('spec_invalid', 'spec 必须是 OpenAPI 文档对象');
  }
  const paths = (obj as Record<string, unknown>)['paths'];
  if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) {
    throw new KernelError('spec_invalid', 'spec 缺少 paths（不是 OpenAPI 文档？）');
  }
  return paths as Record<string, { [method: string]: unknown }>;
}

export function normalizePathTemplate(p: string): string {
  // /orders/:id → /orders/{} ；/orders/{id} → /orders/{}（参数段只比位置）
  return (
    '/' +
    p
      .replace(/^\/+/, '')
      .split('/')
      .filter((s) => s.length > 0)
      .map((s) => (s.startsWith(':') || s.startsWith('{') ? '{}' : s.toLowerCase()))
      .join('/')
  );
}

export function reconcile(
  routes: RouteCandidateRecord[],
  paths: Record<string, { [method: string]: unknown }>,
): ReconcileOutcome {
  // 文档侧：归一化路径 → method 集
  const doc = new Map<string, { methods: Set<string>; sample: { method: string; path: string } }>();
  for (const [rawPath, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== 'object' || pathItem === null) continue;
    const key = normalizePathTemplate(rawPath);
    let entry = doc.get(key);
    if (entry === undefined) {
      entry = { methods: new Set(), sample: { method: '', path: rawPath } };
      doc.set(key, entry);
    }
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method.toLowerCase())) entry.methods.add(method.toUpperCase());
    }
  }

  const outcome: ReconcileOutcome = { compared: 0, aligned: 0, flags: new Map(), drift: [], missing: [], docOnly: [] };
  const coveredDocKeys = new Set<string>();

  for (const route of routes) {
    outcome.compared += 1;
    const key = normalizePathTemplate(route.path);
    const docEntry = doc.get(key);
    if (docEntry === undefined) {
      outcome.missing.push({ routeId: route.id, method: route.method, path: route.path });
      outcome.flags.set(route.id, { drift: false, missing: true });
      continue;
    }
    coveredDocKeys.add(key);
    if (docEntry.methods.has(route.method)) {
      outcome.aligned += 1;
      outcome.flags.set(route.id, { drift: false, missing: false });
    } else {
      outcome.drift.push({ routeId: route.id, method: route.method, path: route.path, docMethods: [...docEntry.methods].sort() });
      outcome.flags.set(route.id, { drift: true, missing: false });
    }
  }

  for (const [key, entry] of doc) {
    if (coveredDocKeys.has(key)) continue;
    for (const method of entry.methods) {
      outcome.docOnly.push({ method, path: entry.sample.path });
    }
  }
  return outcome;
}
