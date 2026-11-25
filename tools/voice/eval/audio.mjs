/**
 * SubStage 5.3 §4.4：音频级端到端评测（30 条合成 wav → `pipeline.py --once --wav`）。
 *
 * ```
 * node tools/voice/eval/audio.mjs [--tier ft|fewshot|base] [--budget 30] [--out artifacts/voice]
 *                                 [--wav-dir artifacts/voice/wav/eval] [--no-make] [--reuse-server]
 * ```
 *
 * 口径：
 *   - 用例 = `make-audio.mjs` 合成好的 wav（文本 = 唤醒词 + holdout 原句）；
 *   - `e2eSuccess` = `command.status === 'applied'` **且**动作集与期望一致（任务书 §4.1；
 *     动作集一致直接复用 `metrics.sampleF1`，与文本级同一套匹配规则，避免两套口径）；
 *   - 分段耗时：`wake` / `record` / `asr` / `llm` / `apply` / `tts` / `total`；
 *     **H 段**（§7.5 的"意图/落地"）= `total_ms - asr_ms`（`--wav` 回放不 sleep，不占音频墙钟）。
 *
 * 退出码：0 成功 / 2 参数错 / 3 一条 wav 都没有 / 5 执行器不可达 / 7 服务起不来 / 9 学生模型缺失
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT, VOICE_DIR, DEFAULT_HOLDOUT, parseHoldout } from './holdout.mjs';
import { p50, p95, percentile, sampleF1, summarize } from './metrics.mjs';
import { DEFAULT_PORT, EXECUTOR_URL, PYTHON, ensureServer, executorHealth, stopServer } from './server.mjs';
import { PROMPT_SHIM, TIERS, lastJsonLine, parseShimLine, stamp } from './run.mjs';
import { relative, writeAudioReport } from './report.mjs';

export const EXIT_OK = 0;
export const EXIT_ARGS = 2;
export const EXIT_NO_WAV = 3;
export const EXIT_EXECUTOR = 5;
export const EXIT_SERVER = 7;
export const EXIT_NO_STUDENT = 9;

export const DEFAULT_OUT = path.join(REPO_ROOT, 'artifacts', 'voice');
export const DEFAULT_WAV_DIR = path.join(REPO_ROOT, 'artifacts', 'voice', 'wav', 'eval');
export const H_P95_GATE_MS = 3500;
export const E2E_GATE = 0.7;

export function parseArgs(argv = []) {
  const options = {
    tier: null,
    budget: 30,
    out: DEFAULT_OUT,
    wavDir: DEFAULT_WAV_DIR,
    sink: 'dry',
    port: DEFAULT_PORT,
    executor: EXECUTOR_URL,
    make: true,
    reuseServer: false,
  };
  const takeValue = (index, flag) => {
    const value = argv[index];
    if (value === undefined) throw new Error(`${flag} 需要一个值`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--tier') options.tier = takeValue((index += 1), '--tier');
    else if (arg === '--budget') options.budget = Number.parseInt(takeValue((index += 1), '--budget'), 10);
    else if (arg === '--out') options.out = takeValue((index += 1), '--out');
    else if (arg === '--wav-dir') options.wavDir = takeValue((index += 1), '--wav-dir');
    else if (arg === '--sink') options.sink = takeValue((index += 1), '--sink');
    else if (arg === '--port') options.port = Number.parseInt(takeValue((index += 1), '--port'), 10);
    else if (arg === '--executor') options.executor = takeValue((index += 1), '--executor');
    else if (arg === '--no-make') options.make = false;
    else if (arg === '--reuse-server') options.reuseServer = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (options.tier && !Object.keys(TIERS).includes(options.tier)) {
    throw new Error(`--tier 只能是 ${Object.keys(TIERS).join('|')}`);
  }
  if (!Number.isInteger(options.budget) || options.budget < 1) throw new Error('--budget 必须是正整数');
  options.out = path.resolve(options.out);
  options.wavDir = path.resolve(options.wavDir);
  return options;
}

/**
 * 没给 `--tier` 就按 `tools/voice/config.json` 走：
 * 优先 `evalTier`（四选一的真实结果），退回 `tier`（三值，按生产形态换成带 few-shot 的那档）。
 */
export function resolveTier(explicit) {
  if (explicit) return { tier: explicit, source: '--tier' };
  const config = path.join(VOICE_DIR, 'config.json');
  if (fs.existsSync(config)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(config, 'utf8'));
      if (Object.keys(TIERS).includes(parsed.evalTier)) return { tier: parsed.evalTier, source: 'config.json:evalTier' };
      const serving = { base: 'base-fs', fewshot: 'base-fs', ft: 'ft-fs' }[parsed.tier];
      if (serving) return { tier: serving, source: 'config.json:tier（按生产形态换算成带 few-shot 的档）' };
    } catch {
      // 配置坏了就当没有，最后仍会给出确定的档位
    }
  }
  return { tier: 'ft-fs', source: '默认（config.json 不存在或无效）' };
}

