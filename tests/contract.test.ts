/**
 * Kernel 契约：方法白名单、错误形状、确定性调用。
 */

import { describe, expect, it } from 'vitest';
import { testKernel } from './helpers.ts';

describe('Kernel 入口', () => {
  it('未知方法被拒绝（RPC 白名单）', async () => {
    const h = testKernel();
    await expect(h.kernel.call('shell:rm' as never, {} as never)).rejects.toMatchObject({ code: 'unknown_method' });
    h.dispose();
  });

  it('app:ping 返回版本', async () => {
    const h = testKernel();
    const res = await h.kernel.call('app:ping', {});
    expect(res.pong).toBe(true);
    expect(res.version).toBeTruthy();
    h.dispose();
  });

  it('入参形状校验（运行时，不是类型断言）', async () => {
    const h = testKernel();
    await expect(h.kernel.call('project:create', { name: '', sourceType: 'local' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(h.kernel.call('project:create', { name: 'x', sourceType: 'ftp' } as never)).rejects.toMatchObject({ code: 'invalid_params' });
    h.dispose();
  });

  it('不存在的项目 → not_found（scope 铸造失败）', async () => {
    const h = testKernel();
    await expect(h.kernel.call('env:list', { projectId: 999 })).rejects.toMatchObject({ code: 'not_found' });
    h.dispose();
  });
});
