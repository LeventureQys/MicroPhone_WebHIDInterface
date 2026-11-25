/**
 * SubStage 5.3 §4.2：跑一档（`base` / `fewshot` / `ft`）。
 *
 * ```
 * node tools/voice/eval/run.mjs --tier base|base-fs|ft|ft-fs [--limit N] [--out artifacts/voice] [--sink dry]
 * ```
 *
 * 五种模式（默认 `both`）：
 *
 * | `--mode` | 走什么 | 量到什么 |
 * |---|---|---|
 * | `pipeline` | 逐条 `python eval/prompt_shim.py --text …`（= `pipeline.py --text`） | 产品真实链路：规则层优先，命中就不调 LLM |
 * | `llm` | 常驻 `python eval/model_probe.py`，逐条 `PlanClient.plan()` | 只有模型这一层，三档才可比 |
 * | `both` | 先 `llm` 再 `pipeline`（同一台 llama-server，一次起停） | 上面两份 |
 *
 * 为什么两个都要：5.1 的 holdout 每条都能被 `parser.py` 命中，`pipeline` 模式的
 * `route` 恒为 `rule`，量到的是规则层。`llm` 模式绕开规则层，三档差异才看得见。
 * 两个模式的口径差在报告里各占一个 `modes.` 分支，绝不混算。
 *
 * 公平性（任务书"三档必须同一个 --limit、同一份 holdout 顺序"）：
 *   - 顺序 = holdout 文件顺序，`--limit` 取前 N 条，**不随机**；
 *   - 每档都新起 llama-server（端口 8768，`/props` 复核 `model_path` 才允许复用）；
 *   - `llm` 模式把 user 消息里的参数快照固定成产品默认值（`state=None`），三档逐行输入一致。
 *
 * 退出码：0 成功 / 2 holdout 或参数不对 / 5 执行器不可达（只需 `pipeline` 模式） /
 * 7 8768 被别的模型占用或 llama-server 起不来 / 9 学生模型缺失（`--tier ft`）
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASE_GGUF, DEFAULT_PORT, EXECUTOR_URL, PYTHON, STUDENT_GGUF,
  ensureServer, executorHealth, sleep, stopServer,
} from './server.mjs';
import { categoryOf, coverageOf, loadHoldout, REPO_ROOT, VOICE_DIR } from './holdout.mjs';
import { directionAudit, summarize } from './metrics.mjs';
import { printTierSummary, writeTierReport } from './report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EVAL_DIR = HERE;
export const PROMPT_SHIM = path.join(HERE, 'prompt_shim.py');
export const MODEL_PROBE = path.join(HERE, 'model_probe.py');
export const DEFAULT_OUT = path.join(REPO_ROOT, 'artifacts', 'voice');

export const EXIT_OK = 0;
export const EXIT_ARGS = 2;
export const EXIT_EXECUTOR = 5;
export const EXIT_SERVER = 7;
export const EXIT_NO_STUDENT = 9;

/** 四档的模型与提示词（模型 × 提示词 的完全组合；`ft` 与训练同分布，是主判据） */
export const TIERS = Object.freeze({
  base: Object.freeze({ gguf: BASE_GGUF, promptMode: 'system', label: 'base（原始权重 + 纯 system）' }),
  'base-fs': Object.freeze({ gguf: BASE_GGUF, promptMode: 'fewshot', label: 'base-fs（原始权重 + 5 条 few-shot）' }),
  ft: Object.freeze({ gguf: STUDENT_GGUF, promptMode: 'system', label: 'ft（学生模型 + 纯 system，与训练同分布）' }),
  'ft-fs': Object.freeze({ gguf: STUDENT_GGUF, promptMode: 'fewshot', label: 'ft-fs（学生模型 + 5 条 few-shot）' }),
});
export const TIER_NAMES = Object.freeze(Object.keys(TIERS));
/** 旧名兼容：任务书 v2 里的 `fewshot` = 这里的 `base-fs`；`ft` 旧义 = 这里的 `ft-fs` */
export const TIER_ALIASES = Object.freeze({ fewshot: 'base-fs' });

/**
 * 变成四档的原因（与任务书 v2 的差异，报告里必须写）：
 * 5.2 的训练样本 `messages[0]` 是 `prompts/system.zh.txt` **原文、不含 few-shot**，
 * 而 `llm.py` 默认会把 5 条 few-shot 拼进 system。若只比"base / base+fs / 学生+fs"，
 * 就分不清"微调没用"和"评测把模型放到了没见过的输入分布上"。四档把模型与提示词完全交叉，
 * 主判据是同提示词的 `ft` vs `base`。
 */

