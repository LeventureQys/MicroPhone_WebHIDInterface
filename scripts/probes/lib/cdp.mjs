/**
 * CDP 驱动：把 Electron 当被测页面跑，用于界面级取证与验收。
 *
 * 真机插着时会自动连上（auto-connect），没有真机时退化为 mock 通道，界面检查照样成立。
 * 用法见 `scripts/probes/verify-buglist-20261121.mjs`。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const repo = path.resolve(import.meta.dirname, '..', '..', '..');
export const electron = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('cdp socket error')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  send(method, params = {}, timeoutMs = 90_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`cdp timeout: ${method}`));
      }, timeoutMs);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  async json(expression) {
    return JSON.parse(await this.evaluate(expression));
  }

  /** 截图：失败不抛错（窗口被遮挡时 Chromium 会拒），把失败记到 detail 里由调用方决定 */
  async shot(target, { onFail } = {}) {
    try {
      await this.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
      const result = await this.send('Page.captureScreenshot', { format: 'png' }, 10_000);
      mkdirSync(path.dirname(target), { recursive: true });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(target, Buffer.from(result.data, 'base64'));
      return true;
    } catch (error) {
      onFail?.(error);
      return false;
    }
  }

  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // 已经断开
    }
  }
}

/** 起一个跑 `out/` 构建产物的 Electron 窗口（带 --no-sandbox，见 AGENTS 已知坑 14） */
export function launchApp({ profile, port, width = 1280, height = 820, extraArgs = [] }) {
  if (!existsSync(electron)) throw new Error(`electron not found: ${electron}`);
  mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MICSTUDIO_USER_DATA: profile };
  // 本工具环境里带着 ELECTRON_RUN_AS_NODE，Electron 会按 Node 模式解析参数后直接退出（已知坑 13）
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    electron,
    [
      '.',
      '--no-sandbox',
      `--remote-debugging-port=${port}`,
      `--width=${width}`,
      `--height=${height}`,
      // 窗口被压住时 Chromium 会降频渲染 / 节流定时器，截图与拖拽会失真
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
      ...extraArgs,
    ],
    { cwd: repo, env, stdio: 'ignore', windowsHide: false },
  );
  return child;
}

export async function findPageTarget(port, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && (item.url ?? '').includes('index.html'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // 端口还没起
    }
    await wait(300);
  }
  throw new Error('devtools page target not found');
}

/** 等渲染进程挂好、`window.__micstudioGo` 可用 */
export async function waitReady(cdp, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) return true;
    await wait(300);
  }
  return false;
}

export function killApp(child) {
  try {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // 已经退出
  }
}
