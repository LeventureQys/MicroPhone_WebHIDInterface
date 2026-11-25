/**
 * ESM 解析钩子：让 Node 直接 import 本仓的 `.ts` 源码。
 *
 * 为什么需要它：`src/renderer/src/**` 的 import 一律省略扩展名（`from '../device/registers'`），
 * 那是 vite / tsc 的写法；Node 的 ESM 解析器要求写全扩展名，`--experimental-strip-types`
 * 只负责剥类型、不改解析规则。所以缺扩展名的相对路径必须在解析阶段补回 `.ts`。
 *
 * 只处理相对路径；`node:*`、裸包名、已带扩展名的路径全部交回默认解析器，
 * 避免把宿主仓库的依赖解析规则改歪。
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 补全顺序：先 TS 再 JS，最后才试目录 index */
const SUFFIXES = ['.ts', '.mts', '.cts', '.mjs', '.js'];
const INDEX_SUFFIXES = ['.ts', '.mjs', '.js'];

function isRelative(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
}

function isFile(candidate) {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function candidatesFor(target) {
  const ext = path.extname(target);
  const out = [];
  // `import './x.js'` 指向源码 `./x.ts`（TS 的 NodeNext 写法）；文件不存在时才生效
  if (ext === '.js') out.push(`${target.slice(0, -ext.length)}.ts`);
  if (ext === '') {
    for (const suffix of SUFFIXES) out.push(`${target}${suffix}`);
    for (const suffix of INDEX_SUFFIXES) out.push(path.join(target, `index${suffix}`));
  }
  return out;
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!isRelative(specifier) || !context?.parentURL) throw error;
    let target;
    try {
      target = fileURLToPath(new URL(specifier, context.parentURL));
    } catch {
      throw error;
    }
    for (const candidate of candidatesFor(target)) {
      if (isFile(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  return nextLoad(url, context);
}