function runOnce(command, args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: error.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function tail(text, count = 4) {
  return String(text ?? '').split(/\r?\n/).filter(Boolean).slice(-count).join(' | ');
}

/** 用例结果 → `e2eSuccess` 与分段耗时（纯函数，单测可用） */
export function scoreCases(records, expectedById) {
  const scored = records.map((record) => {
    const expected = expectedById.get(record.id)?.plan ?? null;
    const score = expected ? sampleF1(expected.ops ?? [], record.plan?.ops ?? []) : { f1: 0 };
    return {
      ...record,
      expected,
      kb: expectedById.get(record.id)?.kb ?? null,
      actionF1: score.f1,
      ok: record.status === 'applied' && score.f1 === 1 && !record.error,
    };
  });
  const e2eSuccess = scored.length === 0 ? 0 : scored.filter((item) => item.ok).length / scored.length;
  const segmentKeys = ['wake', 'record', 'asr', 'llm', 'apply', 'tts', 'total', 'hMs'];
  const segments = {};
  for (const key of segmentKeys) {
    const values = scored
      .map((record) => (key === 'hMs' ? record.hMs : record.segments?.[key]))
      .filter((value) => Number.isFinite(value));
    segments[key] = {
      n: values.length,
      p50: Math.round(p50(values) * 10) / 10,
      p95: Math.round(p95(values) * 10) / 10,
      p99: Math.round(percentile(values, 0.99) * 10) / 10,
      max: values.length ? Math.max(...values) : null,
    };
  }
  return { scored, e2eSuccess: Math.round(e2eSuccess * 10000) / 10000, segments };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[audio] ${error.message}`);
    return EXIT_ARGS;
  }
  if (options.help) {
    console.log(
      '用法：node tools/voice/eval/audio.mjs [--tier ft|fewshot|base] [--budget 30] [--out artifacts/voice]\n' +
        '        [--wav-dir artifacts/voice/wav/eval] [--no-make] [--reuse-server]',
    );
    return EXIT_OK;
  }
  const resolved = resolveTier(options.tier);
  const tier = TIERS[resolved.tier];
  if (resolved.tier === 'ft' && !fs.existsSync(tier.gguf)) {
    console.error(`[audio] 学生模型不存在：${tier.gguf}`);
    return EXIT_NO_STUDENT;
  }
  if (!fs.existsSync(PYTHON)) {
    console.error(`[audio] 找不到推理侧 venv 的 python：${PYTHON}`);
    return EXIT_ARGS;
  }

  if (options.make) {
    const result = await runOnce(process.execPath, [
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'make-audio.mjs'),
      '--budget', String(options.budget),
      '--out', options.wavDir,
    ], { timeoutMs: 1800000 });
    if (result.code !== 0) {
      console.error(`[audio] make-audio 失败（退出码 ${result.code}）：${tail(result.stderr, 5)}`);
      return EXIT_NO_WAV;
    }
    process.stderr.write(result.stderr);
  }

  const manifestFile = path.join(options.wavDir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    console.error(`[audio] 缺 ${relative(manifestFile)}：先跑 node tools/voice/eval/make-audio.mjs`);
    return EXIT_NO_WAV;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const cases = (manifest.cases ?? []).filter((item) => !item.error && fs.existsSync(path.join(options.wavDir, item.wav)));
  if (cases.length === 0) {
    console.error(`[audio] ${relative(options.wavDir)} 里没有可用的 wav（合成全失败？见 manifest.json）`);
    return EXIT_NO_WAV;
  }

  const health = await executorHealth(options.executor);
  if (!health) {
    console.error(`[audio] 执行器没起来：${options.executor}`);
    return EXIT_EXECUTOR;
  }

  let server = null;
  let exitCode = EXIT_OK;
  const records = [];
  const shim = { value: null };
  try {
    if (options.reuseServer) {
      server = { mode: 'reuse', child: null };
    } else {
      server = await ensureServer({
        gguf: tier.gguf,
        port: options.port,
        logDir: path.join(options.out, 'server-logs'),
        tag: `llama-audio-${resolved.tier}`,
      });
      console.error(`[audio] llama-server ${server.mode === 'reuse' ? '复用' : '已启动'}：${path.basename(tier.gguf)}`);
    }

    const startedAt = Date.now();
    for (const [index, item] of cases.entries()) {
      const wav = path.join(options.wavDir, item.wav);
      const result = await runOnce(PYTHON, [
        PROMPT_SHIM,
        '--eval-prompt', tier.promptMode,
        '--once', '--wav', wav,
        '--sink', options.sink,
        '--no-tts',
      ]);
      if (!shim.value) shim.value = parseShimLine(result.stderr);
      const record = { id: item.id, text: item.text, wav: item.wav, plan: null, status: null, route: null, error: null, segments: {}, hMs: null };
      const parsed = result.timedOut ? null : lastJsonLine(result.stdout);
      if (!parsed) {
        record.error = result.timedOut ? 'E_TIMEOUT' : `E_NO_TURN(exit=${result.code})`;
        record.detail = tail(result.stderr);
      } else {
        record.plan = parsed.plan ?? null;
        record.norm_text = parsed.norm_text ?? null;
        record.status = parsed.command?.status ?? null;
        record.route = parsed.route ?? null;
        record.segments = {
          wake: parsed.wake_ms,
          record: parsed.audio_ms,
          asr: parsed.asr_ms,
          llm: parsed.llm_ms,
          apply: parsed.apply_ms,
          tts: parsed.tts_ms,
          total: parsed.total_ms,
        };
        record.hMs = Number.isFinite(parsed.total_ms) && Number.isFinite(parsed.asr_ms)
          ? Math.round((parsed.total_ms - parsed.asr_ms) * 10) / 10
          : null;
      }
      records.push(record);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      process.stderr.write(`[audio] ${index + 1}/${cases.length} ${item.id} ${record.error ?? record.status} ${elapsed}s\n`);
    }
  } catch (error) {
    console.error(`[audio] ${error.code ?? 'E_AUDIO'}: ${error.message}`);
    exitCode = error.code === 'E_NO_GGUF' ? EXIT_NO_STUDENT : EXIT_SERVER;
  } finally {
    if (server && server.child) await stopServer(server.child, options.port);
  }

  // 期望值回查 holdout（manifest 只存文本，避免把标签复制成两份真相）
  const expectedById = new Map();
  if (fs.existsSync(DEFAULT_HOLDOUT)) {
    for (const row of parseHoldout(fs.readFileSync(DEFAULT_HOLDOUT, 'utf8'), DEFAULT_HOLDOUT)) {
      expectedById.set(row.id, row);
    }
  }

  const { scored, e2eSuccess, segments } = scoreCases(records, expectedById);
  const textMetrics = summarize(scored.map((record) => ({
    id: record.id,
    kb: record.kb,
    text: record.text,
    norm_text: record.norm_text,
    expected: record.expected,
    actual: record.plan,
    ms: record.segments?.total ?? null,
    error: record.error,
  })));

  const report = {
    v: 1,
    kind: 'eval-audio',
    ts: stamp(new Date()),
    tier: resolved.tier,
    tierSource: resolved.source,
    model: {
      gguf: path.relative(REPO_ROOT, tier.gguf).replace(/\\/g, '/'),
      promptMode: tier.promptMode,
    },
    prompt: shim.value,
    wav: {
      dir: relative(options.wavDir),
      manifest: relative(manifestFile),
      cases: cases.length,
      voice: manifest.voice ?? null,
      wakePrefix: manifest.wakePrefix ?? null,
      holdoutSha256: manifest.holdoutSha256 ?? null,
      failed: manifest.failed ?? null,
    },
    e2eSuccess,
    gate: { e2e: e2eSuccess >= E2E_GATE, hP95: segments.hMs.p95 <= H_P95_GATE_MS },
    gateThresholds: { e2e: E2E_GATE, hP95Ms: H_P95_GATE_MS },
    textMetrics,
    segments,
    cases: scored,
  };
  const written = writeAudioReport(report, options.out);
  console.log(
    `[audio] tier=${resolved.tier}（${resolved.source}）e2e=${e2eSuccess.toFixed(4)} ` +
      `（门禁 ≥ ${E2E_GATE}）H 段 P95=${segments.hMs.p95} ms（门禁 ≤ ${H_P95_GATE_MS}）`,
  );
  console.log(
    `[audio] 分段 P50：${Object.keys(segments).map((key) => `${key}=${segments[key].p50}`).join(' ')}`,
  );
  console.log(`[audio] 报告：${relative(written.report)}`);
  const failures = scored.filter((record) => !record.ok);
  if (failures.length > 0) {
    console.log(
      `[audio] 未通过 ${failures.length} 条：` +
        failures.map((item) => `${item.id}:${item.error ?? item.status ?? 'mismatch'}`).join(' '),
    );
  }
  return exitCode;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`[audio] 未捕获异常：${error?.stack ?? error}`);
    process.exit(1);
  });
}
