/**
 * Kernel 服务 —— 基座对上的唯一入口（02 §4 RPC 契约的内核形态）。
 *
 * 「基座是上层无关的」在这里结构性成立：
 *   - call(method, params) 是纯方法分发，不含任何传输假设
 *   - 未来的 webview SAB 桥、CLI、测试驱动都只是把这个调用序列化后转发
 *   - 方法白名单 = KernelMethods 的键，未知方法直接拒绝（02 §7 第 3 条）
 *
 * 所有方法要么不带项目语义，要么显式携带 projectId → 铸造 ProjectScope（P5）。
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from './store/db.ts';
import * as projectsRepo from './store/repos/projects.ts';
import * as casesRepo from './store/repos/cases.ts';
import * as runsRepo from './store/repos/runs.ts';
import { getArtifact, putArtifact } from './store/repos/artifacts.ts';
import * as sourcesRepo from './store/repos/sources.ts';
import * as dbconnsRepo from './store/repos/dbconns.ts';
import * as agentsRepo from './store/repos/agents.ts';
import { decryptSecret, encryptSecret } from './store/secrets.ts';
import { appendEvents, beginRun, finishRun, judgeRunFromDb, rebuildProjections, rejudgeRun, verifyIntegrity, type EventLogDeps, type IntegrityReport } from './domain/eventlog.ts';
import { applyReview, type FieldEdit } from './domain/review.ts';
import { diffRuns } from './domain/diff.ts';
import { bool, checkPolicy, enumOf, int, isObj, requireString } from './domain/validate.ts';
import { defaultRedactOptions, redactDeep, type RedactOptions } from './domain/redact.ts';
import { KernelError, realClock, type Clock } from './shared/util.ts';
import type { ProjectScope } from './shared/ids.ts';
import type {
  AssertResultRow,
  EntryJudgment,
  EnvRecord,
  PrincipleDraft,
  PrincipleRecord,
    RouteCandidateDraft,
  RouteCandidateRecord,
  SourceIndexRecord,
  ProgressSummary,
  ProjectRecord,
  RejudgeDiff,
  RunDiff,
  RunEvent,
  RunEventInput,
  RunPolicy,
  RunRecord,
  StepResultRow,
  TestCaseDraft,
  TestCaseRecord,
} from './shared/domain.ts';
import { defaultRunPolicy } from './shared/domain.ts';
import type { DbConnectionRecord as DbConnRecord } from './shared/domain.ts';

export const KERNEL_VERSION = '0.1.0';

/* ─────────────────────────── 契约（单一来源） ─────────────────────────── */

