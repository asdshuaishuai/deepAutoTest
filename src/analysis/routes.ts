/**
 * 路由发现（S2，M1 范围）：ts-morph 从源码提取 API 候选。
 *
 * 覆盖两类形态：
 *  - CallExpression：`app|router|server|api.get('/path', handler)`（Express / Fastify / Koa-router）
 *  - 装饰器：NestJS `@Controller('prefix')` + `@Get('sub')`
 *
 * 置信度（进入待复核队列的依据，P3）：
 *  - high：NestJS 装饰器（来自 @nestjs/common 的明确导入）；
 *          CallExpression 且接收者名是惯例命名（app/router/server/api）且有函数处理器
 *  - medium：接收者名非惯例（如 r.xxx）——可能是误报（数组 .get()）
 *
 * 已知边界（如实）：app.use('/prefix', router) 的前缀合成暂不展开，
 * 路由按字面路径记录；mount 结构在 diff 复核时人工确认。
 */

import { Project, SyntaxKind, type CallExpression, type ClassDeclaration, type Decorator, type SourceFile } from 'ts-morph';
import type { RouteCandidateDraft } from '../kernel/shared/domain.ts';

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const CONVENTIONAL_RECEIVERS = /^(app|router|server|api|route|routes|endpoints?|controller)$/i;

export function extractRoutes(project: Project): { routes: RouteCandidateDraft[]; frameworks: Set<string> } {
  const routes: RouteCandidateDraft[] = [];
  const frameworks = new Set<string>();

  for (const file of project.getSourceFiles()) {
    const imports = collectImportAliases(file);
    const expressLike = hasModule(imports, 'express') || hasModule(imports, 'fastify') || hasModule(imports, '@koa/router') || hasModule(imports, 'koa-router');
    const nest = hasModule(imports, '@nestjs/common');
    if (expressLike) frameworks.add(moduleName(imports, 'express') === 'fastify' ? 'fastify' : 'express');
    if (hasModule(imports, '@koa/router') || hasModule(imports, 'koa-router')) frameworks.add('koa');
    if (nest) frameworks.add('nestjs');

    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const route = tryCallRoute(call, expressLike);
      if (route !== null) routes.push(route);
    }

    if (nest) {
      for (const cls of file.getClasses()) {
        for (const nestRoute of tryNestRoutes(cls)) routes.push(nestRoute);
      }
    }
  }

  // 同文件内去重（同 path+method 多次注册保留首个）
  const seen = new Set<string>();
  return {
    routes: routes.filter((r) => {
      const key = `${r.method} ${r.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    frameworks,
  };
}

function tryCallRoute(call: CallExpression, expressLike: boolean): RouteCandidateDraft | null {
  const prop = call.getExpression();
  if (!prop.isKind(SyntaxKind.PropertyAccessExpression)) return null;
  const verb = prop.getName();
  if (!HTTP_VERBS.has(verb)) return null;

  const receiver = prop.getExpression();
  if (!receiver.isKind(SyntaxKind.Identifier)) return null;
  const receiverName = receiver.getText();
  const conventional = CONVENTIONAL_RECEIVERS.test(receiverName);

  const args = call.getArguments();
  if (args.length < 2) return null; // 路由注册必须 (path, handler)
  const firstArg = args[0];
  if (firstArg === undefined) return null;
  const path = literalString(firstArg);
  if (path === null || !path.startsWith('/')) return null;

  const hasHandler = args.slice(1).some((a) => a.isKind(SyntaxKind.ArrowFunction) || a.isKind(SyntaxKind.FunctionExpression) || a.isKind(SyntaxKind.Identifier));
  if (!hasHandler && !conventional) return null; // 非惯例接收者且无函数参 → 多半是数组.get() 之类

  const file = call.getSourceFile();
  const framework = detectFrameworkOf(file);
  return {
    method: verb.toUpperCase(),
    path,
    handlerFile: relativePath(file),
    handlerLine: call.getStartLineNumber(),
    framework,
    confidence: conventional && hasHandler ? 'high' : 'medium',
  };
}

function tryNestRoutes(cls: ClassDeclaration): RouteCandidateDraft[] {
  const controller = cls.getDecorators().find((d) => d.getName() === 'Controller');
  if (controller === undefined) return [];
  const prefix = decoratorFirstString(controller) ?? '';
  const file = cls.getSourceFile();

  const out: RouteCandidateDraft[] = [];
  for (const method of cls.getInstanceMethods()) {
    for (const deco of method.getDecorators()) {
      const verb = deco.getName().toLowerCase();
      if (!HTTP_VERBS.has(verb)) continue;
      const sub = decoratorFirstString(deco) ?? '';
      const path = joinPath(prefix, sub);
      out.push({
        method: verb.toUpperCase(),
        path,
        handlerFile: relativePath(file),
        handlerLine: method.getStartLineNumber(),
        framework: 'nestjs',
        confidence: 'high',
      });
    }
  }
  return out;
}

/* ─────────────── 辅助 ─────────────── */

function detectFrameworkOf(file: SourceFile): string {
  const imports = collectImportAliases(file);
  if (hasModule(imports, 'fastify')) return 'fastify';
  if (hasModule(imports, '@koa/router') || hasModule(imports, 'koa-router')) return 'koa';
  if (hasModule(imports, 'express')) return 'express';
  return 'express'; // 形态推断（CallExpression 路由形态与 express 同族）
}

function collectImportAliases(file: SourceFile): Map<string, string[]> {
  // module → 导入到本地的标识符列表（默认导入 + 命名导入）
  const map = new Map<string, string[]>();
  for (const decl of file.getImportDeclarations()) {
    const mod = decl.getModuleSpecifierValue();
    if (mod === undefined) continue;
    const names: string[] = [];
    const defaultImport = decl.getDefaultImport();
    if (defaultImport !== undefined) names.push(defaultImport.getText());
    for (const named of decl.getNamedImports()) {
      names.push(named.getAliasNode()?.getText() ?? named.getNameNode().getText());
    }
    const list = map.get(mod) ?? [];
    list.push(...names);
    map.set(mod, list);
  }
  return map;
}

function hasModule(imports: Map<string, string[]>, mod: string): boolean {
  return imports.has(mod);
}

function moduleName(imports: Map<string, string[]>, mod: string): string {
  return imports.has(mod) ? mod : mod;
}

function literalString(node: { isKind: (k: SyntaxKind) => boolean; getLiteralValue?: () => string; getText: () => string }): string | null {
  if (node.isKind(SyntaxKind.StringLiteral) || node.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
    return node.getLiteralValue?.() ?? null;
  }
  return null;
}

function decoratorFirstString(deco: Decorator): string | null {
  const expr = deco.getExpression();
  if (!expr.isKind(SyntaxKind.CallExpression)) return null;
  const first = expr.getArguments()[0];
  if (first === undefined) return null;
  return literalString(first);
}

function joinPath(prefix: string, sub: string): string {
  const p = prefix.startsWith('/') ? prefix : `/${prefix}`;
  if (sub === '') return p;
  const s = sub.startsWith('/') ? sub : `/${sub}`;
  return `${p.replace(/\/$/, '')}${s}`;
}

function relativePath(file: SourceFile): string {
  const path = file.getFilePath();
  // 保留 src/ 起的相对形态（溯源跳转锚点）；找不到标记时退化为全路径
  const marker = path.lastIndexOf('/src/');
  return marker === -1 ? path : path.slice(marker + 1);
}
