/**
 * 执行器侧 turn 日志（Alpha v1.3.0 / SubStage 4.2 §4.4）。
 *
 * **分工**（§4.4 明文，别搞混两个文件）：
 *
 * | 文件 | 谁写 | 作用 |
 * |---|---|---|
 * | `artifacts/voice/exec/exec-<ts>.jsonl` | 本模块（执行器） | 执行侧自查：这一轮写了什么、回读对不对 |
 * | `artifacts/voice/turn-<ts>.jsonl` | SubStage 4.3 的 `pipeline.py` | 设计文档 §3.10 的"每轮一行"，只有它能拿到唤醒/ASR/TTS 耗时 |
 *
 * 两个文件**不许共用命名**：同名两处写会让"这行是谁写的"无法回答。本模块因此固定
 * `exec-` 前缀 + `exec/` 子目录，字段仍按 §3.10 的键给全（缺的由调用方显式给 `null`）。
 *
 * 写盘失败**不吞也不影响业务**：本模块照常抛，由调用方（执行器）打 warn 后继续——
 * "日志不是业务"这条要求落在调用方，落在本模块会让磁盘满时静默丢证据。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** 设计文档 §3.10 的固定键（缺一个都会让 4.3 / 5.3 的取证对不齐） */
export const TURN_LOG_KEYS = Object.freeze([
  'turn',
  'ts',
  'wake_ms',
  'audio_ms',
  'asr_ms',
  'route',
  'llm_ms',
  'apply_ms',
  'tts_ms',
  'text',
  'norm_text',
  'plan',
  'command',
  'readback_ok',
  'mismatch',
  'sink',
  'mem_mb',
]);

/** 默认目录：执行器侧记录（**不是** §3.10 的 `artifacts/voice/` 根） */
export const DEFAULT_TURN_LOG_DIR = 'artifacts/voice/exec';

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

/** `yyyyMMdd-HHmmss-SSS`（本地时间：取证时与人工观察的时钟一致，不换算时区） */
export function stampOf(date = new Date()) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `-${pad(date.getMilliseconds(), 3)}`
  );
}

/** 带本地时区偏移的 ISO 时间戳（`2026-11-24T10:31:02.117+08:00`，与 §3.10 的样例同形） */
export function localIsoNow(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 把调用方给的记录补齐成 §3.10 的键集合：缺的补 `null`，多的原样保留 */
export function normalizeTurn(record) {
  const source = record && typeof record === 'object' ? record : {};
  const out = {};
  for (const key of TURN_LOG_KEYS) {
    out[key] = Object.prototype.hasOwnProperty.call(source, key) ? source[key] ?? null : null;
  }
  for (const [key, value] of Object.entries(source)) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value ?? null;
  }
  if (out.ts === null) out.ts = localIsoNow();
  return out;
}

/**
 * 追加一行 turn 记录，返回写出的文件路径。
 *
 * 每次调用按当时的毫秒时间戳起名；同一毫秒内的两次调用会落到同一个文件里各一行
 * （`appendFileSync` 追加，不覆盖）。
 */
export function appendTurn(record, dir = DEFAULT_TURN_LOG_DIR) {
  const target = path.resolve(dir);
  mkdirSync(target, { recursive: true });
  const file = path.join(target, `exec-${stampOf()}.jsonl`);
  appendFileSync(file, `${JSON.stringify(normalizeTurn(record))}\n`, { encoding: 'utf8' });
  return file;
}
