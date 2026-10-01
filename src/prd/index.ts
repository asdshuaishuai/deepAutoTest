/**
 * PRD 索引编排：读 docs 目录的 .md → 解析 → 合成 → `case:propose`（proposed，P3）。
 * 幂等：同名用例已存在则跳过（重复解析 PRD 不产生重复用例）。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Kernel } from '../kernel/service.ts';
import { parsePrdMarkdown, type PrdParseResult, type PrdSkip } from './parse.ts';
import { synthesizeFromPrd } from './synth.ts';

export interface PrdIndexResult {
  filesParsed: string[];
  casesInserted: number;
  casesSkippedExisting: number;
  uiFlowCount: number;
  /** 不可执行需求的上报（prose 验收项、缺接口声明的字段表…）。 */
  skipped: (PrdSkip & { file: string })[];
}

export async function indexPrd(kernel: Kernel, projectId: number, prdDir: string): Promise<PrdIndexResult> {
  let entries: string[];
  try {
    entries = readdirSync(prdDir);
  } catch {
    throw new Error(`PRD 目录不存在：${prdDir}`);
  }
  const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
  if (mdFiles.length === 0) throw new Error(`PRD 目录没有 .md 文件：${prdDir}`);

  const existing = await kernel.call('case:list', { projectId });
  const existingNames = new Set(existing.map((c) => c.name));

  const result: PrdIndexResult = {
    filesParsed: [],
    casesInserted: 0,
    casesSkippedExisting: 0,
    uiFlowCount: 0,
    skipped: [],
  };

  for (const file of mdFiles) {
    const path = join(prdDir, file);
    const text = readFileSync(path, 'utf8');
    const parsed: PrdParseResult = parsePrdMarkdown(text, file);
    result.filesParsed.push(file);
    result.uiFlowCount += parsed.uiFlows.length;

    const { cases } = synthesizeFromPrd(parsed);
    for (const draft of cases) {
      if (existingNames.has(draft.name)) {
        result.casesSkippedExisting += 1;
        continue;
      }
      await kernel.call('case:propose', { projectId, proposedBy: 'prd-parser', draft });
      existingNames.add(draft.name);
      result.casesInserted += 1;
    }
    for (const skip of parsed.skipped) {
      result.skipped.push({ ...skip, file });
    }
  }
  return result;
}

export { parsePrdMarkdown, parseConstraints, type PrdParseResult, type PrdFieldConstraint, type PrdUiFlow, type PrdSkip } from './parse.ts';
export { synthesizeFromPrd, type PrdSynthesis } from './synth.ts';