const PROGRESS_EVERY = 25;
const ROW_TIMEOUT_MS = 180000;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

export function parseArgs(argv = []) {
  const options = {
    tier: 'base',
    limit: null,
    out: DEFAULT_OUT,
    sink: 'dry',
    mode: 'both',
    port: DEFAULT_PORT,
    executor: EXECUTOR_URL,
    reuseServer: false,
    tag: '',
  };
  const takeValue = (index, flag) => {
    const value = argv[index];
    if (value === undefined) throw new Error(`${flag} 需要一个值`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--tier') options.tier = takeValue((index += 1), '--tier');
    else if (arg === '--limit') options.limit = Number.parseInt(takeValue((index += 1), '--limit'), 10);
    else if (arg === '--out') options.out = takeValue((index += 1), '--out');
    else if (arg === '--sink') options.sink = takeValue((index += 1), '--sink');
    else if (arg === '--mode') options.mode = takeValue((index += 1), '--mode');
    else if (arg === '--port') options.port = Number.parseInt(takeValue((index += 1), '--port'), 10);
    else if (arg === '--executor') options.executor = takeValue((index += 1), '--executor');
    else if (arg === '--tag') options.tag = takeValue((index += 1), '--tag');
    else if (arg === '--reuse-server') options.reuseServer = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  const tierName = TIER_ALIASES[options.tier] ?? options.tier;
  if (!TIER_NAMES.includes(tierName)) throw new Error(`--tier 只能是 ${TIER_NAMES.join('|')}`);
  options.tier = tierName;
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('--limit 必须是正整数');
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error('--port 必须是 1..65535');
  }
  if (!['both', 'pipeline', 'llm'].includes(options.mode)) {
    throw new Error('--mode 只能是 both|pipeline|llm');
  }
  options.out = path.resolve(options.out);
  return options;
}

// ---------------------------------------------------------------------------
// 子进程小工具
// ---------------------------------------------------------------------------

function runOnce(command, args, { timeoutMs = ROW_TIMEOUT_MS, cwd = REPO_ROOT, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** 从管道输出里取最后一行可解析的 JSON（`pipeline.py` 只打一行，但多一层容错） */
export function lastJsonLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // 继续往前找
    }
  }
  return null;
}

/** `[eval-shim] promptMode=… fewshots=… systemSha256=… systemChars=…` → 对象 */
export function parseShimLine(stderr) {
  const match = /\[eval-shim\] promptMode=(\S+) fewshots=(\d+) systemSha256=(\S+) systemChars=(\d+)/.exec(
    String(stderr ?? ''),
  );
  if (!match) return null;
  return {
    promptMode: match[1],
    fewshotCount: Number.parseInt(match[2], 10),
    systemSha256: match[3],
    systemChars: Number.parseInt(match[4], 10),
  };
}

function tail(text, count = 20) {
  return String(text ?? '').split(/\r?\n/).slice(-count).join('\n').trim();
}

export function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let read = 0;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function gitCommit() {
  try {
    const head = fs.readFileSync(path.join(REPO_ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5);
      return fs.readFileSync(path.join(REPO_ROOT, '.git', ref), 'utf8').trim();
    }
    return head;
  } catch {
    return null;
  }
}

function progress(done, total, startedAt) {
  if (done % PROGRESS_EVERY !== 0 && done !== total) return;
  const elapsed = (Date.now() - startedAt) / 1000;
  const perRow = elapsed / Math.max(1, done);
  const eta = Math.max(0, Math.round(perRow * (total - done)));
  process.stderr.write(
    `[run] ${String(done).padStart(4)}/${total}  已用 ${elapsed.toFixed(0)} s  ` +
      `预计还需 ${eta} s（${perRow.toFixed(2)} s/条）\n`,
  );
}

// ---------------------------------------------------------------------------
// 两种模式的执行器
// ---------------------------------------------------------------------------

/**
 * `pipeline` 模式：逐条起一个进程（与任务书 §4.2 ③ 逐字一致），读它标准输出的那一行 JSON。
 *
 * 为什么仍然一条一个进程：`total_ms` 是**进程内**的单轮墙钟（不含进程启动），
 * 一条进程一条样本才能保证这个口径不被"同一个进程跑了 500 轮"污染。
 */
