/**
 * 模板变量：{{env.x}} / {{var.x}} / {{secret.x}} / {{param.x}}（03 §3.4）。
 *
 * 三类来源分离（环境 / 步骤提取 / 凭据）+ 参数行值。编译期校验存在性，
 * 运行期解析；secret 值永不落库（runner 在发出事件前对已知 secret 值做掩码）。
 */

import { KernelError } from '../kernel/shared/util.ts';

export interface TemplateContext {
  env: Record<string, unknown>;
  vars: Record<string, string>;
  secrets: Record<string, string>;
  params: Record<string, unknown>;
}

export type TemplateRef = { ns: 'env' | 'var' | 'secret' | 'param'; name: string };

const REF = /\{\{\s*(env|var|secret|param)\.([A-Za-z0-9_.-]+)\s*\}\}/g;

export function parseRefs(text: string): TemplateRef[] {
  const out: TemplateRef[] = [];
  for (const m of text.matchAll(REF)) {
    out.push({ ns: m[1] as TemplateRef['ns'], name: m[2]! });
  }
  return out;
}

/** 运行期解析：未定义引用抛错（宁可 errored，不可悄悄发空值请求）。 */
export function resolveTemplate(text: string, ctx: TemplateContext): string {
  return text.replace(REF, (_full, ns: string, name: string) => {
    const value = lookupValue({ ns, name } as TemplateRef, ctx);
    if (value === undefined) {
      throw new KernelError('template_undefined', `模板引用 {{${ns}.${name}}} 在运行期未定义`);
    }
    return String(value);
  });
}

function lookupValue(ref: TemplateRef, ctx: TemplateContext): unknown {
  switch (ref.ns) {
    case 'env':
      return ctx.env[ref.name];
    case 'var':
      return ctx.vars[ref.name];
    case 'secret':
      return ctx.secrets[ref.name];
    case 'param':
      return ctx.params[ref.name];
  }
}

/**
 * 编译期校验：引用的变量必须存在。
 *  - env.* / secret.* 来自 EnvRecord（variables / secretNames）
 *  - param.* 来自参数行 values 的键
 *  - var.* 必须由**同 case 更早的 extract 步骤**定义（自然无环）
 */
export function validateRefs(
  text: string,
  known: { envKeys: Set<string>; secretKeys: Set<string>; paramKeys: Set<string>; definedVars: Set<string> },
  where: string,
): void {
  for (const ref of parseRefs(text)) {
    switch (ref.ns) {
      case 'env':
        if (!known.envKeys.has(ref.name)) {
          throw new KernelError('template_ref_unknown', `${where}：{{env.${ref.name}}} 不在环境变量中`);
        }
        break;
      case 'secret':
        if (!known.secretKeys.has(ref.name)) {
          throw new KernelError('template_ref_unknown', `${where}：{{secret.${ref.name}}} 不在环境 secretNames 中`);
        }
        break;
      case 'param':
        if (!known.paramKeys.has(ref.name)) {
          throw new KernelError('template_ref_unknown', `${where}：{{param.${ref.name}}} 不在参数行 values 中`);
        }
        break;
      case 'var':
        if (!known.definedVars.has(ref.name)) {
          throw new KernelError(
            'template_ref_unknown',
            `${where}：{{var.${ref.name}}} 未被更早的 extract 步骤定义（或定义晚于引用）`,
          );
        }
        break;
    }
  }
}

/** 把模板中的 var/param/secret 引用替换为占位值，用于编译期静态检查 URL 归属。 */
export function maskTemplate(text: string): string {
  return text.replace(REF, (_full, ns: string, name: string) => `__${ns}_${name}__`);
}
