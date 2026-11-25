/**
 * SubStage 5.3：报告落盘与终端摘要。
 *
 * 目录约定（`--out` 默认 `artifacts/voice`）：
 *
 * ```
 * <out>/eval-<tier>-<yyyyMMdd-HHmmss>.json   单档报告（**不覆盖**，§5）
 * <out>/latest/eval-<tier>.json              最近一次的副本，给 compare.mjs 找
 * <out>/eval-compare-<ts>.json               三档对照
 * <out>/eval-audio-<ts>.json                 音频级
 * ```
 */

import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './holdout.mjs';

export function latestDir(out) {
  return path.join(out, 'latest');
}

export function latestReportPath(out, name) {
  return path.join(latestDir(out), `eval-${name}.json`);
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

export function relative(file) {
  return path.relative(REPO_ROOT, file).replace(/\\/g, '/');
}

/** 单档报告：带时间戳的新文件 + `latest/` 指针（指针被覆盖是设计，报告本身不覆盖） */
export function writeTierReport(report, out) {
  const file = path.join(out, `eval-${report.tier}-${report.ts}.json`);
  writeJson(file, report);
  const latest = writeJson(latestReportPath(out, report.tier), { ...report, latestOf: path.basename(file) });
  return { report: file, latest };
}

export function writeCompareReport(report, out) {
  const file = path.join(out, `eval-compare-${report.ts}.json`);
  writeJson(file, report);
  const latest = writeJson(latestReportPath(out, 'compare'), { ...report, latestOf: path.basename(file) });
  return { report: file, latest };
}

export function writeAudioReport(report, out) {
  const file = path.join(out, `eval-audio-${report.ts}.json`);
  writeJson(file, report);
  const latest = writeJson(latestReportPath(out, 'audio'), { ...report, latestOf: path.basename(file) });
  return { report: file, latest };
}

/** 读 `latest/eval-<name>.json`；没有返回 `null`（compare.mjs 用它判断缺哪一档） */
export function readLatestReport(out, name) {
  const file = latestReportPath(out, name);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${relative(file)} 不是合法 JSON：${error.message}`);
  }
}

const COLUMNS = [
  ['samples', '样本', 0],
  ['validRate', 'validRate', 4],
  ['actionSetF1', 'F1', 4],
  ['precision', 'P', 4],
  ['recall', 'R', 4],
  ['strengthAcc', 'strengthAcc', 4],
  ['groundingAcc', 'groundingAcc', 4],
  ['refusalRecall', 'refusalRecall', 4],
  ['overRefusal', 'overRefusal', 4],
  ['p50Ms', 'P50ms', 1],
  ['p95Ms', 'P95ms', 1],
  ['errors', '崩溃/错', 0],
];

export function formatMetrics(metrics) {
  return COLUMNS.map(([key, label, digits]) => {
    const value = metrics?.[key];
    if (typeof value === 'number') return `${label}=${value.toFixed(digits)}`;
    return `${label}=${value ?? '-'}`;
  }).join(' ');
}

export function printTierSummary({ tier, mode, metrics, rows }) {
  const routes = {};
  for (const row of rows) {
    const key = row.route ?? (row.mode === 'llm' ? 'llm' : 'error');
    routes[key] = (routes[key] ?? 0) + 1;
  }
  const routeText = Object.entries(routes).map(([key, value]) => `${key}:${value}`).join(' ');
  console.log(`[eval] ${tier}/${mode}  ${formatMetrics(metrics)}`);
  console.log(`[eval] ${tier}/${mode}  route=${routeText || '(无)'}`);
  if (metrics.refusalSamples === 0) {
    console.log(
      `[eval] ${tier}/${mode}  refusalRecall 分母为 0（holdout 里没有 status=unsupported 的样本）→ 记 0，不可用于门禁`,
    );
  }
}

const TABLE_ALIASES = Object.freeze({ actionSetF1: 'f1' });

export function printMetricsTable(title, rows) {
  console.log(`\n${title}`);
  const header = ['tier', 'mode', ...COLUMNS.map(([, label]) => label)].join('\t');
  console.log(header);
  for (const row of rows) {
    const source = row.metrics ?? row;
    const values = COLUMNS.map(([key, , digits]) => {
      const value = source[key] ?? source[TABLE_ALIASES[key]];
      return typeof value === 'number' ? value.toFixed(digits) : String(value ?? '-');
    });
    console.log([row.tier, row.mode ?? '-', ...values].join('\t'));
  }
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}
