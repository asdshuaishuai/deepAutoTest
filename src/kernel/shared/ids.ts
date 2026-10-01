/**
 * P5「项目即边界」的类型层强制。
 *
 * 所有仓储函数、领域函数的第一参数都是 ProjectScope。
 * 跨项目查询在编译期就写不出来（没有 scope 拿不到任何数据）。
 *
 * scope 只能由 store 层在校验项目存在后铸造（mintProjectScope），
 * 业务代码拿到的是不透明令牌——它无法伪造，也无法改写其中的 pid。
 */

/** 项目作用域：不透明令牌，只能由 store 铸造。 */
export type ProjectScope = {
  readonly __brand: 'ProjectScope';
  readonly projectId: number;
};

/** 参数化后的执行单元标识（一次运行内唯一）。 */
export type EntryId = string;

export type ActorId = string;

export interface MintScope {
  (projectId: number): ProjectScope;
}

/** 唯一的铸造点。仅供 store / service 内部使用，不对外导出构造方式。 */
export const mintProjectScope: MintScope = (projectId) => {
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new Error(`invalid_project_id:${projectId}`);
  }
  return { __brand: 'ProjectScope', projectId };
};

export function scopeId(scope: ProjectScope): number {
  return scope.projectId;
}
