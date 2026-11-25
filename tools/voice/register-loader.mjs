/**
 * 注册 ESM 解析钩子（`tsloader.mjs`），供 Node 直接 import 本仓的 `.ts` 源码。
 *
 * 用法（所有消费 `.ts` 的 Node 脚本都走这一行）：
 *
 *   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *        --import ./tools/voice/register-loader.mjs <script>
 *
 * 不给根 `package.json` 加 `type: module`：那会让 electron-vite 把 preload 输出成 `.mjs`，
 * 而主进程仍按 `.js` 引用（AGENTS.md 已知坑 11）。
 */

import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

register('./tsloader.mjs', import.meta.url);

export const TSLOADER_PATH = fileURLToPath(new URL('./tsloader.mjs', import.meta.url));
