import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // node:sqlite 触发 experimental 警告，测试输出保持干净
    onConsoleLog(log) {
      if (log.includes('SQLite is an experimental feature')) return false;
      return undefined;
    },
  },
});