export interface KernelMethods {
  'app:ping': { req: { ping?: number }; res: { pong: true; version: string; atMs: number } };
  'project:create': {
    req: { name: string; sourceType: 'git' | 'local' | 'zip'; repoUrl?: string | null; localPath?: string | null; gitRef?: string | null };
    res: ProjectRecord;
  };
  'project:list': { req: Record<string, never>; res: ProjectRecord[] };
  'project:archive': { req: { projectId: number }; res: ProjectRecord };
  'env:create': {
    req: { projectId: number; name: string; baseUrl: string; variables?: Record<string, unknown>; secretNames?: string[]; headers?: Record<string, string>; allowSelfSigned?: boolean };
    res: EnvRecord;
  };
  'env:list': { req: { projectId: number }; res: EnvRecord[] };
  'case:propose': { req: { projectId: number; draft: unknown; proposedBy: string }; res: TestCaseRecord };
  'case:get': { req: { projectId: number; caseId: number }; res: TestCaseRecord | null };
  'case:list': { req: { projectId: number; status?: 'proposed' | 'adopted' | 'rejected' }; res: TestCaseRecord[] };
  'case:review': {
    req: { projectId: number; caseId: number; action: 'adopt' | 'edit' | 'reject'; actor: string; edits?: FieldEdit[] };
    res: TestCaseRecord;
  };
  'run:begin': {
    req: { projectId: number; envId: number; policy?: unknown; seed?: number; triggeredBy?: 'human' | 'agent' | 'schedule' | 'retry'; plan?: unknown };
    res: { runId: number };
  };
  'run:appendEvents': { req: { projectId: number; runId: number; events: unknown[] }; res: { appended: number; lastSeq: number } };
  'run:finish': { req: { projectId: number; runId: number; status: 'completed' | 'cancelled' | 'errored' }; res: RunRecord };
  'run:get': { req: { projectId: number; runId: number }; res: RunRecord | null };
  'run:list': { req: { projectId: number; limit?: number }; res: RunRecord[] };
  'run:events': { req: { projectId: number; runId: number; sinceSeq?: number; limit?: number }; res: RunEvent[] };
  'run:results': {
    req: { projectId: number; runId: number };
    res: { entries: EntryJudgment[]; steps: StepResultRow[]; asserts: AssertResultRow[] };
  };
  'run:progress': { req: { projectId: number; runId: number }; res: ProgressSummary };
  'run:verify': { req: { projectId: number; runId: number }; res: IntegrityReport };
  'run:note': { req: { projectId: number; runId: number; text: string; by: string }; res: { seq: number } };
  'run:void': { req: { projectId: number; runId: number; reason: string; by: string }; res: { seq: number } };
  'run:waiveCase': { req: { projectId: number; runId: number; caseId: number; reason: string; by: string; expiresAtMs?: number | null }; res: { seq: number } };
  'run:overrideCase': { req: { projectId: number; runId: number; caseId: number; from: string; to: string; reason: string; by: string }; res: { seq: number } };
  'run:rebuildProjections': { req: { projectId: number; runId: number }; res: { rebuilt: number } };
  'run:rejudge': { req: { projectId: number; runId: number; policy: unknown; mode: 'preview' | 'apply'; actor: string }; res: RejudgeDiff };
  'run:diff': { req: { projectId: number; baseRunId: number; headRunId: number }; res: RunDiff };
  'source:recordIndex': { req: { projectId: number; gitRef?: string | null; fileCount: number; frameworks?: string[] }; res: SourceIndexRecord };
  'route:proposeBatch': { req: { projectId: number; sourceIndexId: number; routes: unknown[]; proposedBy: string }; res: { inserted: number } };
  'route:list': { req: { projectId: number; status?: 'proposed' | 'adopted' | 'rejected' }; res: RouteCandidateRecord[] };
  'route:review': { req: { projectId: number; routeId: number; action: 'adopt' | 'edit' | 'reject'; actor: string }; res: RouteCandidateRecord };
  'principle:proposeBatch': { req: { projectId: number; principles: unknown[]; proposedBy: string }; res: { inserted: number } };
  'principle:list': { req: { projectId: number; status?: 'proposed' | 'adopted' | 'rejected' }; res: PrincipleRecord[] };
  'principle:review': { req: { projectId: number; principleId: number; action: 'adopt' | 'edit' | 'reject'; actor: string }; res: PrincipleRecord };
  'metrics:coverage': {
    req: { projectId: number };
    res: { eligible: number; covered: number; uncovered: { routeId: number; method: string; path: string; confidence: string; framework: string }[] };
  };
  'metrics:principleEffectiveness': {
    req: { projectId: number };
    res: {
      rows: {
        principleId: number;
        subject: string;
        rule: string;
        sourceFile: string;
        sourceLine: number;
        casesReferencing: number;
        violationsDetected: number;
        /** adopted 且有引用但零失败——可疑：约束写错或测试值没打到位（03 §7.4）。 */
        zeroDetection: boolean;
      }[];
      unreferenced: number[];
    };
  };
  'dbconn:create': { req: { projectId: number; name: string; dialect: 'mysql' | 'postgres' | 'sqlite'; dsn: string; readOnly?: boolean }; res: DbConnRecord };
  'dbconn:list': { req: { projectId: number }; res: DbConnRecord[] };
  'dbconn:delete': { req: { projectId: number; connId: number }; res: { deleted: true } };
  'dbconn:getDsn': { req: { projectId: number; connId: number }; res: { dsn: string; dialect: string; readOnly: boolean; protection: string } };
  'agent:session:create': { req: { projectId: number; kind: 'api_discovery' | 'principle_extract' | 'case_synth' | 'prd_extract' }; res: { id: number; kind: string; turnCount: number } };
  'agent:session:list': { req: { projectId: number }; res: { id: number; kind: string; turnCount: number; hasCheckpoint: boolean }[] };
  'agent:turn:append': { req: { projectId: number; sessionId: number; role: string; content: string; toolName?: string | null; tokensIn?: number | null; tokensOut?: number | null }; res: { turnSeq: number } };
  'agent:turn:list': { req: { projectId: number; sessionId: number }; res: { turnSeq: number; role: string; content: string; toolName: string | null; atMs: number }[] };
  'agent:checkpoint:save': { req: { projectId: number; sessionId: number; checkpointBase64: string }; res: { saved: true } };
  'agent:checkpoint:load': { req: { projectId: number; sessionId: number }; res: { checkpointBase64: string | null } };
  'artifact:put': { req: { contentType?: string | null; contentBase64: string }; res: { sha256: string; sizeBytes: number; truncated: boolean; originalSize: number } };
  'artifact:get': { req: { sha256: string }; res: { contentType: string | null; contentBase64: string; truncated: boolean; originalSize: number } };
}

