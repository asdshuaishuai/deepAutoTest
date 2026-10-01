/**
 * UI 测试族：编译器校验（族检查/同源）+ 脚本驱动执行（事件/判定/截图/错误）+ 真浏览器集成（可跳过）。
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compilePlan } from '../src/execution/plan-compiler.ts';
import { executePlan } from '../src/execution/runner.ts';
import { PlaywrightUiDriverFactory, browserChannel, type UiDriver, type UiDriverFactory } from '../src/execution/ui/driver.ts';
import { defaultRunPolicy, type EnvRecord, type RunPolicy, type TestCaseDraft, type TestCaseRecord } from '../src/kernel/shared/domain.ts';
import { testKernel, type KernelHandle } from './helpers.ts';

/* ─────────────── 脚本驱动（确定性） ─────────────── */

class ScriptedDriver implements UiDriver {
  readonly log: string[] = [];
  constructor(
    private readonly pageText: Record<string, string> = {},
    private readonly missing: Set<string> = new Set(),
    private readonly hangSelectors: Set<string> = new Set(),
  ) {}
  async goto(url: string): Promise<void> {
    this.log.push(`goto ${url}`);
  }
  async click(selector: string): Promise<void> {
    if (this.hangSelectors.has(selector)) throw new Error(`Timeout 5000ms exceeded waiting for ${selector}`);
    this.log.push(`click ${selector}`);
  }
  async fill(selector: string, text: string): Promise<void> {
    this.log.push(`fill ${selector}=${text}`);
  }
  async press(key: string): Promise<void> {
    this.log.push(`press ${key}`);
  }
  async waitFor(selector: string): Promise<void> {
    if (this.missing.has(selector)) throw new Error(`Timeout 5000ms exceeded waiting for selector ${selector}`);
  }
  async textOf(selector: string): Promise<string | null> {
    return this.pageText[selector] ?? null;
  }
  async bodyText(): Promise<string> {
    return Object.values(this.pageText).join('\n');
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.from('fake-png-bytes');
  }
  async close(): Promise<void> {
    this.log.push('close');
  }
}

class ScriptedFactory implements UiDriverFactory {
  readonly drivers: ScriptedDriver[] = [];
  constructor(private readonly make: () => ScriptedDriver) {}
  available(): boolean {
    return true;
  }
  unavailableReason(): string {
    return '';
  }
  async create(): Promise<UiDriver> {
    const d = this.make();
    this.drivers.push(d);
    return d;
  }
}

/* ─────────────── 基座搭建 ─────────────── */

const ENV: EnvRecord = {
  id: 1,
  projectId: 1,
  name: 'web',
  baseUrl: 'http://127.0.0.1:41730',
  variables: {},
  secretNames: [],
  headers: {},
  allowSelfSigned: false,
  createdAtMs: 0,
};

function uiDraft(name: string, steps: { kind: string; config: Record<string, unknown> }[]): TestCaseDraft {
  return {
    name,
    description: null,
    routeId: null,
    paramKind: 'single',
    steps: steps.map((s, i) => ({ id: `s${i}`, seq: i, kind: s.kind, config: s.config })) as TestCaseDraft['steps'],
    params: { kind: 'single', rows: [{ label: 'baseline', values: {}, intent: 'baseline' }] },
    provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
    policyOverride: null,
    tags: [],
  };
}

async function adoptCase(h: KernelHandle, projectId: number, draft: TestCaseDraft): Promise<TestCaseRecord> {
  const proposed = await h.kernel.call('case:propose', { projectId, proposedBy: 'test', draft });
  return h.kernel.call('case:review', { projectId, caseId: proposed.id, action: 'adopt', actor: 'kel' });
}

const POLICY: RunPolicy = defaultRunPolicy();