export async function runPipelineMode(rows, options, context) {
  const sink = options.sink;
  const startedAt = Date.now();
  const records = [];
  let shimInfo = context.promptInfo ?? null;
  for (const [index, row] of rows.entries()) {
    const result = await runOnce(PYTHON, [
      PROMPT_SHIM,
      '--eval-prompt', context.promptMode,
      '--text', row.text,
      '--sink', sink,
      '--no-tts',
    ]);
    const record = {
      id: row.id,
      kb: row.kb ?? null,
      text: row.text,
      expected: row.plan,
      mode: 'pipeline',
      plan: null,
      norm_text: null,
      route: null,
      ms: null,
      apply_ms: null,
      llm_ms: null,
      command_status: null,
      readback_ok: null,
      error: null,
    };
    if (result.timedOut) {
      record.error = 'E_TIMEOUT';
    } else {
      if (!shimInfo) shimInfo = parseShimLine(result.stderr);
      const parsed = lastJsonLine(result.stdout);
      if (!parsed) {
        record.error = `E_CRASH(exit=${result.code})`;
        record.detail = tail(result.stderr, 6);
      } else {
        record.plan = parsed.plan ?? null;
        record.norm_text = parsed.norm_text ?? null;
        record.route = parsed.route ?? null;
        record.ms = Number.isFinite(parsed.total_ms) ? parsed.total_ms : null;
        record.apply_ms = Number.isFinite(parsed.apply_ms) ? parsed.apply_ms : null;
        record.llm_ms = Number.isFinite(parsed.llm_ms) ? parsed.llm_ms : null;
        record.command_status = parsed.command?.status ?? null;
        record.readback_ok = parsed.readback_ok ?? null;
        if (parsed.error) record.error = parsed.error;
        if (result.code !== 0 && !record.error) record.error = `E_EXIT_${result.code}`;
      }
    }
    records.push(record);
    progress(index + 1, rows.length, startedAt);
  }
  return { records, promptInfo: shimInfo, wallMs: Date.now() - startedAt, restarts: 0 };
}

/**
 * `llm` 模式：常驻一个探针进程（NDJSON 一问一答），崩了就记 `E_CRASH` 再重启。
 *
 * 常驻的理由：501 次 Python 启动的 ~0.6 s 会全部进"每条墙钟"，把 P95 污染成启动耗时。
 */