export type KernelMethodName = keyof KernelMethods;

export type MethodReq<M extends KernelMethodName> = KernelMethods[M]['req'];
export type MethodRes<M extends KernelMethodName> = KernelMethods[M]['res'];

/* ─────────────────────────── Kernel 实例 ─────────────────────────── */

export interface KernelOptions {
  /** 数据目录（app.db 与 artifacts/ 所在地）。 */
  dataDir: string;
  clock?: Clock;
  redact?: RedactOptions;
  /** 测试用：不落盘。 */
  memory?: boolean;
}

export interface Kernel {
  call<M extends KernelMethodName>(method: M, params: MethodReq<M>): Promise<MethodRes<M>>;
  close(): void;
  /** 暴露给测试与上层诊断（非业务通道）。 */
  readonly db: Db;
}

export function createKernel(options: KernelOptions): Kernel {
  mkdirSync(options.dataDir, { recursive: true });
  const db = options.memory === true ? openDb(':memory:') : openDb(join(options.dataDir, 'app.db'));
  const artifactsDir = join(options.dataDir, 'artifacts');
  const clock = options.clock ?? realClock;
  const redact = options.redact ?? defaultRedactOptions;
  const deps: EventLogDeps = { db, clock, redact };

  const scope = (projectId: unknown): ProjectScope => {
    const pid = int(projectId, 'projectId', 1);
    return projectsRepo.mintScopeFor(db, pid);
  };

  const handlers: { [M in KernelMethodName]: (params: unknown) => unknown } = {
    'app:ping': () => ({ pong: true, version: KERNEL_VERSION, atMs: clock.nowMs() }),
    'project:create': (p) => {
      const o = isObj(p) ? p : {};
      return projectsRepo.createProject(
        db,
        {
          name: requireString(o['name'], 'name', 200),
          sourceType: enumOf(o['sourceType'], 'sourceType', ['git', 'local', 'zip'] as const),
          repoUrl: o['repoUrl'] === undefined ? null : requireString(o['repoUrl'], 'repoUrl', 4096),
          localPath: o['localPath'] === undefined ? null : requireString(o['localPath'], 'localPath', 4096),
          gitRef: o['gitRef'] === undefined ? null : requireString(o['gitRef'], 'gitRef', 256),
        },
        clock.nowMs(),
      );
    },
    'project:list': () => projectsRepo.listProjects(db),
    'project:archive': (p) => {
      const o = isObj(p) ? p : {};
      return projectsRepo.archiveProject(db, int(o['projectId'], 'projectId', 1), clock.nowMs());
    },
    'env:create': (p) => {
      const o = isObj(p) ? p : {};
      return projectsRepo.createEnv(
        db,
        scope(o['projectId']),
        {
          name: requireString(o['name'], 'name', 200),
          baseUrl: requireString(o['baseUrl'], 'baseUrl', 4096),
          variables: (o['variables'] ?? {}) as Record<string, unknown>,
          secretNames: (o['secretNames'] ?? []) as string[],
          headers: (o['headers'] ?? {}) as Record<string, string>,
          allowSelfSigned: o['allowSelfSigned'] === undefined ? false : bool(o['allowSelfSigned'], 'allowSelfSigned'),
        },
        clock.nowMs(),
      );
    },
    'env:list': (p) => {
      const o = isObj(p) ? p : {};
      return projectsRepo.listEnvs(db, scope(o['projectId']));
    },
    'case:propose': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      const draft = validateCaseDraft(o['draft']);
      return casesRepo.insertCase(db, sc, draft, requireString(o['proposedBy'], 'proposedBy', 256), clock.nowMs());
    },
    'case:get': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      return casesRepo.getCase(db, sc, int(o['caseId'], 'caseId', 1)) ?? null;
    },
    'case:list': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      const status = o['status'] === undefined ? undefined : enumOf(o['status'], 'status', ['proposed', 'adopted', 'rejected'] as const);
      return casesRepo.listCases(db, sc, status);
    },
    'case:review': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      const caseId = int(o['caseId'], 'caseId', 1);
      const record = casesRepo.getCase(db, sc, caseId);
      if (record === undefined) throw new KernelError('not_found', `用例 ${caseId} 不在当前项目内`);
      const action = enumOf(o['action'], 'action', ['adopt', 'edit', 'reject'] as const);
      const actor = requireString(o['actor'], 'actor', 256);
      const edits = validateEdits(o['edits']);
      const result = applyReview(record, action, actor, edits, clock.nowMs());
      return casesRepo.applyReviewResult(db, sc, caseId, result);
    },
    'run:begin': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      const policy: RunPolicy =
        o['policy'] === undefined ? defaultRunPolicy() : (checkPolicy(o['policy']), o['policy'] as RunPolicy);
      const runId = beginRun(deps, sc, {
        envId: int(o['envId'], 'envId', 1),
        policy,
        seed: o['seed'] === undefined ? 0 : int(o['seed'], 'seed', 0, Number.MAX_SAFE_INTEGER),
        triggeredBy:
          o['triggeredBy'] === undefined ? 'human' : enumOf(o['triggeredBy'], 'triggeredBy', ['human', 'agent', 'schedule', 'retry'] as const),
        ...(o['plan'] === undefined ? {} : { planSnapshot: o['plan'] }),
      });
      return { runId };
    },
    'run:appendEvents': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      const runId = int(o['runId'], 'runId', 1);
      const evs = o['events'];
      if (!Array.isArray(evs) || evs.length > 10_000) throw new KernelError('invalid_params', 'events 必须是数组（≤10000）');
      const written = appendEvents(deps, sc, runId, evs as RunEventInput[]);
      return { appended: written.length, lastSeq: written.length > 0 ? written[written.length - 1]!.seq : 0 };
    },
    'run:finish': (p) => {
      const o = isObj(p) ? p : {};
      return finishRun(deps, scope(o['projectId']), int(o['runId'], 'runId', 1), enumOf(o['status'], 'status', ['completed', 'cancelled', 'errored'] as const));
    },
    'run:get': (p) => {
      const o = isObj(p) ? p : {};
      return runsRepo.getRun(db, scope(o['projectId']), int(o['runId'], 'runId', 1)) ?? null;
    },
    'run:list': (p) => {
      const o = isObj(p) ? p : {};
      const limit = o['limit'] === undefined ? 50 : int(o['limit'], 'limit', 1, 1000);
      return runsRepo.listRuns(db, scope(o['projectId']), limit);
    },
    'run:events': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      const runId = int(o['runId'], 'runId', 1);
      const run = runsRepo.getRun(db, sc, runId);
      if (run === undefined) throw new KernelError('not_found', `运行 ${runId} 不在当前项目内`);
      return runsRepo.readEvents(db, runId, o['sinceSeq'] === undefined ? 0 : int(o['sinceSeq'], 'sinceSeq', 0), o['limit'] === undefined ? 10_000 : int(o['limit'], 'limit', 1, 100_000));
    },
    'run:results': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      const runId = int(o['runId'], 'runId', 1);
      const run = runsRepo.getRun(db, sc, runId);
      if (run === undefined) throw new KernelError('not_found', `运行 ${runId} 不在当前项目内`);
      return {
        entries: runsRepo.readCaseResultRows(db, runId),
        steps: runsRepo.readStepRows(db, runId),
        asserts: runsRepo.readAssertRows(db, runId),
      };
    },
    'run:progress': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      const runId = int(o['runId'], 'runId', 1);
      const run = runsRepo.getRun(db, sc, runId);
      if (run === undefined) throw new KernelError('not_found', `运行 ${runId} 不在当前项目内`);
      return runsRepo.progressSummary(db, runId);
    },
    'run:verify': (p) => {
      const o = isObj(p) ? p : {};
      return verifyIntegrity(deps, scope(o['projectId']), int(o['runId'], 'runId', 1));
    },
    'run:note': (p) => {
      const o = isObj(p) ? p : {};
      const written = appendEvents(deps, scope(o['projectId']), int(o['runId'], 'runId', 1), [
        { kind: 'note', entryId: null, text: requireString(o['text'], 'text', 8192), by: requireString(o['by'], 'by', 256) },
      ]);
      return { seq: written[0]?.seq ?? 0 };
    },
    'run:void': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      const runId = int(o['runId'], 'runId', 1);
      const written = appendEvents(deps, sc, runId, [
        { kind: 'run_voided', entryId: null, reason: requireString(o['reason'], 'reason', 8192), by: requireString(o['by'], 'by', 256) },
      ]);
      runsRepo.setRunVoided(db, runId);
      return { seq: written[0]?.seq ?? 0 };
    },
    'run:waiveCase': (p) => {
      const o = isObj(p) ? p : {};
      const written = appendEvents(deps, scope(o['projectId']), int(o['runId'], 'runId', 1), [
        {
          kind: 'case_waived',
          entryId: null,
          caseId: int(o['caseId'], 'caseId', 1),
          reason: requireString(o['reason'], 'reason', 8192),
          by: requireString(o['by'], 'by', 256),
          expiresAtMs: o['expiresAtMs'] === undefined || o['expiresAtMs'] === null ? null : int(o['expiresAtMs'], 'expiresAtMs', 0),
        },
      ]);
      return { seq: written[0]?.seq ?? 0 };
    },
    'run:overrideCase': (p) => {
      const o = isObj(p) ? p : {};
      const written = appendEvents(deps, scope(o['projectId']), int(o['runId'], 'runId', 1), [
        {
          kind: 'case_overridden',
          entryId: null,
          caseId: int(o['caseId'], 'caseId', 1),
          from: enumOf(o['from'], 'from', ['passed', 'degraded', 'failed', 'errored', 'skipped'] as const),
          to: enumOf(o['to'], 'to', ['passed', 'degraded', 'failed', 'errored', 'skipped'] as const),
          reason: requireString(o['reason'], 'reason', 8192),
          by: requireString(o['by'], 'by', 256),
        },
      ]);
      return { seq: written[0]?.seq ?? 0 };
    },
    'run:rebuildProjections': (p) => {
      const o = isObj(p) ? p : {};
      return rebuildProjections(deps, scope(o['projectId']), int(o['runId'], 'runId', 1));
    },
    'run:rejudge': (p) => {
      const o = isObj(p) ? p : {};
      checkPolicy(o['policy']);
      return rejudgeRun(
        deps,
        scope(o['projectId']),
        int(o['runId'], 'runId', 1),
        o['policy'] as RunPolicy,
        enumOf(o['mode'], 'mode', ['preview', 'apply'] as const),
        requireString(o['actor'], 'actor', 256),
      );
    },
    'run:diff': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      const baseRunId = int(o['baseRunId'], 'baseRunId', 1);
      const headRunId = int(o['headRunId'], 'headRunId', 1);
      for (const id of [baseRunId, headRunId]) {
        if (runsRepo.getRun(db, sc, id) === undefined) throw new KernelError('not_found', `运行 ${id} 不在当前项目内`);
      }
      return diffRuns(judgeRunFromDb(deps, baseRunId), judgeRunFromDb(deps, headRunId));
    },
    'source:recordIndex': (p) => {
      const o = isObj(p) ? p : {};
      return sourcesRepo.recordSourceIndex(
        db,
        scope(o['projectId']),
        o['gitRef'] === undefined || o['gitRef'] === null ? null : requireString(o['gitRef'], 'gitRef', 256),
        int(o['fileCount'], 'fileCount', 0, 1_000_000),
        (o['frameworks'] ?? []) as string[],
        clock.nowMs(),
      );
    },
    'route:proposeBatch': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      const routes = o['routes'];
      if (!Array.isArray(routes) || routes.length > 20_000) throw new KernelError('invalid_params', 'routes 必须是数组（≤20000）');
      const drafts = routes.map(validateRouteDraft);
      const inserted = sourcesRepo.insertRoutes(db, sc, int(o['sourceIndexId'], 'sourceIndexId', 1), drafts, requireString(o['proposedBy'], 'proposedBy', 256));
      return { inserted };
    },
    'route:list': (p) => {
      const o = isObj(p) ? p : {};
      const status = o['status'] === undefined ? undefined : enumOf(o['status'], 'status', ['proposed', 'adopted', 'rejected'] as const);
      return sourcesRepo.listRoutes(db, scope(o['projectId']), status);
    },
    'route:review': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      const routeId = int(o['routeId'], 'routeId', 1);
      const record = sourcesRepo.getRoute(db, sc, routeId);
      if (record === undefined) throw new KernelError('not_found', `路由候选 ${routeId} 不在当前项目内`);
      const action = enumOf(o['action'], 'action', ['adopt', 'edit', 'reject'] as const);
      const actor = requireString(o['actor'], 'actor', 256);
      const result = applyReview({ id: record.id, status: record.status }, action, actor, [], clock.nowMs());
      return sourcesRepo.applyRouteReview(db, sc, routeId, result);
    },
    'principle:proposeBatch': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      const principles = o['principles'];
      if (!Array.isArray(principles) || principles.length > 20_000) throw new KernelError('invalid_params', 'principles 必须是数组（≤20000）');
      const drafts = principles.map(validatePrincipleDraft);
      const inserted = sourcesRepo.insertPrinciples(db, sc, drafts, requireString(o['proposedBy'], 'proposedBy', 256));
      return { inserted };
    },
    'principle:list': (p) => {
      const o = isObj(p) ? p : {};
      const status = o['status'] === undefined ? undefined : enumOf(o['status'], 'status', ['proposed', 'adopted', 'rejected'] as const);
      return sourcesRepo.listPrinciples(db, scope(o['projectId']), status);
    },
    'principle:review': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      const principleId = int(o['principleId'], 'principleId', 1);
      const record = sourcesRepo.getPrinciple(db, sc, principleId);
      if (record === undefined) throw new KernelError('not_found', `原则 ${principleId} 不在当前项目内`);
      const action = enumOf(o['action'], 'action', ['adopt', 'edit', 'reject'] as const);
      const actor = requireString(o['actor'], 'actor', 256);
      const result = applyReview({ id: record.id, status: record.status }, action, actor, [], clock.nowMs());
      return sourcesRepo.applyPrincipleReview(db, sc, principleId, result);
    },
    'metrics:coverage': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      // 口径与 06 §3 uncoveredRoutes 一致：adopted 或 high 置信度，且没有被非 rejected 用例引用
      const uncovered = db
        .prepare(
          `SELECT rc.id, rc.method, rc.path, rc.confidence, rc.framework
           FROM route_candidate rc
           LEFT JOIN test_case c ON c.route_id = rc.id AND c.status <> 'rejected'
           WHERE rc.project_id = ? AND rc.status <> 'rejected'
             AND (rc.status = 'adopted' OR rc.confidence = 'high')
             AND c.id IS NULL
           ORDER BY rc.path, rc.method`,
        )
        .all(sc.projectId) as { id: number; method: string; path: string; confidence: string; framework: string }[];
      const eligibleRow = db
        .prepare(
          `SELECT COUNT(*) AS n FROM route_candidate
           WHERE project_id = ? AND status <> 'rejected' AND (status = 'adopted' OR confidence = 'high')`,
        )
        .get(sc.projectId) as { n: number };
      return {
        eligible: eligibleRow.n,
        covered: eligibleRow.n - uncovered.length,
        uncovered: uncovered.map((r) => ({ routeId: r.id, method: r.method, path: r.path, confidence: r.confidence, framework: r.framework })),
      };
    },
    'metrics:principleEffectiveness': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);

      // 引用计数：从用例的溯源 JSON 解析（溯源是"记录"而非查询维度，06 §3 的取舍）
      const caseRows = db
        .prepare("SELECT provenance_json FROM test_case WHERE project_id = ? AND status <> 'rejected'")
        .all(sc.projectId) as { provenance_json: string }[];
      const refCount = new Map<number, number>();
      for (const row of caseRows) {
        const prov = JSON.parse(row.provenance_json) as { principles?: { principleId?: number }[] };
        for (const ref of prov.principles ?? []) {
          if (typeof ref.principleId === 'number') refCount.set(ref.principleId, (refCount.get(ref.principleId) ?? 0) + 1);
        }
      }

      // 违反检出：assert_result 里带该 principle_id 且失败的行数（查询期聚合，P2）
      const violationRows = db
        .prepare('SELECT principle_id, COUNT(*) AS n FROM assert_result WHERE principle_id IS NOT NULL AND passed = 0 GROUP BY principle_id')
        .all() as { principle_id: number; n: number }[];
      const violations = new Map(violationRows.map((r) => [r.principle_id, r.n]));

      const adopted = sourcesRepo.listPrinciples(db, sc, 'adopted');
      const rows = adopted.map((pr) => {
        const casesReferencing = refCount.get(pr.id) ?? 0;
        const violationsDetected = violations.get(pr.id) ?? 0;
        return {
          principleId: pr.id,
          subject: pr.subject,
          rule: pr.rule,
          sourceFile: pr.sourceFile,
          sourceLine: pr.sourceLine,
          casesReferencing,
          violationsDetected,
          zeroDetection: casesReferencing > 0 && violationsDetected === 0,
        };
      });
      return {
        rows,
        unreferenced: rows.filter((r) => r.casesReferencing === 0).map((r) => r.principleId),
      };
    },
    'dbconn:create': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      const dsn = requireString(o['dsn'], 'dsn', 4096);
      const encrypted = encryptSecret(options.dataDir, dsn);
      return dbconnsRepo.insertConnection(
        db, sc,
        requireString(o['name'], 'name', 200),
        enumOf(o['dialect'], 'dialect', ['mysql', 'postgres', 'sqlite'] as const),
        encrypted,
        o['readOnly'] === undefined ? true : bool(o['readOnly'], 'readOnly'),
        clock.nowMs(),
      );
    },
    'dbconn:list': (p) => {
      const o = isObj(p) ? p : {};
      return dbconnsRepo.listConnections(db, scope(o['projectId']));
    },
    'dbconn:delete': (p) => {
      const o = isObj(p) ? p : {};
      dbconnsRepo.deleteConnection(db, scope(o['projectId']), int(o['connId'], 'connId', 1));
      return { deleted: true };
    },
    'dbconn:getDsn': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      const row = dbconnsRepo.getConnectionRow(db, sc, int(o['connId'], 'connId', 1));
      if (row === undefined) throw new KernelError('not_found', `连接 ${String(o['connId'])} 不在当前项目内`);
      return {
        dsn: decryptSecret(options.dataDir, row.dsnEncrypted),
        dialect: row.record.dialect,
        readOnly: row.record.readOnly,
        // 诚实标注保护级别（08 §5.4）：keyfile 0600，非系统钥匙串
        protection: 'file-permission-key (非系统钥匙串)',
      };
    },
    'agent:session:create': (p) => {
      const o = isObj(p) ? p : {};
      const rec = agentsRepo.insertSession(db, scope(o['projectId']), enumOf(o['kind'], 'kind', ['api_discovery', 'principle_extract', 'case_synth', 'prd_extract'] as const), clock.nowMs());
      return { id: rec.id, kind: rec.kind, turnCount: rec.turnCount };
    },
    'agent:session:list': (p) => {
      const o = isObj(p) ? p : {};
      return agentsRepo.listSessions(db, scope(o['projectId'])).map((r) => ({ id: r.id, kind: r.kind, turnCount: r.turnCount, hasCheckpoint: r.hasCheckpoint }));
    },
    'agent:turn:append': (p) => {
      const o = isObj(p) ? p : {};
      const sc = scope(o['projectId']);
      // 脱敏后落库（08 §4：对话记录是落库路径；凭据/手机号等不入库）
      const content = redactDeep(requireString(o['content'], 'content', 200_000), redact) as string;
      const rec = agentsRepo.appendTurn(db, sc, int(o['sessionId'], 'sessionId', 1), {
        role: requireString(o['role'], 'role', 64),
        content,
        toolName: o['toolName'] === undefined || o['toolName'] === null ? null : requireString(o['toolName'], 'toolName', 128),
        tokensIn: o['tokensIn'] === undefined || o['tokensIn'] === null ? null : int(o['tokensIn'], 'tokensIn', 0),
        tokensOut: o['tokensOut'] === undefined || o['tokensOut'] === null ? null : int(o['tokensOut'], 'tokensOut', 0),
        atMs: clock.nowMs(),
      });
      return { turnSeq: rec.turnSeq };
    },
    'agent:turn:list': (p) => {
      const o = isObj(p) ? p : {};
      return agentsRepo.listTurns(db, scope(o['projectId']), int(o['sessionId'], 'sessionId', 1)).map((t) => ({ turnSeq: t.turnSeq, role: t.role, content: t.content, toolName: t.toolName, atMs: t.atMs }));
    },
    'agent:checkpoint:save': (p) => {
      const o = isObj(p) ? p : {};
      const blob = Buffer.from(requireString(o['checkpointBase64'], 'checkpointBase64', 20_000_000), 'base64');
      agentsRepo.saveCheckpoint(db, scope(o['projectId']), int(o['sessionId'], 'sessionId', 1), new Uint8Array(blob), clock.nowMs());
      return { saved: true };
    },
    'agent:checkpoint:load': (p) => {
      const o = isObj(p) ? p : {};
      const blob = agentsRepo.loadCheckpoint(db, scope(o['projectId']), int(o['sessionId'], 'sessionId', 1));
      return { checkpointBase64: blob === null ? null : Buffer.from(blob).toString('base64') };
    },
    'artifact:put': (p) => {
      const o = isObj(p) ? p : {};
      const content = Buffer.from(requireString(o['contentBase64'], 'contentBase64', 20_000_000), 'base64');
      return putArtifact(db, artifactsDir, content, o['contentType'] === undefined || o['contentType'] === null ? null : requireString(o['contentType'], 'contentType', 256), clock.nowMs());
    },
    'artifact:get': (p) => {
      const o = isObj(p) ? p : {};
      const stored = getArtifact(db, artifactsDir, requireString(o['sha256'], 'sha256', 128));
      return {
        contentType: stored.contentType,
        contentBase64: stored.content.toString('base64'),
        truncated: stored.truncated,
        originalSize: stored.originalSize,
      };
    },
  };

  return {
    db,
    async call(method, params) {
      const handler = (handlers as Record<string, (p: unknown) => unknown>)[method];
      if (handler === undefined) {
        throw new KernelError('unknown_method', `未知方法 ${String(method)}（RPC 白名单之外）`);
      }
      return handler(params) as MethodRes<KernelMethodName>;
    },
    close() {
      db.close();
    },
  };
}

