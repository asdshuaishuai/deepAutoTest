/**
 * deepAutoTest 基座（headless kernel）公共出口。
 *
 * 上层无关性承诺：本包不含 GUI、webview、React、出站网络。
 * 任何 UI 壳（桌面 webview / CLI / 未来形态）只应依赖 createKernel + KernelMethods。
 */

export { createKernel, KERNEL_VERSION, type Kernel, type KernelMethods, type KernelMethodName, type KernelOptions, type MethodReq, type MethodRes } from './service.ts';
export { mintProjectScope, type ProjectScope, type EntryId } from './shared/ids.ts';
export * from './shared/domain.ts';
export { KernelError, canonicalJson, chainEvent, sha256Hex, type Clock, realClock, median, percentile } from './shared/util.ts';
export { judgeRun, judgeEntry, type EntryJudgeContext, type JudgeOptions } from './domain/judge.ts';
export { deriveEntryRows, splitEntryEvents, type EntrySplit, type DerivedEntryRows } from './domain/derive.ts';
export { applyReview, type FieldEdit, type ReviewResult } from './domain/review.ts';
export { redactDeep, redactString, type RedactOptions } from './domain/redact.ts';
export { diffRuns } from './domain/diff.ts';
export { appendEvents, beginRun, finishRun, rebuildProjections, rejudgeRun, verifyIntegrity, judgeRunFromDb, type EventLogDeps, type IntegrityReport } from './domain/eventlog.ts';
export { openDb, openMemoryDb, migrate, tx, type Db } from './store/db.ts';
export { MIGRATIONS, type Migration } from './store/migrations/index.ts';
