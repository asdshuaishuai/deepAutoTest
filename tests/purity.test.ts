/**
 * 纯度守卫（02 §3 三条结构性纪律的测试化强制，将来迁 ESLint no-restricted-imports）：
 *  1. judge/derive/diff/review 禁止 import 任何 IO 模块与 store 层
 *  2. 禁止 Date.now / Math.random（判定不可读时钟、不可用随机）
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const KERNEL = join(import.meta.dirname, '..', 'src', 'kernel');

const PURE_FILES = ['domain/judge.ts', 'domain/derive.ts', 'domain/diff.ts', 'domain/review.ts', 'domain/redact.ts'];

const FORBIDDEN_IMPORTS = [
  'node:fs',
  'node:net',
  'node:http',
  'node:sqlite',
  'node:os',
  'undici',
  '../store/',
 "./store/",
];

describe('纯度守卫', () => {
  it('判定与纯领域模块不含 IO import 与非确定性调用', () => {
    for (const rel of PURE_FILES) {
      const src = readFileSync(join(KERNEL, rel), 'utf8');
      for (const bad of FORBIDDEN_IMPORTS) {
        expect(src.includes(`'${bad}`) || src.includes(`"${bad}`), `${rel} 引用了禁止模块 ${bad}`).toBe(false);
      }
      expect(src.includes('Date.now'), `${rel} 使用 Date.now（判定不得读时钟）`).toBe(false);
      expect(src.includes('Math.random'), `${rel} 使用 Math.random（判定不得用随机）`).toBe(false);
    }
  });

  it('全 src 禁 TypeScript 参数属性（node strip-only 模式运行时不支持，必须静态拦截）', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        return e.isDirectory() ? walk(p) : e.name.endsWith('.ts') ? [p] : [];
      });
    const paramProp = /constructor\([^)]*\b(?:private|protected|public)\s+readonly\b[^)]*\)/;
    for (const file of walk(join(KERNEL, '..'))) {
      const src = readFileSync(file, 'utf8');
      expect(paramProp.test(src), `${file} 使用了参数属性（node 直跑 TS 时会 SyntaxError）`).toBe(false);
    }
  });

  it('基座（src/kernel）运行时零第三方依赖（undici 只属于执行层）', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        return e.isDirectory() ? walk(p) : e.name.endsWith('.ts') ? [p] : [];
      });
    for (const file of walk(KERNEL)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        expect(spec.startsWith('.') || spec.startsWith('node:'), `${file} 引入了第三方或非 node 模块：${spec}`).toBe(true);
      }
    }
  });

  it('迁移只增不改：编号连续', async () => {
    const dir = join(KERNEL, 'store', 'migrations');
    const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.ts$/.test(f)).sort();
    files.forEach((f, i) => {
      expect(f.startsWith(String(i + 1).padStart(4, '0')), `迁移编号不连续：${f}`).toBe(true);
    });
  });
});
