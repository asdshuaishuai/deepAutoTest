/**
 * 本地源码索引编排（S1 的 local 模式 + S2/S3 触发）。
 *
 * 分层：analysis 读文件系统与 AST（重计算），产物经 kernel 的 propose 批量方法
 * 落库（status='proposed'，P3）。git/zip 接入是后续层——编排接口不变。
 *
 * 只读纪律（09 §5）：永不修改被测仓库。walk 只读。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Project } from 'ts-morph';
import { KernelError } from '../kernel/shared/util.ts';
import type { Kernel } from '../kernel/service.ts';
import { extractRoutes } from './routes.ts';
import { extractPrinciples, extractPrismaSchema } from './principles.ts';

const MAX_TS_FILES = 5000;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.git', 'coverage', '.next', 'vendor']);

export interface ScanOptions {
  /** 限定子目录（如 ['src']）；默认全仓（跳过 SKIP_DIRS）。 */
  includeDirs?: string[];
}

export interface ScanResult {
  sourceIndexId: number;
  fileCount: number;
  frameworks: string[];
  routesInserted: number;
  principlesInserted: number;
}

export async function indexLocalSource(kernel: Kernel, projectId: number, rootPath: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const root = resolve(rootPath);
  let stat;
  try {
    stat = statSync(root);
  } catch {
    throw new KernelError('source_not_found', `源码目录不存在：${root}`);
  }
  if (!stat.isDirectory()) throw new KernelError('source_not_found', `源码路径不是目录：${root}`);

  const tsFiles = collectTsFiles(root, opts.includeDirs);
  if (tsFiles.length > MAX_TS_FILES) {
    throw new KernelError('source_too_large', `TS 文件数 ${tsFiles.length} 超过 ${MAX_TS_FILES}；请用 includeDirs 缩小范围（R4）`);
  }
  const prismaFiles = collectFiles(root, ['.prisma']);

  const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true, compilerOptions: { allowJs: false } });
  for (const f of tsFiles) project.addSourceFileAtPath(f);

  const { routes, frameworks } = extractRoutes(project);
  const principles = extractPrinciples(project);
  for (const pf of prismaFiles) {
    const text = readFileSync(pf, 'utf8');
    principles.push(...extractPrismaSchema(text, relative(root, pf)));
  }
  if (prismaFiles.length > 0) frameworks.add('prisma');
  if (frameworks.size === 0 && tsFiles.length > 0) frameworks.add('unknown');

  const sourceIndex = await kernel.call('source:recordIndex', {
    projectId,
    gitRef: null,
    fileCount: tsFiles.length + prismaFiles.length,
    frameworks: [...frameworks].sort(),
  });
  const routesRes = await kernel.call('route:proposeBatch', {
    projectId,
    sourceIndexId: sourceIndex.id,
    routes: routes as unknown[],
    proposedBy: 'ts-morph',
  });
  const principlesRes = await kernel.call('principle:proposeBatch', {
    projectId,
    principles: principles as unknown[],
    proposedBy: 'ts-morph',
  });

  return {
    sourceIndexId: sourceIndex.id,
    fileCount: tsFiles.length + prismaFiles.length,
    frameworks: [...frameworks].sort(),
    routesInserted: routesRes.inserted,
    principlesInserted: principlesRes.inserted,
  };
}

function collectTsFiles(root: string, includeDirs?: string[]): string[] {
  const roots = includeDirs === undefined || includeDirs.length === 0 ? [root] : includeDirs.map((d) => join(root, d));
  const out: string[] = [];
  for (const r of roots) {
    walk(r, (f) => {
      if (f.endsWith('.ts') && !f.endsWith('.d.ts')) out.push(f);
    });
  }
  return out;
}

function collectFiles(root: string, exts: string[]): string[] {
  const out: string[] = [];
  walk(root, (f) => {
    if (exts.some((e) => f.endsWith(e))) out.push(f);
  });
  return out;
}

function walk(dir: string, onFile: (path: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.prisma') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, onFile);
    } else if (entry.isFile()) {
      onFile(full);
    }
  }
}