/* ─────────────────────────── 用例草稿校验 ─────────────────────────── */

function validateCaseDraft(v: unknown): TestCaseDraft {
  if (!isObj(v)) throw new KernelError('invalid_params', 'draft 必须是对象');
  requireString(v['name'], 'draft.name', 200);
  const paramKind = enumOf(v['paramKind'], 'draft.paramKind', ['single', 'boundary', 'pair', 'matrix', 'sequence'] as const);
  const params = v['params'];
  if (!isObj(params) || !Array.isArray(params['rows'])) {
    throw new KernelError('invalid_params', 'draft.params.rows 必须是数组');
  }
  if (params['rows'].length > 256) throw new KernelError('invalid_params', 'draft.params.rows 超过硬上限 256');
  const steps = v['steps'];
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 100) {
    throw new KernelError('invalid_params', 'draft.steps 必须是 1–100 个步骤');
  }
  for (const s of steps) {
    if (!isObj(s)) throw new KernelError('invalid_params', 'draft.steps[] 必须是对象');
    enumOf(s['kind'], 'draft.steps[].kind', ['request', 'extract', 'assert', 'wait', 'script', 'db_check', 'ui_navigate', 'ui_click', 'ui_fill', 'ui_press', 'ui_wait_for', 'ui_see', 'ui_screenshot'] as const);
  }
  if (paramKind === 'matrix') {
    const max = typeof params['maxRows'] === 'number' ? params['maxRows'] : 32;
    if (params['rows'].length > max) {
      // 静默截断会让人误以为覆盖完整——"测过了"必须是真话（03 §2.3）
      throw new KernelError('matrix_rows_exceeded', `matrix 参数行 ${params['rows'].length} 超过 maxRows=${max}，请缩小维度`);
    }
  }
  return v as unknown as TestCaseDraft;
}

