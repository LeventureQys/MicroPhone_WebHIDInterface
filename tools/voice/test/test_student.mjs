/**
 * SubStage 5.2 §4.4：加载学生模型并冒烟。
 *
 * 四件事（缺一不可）：
 *   1) 新起一个 llama-server 加载学生模型 GGUF，端口 **8769**（8768 归推理侧，不抢）；
 *   2) 发 10 条 holdout 的 text，断言 10/10 schema 合法；
 *   3) 打印每条耗时与 P50；
 *   4) 关闭服务并释放端口。
 *
 * 推理侧规矩（设计文档 §2.4）：CPU only，**不传 -ngl**。
 *
 * 离线部分（不碰服务）同时是单测，由 `node --test tools/voice/test/test_student.mjs` 触发：
 * Node 的测试运行器会给孩子进程设 NODE_TEST_CONTEXT，直接跑本文件时没有这个变量，
 * 于是只走 main()，不会把用例当输出打到终端上。
 *
 * 用法：
 *   node tools/voice/test/test_student.mjs [--gguf <path>] [--limit 10] [--port 8769]
 *
 * 退出码（§5）：0 通过 / 9 模型缺失或加载失败 / 10 合法率不足 10/10 / 1 端口被占
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadArtifacts, validatePlan } from '../datagen/templates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VOICE_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(VOICE_DIR, '..', '..');

export const DEFAULT_PORT = 8769;
export const DEFAULT_LIMIT = 10;
export const DEFAULT_GGUF = path.join(VOICE_DIR, 'models', 'student', 'Qwen3-1.7B-ft-Q4_K_M.gguf');
export const SERVER_EXE = path.join(VOICE_DIR, 'models', 'llama', 'llama-server.exe');
export const HOLDOUT_PATH = path.join(VOICE_DIR, 'data', 'holdout.jsonl');
export const SCHEMA_PATH = path.join(VOICE_DIR, 'schema', 'voice-plan.schema.json');
export const SYSTEM_PATH = path.join(VOICE_DIR, 'prompts', 'system.zh.txt');
export const ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts', 'voice', 'substage-5.2');

export const EXIT_OK = 0;
export const EXIT_PORT_BUSY = 1;
export const EXIT_MISSING_GGUF = 9;
export const EXIT_NOT_LEGAL = 10;

/** user 消息首行：与推理侧 llm.py 的 DEFAULT_SNAPSHOT 逐字相同的默认快照。 */
export const SNAPSHOT_LINE =
  '当前：降噪档位=1，压缩阈值=-18dB，限制器阈值=-2.0dB，噪声门阈值=-41dB，增益=[0,0,0,0,0,0,0]dB';

// ---------------------------------------------------------------------------
// 纯函数部分（可离线单测）
// ---------------------------------------------------------------------------

export function parseArgs(argv = []) {
  const options = { gguf: DEFAULT_GGUF, limit: DEFAULT_LIMIT, port: DEFAULT_PORT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--gguf') {
      options.gguf = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--gguf=')) {
      options.gguf = arg.slice('--gguf='.length);
    } else if (arg === '--limit') {
      options.limit = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (arg === '--port') {
      options.port = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('--limit 必须是正整数');
  if (!Number.isInteger(options.port) || options.port < 1) throw new Error('--port 必须是正整数');
  return options;
}

/** §5：学生模型缺失 → 退出码 9（先把路径查清楚，别等 llama-server 起不来再猜）。 */
export function checkGguf(file) {
  if (typeof file !== 'string' || file.trim() === '') {
    return { ok: false, code: EXIT_MISSING_GGUF, message: '没有给 --gguf 路径' };
  }
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    return {
      ok: false,
      code: EXIT_MISSING_GGUF,
      message: `找不到学生模型 ${resolved}（先跑 tools\\voice\\train\\merge_and_quantize.ps1）`,
    };
  }
  const size = fs.statSync(resolved).size;
  if (size < 100 * 1024 * 1024) {
    return {
      ok: false,
      code: EXIT_MISSING_GGUF,
      message: `学生模型只有 ${(size / 1024 ** 2).toFixed(1)} MB，不是量化后的 1.7B GGUF（多半是半成品）`,
    };
  }
  return { ok: true, code: EXIT_OK, message: '', size, path: resolved };
}

/** §4.1：user = 快照行 + 换行 + 句子。 */
export function buildUserContent(text) {
  return `${SNAPSHOT_LINE}\n${String(text)}`;
}

export function loadHoldout(limit, file = HOLDOUT_PATH) {
  const rows = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  if (rows.length < 100) throw new Error(`holdout 只有 ${rows.length} 条（< 100，数据不对）`);
  return rows.slice(0, limit);
}

/**
 * 3.3 §4.3 第 7 条明说「confidence < 0.5 且 status=='ok' → 上层会降级，本层原样返回」，
 * 所以它不是"非法"。datagen 的 validatePlan 比 3.3 严（模板自己就不该产出这种），
 * 这里按 3.3 的口径把它降级成 warning。
 */
const ALLOWED_WARNINGS = new Set(['confidence<0.5 不应是 ok']);

/** 用仓库自己的校验器（3.3 §4.3 的 1–7 条）判 schema 合法性，不另写一份规则。 */
export function checkLegal(content, art) {
  if (typeof content !== 'string' || content.trim() === '') {
    return { ok: false, errors: ['内容为空'], warnings: [] };
  }
  let plan;
  try {
    plan = JSON.parse(content);
  } catch (error) {
    return { ok: false, errors: [`不是合法 JSON：${error.message}`], warnings: [] };
  }
  const check = validatePlan(plan, art);
  const errors = check.errors.filter((item) => !ALLOWED_WARNINGS.has(item));
  const warnings = check.errors.filter((item) => ALLOWED_WARNINGS.has(item));
  return { ok: errors.length === 0, errors, warnings, plan };
}

/** 最近秩 P50（毫秒）：n 个样本取第 ceil(0.5n) 小的那个。 */
export function p50(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.5 * sorted.length) - 1)];
}

