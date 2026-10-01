/**
 * 原则提取（S3，M2 范围）：从源码提炼「什么值算合法、什么值算边界」。
 *
 * 四个提取器：
 *  - zod / joi：校验链（z.number().max(50000)）的 CallExpression 链游走
 *  - class-validator：DTO 属性装饰器（@Max(50000)）
 *  - Prisma：schema.prisma 字段属性（@db.VarChar(20)、@unique）——文本级解析
 *
 * 每条原则强制 file:line 溯源（03 §2.5）与机读 value_json（S3 → S5 的唯一接口）。
 * 层次（layer）：validation（校验代码）| persistence（存储模型）。
 */

import { Project, SyntaxKind, type CallExpression, type Decorator, type SourceFile } from 'ts-morph';
import type { PrincipleDraft, PrincipleLayer } from '../kernel/shared/domain.ts';

interface NormalizedValue {
  type?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: (string | number)[];
  email?: boolean;
  url?: boolean;
  integer?: boolean;
  positive?: boolean;
  optional?: boolean;
  nullable?: boolean;
  unique?: boolean;
  [k: string]: unknown;
}

export function extractPrinciples(project: Project): PrincipleDraft[] {
  const out: PrincipleDraft[] = [];
  for (const file of project.getSourceFiles()) {
    const imports = collectImportAliases(file);
    const zodRoots = new Set(imports.get('zod') ?? []);
    const joiRoots = new Set([...(imports.get('joi') ?? []), ...(imports.get('@hapi/joi') ?? [])]);
    const hasCv = imports.has('class-validator');
    if (zodRoots.size > 0) out.push(...extractValidatorChains(file, zodRoots, 'zod'));
    if (joiRoots.size > 0) out.push(...extractValidatorChains(file, joiRoots, 'joi'));
    if (hasCv) out.push(...extractClassValidator(file));
  }
  return dedup(out);
}

/* ─────────────── zod / joi 链提取 ─────────────── */

const BASE_TYPES = new Set(['number', 'string', 'boolean', 'date', 'enum', 'array', 'object', 'any', 'uuid']);

function extractValidatorChains(file: SourceFile, roots: Set<string>, lib: 'zod' | 'joi'): PrincipleDraft[] {
  const out: PrincipleDraft[] = [];
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    // 只处理链的最外层（父节点不是链内调用）
    if (isInsideChain(call)) continue;
    const chain = walkChain(call, roots);
    if (chain === null) continue;

    const subject = inferSubject(call);
    if (subject === null) continue;
    const value = chainToValue(chain, lib);
    const rule = humanRule(subject, value);
    if (rule === null) continue; // 无有效约束（如纯 z.any()）不产出噪声

    out.push({
      subject,
      rule,
      valueJson: value as Record<string, unknown>,
      sourceFile: relativePath(file),
      sourceLine: call.getStartLineNumber(),
      layer: 'validation',
      confidence: 'high',
    });
  }
  return out;
}

function isInsideChain(call: CallExpression): boolean {
  const parent = call.getParent();
  if (parent === undefined) return false;
  if (parent.isKind(SyntaxKind.PropertyAccessExpression) && parent.getExpression() === call) {
    const grand = parent.getParent();
    return grand !== undefined && grand.isKind(SyntaxKind.CallExpression);
  }
  return false;
}

interface ChainPart {
  name: string;
  args: (string | number | boolean)[];
}

