import { defineConfig } from 'electron-vite';
import path from 'node:path';

// 产物路径由 electron-vite 固定为 out/main、out/preload、out/renderer，
// 不要在 build 里写 outDir：那是 vite 的字段，不在这三个端配置的类型里。
export default defineConfig({
  main: {
    build: { rollupOptions: { input: 'src/main/index.ts' } },
  },
  preload: {
    build: { rollupOptions: { input: 'src/preload/index.ts' } },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
        '@renderer': path.resolve(__dirname, 'src/renderer/src'),
        // 第三方 WebHID 套件（git submodule，原生 ESM，无构建步骤）；
        // vitest.config.ts 里必须配同一个别名，否则单测解析不到。
        '@webhid-kit': path.resolve(__dirname, 'third_party/web_hid_utils/packages/webhid-kit/src/index.js'),
      },
    },
    build: {
      rollupOptions: { input: path.resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
