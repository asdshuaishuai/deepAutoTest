/**
 * SQL 只读防护（08 §3）—— 四层中的第 ③④ 层（语句白名单 + 拒绝多语句）。
 * 第 ① 层（只读账号）是用户配置责任；第 ② 层（会话级只读）在 sampler 建连时设置。
 *
 * 白名单语义：只允许**查询形态**的语句；拒绝一切写/DDL/锁/外带。
 * `SELECT ... FOR UPDATE` 也拒绝——它在语义上是加锁写操作（08 §3.1）。
 */

const ALLOWED_PREFIX = /^(?:SELECT|WITH|EXPLAIN|SHOW|DESCRIBE|DESC)\b/i;

const FORBIDDEN_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|CALL|COPY|LOAD|MERGE|REPLACE|SET|VACUUM|REINDEX|ATTACH|DETACH|PRAGMA|HANDLER|LOCK|UNLOCK|DO|SHUTDOWN|KILL)\b/i;

const FORBIDDEN_PATTERNS = [/\bFOR\s+(?:UPDATE|SHARE)\b/i, /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i, /\bLOCK\s+IN\s+SHARE\s+MODE\b/i];

export interface GuardResult {
  ok: boolean;
  reason: string | null;
}

/** 剥除注释后再检查（防 `SELECT 1 /* ; DROP *\/` 这类藏匿）。 */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/#[^\n]*/g, ' ');
}

export function guardReadOnlySql(sql: string): GuardResult {
  const stripped = stripSqlComments(sql).trim();
  if (stripped.length === 0) return { ok: false, reason: 'empty_statement' };

  if (!ALLOWED_PREFIX.test(stripped)) {
    return { ok: false, reason: 'not_a_read_statement（仅允许 SELECT / WITH / EXPLAIN / SHOW / DESCRIBE 开头）' };
  }

  // 多语句：剥除字符串字面量后，分号后还有非空白内容即拒绝（08 §3.1 第③层的语句级补强）
  const noStrings = stripped.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const afterFirstSemicolon = noStrings.slice(noStrings.indexOf(';') + 1).trim();
  if (noStrings.includes(';') && afterFirstSemicolon.length > 0) {
    return { ok: false, reason: 'multiple_statements（一次一条；驱动层同样禁多语句）' };
  }

  const forbidden = FORBIDDEN_KEYWORDS.exec(stripped);
  if (forbidden !== null) {
    return { ok: false, reason: `forbidden_keyword:${forbidden[1]!.toUpperCase()}` };
  }
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(stripped)) return { ok: false, reason: `forbidden_pattern:${pattern.source}` };
  }
  return { ok: true, reason: null };
}

/** 会话级只读语句（第 ② 层）。建连后立即执行。 */
export function sessionReadOnlyStatements(dialect: 'mysql' | 'postgres' | 'sqlite'): string[] {
  switch (dialect) {
    case 'mysql':
      return ['SET SESSION TRANSACTION READ ONLY'];
    case 'postgres':
      return ['SET default_transaction_read_only = on'];
    case 'sqlite':
      return ['PRAGMA query_only = ON'];
  }
}

/** 表/列名白名单（采样接口不接受任意 SQL，表名无法参数化——字符白名单是注入底线，08 §3.2）。 */
export function guardIdentifier(name: string): GuardResult {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
    return { ok: false, reason: `invalid_identifier:${name}` };
  }
  return { ok: true, reason: null };
}
