/**
 * holdout 读取与"固定顺序"选择（SubStage 5.3 §4.2 ④：`--limit` 取固定前 N 条，**不得随机**）。
 *
 * 三档不能比的根因只有两个：换了条数、换了顺序。这里把两件事都压成纯函数，
 * `run.mjs` 只负责把 `slice(0, limit)` 的结果喂给评测，不自己再排一次序。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VOICE_DIR = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(VOICE_DIR, '..', '..');
export const DEFAULT_HOLDOUT = path.join(VOICE_DIR, 'data', 'holdout.jsonl');

/** §5：holdout 条数 < 100 → 退出码 2（数据不对） */
export const MIN_HOLDOUT_ROWS = 100;

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** 逐行解析 holdout（空行跳过；坏行直接报错——静默跳过会让"跑 500 条"变成跑 499 条） */
export function parseHoldout(text, source = '<memory>') {
  const rows = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`${source}:${index + 1} 不是合法 JSON：${error.message}`);
    }
    if (!row || typeof row !== 'object') throw new Error(`${source}:${index + 1} 不是对象`);
    if (typeof row.id !== 'string' || !row.id) throw new Error(`${source}:${index + 1} 缺 id`);
    if (typeof row.text !== 'string' || !row.text.trim()) throw new Error(`${source}:${index + 1} 缺 text`);
    if (!row.plan || typeof row.plan !== 'object') throw new Error(`${source}:${index + 1} 缺 plan`);
    rows.push(row);
  });
  return rows;
}

/**
 * 读 holdout 并取固定前 `limit` 条。
 *
 * 返回 `{rows, all, limit, sha256, path, count, kbKeys}`；`sha256` 是**文件**的哈希，
 * `compare.mjs` 用它判断三档是不是跑的同一份数据。
 */
export function loadHoldout({ file = DEFAULT_HOLDOUT, limit = null } = {}) {
  if (!fs.existsSync(file)) throw new Error(`找不到 holdout：${file}`);
  const text = fs.readFileSync(file, 'utf8');
  const all = parseHoldout(text, file);
  if (all.length < MIN_HOLDOUT_ROWS) {
    const error = new Error(`holdout 只有 ${all.length} 条（< ${MIN_HOLDOUT_ROWS}，数据不对）`);
    error.code = 'E_HOLDOUT_TOO_SMALL';
    throw error;
  }
  const take = limit === null || limit === undefined ? all.length : Math.max(0, Math.trunc(limit));
  const rows = all.slice(0, Math.min(take, all.length));
  return {
    rows,
    all,
    limit: take,
    count: all.length,
    path: file,
    sha256: sha256(text),
    kbKeys: [...new Set(all.map((row) => row.kb ?? ''))].filter(Boolean).sort(),
  };
}

/**
 * 音频级用例的挑选（§4.4：30 条，覆盖尽量多的类别，**确定**，不用随机）。
 *
 * 规则：按 `kb` 分组 → 组间轮转（先每组一条，再补第二条…）→ 组内按 (文本长度, id) 升序。
 * 短句优先只是因为 TTS+ASR 的合成误差随句子变长单调变差，与"挑好答的题"无关：
 * 每个组都会先被抽到一条，组内顺序也完全确定。
 */
export function pickAudioRows(rows, budget = 30) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.kb ?? 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const keys = [...groups.keys()].sort();
  for (const key of keys) {
    groups.get(key).sort((a, b) => (a.text.length - b.text.length) || a.id.localeCompare(b.id));
  }
  const picked = [];
  for (let round = 0; picked.length < budget; round += 1) {
    let added = 0;
    for (const key of keys) {
      if (picked.length >= budget) break;
      const items = groups.get(key);
      if (round < items.length) {
        picked.push(items[round]);
        added += 1;
      }
    }
    if (added === 0) break;
  }
  return picked;
}

/** holdout 的类别覆盖（`set:<param>` 归成 `set`，便于报告里写"覆盖 N 类"） */
export function categoryOf(kb) {
  const head = String(kb ?? '').split(':')[0];
  return head || 'unknown';
}

export function coverageOf(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = categoryOf(row.kb);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort());
}
