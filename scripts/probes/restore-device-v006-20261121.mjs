/**
 * 把真机参数还原成参数表 V0.3 的默认值（等价于设置页「复位全部参数」）。
 *
 * 上一轮验证探针（`verify-v006-20261121.mjs` 修复前的版本）在本机误连到真机 M001、
 * 并把「唱歌」场景与几个新参数写进了设备，这个脚本用界面自己的复位动作把设备还原，
 * 并把回读结果记进 artifacts/verify-v006/。
 *
 *   node scripts/probes/restore-device-v006-20261121.mjs
 *
 * 需要设备插着（VID 0x0A67 / PID 0x0010）；没有设备时脚本直接退出，不写任何东西。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(repo, 'artifacts', 'verify-v006');
const electron = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const profile = 'D:\\Temp\\ud-restore-v006';
const port = 9362;

if (!existsSync(electron)) throw new Error(`electron not found: ${electron}`);
mkdirSync(outDir, { recursive: true });
mkdirSync(profile, { recursive: true });

const log = (...args) => console.log(`[restore] ${new Date().toISOString().slice(11, 19)}`, ...args);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' }, 10_000);
    writeFileSync(path.join(outDir, name), Buffer.from(result.data, 'base64'));
    log(`shot ${name}`);
  }
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
      // 端口还没起
    }
    await wait(300);
  }
  throw new Error('devtools page target not found');
}

const READBACK = `(() => {
  const body = document.querySelector('.modal-body');
  const num = (id) => body?.querySelector('[data-param="' + id + '"] input.pfield-number')?.value ?? null;
  const on = (id) => body?.querySelector('[data-param="' + id + '"] input[type="checkbox"]')?.checked ?? null;
  // 每行三个 eq-input：freq / gain / q；增益取第二个
  const gainRow = (band) => {
    const inputs = body?.querySelectorAll('[data-band="' + band + '"] input.eq-input') ?? [];
    return inputs[1]?.value ?? null;
  };
  return JSON.stringify({
    fc1: num('drc3.fc1'),
    fc2: num('drc3.fc2'),
    lowPreGain: num('drc3.low.preGain'),
    gateThreshold: num('noisegate.threshold_db'),
    compThreshold: num('comp.Threshold'),
    gateOn: on('noisegate.Enable'),
    drcOn: on('drc3.Enable'),
    rgbOn: on('rgb.OnOff'),
    rgbMode: num('rgb.Mode'),
    band1Gain: gainRow(0),
    band3Gain: gainRow(2),
  });
})()`;

async function main() {
  const env = { ...process.env, MICSTUDIO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(
    electron,
    ['.', '--no-sandbox', `--remote-debugging-port=${port}`, '--width=1280', '--height=820', '--disable-background-timer-throttling'],
    { cwd: repo, env, stdio: 'ignore', windowsHide: false },
  );

  const result = { startedAt: new Date().toISOString(), restored: false, checks: [] };
  try {
    const target = await findPageTarget();
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
      await wait(300);
    }

    // 这一轮需要真机：切到原生通道并打开自动连接
    await cdp.evaluate(`(() => {
      localStorage.setItem('micstudio.channel', 'native');
      localStorage.setItem('micstudio.autoConnect', 'true');
      location.reload();
      return true;
    })()`);
    await wait(1500);
    const ready = Date.now() + 40_000;
    let connected = false;
    while (Date.now() < ready) {
      connected = await cdp.evaluate(`!!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready')`);
      if (connected) break;
      await wait(500);
    }
    result.connected = connected;
    if (!connected) {
      log('没有真机可连（自动连接未就绪），什么都没写');
      return result;
    }
    await wait(1500);
    const deviceName = await cdp.evaluate(`document.querySelector('.console-device-name')?.textContent?.trim() ?? ''`);
    result.deviceName = deviceName;
    log(`connected: ${deviceName}`);

    await cdp.evaluate(`window.__micstudioGo('settings'); true`);
    await wait(800);
    result.before = await cdp.json(`(() => JSON.stringify({
      device: document.querySelector('.console-device-name')?.textContent?.trim() ?? null,
    }))()`);

    // 设置页「复位全部参数」是二次确认：第一次上膛，第二次执行
    const clicked = await cdp.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('.modal-body button'))
        .find((node) => node.classList.contains('btn--danger'));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error('reset button not found in settings');
    await wait(600);
    await cdp.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('.modal-body button'))
        .find((node) => node.classList.contains('btn--danger'));
      button?.click();
      return true;
    })()`);
    // 46 项标量写按 300 ms 合并 + 200 ms 写帧间隔，等够时间再回读
    await wait(12_000);
    await cdp.shot('05-settings-reset.png');
    await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
    await wait(600);

    await cdp.evaluate(`window.__micstudioGo('advanced'); true`);
    await wait(900);
    const after = await cdp.json(READBACK);
    result.after = after;
    await cdp.shot('06-after-reset.png');
    result.restored = true;
    result.finishedAt = new Date().toISOString();
    log(`readback: ${JSON.stringify(after)}`);
    return result;
  } finally {
    try {
      spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // 已经退出
    }
  }
}

main()
  .then((result) => {
    writeFileSync(path.join(outDir, 'restore.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    process.exit(0);
  })
  .catch((error) => {
    writeFileSync(path.join(outDir, 'restore.json'), `${JSON.stringify({ error: String(error?.stack ?? error) }, null, 2)}\n`, 'utf8');
    console.error('[restore] failed', error);
    process.exit(1);
  });
