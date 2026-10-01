/**
 * schema 漂移检测（08 §3.3）：数据库实际列型 vs Prisma 原则（持久层）对账。
 * 不一致 = 迁移没跑 / 代码与库不同步的强信号。
 */

import type { PrincipleRecord } from '../kernel/shared/domain.ts';
import type { DbColumn } from './sampler.ts';

export interface DriftItem {
  subject: string;
  kind: 'length_mismatch' | 'type_mismatch' | 'missing_column';
  principle: { rule: string; sourceFile: string; sourceLine: number };
  expected: string;
  actual: string;
}

const TYPE_FAMILIES: Record<string, string[]> = {
  number: ['int', 'integer', 'bigint', 'smallint', 'tinyint', 'mediumint', 'decimal', 'numeric', 'real', 'float', 'double', 'number'],
  string: ['varchar', 'char', 'text', 'character varying', 'character', 'string', 'nvarchar'],
  boolean: ['boolean', 'bool', 'tinyint(1)'],
  date: ['datetime', 'timestamp', 'date', 'time'],
};

function typeFamily(dataType: string): string | null {
  const lower = dataType.toLowerCase();
  for (const [family, members] of Object.entries(TYPE_FAMILIES)) {
    if (members.some((m) => lower === m || lower.startsWith(m + '(') || lower.startsWith(m + ' '))) return family;
  }
  return null;
}

export function checkDrift(columns: DbColumn[], principles: PrincipleRecord[]): DriftItem[] {
  const drift: DriftItem[] = [];
  const byKey = new Map(columns.map((c) => [`${c.table}.${c.column}`, c]));

  for (const p of principles) {
    if (p.status !== 'adopted') continue;
    if (p.layer !== 'persistence') continue; // 校验层原则对不上 DB 列属正常（DTO ≠ 表）
    const col = byKey.get(p.subject);
    if (col === undefined) continue; // 原则的 subject 不在库中（可能是 DTO 名），不误报

    const v = p.valueJson ?? {};

    // 长度对账：原则 maxLength vs 实际 character_maximum_length
    if (typeof v['maxLength'] === 'number') {
      const actualLen = col.maxLength;
      if (actualLen !== null && actualLen !== v['maxLength']) {
        drift.push({
          subject: p.subject,
          kind: 'length_mismatch',
          principle: { rule: p.rule, sourceFile: p.sourceFile, sourceLine: p.sourceLine },
          expected: `maxLength=${String(v['maxLength'])}`,
          actual: `maxLength=${String(actualLen)}`,
        });
      }
    }

    // 类型族对账
    if (typeof v['type'] === 'string' && v['type'] !== 'enum') {
      const expectedFamily = typeFamily(v['type'] as string) ?? (v['type'] as string);
      const actualFamily = typeFamily(col.dataType);
      if (actualFamily !== null && actualFamily !== expectedFamily) {
        drift.push({
          subject: p.subject,
          kind: 'type_mismatch',
          principle: { rule: p.rule, sourceFile: p.sourceFile, sourceLine: p.sourceLine },
          expected: `${expectedFamily}（${v['type'] as string}）`,
          actual: `${actualFamily}（${col.dataType}）`,
        });
      }
    }
  }
  return drift;
}