function walkChain(call: CallExpression, roots: Set<string>): { base: string; baseArgs: (string | number)[]; ops: ChainPart[] } | null {
  const ops: ChainPart[] = [];
  let current: CallExpression = call;
  for (;;) {
    const expr = current.getExpression();
    if (!expr.isKind(SyntaxKind.PropertyAccessExpression)) return null;
    const name = expr.getName();
    const args = current.getArguments().map(literalArg).filter((a): a is string | number | boolean => a !== null);

    const left = expr.getExpression();
    if (left.isKind(SyntaxKind.Identifier)) {
      // 到达根部：roots.X(...) 且 X 是基础类型（z.enum([...]) 的数组参数在此解包）
      if (roots.has(left.getText()) && (BASE_TYPES.has(name) || name === 'enum')) {
        return { base: name === 'enum' ? 'enum' : name, baseArgs: rootArgValues(current), ops };
      }
      return null;
    }
    if (!left.isKind(SyntaxKind.CallExpression)) return null;
    ops.unshift({ name, args });
    current = left;
  }
}

/** 装饰器参数值：标量直取；数组字面量取元素（@IsIn(['A','B'])）。 */
function decoratorArgValues(deco: Decorator): (string | number)[] {
  const expr = deco.getExpression();
  if (!expr.isKind(SyntaxKind.CallExpression)) return [];
  const out: (string | number)[] = [];
  for (const arg of expr.getArguments()) {
    if (arg.isKind(SyntaxKind.ArrayLiteralExpression)) {
      for (const el of arg.getElements()) {
        const v = literalArg(el);
        if (typeof v === 'string' || typeof v === 'number') out.push(v);
      }
    } else {
      const v = literalArg(arg);
      if (typeof v === 'string' || typeof v === 'number') out.push(v);
    }
  }
  return out;
}

/** 根调用的参数值：标量直取；数组字面量取元素（z.enum(['A','B'])）。 */
function rootArgValues(call: CallExpression): (string | number)[] {
  const out: (string | number)[] = [];
  for (const arg of call.getArguments()) {
    if (arg.isKind(SyntaxKind.ArrayLiteralExpression)) {
      for (const el of arg.getElements()) {
        const v = literalArg(el);
        if (typeof v === 'string' || typeof v === 'number') out.push(v);
      }
    } else {
      const v = literalArg(arg);
      if (typeof v === 'string' || typeof v === 'number') out.push(v);
    }
  }
  return out;
}

function chainToValue(chain: { base: string; baseArgs: (string | number)[]; ops: ChainPart[] }, lib: 'zod' | 'joi'): NormalizedValue {
  const v: NormalizedValue = {};
  if (chain.base === 'enum' && chain.baseArgs.length > 0) {
    v.type = 'enum';
    v.enum = chain.baseArgs;
  } else if (chain.base !== 'any') {
    v.type = chain.base;
  }
  void 0;
  for (const op of chain.ops) {
    const [a] = op.args;
    switch (op.name) {
      case 'max':
        if (typeof a === 'number') {
          if (chain.base === 'string') v.maxLength = a;
          else v.max = a;
        }
        break;
      case 'min':
        if (typeof a === 'number') {
          if (chain.base === 'string') v.minLength = a;
          else v.min = a;
        }
        break;
      case 'length':
        if (typeof a === 'number') {
          v.minLength = a;
          v.maxLength = a;
        }
        break;
      case 'int':
      case 'integer':
        v.integer = true;
        break;
      case 'positive':
        v.positive = true;
        break;
      case 'email':
        v.email = true;
        break;
      case 'url':
      case 'uri':
        v.url = true;
        break;
      case 'regex':
      case 'pattern':
        if (op.args.length > 0) v.pattern = String(op.args[0]);
        break;
      case 'valid':
      case 'oneOf':
      case 'allow':
        if (op.args.length > 0) {
          v.type = 'enum';
          v.enum = op.args.filter((a): a is string | number => typeof a !== 'boolean');
        }
        break;
      case 'optional':
        v.optional = true;
        break;
      case 'nullable':
        v.nullable = true;
        break;
      case 'required':
        v.optional = false;
        break;
      default:
        break;
    }
  }
  void lib;
  return v;
}

