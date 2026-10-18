import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // 与 electron.vite.config.ts 的 renderer 别名保持一致：单测要走真实的子模块代码
      '@webhid-kit': path.resolve(__dirname, 'third_party/web_hid_utils/packages/webhid-kit/src/index.js'),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/unit/**/*.test.ts'],
    reporters: 'default',
  },
});
