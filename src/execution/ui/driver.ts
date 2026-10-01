/**
 * UI 驱动抽象 —— 执行层依赖的最小浏览器接口。
 *
 * 驱动实现是**可替换的**（与 HTTP runner 的 undici 同位）：
 *  - PlaywrightDriverFactory：playwright-core（optionalDependency），channel 走系统 Chrome，
 *    不捆绑浏览器——与「不捆绑 Chromium」的产品级决策一致
 *  - 测试/录制/未来其它驱动：实现同一接口即可
 *
 * 不可用时的纪律与 db_check 相同：诚实拒绝（ui_driver_unavailable），不静默跳过。
 * 每个 entry 独立 driver 实例（页面隔离：一个用例一个干净会话）。
 */

import { createRequire } from 'node:module';

export type UiWaitState = 'visible' | 'hidden';

/** ESM 下解析 optionalDependency 的唯一正道。 */
const require = createRequire(import.meta.url);

export interface UiDriver {
  goto(url: string, timeoutMs: number): Promise<void>;
  click(selector: string, timeoutMs: number): Promise<void>;
  fill(selector: string, text: string, timeoutMs: number): Promise<void>;
  press(key: string): Promise<void>;
  waitFor(selector: string, state: UiWaitState, timeoutMs: number): Promise<void>;
  /** 元素文本；元素不存在返回 null（由 ui_see 转为断言失败，不是错误）。 */
  textOf(selector: string, timeoutMs: number): Promise<string | null>;
  bodyText(): Promise<string>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

export interface UiDriverFactory {
  /** 驱动是否可用（依赖在位 + 浏览器可启动的快速判断）。 */
  available(): boolean;
  unavailableReason(): string;
  /** 创建一个隔离的驱动实例（新页面/新会话）。 */
  create(): Promise<UiDriver>;
}

/** 默认浏览器 channel：系统 Chrome（不捆绑）。可用环境变量 DAT_UI_BROWSER 覆盖。 */
export function browserChannel(): string {
  return process.env['DAT_UI_BROWSER'] ?? 'chrome';
}

export class PlaywrightUiDriverFactory implements UiDriverFactory {
  private reason: string | null = null;
  private module: typeof import('playwright-core') | null = null;

  available(): boolean {
    if (this.module !== null) return true;
    try {
      this.module = require('playwright-core') as typeof import('playwright-core');
      return true;
    } catch {
      this.reason = 'playwright-core 未安装（npm i playwright-core）';
      return false;
    }
  }

  unavailableReason(): string {
    return this.reason ?? '未知原因';
  }

  async create(): Promise<UiDriver> {
    const pw = this.module ?? (this.available() ? this.module! : (() => { throw new Error(this.unavailableReason()); })());
    let browser: import('playwright-core').Browser;
    try {
      browser = await pw.chromium.launch({ channel: browserChannel(), headless: true });
    } catch (err) {
      this.reason = `浏览器启动失败（channel=${browserChannel()}）：${String((err as Error).message).split('\n')[0]}`;
      throw err;
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    return new PlaywrightDriver(browser, context, page);
  }
}

class PlaywrightDriver implements UiDriver {
  private readonly browser: import('playwright-core').Browser;
  private readonly context: import('playwright-core').BrowserContext;
  private readonly page: import('playwright-core').Page;

  constructor(browser: import('playwright-core').Browser, context: import('playwright-core').BrowserContext, page: import('playwright-core').Page) {
    this.browser = browser;
    this.context = context;
    this.page = page;
  }

  async goto(url: string, timeoutMs: number): Promise<void> {
    await this.page.goto(url, { timeout: timeoutMs, waitUntil: 'load' });
  }
  async click(selector: string, timeoutMs: number): Promise<void> {
    await this.page.click(selector, { timeout: timeoutMs });
  }
  async fill(selector: string, text: string, timeoutMs: number): Promise<void> {
    await this.page.fill(selector, text, { timeout: timeoutMs });
  }
  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }
  async waitFor(selector: string, state: UiWaitState, timeoutMs: number): Promise<void> {
    await this.page.waitForSelector(selector, { state, timeout: timeoutMs });
  }
  async textOf(selector: string, timeoutMs: number): Promise<string | null> {
    try {
      return await this.page.locator(selector).innerText({ timeout: timeoutMs });
    } catch {
      return null;
    }
  }
  async bodyText(): Promise<string> {
    return this.page.locator('body').innerText();
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.from(await this.page.screenshot({ fullPage: false }));
  }
  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}
