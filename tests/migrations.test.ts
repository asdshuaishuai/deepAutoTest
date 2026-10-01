/**
 * 迁移纪律（06 §1）：已发布迁移被编辑 → checksum 不符 → 拒绝启动。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/kernel/store/db.ts';

describe('迁移器', () => {
  it('幂等：重复打开不重复应用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dat-mig-'));
    const path = join(dir, 'app.db');
    const db1 = openDb(path);
    const c1 = db1.prepare('SELECT COUNT(*) AS n FROM _migration').get() as { n: number };
    expect(c1.n).toBe(3);
    db1.close();
    const db2 = openDb(path);
    const c2 = db2.prepare('SELECT COUNT(*) AS n FROM _migration').get() as { n: number };
    expect(c2.n).toBe(3);
    db2.close();
  });

  it('已应用的迁移被篡改 → 拒绝打开（宁可拒绝启动，不可静默用错的 schema 跑）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dat-mig-'));
    const path = join(dir, 'app.db');
    const db = openDb(path);
    db.prepare("UPDATE _migration SET checksum = 'tampered' WHERE name = '0002_source_and_cases'").run();
    db.close();

    expect(() => openDb(path)).toThrowError(/发布后被修改/);
  });

  it('STRICT 表生效：文本进 INTEGER 列被拒（动态类型陷阱关闭）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dat-mig-'));
    const db = openDb(join(dir, 'app.db'));
    expect(() =>
      db.prepare("INSERT INTO project (name, source_type, status, created_at_ms, updated_at_ms) VALUES ('x', 'local', 'active', 'not-a-number', 1)").run(),
    ).toThrowError(/cannot store TEXT value in INTEGER column/);
    db.close();
  });
});