describe('UI 族编译器校验', () => {
  it('UI 用例编译：family=ui、同源校验', async () => {
    const h = testKernel();
    void h;
    const plan = await compilePlan({
      cases: [
        {
          id: 1, projectId: 1, name: 'ui-case', description: null, routeId: null, status: 'adopted', paramKind: 'single',
          steps: [
            { id: 's0', seq: 0, kind: 'ui_navigate', config: { url: '/login' } },
            { id: 's1', seq: 1, kind: 'ui_see', config: { contains: '登录' } },
          ],
          params: { kind: 'single', rows: [{ label: 'baseline', values: {}, intent: 'baseline' }] },
          provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
          policyOverride: null, tags: [], proposedBy: 't', reviewedBy: 'k', reviewedAtMs: 1, diff: null, createdAtMs: 0,
        } as TestCaseRecord,
      ],
      env: ENV,
      policy: POLICY,
      seed: 1,
      nowMs: 0,
    });
    expect(plan.entries[0]!.family).toBe('ui');
    h.dispose();
  });

  it('拒绝：导航 URL 在 env 域外；HTTP 与 UI 混用', async () => {
    const h = testKernel();
    void h;
    const base = {
      id: 1, projectId: 1, name: 'c', description: null, routeId: null, status: 'adopted' as const, paramKind: 'single' as const,
      params: { kind: 'single' as const, rows: [{ label: 'baseline', values: {}, intent: 'baseline' as const }] },
      provenance: { principles: [], samples: [], agentSession: null, agentTurn: null },
      policyOverride: null, tags: [], proposedBy: 't', reviewedBy: 'k', reviewedAtMs: 1, diff: null, createdAtMs: 0,
    };
    await expect(
      compilePlan({
        cases: [{ ...base, steps: [{ id: 's0', seq: 0, kind: 'ui_navigate', config: { url: 'http://evil.example.com/' } }] }] as TestCaseRecord[],
        env: ENV, policy: POLICY, seed: 1, nowMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'url_outside_env' });

    await expect(
      compilePlan({
        cases: [{
          ...base,
          steps: [
            { id: 's0', seq: 0, kind: 'request', config: { method: 'GET', url: '/api' } },
            { id: 's1', seq: 1, kind: 'ui_click', config: { selector: 'button' } },
          ],
        }] as TestCaseRecord[],
        env: ENV, policy: POLICY, seed: 1, nowMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'step_invalid' });
    h.dispose();
  });
});

describe('UI runner（脚本驱动）', () => {
  it('全流程：navigate→fill→click→see 通过；事件与判定正确；screenshot 落 artifact', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'web', sourceType: 'local' });
    const env = await h.kernel.call('env:create', { projectId: project.id, name: ENV.name, baseUrl: ENV.baseUrl });
    const driver = new ScriptedDriver({ 'h1': '欢迎回来, admin' });
    const factory = new ScriptedFactory(() => driver);

    const c = await adoptCase(h, project.id, uiDraft('登录成功', [
      { kind: 'ui_navigate', config: { url: '/login' } },
      { kind: 'ui_fill', config: { selector: 'input[name="username"]', text: 'admin' } },
      { kind: 'ui_click', config: { selector: 'button[type=submit]' } },
      { kind: 'ui_see', config: { selector: 'h1', contains: '欢迎回来' } },
      { kind: 'ui_screenshot', config: { name: 'after' } },
    ]));

    const plan = await compilePlan({ cases: [c], env, policy: POLICY, seed: 1, nowMs: 0 });
    const { runId } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy: POLICY, seed: 1, plan });
    await executePlan({ kernel: h.kernel, projectId: project.id, runId, plan, env, uiDriver: factory });
    await h.kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });

    const results = await h.kernel.call('run:results', { projectId: project.id, runId });
    expect(results.entries[0]!.verdict).toBe('passed');
    expect(results.steps.map((s) => s.kind)).toEqual(['ui_navigate', 'ui_fill', 'ui_click', 'ui_see', 'ui_screenshot']);

    // 截图 → artifact（内容寻址）
    const shotStep = results.steps.find((s) => s.kind === 'ui_screenshot')!;
    expect(shotStep.responseRef).toMatch(/^[0-9a-f]{64}$/);
    const art = await h.kernel.call('artifact:get', { sha256: shotStep.responseRef! });
    expect(art.contentBase64).toBe(Buffer.from('fake-png-bytes').toString('base64'));

    // 事件流：ui_action + assert_evaluated
    const events = await h.kernel.call('run:events', { projectId: project.id, runId });
    const actions = events.filter((e) => e.kind === 'ui_action');
    expect(actions.length).toBeGreaterThanOrEqual(4);
    const assertEv = events.find((e) => e.kind === 'assert_evaluated') as { passed: boolean; expected: string } | undefined;
    expect(assertEv?.passed).toBe(true);
    expect(assertEv?.expected).toBe('欢迎回来');
    h.dispose();
  });

  it('ui_see 失败 → failed（断言语义，不是 errored）；元素不存在同样失败', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'web', sourceType: 'local' });
    const env = await h.kernel.call('env:create', { projectId: project.id, name: 'web', baseUrl: ENV.baseUrl });
    const factory = new ScriptedFactory(() => new ScriptedDriver({ 'h1': '错误页' }));

    const c = await adoptCase(h, project.id, uiDraft('见失败', [
      { kind: 'ui_navigate', config: { url: '/' } },
      { kind: 'ui_see', config: { selector: 'h1', contains: '欢迎回来', severity: 'critical' } },
    ]));
    const plan = await compilePlan({ cases: [c], env, policy: POLICY, seed: 1, nowMs: 0 });
    const { runId } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy: POLICY, seed: 1, plan });
    await executePlan({ kernel: h.kernel, projectId: project.id, runId, plan, env, uiDriver: factory });
    await h.kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });

    const results = await h.kernel.call('run:results', { projectId: project.id, runId });
    expect(results.entries[0]!.verdict).toBe('failed');
    expect(results.asserts[0]).toMatchObject({ passed: false, expected: '欢迎回来', severity: 'critical' });
    h.dispose();
  });

  it('选择器超时 → errored(ui_selector_not_found)；无驱动 → errored(ui_driver_unavailable)', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'web', sourceType: 'local' });
    const env = await h.kernel.call('env:create', { projectId: project.id, name: 'web', baseUrl: ENV.baseUrl });

    const hangCase = await adoptCase(h, project.id, uiDraft('等待超时', [
      { kind: 'ui_navigate', config: { url: '/' } },
      { kind: 'ui_wait_for', config: { selector: '.never-appears', timeoutMs: 50 } },
    ]));
    const plan = await compilePlan({ cases: [hangCase], env, policy: POLICY, seed: 1, nowMs: 0 });
    const { runId } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy: POLICY, seed: 1, plan });
    await executePlan({ kernel: h.kernel, projectId: project.id, runId, plan, env, uiDriver: new ScriptedFactory(() => new ScriptedDriver({}, new Set(['.never-appears']))) });
    await h.kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });
    const results = await h.kernel.call('run:results', { projectId: project.id, runId });
    expect(results.entries[0]!.verdict).toBe('errored');
    const events = await h.kernel.call('run:events', { projectId: project.id, runId });
    expect((events.find((e) => e.kind === 'step_errored') as { reason?: string } | undefined)?.reason).toBe('ui_selector_not_found');

    // 无驱动：UI 用例 errored（诚实拒绝），同 run 不影响其它（这里只有 UI 用例）
    const c2 = await adoptCase(h, project.id, uiDraft('无驱动', [{ kind: 'ui_navigate', config: { url: '/' } }]));
    const plan2 = await compilePlan({ cases: [c2], env, policy: POLICY, seed: 1, nowMs: 0 });
    const { runId: runId2 } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy: POLICY, seed: 1, plan: plan2 });
    await executePlan({ kernel: h.kernel, projectId: project.id, runId: runId2, plan: plan2, env }); // 不传 uiDriver
    await h.kernel.call('run:finish', { projectId: project.id, runId: runId2, status: 'completed' });
    const results2 = await h.kernel.call('run:results', { projectId: project.id, runId: runId2 });
    expect(results2.entries[0]!.verdict).toBe('errored');
    const events2 = await h.kernel.call('run:events', { projectId: project.id, runId: runId2 });
    expect((events2.find((e) => e.kind === 'step_errored') as { reason?: string } | undefined)?.reason).toBe('ui_driver_unavailable');
    h.dispose();
  });
});

