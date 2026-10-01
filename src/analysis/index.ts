/**
 * 分析层公共出口 —— S2（API 发现）与 S3（原则提取）。
 * headless：读源码 + AST，产物经 kernel 人机门落库；不修改被测仓库。
 */

export { extractRoutes } from './routes.ts';
export { extractPrinciples, extractPrismaSchema } from './principles.ts';
export { indexLocalSource, type ScanOptions, type ScanResult } from './scan.ts';
