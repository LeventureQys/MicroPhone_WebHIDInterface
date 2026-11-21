/**
 * 只读核对：确认上一轮回写后设备参数已回到参数表默认值（不改任何参数）。
 *
 *   node scripts/probes/verify-readback-20261113.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..', '..');
const electron = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const profile = 'D:\\Temp\\ud-verify-readback';
const port = 9354;
if (!existsSync(electron)) throw new Error('electron missing');
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = { ...process.env, MICSTUDIO_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(electron, ['.', '--no-sandbox', `--remote-debugging-port=${port}`, '--width=1280', '--height=820'], {
  cwd: repo,
  env,
  stdio: 'ignore',
});

try {
  let target = null;
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && target === null) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((item) => item.type === 'page' && (item.url ?? '').includes('index.html')) ?? null;
    } catch {
      // 端口还没起
    }
    if (target === null) await wait(300);
  }
  if (target === null) throw new Error('no page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout ${method}`));
      }, 30_000);
    });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');

  const syncDeadline = Date.now() + 30_000;
  let synced = false;
  while (Date.now() < syncDeadline) {
    synced = await evaluate(`!!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready')`);
    if (synced) break;
    await wait(400);
  }
  await wait(800);
  const device = await evaluate(`(() => JSON.stringify({
    name: document.querySelector('.console-device-name')?.textContent?.trim() ?? null,
    state: document.querySelector('.console-device-state')?.textContent?.trim() ?? null,
    sync: document.querySelector('#sync-pill')?.textContent?.trim() ?? null,
  }))()`);
  await evaluate(`window.__micstudioGo('advanced'); true`);
  await wait(900);
  const params = await evaluate(`(() => JSON.stringify({
    noisegate: document.querySelector('.modal-body [data-param="noisegate.threshold_db"] input.pfield-number')?.value ?? null,
    comp: document.querySelector('.modal-body [data-param="comp.Threshold"] input.pfield-number')?.value ?? null,
    fc1: document.querySelector('.modal-body [data-param="drc3.fc1"] input.pfield-number')?.value ?? null,
    fc2: document.querySelector('.modal-body [data-param="drc3.fc2"] input.pfield-number')?.value ?? null,
    drcLowThreshold: document.querySelector('.modal-body [data-param="drc3.low.threshold"] input.pfield-number')?.value ?? null,
    eq: Array.from(document.querySelectorAll('.modal-body .eq-row[data-band]')).map((row) => {
      const inputs = Array.from(row.querySelectorAll('input[type="number"]'));
      return inputs[1]?.value ?? null;
    }),
  }))()`);
  console.log(`sync=${synced} device=${device}`);
  console.log(`params=${params}`);
} finally {
  spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
}