// ---------------------------------------------------------------------------
// 服务控制
// ---------------------------------------------------------------------------

function httpRequest({ host = '127.0.0.1', port, path: requestPath, method = 'GET', body, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {};
    const request = http.request({ host, port, path: requestPath, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`请求超时（${timeoutMs} ms）`)));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function portInUse(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

async function waitForHealth(port, child, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) return false;
    try {
      const { status } = await httpRequest({ port, path: '/health', timeoutMs: 2000 });
      if (status === 200) return true;
    } catch {
      // 还没起来，继续等
    }
    await sleep(500);
  }
  return false;
}

function tailLines(file, count) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    return lines.slice(-count).join('\n');
  } catch {
    return '';
  }
}

async function stopServer(child, port) {
  if (!child || child.exitCode !== null) return true;
  child.kill();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    await sleep(200);
  }
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await sleep(500);
  }
  return !(await portInUse(port));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[test-student] ${error.message}`);
    return 1;
  }
  if (options.help) {
    console.log('用法：node tools/voice/test/test_student.mjs [--gguf <path>] [--limit 10] [--port 8769]');
    return EXIT_OK;
  }

  const checked = checkGguf(options.gguf);
  if (!checked.ok) {
    console.error(`[test-student] ${checked.message}`);
    return checked.code;
  }
  const gguf = checked.path;
  if (!fs.existsSync(SERVER_EXE)) {
    console.error(`[test-student] 找不到 ${SERVER_EXE}（先跑 .\\voice.cmd fetch --only llama-cpp）`);
    return EXIT_MISSING_GGUF;
  }

  const rows = loadHoldout(options.limit);
  const art = loadArtifacts();
  const systemText = fs.readFileSync(SYSTEM_PATH, 'utf8');
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const outLog = path.join(ARTIFACT_DIR, 'student-server.log');
  const errLog = path.join(ARTIFACT_DIR, 'student-server.err.log');

  if (await portInUse(options.port)) {
    console.error(`[test-student] 127.0.0.1:${options.port} 已被占用（8768=推理侧、8769=本测试）`);
    return EXIT_PORT_BUSY;
  }

  // 端口固定 8769；CPU only，**不加 -ngl**（§8）。
  const serverArgs = [
    '-m', gguf,
    '--host', '127.0.0.1',
    '--port', String(options.port),
    '-t', '14',
    '-c', '4096',
    '-np', '1',
    '--jinja',
    '--reasoning-budget', '0',
    '--chat-template-kwargs', JSON.stringify({ enable_thinking: false }),
  ];
  const outFd = fs.openSync(outLog, 'w');
  const errFd = fs.openSync(errLog, 'w');
  console.log(`[test-student] 启动 llama-server（CPU，端口 ${options.port}）：${path.basename(SERVER_EXE)} -m ${path.basename(gguf)}`);
  const child = spawn(SERVER_EXE, serverArgs, {
    cwd: path.dirname(SERVER_EXE),
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  let exitCode = EXIT_OK;
  const results = [];
  try {
    const ready = await waitForHealth(options.port, child);
    if (!ready) {
      console.error('[test-student] llama-server 没有起来（/health 90 s 内未返回 200），stderr 前 30 行：');
      console.error(tailLines(errLog, 30));
      return EXIT_MISSING_GGUF;
    }
    console.log('[test-student] llama-server ready');

    for (const [index, row] of rows.entries()) {
      const body = {
        model: 'local',
        messages: [
          { role: 'system', content: systemText },
          { role: 'user', content: buildUserContent(row.text) },
        ],
        temperature: 0,
        top_k: 1,
        max_tokens: 96,
        stream: false,
        response_format: { type: 'json_schema', json_schema: { name: 'voice_plan', strict: true, schema } },
      };
      const startedAt = Date.now();
      let content = '';
      let note = '';
      try {
        const response = await httpRequest({
          port: options.port,
          path: '/v1/chat/completions',
          method: 'POST',
          body,
        });
        const parsed = JSON.parse(response.text);
        content = parsed?.choices?.[0]?.message?.content ?? '';
        const finish = parsed?.choices?.[0]?.finish_reason;
        if (finish && finish !== 'stop') note = `finish_reason=${finish}`;
      } catch (error) {
        note = `请求失败：${error.message}`;
      }
      const elapsedMs = Date.now() - startedAt;
      const legal = note.startsWith('请求失败')
        ? { ok: false, errors: [note], warnings: [] }
        : checkLegal(content, art);
      results.push({
        index: index + 1,
        text: row.text,
        kb: row.kb,
        elapsedMs,
        ok: legal.ok,
        errors: legal.errors,
        warnings: legal.warnings ?? [],
        answer: content,
        expected: row.plan,
        note,
      });
      const status = legal.ok ? 'ok' : `FAIL(${legal.errors.join(';')})`;
      const warned = (legal.warnings ?? []).length > 0 ? ` warn(${legal.warnings.join(';')})` : '';
      console.log(
        `[test-student] #${index + 1} ${String(elapsedMs).padStart(5)} ms ${status}${warned}  ${row.text}  -> ${content.replace(/\n/g, ' ')}`,
      );
    }

    const latencies = results.map((item) => item.elapsedMs);
    const legalCount = results.filter((item) => item.ok).length;
    const summary = {
      generatedAt: new Date().toISOString(),
      gguf,
      port: options.port,
      cpuOnly: true,
      rows: results.length,
      legal: legalCount,
      p50Ms: p50(latencies),
      maxMs: Math.max(...latencies),
      meanMs: Math.round(latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length)),
      results,
    };
    const evidence = path.join(ARTIFACT_DIR, `test-student-${Date.now()}.json`);
    fs.writeFileSync(evidence, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    console.log(
      `[test-student] 结果：${legalCount}/${results.length} schema 合法；P50 ${summary.p50Ms} ms，均值 ${summary.meanMs} ms，最大 ${summary.maxMs} ms`,
    );
    console.log(`[test-student] 取证：${evidence}`);
    if (summary.p50Ms > 2500) {
      console.log(`[test-student] 注意：P50 ${summary.p50Ms} ms 超过 §7.4 的 2.5 s 门槛`);
    }
    exitCode = legalCount === results.length ? EXIT_OK : EXIT_NOT_LEGAL;
  } finally {
    const released = await stopServer(child, options.port);
    console.log(released ? `[test-student] llama-server 已关闭，端口 ${options.port} 已释放` : `[test-student] 警告：端口 ${options.port} 仍被占用`);
  }
  return exitCode;
}