/* ─────────────── 真浏览器集成（channel=系统 Chrome；不可用则跳过） ─────────────── */

let server: Server;
let realPort = 0;
let browserAvailable = false;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      <h1>deepAutoTest UI 测试页</h1>
      <form onsubmit="event.preventDefault(); document.getElementById('out').textContent='欢迎回来, ' + document.getElementById('u').value;">
        <input id="u" name="username"/><input id="p" type="password"/>
        <button type="submit">登录</button>
      </form>
      <div id="out"></div>
    </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  realPort = (server.address() as { port: number }).port;
  const factory = new PlaywrightUiDriverFactory();
  browserAvailable = factory.available();
  if (browserAvailable) {
    try {
      const d = await factory.create();
      await d.close();
    } catch {
      browserAvailable = false;
    }
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('UI runner（真浏览器，channel=' + browserChannel() + '）', () => {
  it('真实页面：填写 → 提交 → 应看到（不可用则跳过）', async () => {
    if (!browserAvailable) {
      console.warn('跳过：系统 Chrome / playwright-core 不可用');
      return;
    }
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'real', sourceType: 'local' });
    const env = await h.kernel.call('env:create', { projectId: project.id, name: 'local', baseUrl: `http://127.0.0.1:${realPort}` });
    const c = await adoptCase(h, project.id, uiDraft('真实登录', [
      { kind: 'ui_navigate', config: { url: '/' } },
      { kind: 'ui_fill', config: { selector: '#u', text: 'alice' } },
      { kind: 'ui_fill', config: { selector: '#p', text: 'pw' } },
      { kind: 'ui_click', config: { selector: 'button[type=submit]' } },
      { kind: 'ui_see', config: { selector: '#out', contains: '欢迎回来, alice' } },
      { kind: 'ui_screenshot', config: { name: 'real' } },
    ]));
    const plan = await compilePlan({ cases: [c], env, policy: POLICY, seed: 1, nowMs: 0 });
    const { runId } = await h.kernel.call('run:begin', { projectId: project.id, envId: env.id, policy: POLICY, seed: 1, plan });
    await executePlan({ kernel: h.kernel, projectId: project.id, runId, plan, env, uiDriver: new PlaywrightUiDriverFactory() });
    await h.kernel.call('run:finish', { projectId: project.id, runId, status: 'completed' });

    const results = await h.kernel.call('run:results', { projectId: project.id, runId });
    expect(results.entries[0]!.verdict).toBe('passed');

    const shot = results.steps.find((s) => s.kind === 'ui_screenshot')!;
    const art = await h.kernel.call('artifact:get', { sha256: shot.responseRef! });
    expect(Buffer.from(art.contentBase64, 'base64').length).toBeGreaterThan(1000); // 真截图
    h.dispose();
  });
});
