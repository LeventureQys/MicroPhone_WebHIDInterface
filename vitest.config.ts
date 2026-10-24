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
    // 覆盖率只统计协议层与镜像层（R10-2 的原文）；UI 层不在门禁范围
    coverage: {
      provider: 'v8',
      all: false,
      include: [
        'src/renderer/src/device/proto/**/*.ts',
        'src/renderer/src/device/dfu/**/*.ts',
        'src/renderer/src/device/registers.ts',
      ],
      exclude: ['**/*.d.ts'],
      thresholds: { lines: 90, functions: 85, branches: 80, statements: 90 },
    },
  },
});