export async function runLlmMode(rows, options, context) {
  const startedAt = Date.now();
  const records = [];
  let restarts = 0;
  let child = null;
  let promptInfo = null;
  let buffer = '';
  const pending = new Map();

  const start = async () => {
    child = spawn(PYTHON, [MODEL_PROBE, '--eval-prompt', context.promptMode, '--url', `http://127.0.0.1:${context.port}`, '--warmup'], {
      cwd: REPO_ROOT,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.type === 'ready') {
          promptInfo = {
            promptMode: parsed.promptMode,
            fewshotCount: parsed.fewshotCount,
            systemSha256: String(parsed.systemSha256 ?? '').slice(0, 16),
            systemChars: parsed.systemChars,
            warmupMs: parsed.warmupMs,
          };
          const waiter = pending.get('ready');
          if (waiter) {
            pending.delete('ready');
            waiter.resolve(promptInfo);
          }
        } else if (parsed.type === 'row') {
          const waiter = pending.get(parsed.id);
          if (waiter) {
            pending.delete(parsed.id);
            waiter.resolve(parsed);
          }
        }
      }
    });
    const exited = new Promise((resolve) => {
      child.on('close', (code) => resolve(code));
      child.on('error', () => resolve(null));
    });
    const ready = await Promise.race([
      new Promise((resolve) => pending.set('ready', { resolve })),
      sleep(120000).then(() => null),
      exited.then(() => null),
    ]);
    if (!ready) {
      const detail = tail(stderr, 12);
      await new Promise((resolve) => { if (child.exitCode === null) child.kill(); resolve(); });
      child = null;
      const error = new Error(`llm 探针启动失败：${detail || '（无 stderr）'}`);
      error.code = 'E_PROBE_START';
      throw error;
    }
    return { ready, exited, stderr: () => stderr };
  };

  const askOne = (row) => new Promise((resolve) => {
    const waiter = { resolve };
    pending.set(row.id, waiter);
    child.stdin.write(`${JSON.stringify({ id: row.id, text: row.text })}\n`);
    const timer = setTimeout(() => {
      if (pending.get(row.id) === waiter) {
        pending.delete(row.id);
        resolve({ type: 'row', id: row.id, ok: false, plan: null, error: 'E_TIMEOUT', llm_ms: null });
        if (child) child.kill();
      }
    }, ROW_TIMEOUT_MS);
    const originalResolve = waiter.resolve;
    waiter.resolve = (value) => {
      clearTimeout(timer);
      originalResolve(value);
    };
  });

  let session = await start();
  promptInfo = session.ready;

  for (const [index, row] of rows.entries()) {
    let answer = null;
    try {
      answer = await askOne(row);
    } catch {
      answer = null;
    }
    if (!answer || child === null || child.exitCode !== null) {
      // 探针死了：这一条记崩溃，重启后继续（任务书 §5：单条崩溃不中断整批）
      if (child && child.exitCode === null) child.kill();
      restarts += 1;
      records.push({
        id: row.id,
        kb: row.kb ?? null,
        text: row.text,
        expected: row.plan,
        mode: 'llm',
        plan: null,
        norm_text: null,
        ms: null,
        error: 'E_CRASH',
      });
      progress(index + 1, rows.length, startedAt);
      session = await start();
      promptInfo = session.ready ?? promptInfo;
      continue;
    }
    records.push({
      id: row.id,
      kb: row.kb ?? null,
      text: row.text,
      expected: row.plan,
      mode: 'llm',
      plan: answer.plan ?? null,
      norm_text: answer.norm ?? null,
      ms: Number.isFinite(answer.llm_ms) ? answer.llm_ms : null,
      prompt_n: answer.prompt_n ?? null,
      predicted_n: answer.predicted_n ?? null,
      finish_reason: answer.finish_reason ?? null,
      error: answer.error ?? null,
    });
    progress(index + 1, rows.length, startedAt);
  }
  if (child && child.exitCode === null) {
    child.stdin.end();
    await sleep(100);
    if (child.exitCode === null) child.kill();
  }
  return { records, promptInfo, wallMs: Date.now() - startedAt, restarts };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[run] ${error.message}`);
    return EXIT_ARGS;
  }
  if (options.help) {
    console.log(
      '用法：node tools/voice/eval/run.mjs --tier base|base-fs|ft|ft-fs [--limit N] [--out artifacts/voice]\n' +
        '        [--sink dry] [--mode both|pipeline|llm] [--port 8768] [--reuse-server] [--tag <名字>]',
    );
    return EXIT_OK;
  }

  const tier = TIERS[options.tier];
  if (options.tier.startsWith('ft') && !fs.existsSync(tier.gguf)) {
    console.error(`[run] 学生模型不存在：${tier.gguf}\n[run] 先跑 SubStage 5.2（qlora → merge_and_quantize）`);
    return EXIT_NO_STUDENT;
  }
  if (!fs.existsSync(PYTHON)) {
    console.error(`[run] 找不到推理侧 venv 的 python：${PYTHON}（先跑 .\\voice.cmd venv）`);
    return EXIT_ARGS;
  }
  if (!fs.existsSync(PROMPT_SHIM) || !fs.existsSync(MODEL_PROBE)) {
    console.error('[run] eval/prompt_shim.py 或 eval/model_probe.py 缺失');
    return EXIT_ARGS;
  }

  let holdout;
  try {
    holdout = loadHoldout({ limit: options.limit });
  } catch (error) {
    console.error(`[run] ${error.message}`);
    return error.code === 'E_HOLDOUT_TOO_SMALL' ? EXIT_ARGS : EXIT_ARGS;
  }

  const needsPipeline = options.mode === 'both' || options.mode === 'pipeline';
  if (needsPipeline) {
    const health = await executorHealth(options.executor);
    if (!health) {
      console.error(
        `[run] 执行器没起来：${options.executor}\n` +
          '[run] 先起：node --import ./tools/voice/register-loader.mjs tools/voice/executor.mjs ' +
          `--sink ${options.sink} --serve --log-dir artifacts/voice/eval/exec-logs`,
      );
      return EXIT_EXECUTOR;
    }
    if (health.sink && health.sink !== options.sink) {
      console.error(`[run] 执行器当前 sink=${health.sink}，与 --sink ${options.sink} 不一致（先重启执行器）`);
      return EXIT_EXECUTOR;
    }
    console.error(`[run] 执行器 ok：sink=${health.sink} turn=${health.turn} undoDepth=${health.undoDepth}`);
  }

  const startedAt = new Date();
  const manifestModel = (() => {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(VOICE_DIR, 'data', 'manifest.json'), 'utf8'));
      return manifest.student ?? null;
    } catch {
      return null;
    }
  })();

  let server = null;
  const modes = {};
  let exitCode = EXIT_OK;
  try {
    console.error(`[run] tier=${options.tier}（${tier.label}）model=${path.basename(tier.gguf)} prompt=${tier.promptMode}`);
    if (options.reuseServer) {
      server = { mode: 'reuse', child: null };
      console.error(`[run] --reuse-server：直接用 127.0.0.1:${options.port} 上已经跑着的模型`);
    } else {
      server = await ensureServer({
        gguf: tier.gguf,
        port: options.port,
        logDir: path.join(options.out, 'server-logs'),
        tag: `llama-${options.tier}`,
      });
      console.error(
        `[run] llama-server ${server.mode === 'reuse' ? '复用' : '已启动'}（127.0.0.1:${options.port}）：` +
          `${path.basename(tier.gguf)}`,
      );
    }

    const context = { promptMode: tier.promptMode, port: options.port };
    const order = options.mode === 'both' ? ['llm', 'pipeline'] : [options.mode];
    for (const mode of order) {
      console.error(`[run] === ${mode} 模式：${holdout.rows.length} 条（limit=${holdout.limit}）===`);
      const result = mode === 'llm'
        ? await runLlmMode(holdout.rows, options, context)
        : await runPipelineMode(holdout.rows, options, context);
      // `metrics.summarize()` 的口径字段叫 `actual`（`plan` 是它在记录里的同义名）
      const scored = result.records.map((row) => ({ ...row, actual: row.plan }));
      const metrics = summarize(scored);
      const audit = directionAudit(scored);
      modes[mode] = {
        metrics,
        rows: result.records,
        wallMs: result.wallMs,
        restarts: result.restarts ?? 0,
        prompt: result.promptInfo ?? null,
        audit,
        routeStats: routeStats(result.records),
        coverage: coverageOf(result.records.map((row) => ({ kb: row.kb ?? categoryOf(row.kb) }))),
      };
      printTierSummary({ tier: options.tier, mode, metrics, rows: result.records });
    }
  } catch (error) {
    console.error(`[run] ${error.code ?? 'E_RUN'}: ${error.message}`);
    exitCode = error.code === 'E_NO_GGUF' || error.code === 'E_NO_LLAMA' ? EXIT_NO_STUDENT : EXIT_SERVER;
  } finally {
    if (server && server.child) {
      const freed = await stopServer(server.child, options.port);
      console.error(`[run] llama-server 已停${freed ? '' : '（端口没释放干净，检查 8768）'}`);
    }
  }

  if (Object.keys(modes).length > 0) {
    const report = {
      v: 1,
      kind: 'eval-tier',
      tier: options.tier,
      ts: stamp(startedAt),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      argv: argv.join(' '),
      commit: gitCommit(),
      options: {
        limit: holdout.limit,
        sink: options.sink,
        mode: options.mode,
        port: options.port,
        out: path.relative(REPO_ROOT, options.out).replace(/\\/g, '/'),
        tag: options.tag || null,
      },
      holdout: {
        path: path.relative(REPO_ROOT, holdout.path).replace(/\\/g, '/'),
        count: holdout.count,
        limit: holdout.limit,
        sha256: holdout.sha256,
        firstId: holdout.rows[0]?.id ?? null,
        lastId: holdout.rows[holdout.rows.length - 1]?.id ?? null,
        kbKeys: holdout.kbKeys,
        categories: coverageOf(holdout.rows.map((row) => ({ kb: row.kb }))),
      },
      model: {
        gguf: path.relative(REPO_ROOT, tier.gguf).replace(/\\/g, '/'),
        bytes: fs.existsSync(tier.gguf) ? fs.statSync(tier.gguf).size : null,
        sha256: fs.existsSync(tier.gguf) ? fileSha256(tier.gguf) : null,
        promptMode: tier.promptMode,
        label: tier.label,
        manifestStudent: manifestModel,
        serverMode: server?.mode ?? null,
      },
      modes,
    };
    const written = writeTierReport(report, options.out);
    console.log(`[run] 报告：${path.relative(REPO_ROOT, written.report).replace(/\\/g, '/')}`);
    console.log(`[run] 最新：${path.relative(REPO_ROOT, written.latest).replace(/\\/g, '/')}`);
  }
  return exitCode;
}

export function routeStats(records) {
  const stats = {};
  for (const record of records) {
    const key = record.route ?? (record.mode === 'llm' ? 'llm' : 'unknown');
    stats[key] = (stats[key] ?? 0) + 1;
  }
  return stats;
}

/** `yyyyMMdd-HHmmss`（与 `pipeline.py` 的 `_stamp()` 同形，便于和 turn 日志对时） */
export function stamp(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`[run] 未捕获异常：${error?.stack ?? error}`);
    process.exit(1);
  });
}
