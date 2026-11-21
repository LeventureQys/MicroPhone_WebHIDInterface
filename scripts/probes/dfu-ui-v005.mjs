/**
 * 界面固件升级（DFU）真机取证：CDP 驱动渲染进程，走完整条 UI 流程并逐步截图。
 *
 * 用法（必须在能起 Electron 的环境里跑）：
 *   node scripts/probes/dfu-ui-v005.mjs "Document\Protocol\dfu_M001 MCU V0.0.5_2026-11-07_Rev0.bin"
 *
 * 2026-11-21 起包路径之外还可用环境变量覆盖取证目录 / profile / CDP 端口，
 * 所以刷 V0.0.6 也走同一个脚本：
 *   $env:MICSTUDIO_DFU_OUT='artifacts\dfu-v006'; $env:MICSTUDIO_DFU_PROFILE='D:\Temp\ud-dfu-v006'; $env:MICSTUDIO_CDP_PORT='9334'
 *   node scripts/probes/dfu-ui-v005.mjs "Document\Update\hardware\v0.0.6\dfu_M001 MCU V0.0.6_2026-11-16_Rev0.bin"
 *
 * 为什么不用 --exec-file：那个入口只能在整个探针返回后截一张图；这里要预检 / 写入中 / 收尾
 * 三个时刻的图，所以直接用 --remote-debugging-port + Page.captureScreenshot。
 *
 * 设备不连、包不合法时不点「开始」（零出帧），只把拒绝原因带回来。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..', '..');
const binPath = path.resolve(process.argv[2] ?? path.join(repo, 'Document', 'Protocol', 'dfu_M001 MCU V0.0.5_2026-11-07_Rev0.bin'));
const port = Number(process.env.MICSTUDIO_CDP_PORT ?? 9333);
// 默认落点还是 V0.0.5 那轮；换包时用 MICSTUDIO_DFU_OUT / MICSTUDIO_DFU_PROFILE 分目录取证，
// 避免覆盖上一轮的截图与 summary.json
const shotDir = path.resolve(process.env.MICSTUDIO_DFU_OUT ?? path.join(repo, 'artifacts', 'dfu-v005'));
const userData = process.env.MICSTUDIO_DFU_PROFILE ?? 'D:\\Temp\\ud-dfu-v005';
const electron = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!existsSync(binPath)) throw new Error(`firmware not found: ${binPath}`);
if (!existsSync(electron)) throw new Error(`electron not found: ${electron}`);

const bytes = readFileSync(binPath);
const b64 = bytes.toString('base64');
const fileName = path.basename(binPath);
const sha256 = createHash('sha256').update(bytes).digest('hex').toUpperCase();

rmSync(shotDir, { recursive: true, force: true });
mkdirSync(shotDir, { recursive: true });
rmSync(userData, { recursive: true, force: true });
mkdirSync(userData, { recursive: true });

const log = (...args) => console.log(`[dfu] ${new Date().toISOString().slice(11, 19)}`, ...args);
log(`firmware ${fileName} (${bytes.length} B, sha256 ${sha256})`);

const env = { ...process.env, MICSTUDIO_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;

const app = spawn(electron, ['.', '--no-sandbox', `--remote-debugging-port=${port}`], {
  cwd: repo,
  env,
  stdio: 'ignore',
  windowsHide: false,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findPageTarget() {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && (item.url ?? '').includes('index.html'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // 调试端口还没起来
    }
    await sleep(300);
  }
  throw new Error('DevTools page target not found in 40 s');
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', (event) => reject(new Error(`cdp socket error: ${event?.message ?? 'unknown'}`)), {
        once: true,
      });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
      else waiter.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`cdp timeout: ${method}`));
      }, 120_000);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`evaluate failed: ${detail}`);
    }
    return result.result?.value;
  }

  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(shotDir, name);
    writeFileSync(file, Buffer.from(result.data, 'base64'));
    log(`screenshot ${path.relative(repo, file)}`);
  }
}

const snapshotExpression = `(() => {
  const text = (selector) => document.querySelector(selector)?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
  return JSON.stringify({
    phase: text('.fw-phase'),
    percent: text('.fw-percent'),
    block: text('.fw-block'),
    done: text('.fw-done'),
    resultVisible: document.querySelector('.fw-result') ? !document.querySelector('.fw-result').hidden : null,
    errorVisible: document.querySelector('.fw-error') ? !document.querySelector('.fw-error').hidden : null,
    error: text('.fw-error-title'),
    detail: text('.fw-error-detail'),
    abortVisible: document.querySelector('.fw-abort') ? !document.querySelector('.fw-abort').hidden : null,
  });
})()`;

const pageStateExpression = `(() => {
  const text = (selector) => document.querySelector(selector)?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
  const diag = (field) => document.querySelector('[data-diag="' + field + '"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
  const stat = (field) => document.querySelector('[data-stat="' + field + '"]')?.textContent?.trim() ?? null;
  return JSON.stringify({
    source: text('#source-pill'),
    sync: text('#sync-pill'),
    firmware: diag('firmware'),
    model: diag('model'),
    name: diag('name'),
    stats: { out: stat('out'), in: stat('in'), crc: stat('crc'), timeout: stat('timeout'), retry: stat('retry'), dropped: stat('dropped') },
  });
})()`;

async function openPanelAndWaitSync(cdp) {
  await cdp.evaluate(`window.__micstudioGo('device'); true`);
  await sleep(700);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const state = JSON.parse(await cdp.evaluate(pageStateExpression));
    if ((state.sync ?? '').includes('已同步')) return state;
    await sleep(400);
  }
  // 自动连接没成：按老探针的手动路径再试一次（native → 打开 0A67 那一行）
  log('auto-connect did not reach 已同步, trying manual connect');
  await cdp.evaluate(`(() => {
    document.querySelector('.segmented .seg-btn[data-value="native"]')?.click();
    return true;
  })()`);
  await sleep(300);
  await cdp.evaluate(`(() => {
    document.querySelector('.device-actions .btn')?.click();
    return true;
  })()`);
  await sleep(1500);
  await cdp.evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('.device-row')).find((item) => (item.textContent ?? '').includes('0A67'));
    row?.querySelector('.btn')?.click();
    return Boolean(row);
  })()`);
  const retryDeadline = Date.now() + 20_000;
  while (Date.now() < retryDeadline) {
    await sleep(400);
    const state = JSON.parse(await cdp.evaluate(pageStateExpression));
    if ((state.sync ?? '').includes('已同步')) return state;
  }
  return JSON.parse(await cdp.evaluate(pageStateExpression));
}

let cdp = null;
let summary = null;

try {
  const target = await findPageTarget();
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 等渲染进程 boot 完成（__micstudioGo 由 main.ts 在最后挂上）
  const bootDeadline = Date.now() + 30_000;
  while (Date.now() < bootDeadline) {
    const ready = await cdp.evaluate(`typeof window.__micstudioGo === 'function'`);
    if (ready) break;
    await sleep(300);
  }

  const deviceBefore = await openPanelAndWaitSync(cdp);
  log('device before:', JSON.stringify(deviceBefore));
  await cdp.shot('01-device-before.png');

  await cdp.evaluate(`window.__micstudioGo('firmware'); true`);
  await sleep(700);
  await cdp.shot('02-firmware-empty.png');

  // 把包塞进 <input type=file>：DataTransfer 是渲染进程里唯一能构造 FileList 的路子
  const preflight = JSON.parse(
    await cdp.evaluate(`(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const data = new Uint8Array(bin.length);
      for (let index = 0; index < bin.length; index += 1) data[index] = bin.charCodeAt(index);
      const file = new File([data], ${JSON.stringify(fileName)}, { type: 'application/octet-stream' });
      const input = document.querySelector('.fw-file');
      if (!input) return JSON.stringify({ error: 'no .fw-file input' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 1600));
      const field = (name) => document.querySelector('[data-field="' + name + '"]')?.textContent?.trim() ?? null;
      return JSON.stringify({
        model: field('model'),
        modelName: field('modelName'),
        version: field('version'),
        length: field('length'),
        blocks: field('blocks'),
        checksum: field('checksum'),
        errorVisible: document.querySelector('.fw-error') ? !document.querySelector('.fw-error').hidden : null,
        error: document.querySelector('.fw-error-title')?.textContent?.trim() ?? null,
      });
    })()`),
  );
  log('preflight:', JSON.stringify(preflight));
  await cdp.shot('03-preflight.png');

  summary = { fileName, sha256, deviceBefore, preflight, timeline: [] };

  if (preflight.errorVisible === true || preflight.model === null) {
    summary.rejected = true;
    log('preflight rejected, nothing was sent to the device');
    throw new Error('preflight rejected');
  }

  const clicked = await cdp.evaluate(`(() => {
    const confirm = document.querySelector('.fw-confirm input[type="checkbox"]');
    if (!confirm) return 'no-confirm-switch';
    if (!confirm.checked) confirm.click();
    return 'confirmed';
  })()`);
  await sleep(400);
  const startState = await cdp.evaluate(`(() => {
    const start = document.querySelector('.fw-start');
    if (!start) return 'no-start-button';
    if (start.disabled) return 'start-disabled';
    start.click();
    return 'started';
  })()`);
  log(`confirm=${clicked} start=${startState}`);
  if (startState !== 'started') throw new Error(`cannot start: ${startState}`);

  const startedAt = Date.now();
  const deadline = startedAt + 8 * 60_000;
  let lastKey = '';
  let lastChangeAt = Date.now();
  let shotEarly = false;
  let shotHalf = false;
  let final = null;

  while (Date.now() < deadline) {
    await sleep(350);
    const state = JSON.parse(await cdp.evaluate(snapshotExpression));
    const key = `${state.phase}|${state.block}|${state.percent}`;
    if (key !== lastKey) {
      lastKey = key;
      lastChangeAt = Date.now();
      summary.timeline.push({ at: Date.now() - startedAt, ...state });
      log(`phase=${state.phase} percent=${state.percent} block=${state.block}`);
    }
    const percent = Number(String(state.percent ?? '').replace(/[^\d]/g, '')) || 0;
    if (!shotEarly && percent >= 3) {
      shotEarly = true;
      await cdp.shot('04-writing-early.png');
    }
    if (!shotHalf && percent >= 50) {
      shotHalf = true;
      await cdp.shot('05-writing-half.png');
    }
    if (state.errorVisible === true || state.resultVisible === true) {
      final = state;
      break;
    }
    if (Date.now() - lastChangeAt > 60_000) {
      final = { ...state, stalled: true };
      break;
    }
  }
  if (final === null) final = JSON.parse(await cdp.evaluate(snapshotExpression));

  summary.final = final;
  summary.elapsedMs = Date.now() - startedAt;
  summary.timeline = summary.timeline.slice(-80);
  log(`final: ${JSON.stringify(final)} (elapsed ${(summary.elapsedMs / 1000).toFixed(1)} s)`);
  await cdp.shot(final.phase === 'done' ? '06-done.png' : '06-failed.png');

  // 收尾后再看一眼设备抽屉：固件版本、连接状态、DFU 期间的统计
  await sleep(2500);
  await cdp.evaluate(`window.__micstudioGo('device'); true`);
  await sleep(1500);
  const deviceAfter = JSON.parse(await cdp.evaluate(pageStateExpression));
  summary.deviceAfter = deviceAfter;
  log('device after:', JSON.stringify(deviceAfter));
  await cdp.shot('07-device-after.png');
} catch (error) {
  if (summary === null) summary = { fileName, sha256, error: String(error?.message ?? error) };
  else summary.error = String(error?.message ?? error);
  log(`ERROR ${summary.error}`);
} finally {
  try {
    if (cdp) await cdp.send('Browser.close');
  } catch {
    // 关不掉就走 taskkill
  }
  await sleep(1000);
  spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(800);

  const logFile = path.join(userData, 'startup.log');
  if (existsSync(logFile)) {
    writeFileSync(path.join(shotDir, 'startup.log'), readFileSync(logFile));
  }
  const summaryFile = path.join(shotDir, 'summary.json');
  writeFileSync(summaryFile, JSON.stringify(summary ?? { error: 'no summary' }, null, 2));
  log(`summary ${path.relative(repo, summaryFile)}`);
  console.log('RESULT ' + JSON.stringify(summary ?? { error: 'no summary' }));
}
