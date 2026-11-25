/**
 * llama-server 生命周期与 HTTP 小工具（SubStage 5.3 专用）。
 *
 * 端口纪律（设计文档 §3.8，任何 SubStage 不得违反）：8767 执行器、**8768 推理侧**、8769 教师。
 * 本模块只碰 8768；执行器只做健康检查，**不起也不杀**（§5：执行器未起 → run.mjs 退出码 5）。
 *
 * 启动参数与 `scripts/voice.ps1` 的 `server` 子命令逐字一致（3.3 §4.1：两个关思考开关缺一不可）。
 * 用 `spawn` 直接传 argv 数组而不是拼字符串：PowerShell 会吞 `\"`，node 的 spawn 不会。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

import { VOICE_DIR } from './holdout.mjs';

export const LLAMA_DIR = path.join(VOICE_DIR, 'models', 'llama');
export const SERVER_EXE = path.join(LLAMA_DIR, 'llama-server.exe');
export const BASE_GGUF = path.join(VOICE_DIR, 'models', 'llm', 'Qwen3-1.7B-Q4_K_M.gguf');
export const STUDENT_GGUF = path.join(VOICE_DIR, 'models', 'student', 'Qwen3-1.7B-ft-Q4_K_M.gguf');
export const PYTHON = path.join(VOICE_DIR, '.venv', 'Scripts', 'python.exe');
export const DEFAULT_PORT = 8768;
export const EXECUTOR_URL = 'http://127.0.0.1:8767';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function httpJson({ port, path: requestPath, method = 'GET', body, timeoutMs = 120000, host = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = payload
      ? { 'content-type': 'application/json', 'content-length': payload.length }
      : {};
    const request = http.request({ host, port, path: requestPath, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: response.statusCode, text, json });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`请求超时（${timeoutMs} ms）`)));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
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

export function tailLines(file, count) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-count).join('\n');
  } catch {
    return '';
  }
}

/** 执行器 `/health`；连不上返回 `null`（不抛）——调用方按 §5 决定退出码 5 */
export async function executorHealth(url = EXECUTOR_URL) {
  const parsed = new URL(url);
  try {
    const { status, json } = await httpJson({
      port: Number(parsed.port || 80),
      path: '/health',
      host: parsed.hostname,
      timeoutMs: 2000,
    });
    return status === 200 ? json : null;
  } catch {
    return null;
  }
}

export async function waitForHealth(port, child, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) return false;
    try {
      const { status } = await httpJson({ port, path: '/health', timeoutMs: 2000 });
      if (status === 200) return true;
    } catch {
      // 还没起来，继续等
    }
    await sleep(500);
  }
  return false;
}

/** 8768 上已经跑着的模型是谁（`/props` 的 `model_path`）；连不上返回 `null` */
export async function serverModelPath(port = DEFAULT_PORT) {
  try {
    const { status, json } = await httpJson({ port, path: '/props', timeoutMs: 3000 });
    if (status !== 200 || !json) return null;
    return typeof json.model_path === 'string' ? json.model_path : '';
  } catch {
    return null;
  }
}

export function serverArgs({ gguf, port = DEFAULT_PORT }) {
  return [
    '-m', gguf,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-t', '14',
    '-c', '4096',
    '-np', '1',
    '--jinja',
    '--reasoning-budget', '0',
    '--chat-template-kwargs', JSON.stringify({ enable_thinking: false }),
  ];
}

export function startServer({ gguf, port = DEFAULT_PORT, logDir, tag = 'server' }) {
  fs.mkdirSync(logDir, { recursive: true });
  const outLog = path.join(logDir, `${tag}.log`);
  const errLog = path.join(logDir, `${tag}.err.log`);
  const outFd = fs.openSync(outLog, 'w');
  const errFd = fs.openSync(errLog, 'w');
  const child = spawn(SERVER_EXE, serverArgs({ gguf, port }), {
    cwd: LLAMA_DIR,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return { child, outLog, errLog };
}

export async function stopServer(child, port = DEFAULT_PORT) {
  if (!child || child.exitCode !== null) return !(await portInUse(port));
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

/**
 * 确保 8768 上跑的是指定 GGUF。
 *
 * 返回 `{mode:'reuse'|'started', child|null, outLog, errLog}`；
 * 端口被**别的模型**占着时抛 `E_PORT_FOREIGN`——静默换端口/换模型会让三档比出假结论。
 */
export async function ensureServer({ gguf, port = DEFAULT_PORT, logDir, tag = 'server' }) {
  if (!fs.existsSync(SERVER_EXE)) {
    const error = new Error(`找不到 ${SERVER_EXE}（先跑 .\\voice.cmd fetch --only llama-cpp）`);
    error.code = 'E_NO_LLAMA';
    throw error;
  }
  if (!fs.existsSync(gguf)) {
    const error = new Error(`找不到模型 ${gguf}`);
    error.code = 'E_NO_GGUF';
    throw error;
  }
  if (await portInUse(port)) {
    const running = await serverModelPath(port);
    if (running && path.resolve(running).toLowerCase() === path.resolve(gguf).toLowerCase()) {
      return { mode: 'reuse', child: null, outLog: null, errLog: null };
    }
    const error = new Error(
      `127.0.0.1:${port} 已被占用，且不是本次要评的模型（实际 model_path=${running ?? '未知'}）。` +
        '先关掉它：.\voice.cmd server 不会自动换端口，评测也不会。',
    );
    error.code = 'E_PORT_FOREIGN';
    throw error;
  }
  const started = startServer({ gguf, port, logDir, tag });
  const ready = await waitForHealth(port, started.child);
  if (!ready) {
    const stderr = tailLines(started.errLog, 30);
    await stopServer(started.child, port);
    const error = new Error(`llama-server 没有起来（/health 90 s 内未返回 200）：\n${stderr}`);
    error.code = 'E_SERVER_START';
    throw error;
  }
  return { mode: 'started', ...started };
}