// ---------------------------------------------------------------------------
// 离线单测（只在 node --test 下注册）
// ---------------------------------------------------------------------------

const underTestRunner = process.env.NODE_TEST_CONTEXT !== undefined;

if (underTestRunner) {
  test('1. GGUF 路径不存在 → 退出码 9', () => {
    const result = checkGguf(path.join(REPO_ROOT, 'artifacts', 'voice', 'substage-5.2', 'not-there.gguf'));
    assert.equal(result.ok, false);
    assert.equal(result.code, EXIT_MISSING_GGUF);
    assert.match(result.message, /找不到学生模型/);
  });

  test('2. user 消息 = 默认快照行 + 换行 + 句子', () => {
    assert.equal(buildUserContent('有点闷'), `${SNAPSHOT_LINE}\n有点闷`);
    assert.ok(SNAPSHOT_LINE.startsWith('当前：'));
    assert.ok(SNAPSHOT_LINE.endsWith('dB'));
  });

  test('3. schema 校验：合法通过、非法 JSON 与多余键不通过', () => {
    const art = loadArtifacts();
    const good = '{"v":1,"status":"ok","ops":[{"kind":"tune","target":"brightness","direction":"more","strength":"slight"}],"say":"把明亮度提一提","confidence":1}';
    assert.equal(checkLegal(good, art).ok, true);
    assert.equal(checkLegal('不是 JSON', art).ok, false);
    const extra = '{"v":1,"status":"ok","ops":[],"say":"x","confidence":1,"question":"多余"}';
    assert.equal(checkLegal(extra, art).ok, false);
  });

  test('4. P50 取最近秩', () => {
    assert.equal(p50([400, 100, 300, 200]), 200);
    assert.equal(p50([100]), 100);
    assert.equal(p50([]), 0);
  });
}

if (!underTestRunner) {
  process.exitCode = await main();
}