function validateEdits(v: unknown): FieldEdit[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new KernelError('invalid_params', 'edits 必须是数组');
  return v as FieldEdit[];
}

function validateRouteDraft(v: unknown): RouteCandidateDraft {
  if (!isObj(v)) throw new KernelError('invalid_params', 'route draft 必须是对象');
  const method = requireString(v['method'], 'routes[].method', 16).toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) {
    throw new KernelError('invalid_params', `routes[].method 不支持：${method}`);
  }
  const path = requireString(v['path'], 'routes[].path', 2048);
  if (!path.startsWith('/')) throw new KernelError('invalid_params', `routes[].path 必须以 / 开头：${path}`);
  return {
    method,
    path,
    handlerFile: requireString(v['handlerFile'], 'routes[].handlerFile', 4096),
    handlerLine: int(v['handlerLine'], 'routes[].handlerLine', 1, 5_000_000),
    framework: requireString(v['framework'], 'routes[].framework', 64),
    confidence: enumOf(v['confidence'], 'routes[].confidence', ['high', 'medium'] as const),
  };
}

function validatePrincipleDraft(v: unknown): PrincipleDraft {
  if (!isObj(v)) throw new KernelError('invalid_params', 'principle draft 必须是对象');
  const valueJson = v['valueJson'];
  if (valueJson !== undefined && valueJson !== null && (typeof valueJson !== 'object' || Array.isArray(valueJson))) {
    throw new KernelError('invalid_params', 'principles[].valueJson 必须是对象');
  }
  return {
    subject: requireString(v['subject'], 'principles[].subject', 512),
    rule: requireString(v['rule'], 'principles[].rule', 2048),
    valueJson: (valueJson ?? null) as Record<string, unknown> | null,
    sourceFile: requireString(v['sourceFile'], 'principles[].sourceFile', 4096),
    sourceLine: int(v['sourceLine'], 'principles[].sourceLine', 1, 5_000_000),
    layer: enumOf(v['layer'], 'principles[].layer', ['validation', 'persistence', 'sample', 'comment'] as const),
    confidence: enumOf(v['confidence'], 'principles[].confidence', ['high', 'medium'] as const),
  };
}
