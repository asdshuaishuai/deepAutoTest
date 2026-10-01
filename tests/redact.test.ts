/**
 * 写时脱敏：落库前掩码。断言"库内搜索明文 = 0 命中"。
 */

import { describe, expect, it } from 'vitest';
import { redactDeep, redactString } from '../src/kernel/domain/redact.ts';
import { beginRun, setupProject } from './helpers.ts';

describe('脱敏规则', () => {
  it('手机号保留前3后4', () => {
    expect(redactString('用户手机 13812345678 已注册')).toBe('用户手机 138****5678 已注册');
  });

  it('邮箱保留首字符与域', () => {
    expect(redactString('contact zhang.san@example.com for info')).toBe('contact z***@example.com for info');
  });

  it('身份证与银行卡（长 ID 优先）', () => {
    expect(redactString('id=11010119900307891X')).toBe('id=110***********891X');
    expect(redactString('card 6222020200112233445')).toBe('card 6222***********3445');
  });

  it('凭据类字段名 → 占位符（不泄露长度之外的信息）', () => {
    const out = redactDeep({ headers: { authorization: 'Bearer eyJhbGciOi...' }, apiToken: 'sk-1234567890' });
    expect(out.headers!.authorization).toMatch(/^<redacted, \d+ bytes>$/);
    expect(out.apiToken).toMatch(/^<redacted, \d+ bytes>$/);
  });

  it('不改输入（返回新对象）', () => {
    const input = { note: '电话 13812345678' };
    redactDeep(input);
    expect(input.note).toBe('电话 13812345678');
  });
});

describe('写时脱敏（落库路径）', () => {
  it('note 与 var_extracted 落库后无明文手机号', async () => {
    const s = await setupProject(1);
    const runId = await beginRun(s);

    await s.kernel.call('run:note', { projectId: s.projectId, runId, text: '复现时用的手机号 13812345678，邮箱 a.b@test.cn', by: 'kel' });
    await s.kernel.call('run:appendEvents', {
      projectId: s.projectId,
      runId,
      events: [{ kind: 'var_extracted', entryId: null, name: 'ownerPhone', value: '13998765432' }],
    });

    const raw = s.kernel.db.prepare('SELECT payload FROM run_event WHERE run_id = ?').all(runId) as { payload: string }[];
    const allPayload = raw.map((r) => r.payload).join('\n');
    expect(allPayload).not.toContain('13812345678');
    expect(allPayload).not.toContain('13998765432');
    expect(allPayload).not.toContain('a.b@test.cn');
    expect(allPayload).toContain('138****5678');
    expect(allPayload).toContain('139****5432');
    expect(allPayload).toContain('a***@test.cn');
    s.kernel.close();
  });
});
