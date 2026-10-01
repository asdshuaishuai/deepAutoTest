/**
 * 边界值生成（S3 → S5 的确定性通道，03 §2.3）。
 *
 * 输入是原则的机读约束（value_json），输出是分侧的参数行：
 *   valid   —— 边界内（应通过）
 *   invalid —— 越界（应被拒绝）
 *
 * 为什么分两侧：一个用例的断言步骤对所有参数行是同一套（步骤树 + 参数集模型），
 * 「应通过」与「应拒绝」的期望不同，必须拆成两个测试意图——报表仍可回答
 * 「该接口的 2 个越界值中有 1 个未按预期拒绝」（intent 字段保留语义）。
 *
 * 语义严格对齐约束方向：`amount ≤ 50000` → 49999/50000 合法，50001 越界。
 * 全部为纯函数；生成的行数有硬上限（防止矩阵爆炸）。
 */

import type { ParamIntent } from '../kernel/shared/domain.ts';

export interface GeneratedRow {
  /** 人类可读标签（报表里的参数行名）。 */
  label: string;
  value: string | number;
  intent: ParamIntent;
}

export interface BoundaryValues {
  valid: GeneratedRow[];
  invalid: GeneratedRow[];
}

const MAX_VALID_ROWS = 4;
const MAX_INVALID_ROWS = 3;

/** 从 value_json 生成边界值。约束不可解释时返回空（诚实：不臆造）。 */
export function boundaryValues(paramName: string, valueJson: Record<string, unknown> | null): BoundaryValues {
  const valid: GeneratedRow[] = [];
  const invalid: GeneratedRow[] = [];
  if (valueJson === null) return { valid, invalid };

  const type = typeof valueJson['type'] === 'string' ? (valueJson['type'] as string) : undefined;
  const max = num(valueJson['max']);
  const min = num(valueJson['min']);
  const maxLength = num(valueJson['maxLength']);
  const minLength = num(valueJson['minLength']);
  const enumValues = Array.isArray(valueJson['enum']) ? (valueJson['enum'] as (string | number)[]) : null;
  const isEmail = valueJson['email'] === true;
  const pattern = typeof valueJson['pattern'] === 'string' ? valueJson['pattern'] : null;
  const integer = valueJson['integer'] === true;

  /* 枚举：每个成员一个基线行 + 一个域外值 */
  if (enumValues !== null && enumValues.length > 0) {
    for (const v of enumValues.slice(0, MAX_VALID_ROWS)) {
      valid.push({
        label: `${paramName}=${String(v)}（枚举内）`,
        value: v,
        intent: 'baseline',
      });
    }
    invalid.push({
      label: `${paramName}=__NOT_IN_ENUM__（枚举外）`,
      value: '__NOT_IN_ENUM__',
      intent: 'invalid',
    });
    return cap(valid, invalid);
  }

  /* 邮箱 */
  if (isEmail) {
    valid.push({ label: `${paramName}=合法邮箱`, value: 'tester@example.com', intent: 'baseline' });
    invalid.push({ label: `${paramName}=非法邮箱`, value: 'not-an-email', intent: 'malformed' });
    return cap(valid, invalid);
  }

  /* 格式 pattern：只认可安全生成的常见形态（手机号），其余不臆造 */
  if (pattern !== null) {
    if (pattern.includes('1[3-9]') && /\\d\{9\}|\d\{9\}/.test(pattern)) {
      valid.push({ label: `${paramName}=13800000000（合法手机号）`, value: '13800000000', intent: 'baseline' });
      invalid.push({ label: `${paramName}=12345（格式非法）`, value: '12345', intent: 'malformed' });
      return cap(valid, invalid);
    }
    return { valid: [], invalid: [] }; // 不可逆向的正则：不生成（记在 skipped 里由调用方上报）
  }

  /* 数值边界 */
  if (type === 'number' || max !== undefined || min !== undefined) {
    const round = (n: number): number => (integer ? Math.round(n) : n);
    if (max !== undefined) {
      valid.push({ label: `${paramName}=${round(max - 1)}（≤${max} 边界内）`, value: round(max - 1), intent: 'boundary_low' });
      valid.push({ label: `${paramName}=${round(max)}（恰在边界）`, value: round(max), intent: 'boundary_high' });
      invalid.push({ label: `${paramName}=${round(max + 1)}（超限）`, value: round(max + 1), intent: 'invalid' });
    }
    if (min !== undefined) {
      valid.push({ label: `${paramName}=${round(min)}（恰在下界）`, value: round(min), intent: 'boundary_low' });
      valid.push({ label: `${paramName}=${round(min + 1)}（≥${min} 边界内）`, value: round(min + 1), intent: 'boundary_high' });
      invalid.push({ label: `${paramName}=${round(min - 1)}（低于下界）`, value: round(min - 1), intent: 'invalid' });
    }
    return cap(valid, invalid);
  }

  /* 字符串长度边界 */
  if (type === 'string' && (maxLength !== undefined || minLength !== undefined)) {
    if (maxLength !== undefined) {
      valid.push({ label: `${paramName}=长度${maxLength}（恰在上限）`, value: 'x'.repeat(maxLength), intent: 'boundary_high' });
      invalid.push({ label: `${paramName}=长度${maxLength + 1}（超长）`, value: 'x'.repeat(maxLength + 1), intent: 'invalid' });
    }
    if (minLength !== undefined) {
      valid.push({ label: `${paramName}=长度${minLength}（恰在下限）`, value: 'x'.repeat(minLength), intent: 'boundary_low' });
      if (minLength > 1) {
        invalid.push({ label: `${paramName}=长度${minLength - 1}（过短）`, value: 'x'.repeat(minLength - 1), intent: 'invalid' });
      } else {
        // 下界本身就是"必须非空"：越界形态即空串，intent 如实标 empty
        invalid.push({ label: `${paramName}=空串`, value: '', intent: 'empty' });
      }
    }
    return cap(valid, invalid);
  }

  return { valid, invalid };
}

function cap(valid: GeneratedRow[], invalid: GeneratedRow[]): BoundaryValues {
  return {
    valid: dedup(valid).slice(0, MAX_VALID_ROWS),
    invalid: dedup(invalid).slice(0, MAX_INVALID_ROWS),
  };
}

function dedup(rows: GeneratedRow[]): GeneratedRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${String(r.value)}|${r.intent}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
