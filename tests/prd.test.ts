/**
 * PRD → 用例（解析 / 约束 → value_json / 合成 / 幂等 / P3）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConstraints, parsePrdMarkdown } from '../src/prd/parse.ts';
import { synthesizeFromPrd } from '../src/prd/synth.ts';
import { indexPrd } from '../src/prd/index.ts';
import { testKernel } from './helpers.ts';

const SAMPLE_PRD = `# 订单服务 PRD

## 下单

接口: POST /orders

| 字段 | 类型 | 约束 |
|------|------|------|
| amount | 整数 | 0 ≤ amount ≤ 50000 |
| channel | 枚举 | 枚举：APP、H5、MINI |
| phone | 手机号 | 必填，唯一 |

## 登录流程（UI）

### 管理员登录成功
- 打开 /login
- 填写 input[name="username"] = "admin"
- 填写 input[name="password"] = "secret123"
- 点击 button[type=submit]
- 应看到 "欢迎回来"
- 截图 after-login

## 其他

- 作为普通用户，我希望快速下单，以便节省时间
- 界面应该美观易用
`;

describe('PRD 约束解析（与原则 value_json 同构）', () => {
  it('区间式：0 ≤ amount ≤ 50000 → min/max', () => {
    expect(parseConstraints('0 ≤ amount ≤ 50000', '整数')).toEqual({ type: 'number', min: 0, max: 50000 });
  });

  it('上/下界：≤50000 / ≥18', () => {
    expect(parseConstraints('不超过 50000', '整数')).toMatchObject({ type: 'number', max: 50000 });
    expect(parseConstraints('至少 18', '整数')).toMatchObject({ type: 'number', min: 18 });
  });

  it('长度：长度 1-200', () => {
    expect(parseConstraints('长度 1-200', '字符串')).toEqual({ type: 'string', minLength: 1, maxLength: 200 });
  });

  it('枚举：枚举：APP、H5、MINI', () => {
    expect(parseConstraints('枚举：APP、H5、MINI', '枚举')).toEqual({ type: 'enum', enum: ['APP', 'H5', 'MINI'] });
  });

  it('手机号 → 可逆向正则', () => {
    expect(parseConstraints('必填，唯一', '手机号')).toMatchObject({ type: 'string', pattern: '/^1[3-9]\\d{9}$/', unique: true });
  });
});

describe('PRD markdown 解析', () => {
  it('字段表带段内接口；UI 流协议行映射为步骤；prose 上报 skipped', () => {
    const parsed = parsePrdMarkdown(SAMPLE_PRD, 'order.md');

    expect(parsed.fields).toHaveLength(3);
    expect(parsed.fields[0]).toMatchObject({ field: 'amount', section: '下单', line: 9, api: { method: 'POST', path: '/orders' } });
    expect(parsed.fields[0]!.valueJson).toEqual({ type: 'number', min: 0, max: 50000 });

    expect(parsed.uiFlows).toHaveLength(1);
    const flow = parsed.uiFlows[0]!;
    expect(flow.title).toBe('管理员登录成功');
    expect(flow.steps.map((s) => s.kind)).toEqual(['ui_navigate', 'ui_fill', 'ui_fill', 'ui_click', 'ui_see', 'ui_screenshot']);
    expect(flow.steps[1]!.config).toEqual({ selector: 'input[name="username"]', text: 'admin' });
    expect(flow.steps[4]!.config).toEqual({ contains: '欢迎回来' });
    expect(flow.steps[5]!.config).toEqual({ name: 'after-login' });

    expect(parsed.stories).toHaveLength(1);
    expect(parsed.skipped.length).toBeGreaterThanOrEqual(2);
    expect(parsed.skipped.some((s) => s.reason.includes('Agent'))).toBe(true);
  });
});

describe('PRD 合成', () => {
  it('字段 → 应通过/应拒绝用例（溯源 PRD file:line）；UI 流 → UI 族用例', () => {
    const parsed = parsePrdMarkdown(SAMPLE_PRD, 'order.md');
    const { cases, fieldSkips } = synthesizeFromPrd(parsed);

    // amount(2) + channel(2) + phone(2) + UI 流(1)
    expect(cases).toHaveLength(7);
    expect(fieldSkips).toEqual([]);

    const amountReject = cases.find((c) => c.name.includes('amount') && c.name.includes('应拒绝'))!;
    expect(amountReject.steps[0]!.config).toMatchObject({ method: 'POST', url: '/orders', body: '{"amount":{{param.amount}}}' });
    expect(amountReject.steps[1]!.config).toMatchObject({ op: 'gte', expected: '400', severity: 'critical', sourceFile: 'order.md', sourceLine: 9 });
    expect(amountReject.params.rows.map((r) => Object.values(r.values)[0])).toEqual([50001, -1]); // 上界超限 + 下界违反
    expect(amountReject.provenance.prd).toEqual([{ file: 'order.md', line: 9, requirement: expect.stringContaining('amount') }]);
    expect(amountReject.tags).toContain('prd');

    const uiCase = cases.find((c) => c.name.startsWith('[UI]'))!;
    expect(uiCase.steps.map((s) => s.kind)).toEqual(['ui_navigate', 'ui_fill', 'ui_fill', 'ui_click', 'ui_see', 'ui_screenshot']);
    expect(uiCase.provenance.prd![0]).toMatchObject({ file: 'order.md', requirement: '管理员登录成功' });
  });
});

describe('PRD 索引编排（kernel 侧）', () => {
  it('proposed 落库；幂等重跑零重复；P3 门', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'order', sourceType: 'local' });
    const prdDir = join(tmpdir(), `dat-prd-${Math.random().toString(36).slice(2)}`);
    mkdirSync(prdDir, { recursive: true });
    writeFileSync(join(prdDir, 'order.md'), SAMPLE_PRD);

    const first = await indexPrd(h.kernel, project.id, prdDir);
    expect(first.casesInserted).toBe(7);
    expect(first.uiFlowCount).toBe(1);

    const second = await indexPrd(h.kernel, project.id, prdDir);
    expect(second.casesInserted).toBe(0);
    expect(second.casesSkippedExisting).toBe(7);

    const cases = await h.kernel.call('case:list', { projectId: project.id });
    expect(cases).toHaveLength(7);
    expect(cases.every((c) => c.status === 'proposed')).toBe(true);

    // 跨项目隔离（P5）
    const other = await h.kernel.call('project:create', { name: 'other', sourceType: 'local' });
    expect(await h.kernel.call('case:list', { projectId: other.id })).toEqual([]);

    // 人机门：采纳后可编译执行路径存在（编译器测试覆盖执行；这里只验采纳）
    const adopted = await h.kernel.call('case:review', { projectId: project.id, caseId: cases[0]!.id, action: 'adopt', actor: 'kel' });
    expect(adopted.status).toBe('adopted');
    h.dispose();
  });

  it('缺接口声明的字段表 → 上报 skipped，不产生用例', async () => {
    const parsed = parsePrdMarkdown(
      `## 设置\n\n| 字段 | 类型 | 约束 |\n|---|---|---|\n| nickname | 字符串 | 长度 2-20 |\n`,
      'x.md',
    );
    const { cases } = synthesizeFromPrd(parsed);
    expect(cases).toEqual([]);
  });
});
