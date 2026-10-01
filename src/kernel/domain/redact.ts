/**
 * 写时脱敏（08 §4）。
 *
 * 为什么必须写时而不是读时：一旦明文进入 SQLite，它就进入了导出报告、归档包、
 * 崩溃转储和用户手里的 `sqlite3`。写入即无法收回。
 *
 * 覆盖所有落库路径：事件 payload、artifact 引用前的字符串、导出。
 * 保留部分信息是刻意的（138****5678 可核对但不可还原）；
 * 全掩码会让数据失去测试价值。
 *
 * 已知边界（诚实声明，08 §4.2）：中文姓名无法用正则识别，本层不覆盖 name 规则
 * （依赖上层按字段名处理）；规则为正则可表达的四类 + 凭据字段名匹配。
 */

/** 凭据类字段名（子串匹配，大小写不敏感）→ 值替换为占位符。 */
const SECRET_FIELD_PATTERN = /token|secret|password|passwd|authorization|api[-_]?key|access[-_]?key|cookie|session/i;

interface PatternRule {
  name: string;
  regex: RegExp;
  mask: (match: string) => string;
}

const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const ID_CARD = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const BANK_CARD = /(?<!\d)\d{16,19}(?!\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g;

const RULES: PatternRule[] = [
  // 长 ID 先于短 ID：18 位身份证先于 16-19 位银行卡先于 11 位手机号
  {
    name: 'id_card',
    regex: ID_CARD,
    mask: (m) => m.slice(0, 3) + '*'.repeat(11) + m.slice(14),
  },
  {
    name: 'bank_card',
    regex: BANK_CARD,
    mask: (m) => m.slice(0, 4) + '*'.repeat(m.length - 8) + m.slice(-4),
  },
  {
    name: 'phone',
    regex: PHONE,
    mask: (m) => m.slice(0, 3) + '****' + m.slice(-4),
  },
  {
    name: 'email',
    regex: EMAIL,
    mask: (m) => {
      const at = m.indexOf('@');
      const local = m.slice(0, at);
      return local.slice(0, 1) + '***' + m.slice(at);
    },
  },
];

export interface RedactOptions {
  enabled: boolean;
}

export const defaultRedactOptions: RedactOptions = { enabled: true };

/** 就地脱敏字符串。 */
export function redactString(input: string): string {
  let out = input;
  for (const rule of RULES) {
    out = out.replace(rule.regex, (m) => rule.mask(m));
  }
  return out;
}

/**
 * 深度脱敏：返回新对象（不改输入）。
 *  - 字符串值过正则规则
 *  - 键名命中凭据模式的字段，值替换为 '<redacted, N bytes>'（沿用 libfx 表述习惯）
 */
export function redactDeep<T>(value: T, options: RedactOptions = defaultRedactOptions): T {
  if (!options.enabled) return value;
  return walk(value, new Set(), 0) as T;
}

function walk(value: unknown, seen: Set<object>, depth: number): unknown {
  if (depth > 32) return value; // 防御循环引用
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => walk(v, seen, depth + 1));
  if (Buffer.isBuffer(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      typeof v === 'string' && SECRET_FIELD_PATTERN.test(key)
        ? `<redacted, ${Buffer.byteLength(v)} bytes>`
        : walk(v, seen, depth + 1);
  }
  return out;
}