function inferSubject(call: CallExpression): string | null {
  // z.object({ amount: z.number().max(...) }) → SchemaVar.amount（与设计文档的 order.amount 形态一致）
  let node = call.getParent();
  let propKey: string | null = null;
  while (node !== undefined) {
    if (propKey === null && node.isKind(SyntaxKind.PropertyAssignment)) {
      propKey = node.getNameNode().getText().replace(/^['"`]|['"`]$/g, '');
    }
    if (node.isKind(SyntaxKind.VariableDeclaration)) {
      const varName = node.getNameNode().getText();
      if (varName.length === 0) return null;
      return propKey === null ? varName : `${varName}.${propKey}`;
    }
    if (node.isKind(SyntaxKind.SourceFile)) return propKey;
    node = node.getParent();
  }
  return propKey;
}

function humanRule(subject: string, v: NormalizedValue): string | null {
  const parts: string[] = [];
  if (typeof v.max === 'number') parts.push(`≤ ${v.max}`);
  if (typeof v.min === 'number') parts.push(`≥ ${v.min}`);
  if (typeof v.maxLength === 'number') parts.push(`长度 ≤ ${v.maxLength}`);
  if (typeof v.minLength === 'number') parts.push(`长度 ≥ ${v.minLength}`);
  if (v.email === true) parts.push('email 格式');
  if (v.url === true) parts.push('URL 格式');
  if (typeof v.pattern === 'string') parts.push(`匹配 ${v.pattern}`);
  if (Array.isArray(v.enum) && v.enum.length > 0) parts.push(`枚举 ${v.enum.join('|')}`);
  if (v.integer === true) parts.push('整数');
  if (v.positive === true) parts.push('正数');
  if (v.unique === true) parts.push('唯一');
  if (v.optional === true) parts.push('可缺省');
  if (parts.length === 0) return null;
  void subject;
  return parts.join('，');
}

/* ─────────────── class-validator ─────────────── */

function extractClassValidator(file: SourceFile): PrincipleDraft[] {
  const out: PrincipleDraft[] = [];
  for (const cls of file.getClasses()) {
    const className = cls.getName() ?? 'Anonymous';
    for (const prop of cls.getProperties()) {
      const v: NormalizedValue = {};
      let meaningful = false;
      for (const deco of prop.getDecorators()) {
        const name = deco.getName();
        const args = decoratorArgValues(deco);
        switch (name) {
          case 'Max':
            if (typeof args[0] === 'number') { v.max = args[0]; meaningful = true; }
            break;
          case 'Min':
            if (typeof args[0] === 'number') { v.min = args[0]; meaningful = true; }
            break;
          case 'Length':
            if (typeof args[0] === 'number') { v.minLength = args[0]; meaningful = true; }
            if (typeof args[1] === 'number') v.maxLength = args[1];
            break;
          case 'IsEmail': v.email = true; meaningful = true; break;
          case 'IsUrl': v.url = true; meaningful = true; break;
          case 'Matches': v.pattern = String(args[0] ?? ''); meaningful = true; break;
          case 'IsIn': {
            const values = decoratorArgValues(deco);
            if (values.length > 0) { v.type = 'enum'; v.enum = values; meaningful = true; }
            break;
          }
          case 'IsInt': v.integer = true; meaningful = true; break;
          case 'IsOptional': v.optional = true; break;
          default: break;
        }
      }
      if (!meaningful) continue;
      const rule = humanRule(className, v);
      if (rule === null) continue;
      out.push({
        subject: `${className}.${prop.getName()}`,
        rule,
        valueJson: v as Record<string, unknown>,
        sourceFile: relativePath(file),
        sourceLine: prop.getDecorators()[0]!.getStartLineNumber(),
        layer: 'validation',
        confidence: 'high',
      });
    }
  }
  return out;
}

/* ─────────────── Prisma schema（文本级） ─────────────── */

export function extractPrismaSchema(text: string, fileName: string): PrincipleDraft[] {
  const out: PrincipleDraft[] = [];
  const lines = text.split('\n');
  let model: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const modelMatch = /^model\s+(\w+)\s*\{/.exec(line);
    if (modelMatch !== null) {
      model = modelMatch[1]!;
      continue;
    }
    if (/^\}/.test(line)) {
      model = null;
      continue;
    }
    if (model === null) continue;

    // @@unique([a, b]) → 模型级唯一
    const modelUnique = /@@unique\(\[([^\]]+)\]\)/.exec(line);
    if (modelUnique !== null) {
      for (const field of modelUnique[1]!.split(',').map((f) => f.trim())) {
        out.push({
          subject: `${model}.${field}`,
          rule: '唯一（复合唯一约束成员）',
          valueJson: { unique: true },
          sourceFile: fileName,
          sourceLine: i + 1,
          layer: 'persistence',
          confidence: 'high',
        });
      }
      continue;
    }

    // 字段行：name Type? @attrs
    const field = /^(\w+)\s+(\w+)(\?)?\s*(.*)$/.exec(line.trim());
    if (field === null || field[2] === undefined) continue;
    const name = field[1] as string;
    const rawType = field[2] as string;
    const optMark = field[3];
    const attrs = field[4] ?? '';
    if (name === undefined || rawType === undefined) continue;
    const v: NormalizedValue = { type: prismaType(rawType) };
    let meaningful = false;

    const varChar = /@db\.VarChar(?:\((\d+)\))?/.exec(attrs ?? '');
    if (varChar !== null) {
      v.maxLength = varChar[1] !== undefined ? Number.parseInt(varChar[1], 10) : 191;
      meaningful = true;
    }
    const intType = /@db\.(?:Unsigned)?(?:Tiny|Small|Medium|Big)?Int(?:\((\d+)\))?/.exec(attrs ?? '');
    if (intType !== null) {
      v.integer = true;
      meaningful = true;
    }
    if (/@unique/.test(attrs ?? '')) {
      v.unique = true;
      meaningful = true;
    }
    if (optMark === '?') v.nullable = true;

    const rule = humanRule(name, v);
    if (!meaningful || rule === null) continue;
    out.push({
      subject: `${model}.${name}`,
      rule,
      valueJson: v as Record<string, unknown>,
      sourceFile: fileName,
      sourceLine: i + 1,
      layer: 'persistence',
      confidence: 'high',
    });
  }
  return out;
}

