/**
 * 采样层编排（S4）：连接生命周期 + kernel 桥。
 *
 * 分层纪律与 analysis/synthesis 一致：本层持有驱动（可选依赖），产物与观测经
 * kernel 服务方法读写；kernel 保持零驱动依赖。
 *
 * makeDbChecker 供执行层的 db_check 步骤使用：每次检查独立开闭连接
 * （db_check 频率低，隔离优先；连接池是后续优化）。
 */

import type { Kernel } from '../kernel/service.ts';
import { openConnection, sampleRows, runReadOnlyQuery, introspectSchema, type SampleOptions, type DbColumn } from './sampler.ts';
import { checkDrift, type DriftItem } from './drift.ts';

export async function sampleTable(kernel: Kernel, projectId: number, connId: number, opts: SampleOptions): Promise<Record<string, unknown>[]> {
  const meta = await kernel.call('dbconn:getDsn', { projectId, connId });
  const conn = await openConnection(meta.dialect as 'mysql' | 'postgres' | 'sqlite', meta.dsn);
  try {
    return await sampleRows(conn, opts);
  } finally {
    await conn.close();
  }
}

export async function sampleQuery(kernel: Kernel, projectId: number, connId: number, sql: string): Promise<Record<string, unknown>[]> {
  const meta = await kernel.call('dbconn:getDsn', { projectId, connId });
  const conn = await openConnection(meta.dialect as 'mysql' | 'postgres' | 'sqlite', meta.dsn);
  try {
    return await runReadOnlyQuery(conn, sql);
  } finally {
    await conn.close();
  }
}

export async function introspect(kernel: Kernel, projectId: number, connId: number): Promise<DbColumn[]> {
  const meta = await kernel.call('dbconn:getDsn', { projectId, connId });
  const conn = await openConnection(meta.dialect as 'mysql' | 'postgres' | 'sqlite', meta.dsn);
  try {
    return await introspectSchema(conn);
  } finally {
    await conn.close();
  }
}

/** 内省 + 与已采纳持久层原则对账（漂移 = 迁移没跑/代码与库不同步的信号）。 */
export async function checkSchemaDrift(kernel: Kernel, projectId: number, connId: number): Promise<DriftItem[]> {
  const [columns, principles] = await Promise.all([
    introspect(kernel, projectId, connId),
    kernel.call('principle:list', { projectId, status: 'adopted' }),
  ]);
  return checkDrift(columns, principles);
}

/* ─────────────── db_check 执行面（runner 桥） ─────────────── */

export interface DbChecker {
  /** 按「连接名」执行已过白名单的查询，返回行数与首行采样。 */
  query(projectId: number, connectionName: string, sql: string): Promise<{ rowCount: number; firstRow: Record<string, unknown> | null }>;
}

export function makeDbChecker(kernel: Kernel): DbChecker {
  return {
    async query(projectId, connectionName, sql) {
      const conns = await kernel.call('dbconn:list', { projectId });
      const conn = conns.find((c) => c.name === connectionName);
      if (conn === undefined) {
        throw new Error(`dbconn_not_found:连接「${connectionName}」不在当前项目内`);
      }
      const rows = await sampleQuery(kernel, projectId, conn.id, sql);
      return { rowCount: rows.length, firstRow: rows[0] ?? null };
    },
  };
}

export { guardReadOnlySql, sessionReadOnlyStatements, guardIdentifier, stripSqlComments, type GuardResult } from './guard.ts';
export { openConnection, openSqlite, sampleRows, runReadOnlyQuery, introspectSchema, type SampleConnection, type DbColumn } from './sampler.ts';
export { checkDrift, type DriftItem } from './drift.ts';
