/**
 * 从 Bootloader 状态直接刷固件（救砖/续刷）：CDP 驱动真实界面，不依赖参数链路。
 *
 *   node scripts/probes/dfu-recover-v006.mjs [固件包.bin]
 *
 * 与 `dfu-ui-v005.mjs` 的区别：**不等「已同步」**。设备停在 Bootloader 时 Modbus 没人答，
 * 参数同步必然失败，但 `DeviceLink._failSync()` 会保留原始通道，DFU 走的是同一条句柄，
 * 所以判据改成「设备行已连接 / 句柄已打开」，其余流程与正常升级一致。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..', '..');
const binPath = path.resolve(
  process.argv[2] ??
    path.join(repo, 'Document', 'Update', 'hardware', 'v0.0.6', 'dfu_M001 MCU V0.0.6_2026-11-16_Rev0.bin'),
);
const port = Number(process.env.MICSTUDIO_CDP_PORT ?? 9335);
const shotDir = path.resolve(process.env.MICSTUDIO_DFU_OUT ?? path.join(repo, 'artifacts', 'dfu-v006-recover'));
const userData = process.env.MICSTUDIO_DFU_PROFILE ?? 'D:\\Temp\\ud-dfu-v006-recover';
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

const log = (...args) => console.log(`[recover] ${new Date().toISOString().slice(11, 19)}`, ...args);
log(`firmware ${fileName} (${bytes.length} B, sha256 ${sha256})`);

const env = { ...process.env, MICSTUDIO_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(electron, ['.', '--no-sandbox', `--remote-debugging-port=${port}`], {
  cwd: repo,
  env,
  stdio: 'ignore',
  windowsHide: false,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPageTarget() {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && (item.url ?? '').includes('index.html'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // 端口还没起
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
      if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
      else waiter.resolve(message.result);
    });
  }

  send(method, params = {}, timeoutMs = 120_000) {
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

  async shot(name) {
    // 截图是取证，不是判据：Bootloader 状态下窗口偶发抓不到帧，抓失败就记一笔继续跑
    try {
      const result = await this.send('Page.captureScreenshot', { format: 'png' }, 20_000);
      writeFileSync(path.join(shotDir, name), Buffer.from(result.data, 'base64'));
      log(`screenshot ${name}`);
    } catch (error) {
      log(`screenshot ${name} skipped: ${error?.message ?? error}`);
    }
  }
}

const STATE = `(() => {
  const text = (selector) => document.querySelector(selector)?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
  const field = (name) => document.querySelector('[data-field="' + name + '"]')?.textContent?.trim() ?? null;
  return JSON.stringify({
    source: text('#source-pill'),
    sync: text('#sync-pill'),
    deviceRows: Array.from(document.querySelectorAll('.device-row')).map((row) => row.textContent.replace(/\\s+/g, ' ').trim()),
    fw: {
      phase: text('.fw-phase'),
      percent: text('.fw-percent'),
      block: text('.fw-block'),
      error: text('.fw-error-title'),
      detail: text('.fw-error-detail'),
      done: text('.fw-done'),
      errorVisible: document.querySelector('.fw-error') ? !document.querySelector('.fw-error').hidden : null,
      resultVisible: document.querySelector('.fw-result') ? !document.querySelector('.fw-result').hidden : null,
      model: field('model'),
      version: field('version'),
      blocks: field('blocks'),
    },
  });
})()`;

let cdp = null;
const summary = { fileName, sha256, timeline: [] };

try {
  const target = await findPageTarget();
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const bootDeadline = Date.now() + 30_000;
  while (Date.now() < bootDeadline) {
    if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
    await sleep(300);
  }

  // 设备抽屉：等 auto-connect 把句柄打开（Bootloader 下参数同步必然失败，但句柄会留着）
  await cdp.evaluate(`window.__micstudioGo('device'); true`);
  await sleep(1200);
  let opened = false;
  const openDeadline = Date.now() + 20_000;
  while (Date.now() < openDeadline) {
    const state = await cdp.json(STATE);
    summary.discoveredRows = state.deviceRows;
    summary.syncText = state.sync;
    // 「已同步」= 正常 App 固件；「同步失败」= 句柄已打开但 Modbus 没人答（Bootloader）
    if ((state.sync ?? '').includes('已同步') || (state.sync ?? '').includes('同步失败')) {
      opened = true;
      break;
    }
    await sleep(600);
  }
  if (!opened) {
    // 手动路径：只点设备行上的「打开」，**不点「请求设备」**——那会拉起系统 HID 选择框，
    // 把渲染线程卡住（截图直接超时）；getDevices() 在本仓已有全量权限，列表本来就是全的。
    await cdp.evaluate(`document.querySelector('.segmented .seg-btn[data-value="native"]')?.click(); true`);
    await sleep(500);
    await cdp.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.device-row')).find((item) => (item.textContent ?? '').includes('0A67'));
      row?.querySelector('.btn')?.click();
      return Boolean(row);
    })()`);
    const retryUntil = Date.now() + 20_000;
    while (Date.now() < retryUntil) {
      await sleep(600);
      const state = await cdp.json(STATE);
      if ((state.sync ?? '').includes('已同步') || (state.sync ?? '').includes('同步失败')) {
        opened = true;
        break;
      }
    }
  }
  summary.opened = opened;
  summary.before = await cdp.json(STATE);
  log(`opened=${opened} before=${JSON.stringify(summary.before)}`);
  await cdp.shot('01-device-bootloader.png');

  await cdp.evaluate(`window.__micstudioGo('firmware'); true`);
  await sleep(800);
  await cdp.shot('02-firmware.png');

  const preflight = await cdp.json(`(async () => {
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
  })()`);
  summary.preflight = preflight;
  log(`preflight=${JSON.stringify(preflight)}`);
  await cdp.shot('03-preflight.png');
  if (preflight.errorVisible === true || preflight.model === null) throw new Error('preflight rejected');

  await cdp.evaluate(`(() => {
    const confirm = document.querySelector('.fw-confirm input[type="checkbox"]');
    if (confirm && !confirm.checked) confirm.click();
    return true;
  })()`);
  await sleep(400);
  const started = await cdp.evaluate(`(() => {
    const start = document.querySelector('.fw-start');
    if (!start) return 'no-start-button';
    if (start.disabled) return 'start-disabled';
    start.click();
    return 'started';
  })()`);
  log(`start=${started}`);
  if (started !== 'started') throw new Error(`cannot start: ${started}`);

  const startedAt = Date.now();
  const deadline = startedAt + 6 * 60_000;
  let lastKey = '';
  let final = null;
  while (Date.now() < deadline) {
    await sleep(350);
    const state = await cdp.json(STATE);
    const key = `${state.fw.phase}|${state.fw.block}|${state.fw.percent}`;
    if (key !== lastKey) {
      lastKey = key;
      summary.timeline.push({ at: Date.now() - startedAt, ...state.fw });
      log(`phase=${state.fw.phase} percent=${state.fw.percent} block=${state.fw.block}`);
    }
    const percent = Number(String(state.fw.percent ?? '').replace(/[^\d]/g, '')) || 0;
    if (percent >= 45 && !summary.halfShot) {
      summary.halfShot = true;
      await cdp.shot('04-writing.png');
    }
    if (state.fw.errorVisible === true || state.fw.resultVisible === true) {
      final = state;
      break;
    }
  }
  if (final === null) final = await cdp.json(STATE);
  summary.final = final;
  summary.elapsedMs = Date.now() - startedAt;
  summary.timeline = summary.timeline.slice(-60);
  log(`final=${JSON.stringify(final)} (${(summary.elapsedMs / 1000).toFixed(1)} s)`);
  await cdp.shot(final.fw.phase === '升级完成' ? '05-done.png' : '05-failed.png');

  // 收尾：等设备重新枚举并尝试同步，再看一眼设备抽屉
  await sleep(6000);
  await cdp.evaluate(`window.__micstudioGo('device'); true`);
  await sleep(2000);
  summary.after = await cdp.json(STATE);
  log(`after=${JSON.stringify(summary.after)}`);
  await cdp.shot('06-device-after.png');
} catch (error) {
  summary.error = String(error?.message ?? error);
  log(`ERROR ${summary.error}`);
} finally {
  try {
    if (cdp) await cdp.send('Browser.close');
  } catch {
    // 关不掉就 taskkill
  }
  await sleep(1200);
  spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(800);
  const startupLog = path.join(userData, 'startup.log');
  if (existsSync(startupLog)) writeFileSync(path.join(shotDir, 'startup.log'), readFileSync(startupLog));
  writeFileSync(path.join(shotDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`RESULT ${JSON.stringify({ ok: summary.final?.fw?.phase === '升级完成', phase: summary.final?.fw?.phase, error: summary.error ?? summary.final?.fw?.error ?? null, elapsedMs: summary.elapsedMs ?? null })}`);
}
