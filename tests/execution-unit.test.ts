/**
 * 执行层单元测试：urlguard / 模板 / 断言求值 / 沙箱。
 */

import { describe, expect, it } from 'vitest';
import { checkUrl, privateRange } from '../src/execution/urlguard.ts';
import { parseRefs, resolveTemplate, validateRefs } from '../src/execution/template.ts';
import { evaluateAssert, jsonPath } from '../src/execution/evaluate.ts';
import { runScript } from '../src/execution/sandbox.ts';

describe('urlguard（08 §2 分档）', () => {
  it('strict：拒绝环回 / 私有 / 链路本地（云元数据）/ 保留网段', () => {
    expect(privateRange('127.0.0.1')).toBe('loopback');
    expect(privateRange('10.1.2.3')).toBe('private');
    expect(privateRange('192.168.1.1')).toBe('private');
    expect(privateRange('172.16.0.5')).toBe('private');
    expect(privateRange('169.254.169.254')).toBe('link_local'); // ★ 云元数据
    expect(privateRange('0.0.0.1')).toBe('reserved');
    expect(privateRange('224.0.0.1')).toBe('reserved');
    expect(privateRange('::1')).toBe('loopback');
    expect(privateRange('fd00::1')).toBe('unique_local');
    expect(privateRange('8.8.8.8')).toBeNull();
    expect(privateRange('1.1.1.1')).toBeNull();
  });

  it('strict：拒绝非 http 协议', async () => {
    expect((await checkUrl('file:///etc/passwd', 'strict')).reason).toBe('protocol_denied');
    expect((await checkUrl('ftp://x', 'strict')).reason).toBe('protocol_denied');
  });

  it('strict：公网域名通过；localhost 域名解析后被拒（逐 IP 校验）', async () => {
    expect((await checkUrl('http://localhost/x', 'strict')).ok).toBe(false);
    expect((await checkUrl('http://127.0.0.1:3000/x', 'strict')).reason).toBe('loopback');
  });

  it('permissive：环回允许（产品定位就是测内网）', async () => {
    expect((await checkUrl('http://127.0.0.1:3000/api', 'permissive')).ok).toBe(true);
    expect((await checkUrl('http://192.168.1.10:8080/', 'permissive')).ok).toBe(true);
    expect((await checkUrl('gopher://x', 'permissive')).reason).toBe('protocol_denied'); // 宽松≠不校验协议
  });
});

describe('模板（03 §3.4）', () => {
  it('解析四类引用', () => {
    expect(parseRefs('{{env.baseUrl}}/orders/{{param.id}}')).toEqual([
      { ns: 'env', name: 'baseUrl' },
      { ns: 'param', name: 'id' },
    ]);
    expect(parseRefs('{{var.x}} {{secret.token}}')).toEqual([
      { ns: 'var', name: 'x' },
      { ns: 'secret', name: 'token' },
    ]);
  });

  it('运行期解析', () => {
    const out = resolveTemplate('{{env.h}}/o/{{param.id}}?t={{secret.k}}&v={{var.v}}', {
      env: { h: 'http://a' },
      vars: { v: '7' },
      secrets: { k: 'sk' },
      params: { id: 3 },
    });
    expect(out).toBe('http://a/o/3?t=sk&v=7');
  });

  it('未定义引用抛错（不发空值请求）', () => {
    expect(() => resolveTemplate('{{env.missing}}', { env: {}, vars: {}, secrets: {}, params: {} })).toThrowError(
      /template_undefined|未定义/,
    );
  });

  it('编译期校验：var 必须由更早的 extract 定义', () => {
    const known = { envKeys: new Set(['h']), secretKeys: new Set<string>(), paramKeys: new Set(['id']), definedVars: new Set(['earlier']) };
    expect(() => validateRefs('{{var.later}}', known, 'x')).toThrowError(/var.later/);
    expect(() => validateRefs('{{env.h}}/{{param.id}}/{{var.earlier}}', known, 'x')).not.toThrow();
  });
});

describe('断言求值', () => {
  it('jsonPath：嵌套与数组下标', () => {
    const body = { data: { items: [{ id: 7 }, { id: 8 }], total: '2' } };
    expect(jsonPath(body, 'data.items[1].id')).toBe(8);
    expect(jsonPath(body, 'data.total')).toBe('2');
    expect(jsonPath(body, 'data.nope.deep')).toBeUndefined();
  });

  it('比较操作（数值优先，字符串兜底）', () => {
    expect(evaluateAssert('eq', '200', 200, true).passed).toBe(true);
    expect(evaluateAssert('eq', 'abc', 'abd', true).passed).toBe(false);
    expect(evaluateAssert('gte', '50000', '50001', true).passed).toBe(true);
    expect(evaluateAssert('lt', '5', 4, true).passed).toBe(true);
    expect(evaluateAssert('contains', 'dup', 'duplicate-key', true).passed).toBe(true);
    expect(evaluateAssert('matches', '^AMOUNT_', 'AMOUNT_EXCEEDED', true).passed).toBe(true);
  });

  it('exists / type_is', () => {
    expect(evaluateAssert('exists', undefined, 42, true).passed).toBe(true);
    expect(evaluateAssert('exists', undefined, undefined, false).passed).toBe(false);
    expect(evaluateAssert('type_is', 'array', [1, 2], true).passed).toBe(true);
    expect(evaluateAssert('type_is', 'null', null, true).passed).toBe(true);
  });
});

describe('script 沙箱（08 §6）', () => {
  it('可读 response/vars 并做纯计算', () => {
    const out = runScript('return response.status === 200 && vars.orderId === "o1"', {
      response: { status: 200, headers: {}, body: null, bodyText: '', durationMs: 5 },
      vars: { orderId: 'o1' },
    }, 1000);
    expect(out).toEqual({ ok: true, returned: true });
  });

  it('死循环被超时强杀 → script_timeout', () => {
    const out = runScript('while (true) {}', {
      response: { status: 0, headers: {}, body: null, bodyText: '', durationMs: 0 },
      vars: {},
    }, 100);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('script_timeout');
  });

  it('无 require / process（防误用，不是安全边界）', () => {
    const out = runScript('return typeof require', {
      response: { status: 0, headers: {}, body: null, bodyText: '', durationMs: 0 },
      vars: {},
    }, 1000);
    expect(out).toEqual({ ok: true, returned: 'undefined' });
    const out2 = runScript('return typeof process', {
      response: { status: 0, headers: {}, body: null, bodyText: '', durationMs: 0 },
      vars: {},
    }, 1000);
    expect(out2).toEqual({ ok: true, returned: 'undefined' });
  });

  it('异常 → script_error（判 errored 而非 failed）', () => {
    const out = runScript('throw new Error("boom")', {
      response: { status: 0, headers: {}, body: null, bodyText: '', durationMs: 0 },
      vars: {},
    }, 1000);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('script_error');
      expect(out.detail).toContain('boom');
    }
  });
});