function prismaType(t: string): string {
  switch (t) {
    case 'Int': case 'BigInt': return 'number';
    case 'Float': case 'Decimal': return 'number';
    case 'String': return 'string';
    case 'Boolean': return 'boolean';
    case 'DateTime': return 'date';
    default: return t.toLowerCase();
  }
}

/* ─────────────── 通用辅助 ─────────────── */

function literalArg(node: { isKind: (k: SyntaxKind) => boolean; getLiteralValue?: () => unknown; getText: () => string }): string | number | boolean | null {
  if (node.isKind(SyntaxKind.StringLiteral) || node.isKind(SyntaxKind.NumericLiteral) || node.isKind(SyntaxKind.NoSubstitutionTemplateLiteral) || node.isKind(SyntaxKind.TrueKeyword) || node.isKind(SyntaxKind.FalseKeyword)) {
    const v = node.getLiteralValue?.();
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  }
  // 正则字面量（z.string().regex(/.../)）
  const text = node.getText();
  if (/^\/.*\/[a-z]*$/.test(text)) return text;
  return null;
}

function collectImportAliases(file: SourceFile): Map<string, string[]> {
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

function relativePath(file: SourceFile): string {
  const path = file.getFilePath();
  const marker = path.lastIndexOf('/src/');
  return marker === -1 ? path : path.slice(marker + 1);
}

function dedup(drafts: PrincipleDraft[]): PrincipleDraft[] {
  const seen = new Set<string>();
  return drafts.filter((d) => {
    const key = `${d.subject}|${d.rule}|${d.sourceFile}:${d.sourceLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type { PrincipleLayer };
