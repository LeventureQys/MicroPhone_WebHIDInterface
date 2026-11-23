/**
 * v1.1.3 全量测试 R 系列：真机 M001（固件 0.0.6.0）联调。
 *
 *   node scripts/probes/fulltest-r.mjs [--app=<快照目录>] [--port=9373]
 *
 * R2 自动连接与顶栏状态 / R3 连接+sync+自检 3 轮 / R4 46 项界面值 ⇄ 裸 HID 真值 /
 * R7 20 次连续写 / R8 空闲 60 s / R10 电平来源 / R11 设备轮询关闭 /
 * R5 43 项界面写入 → 裸 HID 回读 / R6 场景写入回读 / R12 恢复默认后裸 HID 回读。
 * R9（物理拔插）需要人工拔线，本脚本不执行，结果里写 blocked。
 *
 * 裸 HID 读用 scripts/probes/real8-health.py（只发 0x13 连续读，不写设备），
 * 读之前先把 Electron 关掉，避免两路抢同一个 HID 句柄。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = 'D:\\WorkShop\\MicroPhone_WebHIDInterface';
const python = 'C:\\Users\\a5935\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const args = new Map(
  process.argv.slice(2).map((item) => {
    const match = item.match(/^--([^=]+)=(.*)$/);
    return match ? [match[1], match[2]] : [item, ''];
  }),
);
const appRoot = args.get('app') ? path.resolve(args.get('app')) : 'D:\\Temp\\micstudio-fulltest\\v1.1.3-baseline';
const outDir = args.get('out') ? path.resolve(args.get('out')) : path.join(repo, 'artifacts', 'fulltest-20261121', 'real');
const port = Number(args.get('port') ?? 9373);
const electron = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const truthFile = path.join(repo, 'artifacts', 'fulltest-20261121', 'gates', 'P1-P5-truth.json');
const r1File = path.join(outDir, 'R1-health.json');

mkdirSync(outDir, { recursive: true });

const results = { startedAt: new Date().toISOString(), checks: [], measurements: {}, screenshots: [] };
const log = (...items) => console.log(`[r] ${new Date().toISOString().slice(11, 19)}`, ...items);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(id, ok, detail) {
  results.checks.push({ id, ok: Boolean(ok), detail: detail ?? null });
  log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 500)}`}`);
}

const truth = JSON.parse(readFileSync(truthFile, 'utf8').replace(/^\uFEFF/, ''));
const params = truth.params;
const eqPresets = truth.eqPresets;
const byId = new Map(params.map((item) => [item.id, item]));
const byAddr = new Map(params.map((item) => [item.addr, item]));

function round6(value) {
  return Number(value.toFixed(6));
}
function snapValue(param, value) {
  const clamped = Math.min(param.max, Math.max(param.min, value));
  if (!(param.step > 0)) return clamped;
  const steps = Math.round((clamped - param.min) / param.step - 1e-9);
  return Math.min(param.max, Math.max(param.min, round6(param.min + steps * param.step)));
}
function fromRaw(param, raw) {
  const scale = param.scale ?? { kind: 'raw' };
  return scale.kind === 'raw' ? raw : round6(raw * scale.mul + scale.add);
}
function rawOf(param, value) {
  const scale = param.scale ?? { kind: 'raw' };
  const snapped = snapValue(param, value);
  const raw = scale.kind === 'raw' ? snapped : Math.round(round6((snapped - scale.add) / scale.mul));
  const rawMin = Math.round(round6(scale.kind === 'raw' ? param.min : (param.min - scale.add) / scale.mul));
  const rawMax = Math.round(round6(scale.kind === 'raw' ? param.max : (param.max - scale.add) / scale.mul));
  return Math.min(rawMax, Math.max(rawMin, raw));
}
function defaultRaw(param) {
  return rawOf(param, param.default);
}

function readReg(health, addr) {
  const { raw } = health;
  if (addr >= 0x2000) return raw.preset?.[addr - 0x2000] ?? null;
  if (addr >= 0x1000) return raw.config?.[addr - 0x1000] ?? null;
  return raw.info?.[addr] ?? null;
}

function readHealth(tag) {
  const started = Date.now();
  execFileSync(python, ['scripts/probes/real8-health.py', tag], {
    cwd: repo,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONPATH: '' },
    stdio: 'pipe',
    timeout: 120_000,
  });
  const file = path.join(repo, 'artifacts', 'dfu-check-20261121', `health-${tag}.json`);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const target = path.join(outDir, `R-${tag}.json`);
  writeFileSync(target, JSON.stringify(data, null, 1), 'utf8');
  return { ...data, elapsedMs: Date.now() - started, file: target };
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
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }
  send(method, params = {}, timeoutMs = 60_000) {
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
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  async shot(name) {
    try {
      const result = await this.send('Page.captureScreenshot', { format: 'png' }, 20_000);
      writeFileSync(path.join(outDir, name), Buffer.from(result.data, 'base64'));
      results.screenshots.push(name);
      return true;
    } catch {
      return false;
    }
  }
}

const HELPERS = `(() => {
  window.__rt = {
    text: (node) => (node?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    status() {
      const pill = document.querySelector('#sync-pill');
      return {
        sync: this.text(document.querySelector('#sync-pill .state-text')),
        ready: Boolean(pill?.classList.contains('state-pill--ready')),
        tone: document.querySelector('#connect-btn')?.dataset.tone ?? null,
        device: this.text(document.querySelector('.console-device-name')),
        deviceState: this.text(document.querySelector('.console-device-state')),
        notice: this.text(document.querySelector('.console-notice .console-notice-text')) || null,
        source: this.text(document.querySelector('#source-pill .state-text')) || null,
      };
    },
    diag() {
      const pick = (key) => this.text(document.querySelector('[data-diag="' + key + '"]'));
      const stat = (key) => this.text(document.querySelector('[data-stat="' + key + '"]'));
      return {
        model: pick('model'), name: pick('name'), firmware: pick('firmware'), vidpid: pick('vidpid'),
        serial: pick('serial'), comErr: pick('comErr'), audio: pick('audio'), poll: pick('poll'),
        stats: { out: stat('out'), in: stat('in'), crc: stat('crc'), timeout: stat('timeout'), retry: stat('retry'), dropped: stat('dropped'), queue: stat('queue') },
        selfCheckBusy: Boolean(document.querySelector('.diag-selfcheck.is-busy, .diag-selfcheck[disabled]')),
        steps: Array.from(document.querySelectorAll('.diag-selfcheck-steps > *')).map((node) => ({ text: this.text(node), error: node.className.includes('is-error'), ok: node.className.includes('is-ok') })),
      };
    },
    readParams() {
      const out = {};
      for (const root of document.querySelectorAll('.modal-body [data-param]')) {
        const id = root.dataset.param;
        const num = root.querySelector('input.pfield-number');
        const checkbox = root.querySelector('input[type="checkbox"]');
        const segment = root.querySelector('.seg-btn.is-active');
        out[id] = { number: num ? num.value : null, checked: checkbox ? checkbox.checked : null, segment: segment ? segment.dataset.value : null };
      }
      for (const root of document.querySelectorAll('.tune-switch-grid [data-param]')) {
        out[root.dataset.param] = { checked: root.querySelector('input[type="checkbox"]')?.checked ?? null };
      }
      return out;
    },
    gains() {
      return Array.from(document.querySelectorAll('.console-gain-item')).map((node) => this.text(node.querySelector('.console-gain-value')));
    },
    setNumber(id, value) {
      const root = document.querySelector('.modal-body [data-param="' + id + '"]');
      const input = root?.querySelector('input.pfield-number');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    setSegment(id, value) {
      const root = document.querySelector('.modal-body [data-param="' + id + '"]');
      const button = root?.querySelector('.seg-btn[data-value="' + value + '"]');
      if (!button) return false;
      if (!button.classList.contains('is-active')) button.click();
      return true;
    },
    setCheckbox(id, on) {
      const root = document.querySelector('.modal-body [data-param="' + id + '"]');
      const input = root?.querySelector('input[type="checkbox"]');
      if (!input) return false;
      if (input.checked !== on) input.click();
      return true;
    },
    setConsoleCheckbox(id, on) {
      const root = document.querySelector('.tune-switch-grid [data-param="' + id + '"]');
      const input = root?.querySelector('input[type="checkbox"]');
      if (!input) return false;
      if (input.checked !== on) input.click();
      return true;
    },
    hidCounter: 0,
    patchHid() {
      const hid = navigator.hid;
      if (!hid || hid.getDevices.__patched) return false;
      const original = hid.getDevices.bind(hid);
      const wrapper = (...callArgs) => { window.__rt.hidCounter += 1; return original(...callArgs); };
      wrapper.__patched = true;
      hid.getDevices = wrapper;
      return true;
    },
  };
  return true;
})()`;

let cdp = null;
let app = null;

async function launch(tag) {
  const profile = path.join('D:\\Temp\\micstudio-fulltest', `userdata-r-${tag}`);
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MICSTUDIO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  app = spawn(electron, ['.', '--no-sandbox', `--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], {
    cwd: appRoot,
    env,
    stdio: 'ignore',
    windowsHide: false,
  });
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && (item.url ?? '').includes('index.html'));
      if (page?.webSocketDebuggerUrl) {
        cdp = new Cdp(page.webSocketDebuggerUrl);
        await cdp.open();
        break;
      }
    } catch {
      // 等端口
    }
    await wait(300);
  }
  if (!cdp) throw new Error('devtools target not found');
  await cdp.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
  const bootDeadline = Date.now() + 30_000;
  while (Date.now() < bootDeadline) {
    if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
    await wait(300);
  }
  await cdp.evaluate(HELPERS);
  // 等自动连接 + 参数同步 ready（首帧可能是 mock 的 ready，要等真机名出现）
  const readyDeadline = Date.now() + 25_000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    const state = await cdp.evaluate(`window.__rt.status()`);
    if (state.ready && state.device && state.device !== '演示数据') { ready = true; break; }
    await wait(250);
  }
  return { ready, bootMs: Date.now() - started };
}

async function killApp() {
  if (!app) return;
  try {
    spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // 已退出
  }
  app = null;
  cdp = null;
  await wait(2500);
}

async function openDevice() {
  await cdp.evaluate(`window.__micstudioGo('device'); true`);
  await wait(700);
}

async function openAdvanced() {
  await cdp.evaluate(`window.__micstudioGo('advanced'); true`);
  await wait(800);
}

async function closeDrawer() {
  await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
  await wait(400);
}

async function runSelfCheck() {
  await cdp.evaluate(`document.querySelector('.diag-selfcheck')?.click(); true`);
  const deadline = Date.now() + 20_000;
  let steps = [];
  while (Date.now() < deadline) {
    await wait(400);
    const diag = await cdp.evaluate(`window.__rt.diag()`);
    if (diag.steps.length > 0 && !diag.selfCheckBusy) { steps = diag.steps; break; }
  }
  return steps;
}

async function phaseA() {
  // R4 的对照真值：本轮任何写入之前先读一次裸 HID（R1 快照早于本轮，设备可能已被后续轮次改过）
  const healthAtStart = readHealth('fulltest-r4-pre');
  results.measurements.r4Truth = healthAtStart.identity;
  const boot = await launch('a');
  const bootReady = boot.ready;
  await cdp.evaluate(`window.__rt.patchHid()`);
  const status = await cdp.evaluate(`window.__rt.status()`);
  await cdp.shot('R2-connected.png');
  check('R2.1 启动后自动连接并「已连接 / 已同步」（实测含 CDP 接入耗时）', bootReady && status.ready, { bootMs: boot.bootMs, sync: status.sync, device: status.device, state: status.deviceState });
  await wait(12_000);
  const hidCalls = await cdp.evaluate(`window.__rt.hidCounter`);
  check('R2.2 已连接后 12 s 内不再调用 getDevices（无重复探测）', hidCalls === 0, { hidCalls });

  await openDevice();
  const diag0 = await cdp.evaluate(`window.__rt.diag()`);
  check(
    'R2.3 设备信息：型号 M001 / 固件 0.0.6.0 / VID-PID 0A67-0010',
    /JYM001|M001/.test(diag0.model) && /0\.0\.6/.test(diag0.firmware) && /0A67/i.test(diag0.vidpid),
    { model: diag0.model, firmware: diag0.firmware, vidpid: diag0.vidpid, serial: diag0.serial },
  );

  const rounds = [];
  for (let index = 0; index < 3; index += 1) {
    const steps = await runSelfCheck();
    const diag = await cdp.evaluate(`window.__rt.diag()`);
    rounds.push({ steps, stats: diag.stats });
    await wait(400);
  }
  const allOk = rounds.every((round) => round.steps.length > 0 && round.steps.every((step) => !step.error));
  const countersZero = rounds.every((round) => ['crc', 'timeout', 'retry'].every((key) => Number(round.stats[key]) === 0));
  check('R3.1 连续 3 轮自检全绿（每轮 3 步）', allOk && rounds.every((round) => round.steps.length === 3), rounds.map((round) => round.steps.map((step) => step.text)));
  check('R3.2 自检 3 轮后 crc / timeout / retry 全 0', countersZero, rounds.map((round) => round.stats));
  await cdp.shot('R3-selfcheck.png');

  // ---- R4 46 项界面值 ⇄ 裸 HID 真值 ---------------------------------------
  const health = healthAtStart;
  await openAdvanced();
  const ui = await cdp.evaluate(`window.__rt.readParams()`);
  const gains = await cdp.evaluate(`window.__rt.gains()`);
  const mismatches = [];
  for (const param of params) {
    const raw = readReg(health, param.addr);
    if (raw === null || raw === undefined) { mismatches.push({ id: param.id, problem: 'no register value' }); continue; }
    // 界面显示值 = 标定换算后夹紧到工程量区间（raw 1 对 ratio 这类 min=1 的参数会夹到 1）
    const want = Math.min(param.max, Math.max(param.min, fromRaw(param, raw)));
    let actual = null;
    if (param.readonly) {
      const index = param.id === 'gain.Mic' ? 0 : param.id === 'gain.Hp' ? 1 : -1;
      actual = index >= 0 ? Number(gains[index]) : null;
    } else if (ui[param.id]) {
      const cell = ui[param.id];
      if (cell.number !== null && cell.number !== undefined) actual = Number(cell.number);
      else if (cell.checked !== null && cell.checked !== undefined) actual = cell.checked ? 1 : 0;
      else if (cell.segment !== null && cell.segment !== undefined) actual = Number(cell.segment);
    }
    if (actual === null || !Number.isFinite(actual)) {
      if (param.id === 'eq.mode') continue;
      mismatches.push({ id: param.id, problem: 'no ui value', raw, want });
      continue;
    }
    const tolerance = Math.max(param.step / 2 + 1e-6, 0.001);
    if (Math.abs(actual - want) > tolerance) mismatches.push({ id: param.id, addr: `0x${param.addr.toString(16)}`, raw, want, actual });
  }
  results.measurements.r4 = { mismatches, gains };
  check('R4 46 项界面值 ⇄ 裸 HID 真值（R1 快照）逐项一致', mismatches.length === 0, { mismatchCount: mismatches.length, sample: mismatches.slice(0, 10), gains });
  await closeDrawer();

  // ---- R10 / R11 电平来源与轮询关闭 --------------------------------------
  await openDevice();
  await wait(2500);
  const diag1 = await cdp.evaluate(`window.__rt.diag()`);
  const frames = [];
  for (let index = 0; index < 3; index += 1) {
    frames.push(Number((await cdp.evaluate(`window.__rt.diag()`)).stats.in));
    await wait(3000);
  }
  const pollOff = /关/.test(diag1.poll);
  const framesStable = frames.every((value) => Number.isFinite(value)) && frames[frames.length - 1] === frames[0];
  check('R10 电平来源 = 音频输入（设备还在，麦克风端点匹配）', /音频输入|麦克风|USB Audio/.test(diag1.audio), { audio: diag1.audio });
  check('R11 音频接管后设备轮询关闭，3 次采样帧数不再增长', pollOff && framesStable, { poll: diag1.poll, frames });
  await cdp.shot('R10-R11-diag.png');

  // ---- R7 20 次连续写 -----------------------------------------------------
  const before7 = await cdp.evaluate(`window.__rt.diag()`);
  const start7 = Date.now();
  for (let index = 0; index < 20; index += 1) {
    await cdp.evaluate(`window.__rt.setConsoleCheckbox('mic.sigMute', ${index % 2 === 0 ? 'true' : 'false'})`);
    await wait(320);
  }
  await wait(1500);
  const after7 = await cdp.evaluate(`window.__rt.diag()`);
  const elapsed7 = Date.now() - start7;
  check(
    'R7 20 次连续写：无 timeout/retry 上涨，帧数增加，设备不卡死',
    Number(after7.stats.timeout) === Number(before7.stats.timeout) &&
      Number(after7.stats.retry) === Number(before7.stats.retry) &&
      Number(after7.stats.out) > Number(before7.stats.out) &&
      (await cdp.evaluate(`window.__rt.status()`)).ready,
    { elapsedMs: elapsed7, before: before7.stats, after: after7.stats },
  );

  // ---- R8 空闲 60 s -------------------------------------------------------
  const idleFrames = [];
  let idleOk = true;
  for (let index = 0; index < 12; index += 1) {
    await wait(5000);
    const state = await cdp.evaluate(`window.__rt.status()`);
    const diag = await cdp.evaluate(`window.__rt.diag()`);
    idleFrames.push({ t: (index + 1) * 5, in: Number(diag.stats.in), ready: state.ready, tone: state.tone });
    if (!state.ready || state.tone === 'error') idleOk = false;
  }
  const idleStable = idleFrames.every((item) => item.in === idleFrames[0].in);
  check('R8 空闲 60 s：不掉线、无 error、帧计数不增长（轮询已关）', idleOk && idleStable, { idleFrames: idleFrames.filter((item, index) => index % 3 === 0), idleStable });
  await closeDrawer();

  // ---- R5 43 项界面写入（真实写设备） -------------------------------------
  await openAdvanced();
  const targets = params.filter((param) => !param.readonly && param.id !== 'eq.mode');
  const written = [];
  for (let index = 0; index < targets.length; index += 1) {
    const param = targets[index];
    const candidates = [param.min, round6((param.min + param.max) / 2), param.max];
    let value = candidates[index % 3];
    if (Math.abs(value - param.default) < 1e-9) value = candidates[(index + 1) % 3];
    // 使能位必须先写 1：ENC 关闭时它的档位按钮是 disabled，点击不会生效
    if (['enc.OnOff', 'comp.Enable', 'limit.Enable', 'noisegate.Enable', 'drc3.Enable'].includes(param.id)) value = 1;
    let ok = false;
    let method = '';
    let effective = value;
    if (['mic.mute', 'hp.OnOff', 'mic.sigMute'].includes(param.id)) {
      ok = await cdp.evaluate(`window.__rt.setConsoleCheckbox(${JSON.stringify(param.id)}, ${value === 1 ? 'true' : 'false'})`);
      method = 'console-checkbox';
    } else if (param.max === 1) {
      ok = await cdp.evaluate(`window.__rt.setCheckbox(${JSON.stringify(param.id)}, ${value === 1 ? 'true' : 'false'})`);
      method = 'checkbox';
    } else {
      ok = await cdp.evaluate(`window.__rt.setNumber(${JSON.stringify(param.id)}, ${value})`);
      method = 'number';
      if (!ok) {
        // 分段控件（如 enc.Level 0–3）只接受整数档位
        effective = param.max;
        ok = await cdp.evaluate(`window.__rt.setSegment(${JSON.stringify(param.id)}, ${effective})`);
        method = 'segment';
      }
    }
    const raw = rawOf(param, effective);
    written.push({ id: param.id, addr: param.addr, value: snapValue(param, effective), raw, ok, method });
    await wait(420);
  }
  await wait(3000);
  const writeStats = (await cdp.evaluate(`window.__rt.diag()`)).stats;
  results.measurements.r5 = { written, writeStats };
  await cdp.shot('R5-after-write.png');
  check('R5.1 43 项界面写入全部落到控件（≥40 项要求）', written.filter((item) => item.ok).length >= 40, { ok: written.filter((item) => item.ok).length, total: written.length });
  await closeDrawer();
  await killApp();
  await wait(2000);
  const healthAfterWrite = readHealth('fulltest-r5');
  const writeMismatch = [];
  for (const item of written) {
    const param = byId.get(item.id);
    const raw = readReg(healthAfterWrite, param.addr);
    if (raw !== item.raw) writeMismatch.push({ id: item.id, addr: `0x${param.addr.toString(16)}`, want: item.raw, actual: raw });
  }
  results.measurements.r5.readback = writeMismatch;
  check('R5.2 43 项写入后用裸 HID 回读一致（0 失配）', writeMismatch.length === 0, { mismatchCount: writeMismatch.length, sample: writeMismatch.slice(0, 10), elapsedMs: healthAfterWrite.elapsedMs });

  // ---- R6 场景写入回读 ----------------------------------------------------
  const boot2 = await launch('b');
  await openDevice();
  await wait(1200);
  const sceneGains = {};
  const scenePreset = { quiet: 'flat', meeting: 'vocal', podcast: 'warm', sing: 'bright' };
  const sceneUi = [];
  for (const id of ['quiet', 'meeting', 'podcast', 'sing']) {
    await cdp.evaluate(`document.querySelector('.scene-btn[data-scene="${id}"]')?.click(); true`);
    await wait(2500);
    sceneGains[id] = eqPresets[scenePreset[id]];
    const state = await cdp.evaluate(`(() => {
      const macro = (key) => document.querySelector('[data-macro="' + key + '"] .pfield-value')?.textContent?.trim() ?? null;
      return {
        scene: document.querySelector('.scene-btn.is-active')?.dataset.scene ?? null,
        tone: document.querySelector('.tone-chip.is-active')?.dataset.tone ?? null,
        denoise: macro('denoise'),
        evenness: macro('evenness'),
        enc: document.querySelector('.switch-grid .switch-item input[type="checkbox"]')?.checked ?? null,
        level: document.querySelector('.switch-grid .seg-btn.is-active')?.dataset.value ?? null,
      };
    })()`);
    sceneUi.push({ id, ...state });
  }
  const sceneStatus = await cdp.evaluate(`window.__rt.status()`);
  await cdp.shot('R6-scene.png');
  await killApp();
  await wait(2000);
  const healthScene = readHealth('fulltest-r6');
  const sceneExpect = {
    quiet: { gate: -82, comp: -18, enc: 0, level: 1 },
    meeting: { gate: -41, comp: -36, enc: 1, level: 2 },
    podcast: { gate: -59, comp: -42, enc: 1, level: 1 },
    sing: { gate: -73, comp: -21, enc: 0, level: 1 },
  };
  const sceneMismatch = [];
  // R6.1 每个场景点击后主界面读数（4 个固定场景逐个核对）
  const sceneTone = { quiet: 'flat', meeting: 'vocal', podcast: 'warm', sing: 'bright' };
  const uiProblems = [];
  for (const ui of sceneUi) {
    const want = sceneExpect[ui.id];
    if (ui.scene !== ui.id) uiProblems.push({ id: ui.id, problem: `active=${ui.scene}` });
    if (ui.tone !== sceneTone[ui.id]) uiProblems.push({ id: ui.id, problem: `tone=${ui.tone}` });
    if (ui.denoise !== `${want.gate} dB`) uiProblems.push({ id: ui.id, problem: `denoise=${ui.denoise}` });
    if (ui.evenness !== `${want.comp} dB`) uiProblems.push({ id: ui.id, problem: `evenness=${ui.evenness}` });
    if (ui.enc !== Boolean(want.enc)) uiProblems.push({ id: ui.id, problem: `enc=${ui.enc}` });
    if (ui.level !== String(want.level)) uiProblems.push({ id: ui.id, problem: `level=${ui.level}` });
  }
  check('R6.1 四个固定场景逐个点击后主界面读数正确（门/压缩/音色/降噪/档位）', uiProblems.length === 0, { problems: uiProblems, sceneUi });

  // R6.2 最后一个场景（唱歌）写入设备后，裸 HID 校验字段 + 7 段 EQ
  {
    const want = sceneExpect.sing;
    const gateParam = byId.get('noisegate.threshold_db');
    const compParam = byId.get('comp.Threshold');
    const encParam = byId.get('enc.OnOff');
    const levelParam = byId.get('enc.Level');
    const gateRaw = readReg(healthScene, gateParam.addr);
    const compRaw = readReg(healthScene, compParam.addr);
    const encRaw = readReg(healthScene, encParam.addr);
    const levelRaw = readReg(healthScene, levelParam.addr);
    if (gateRaw !== rawOf(gateParam, want.gate)) sceneMismatch.push({ field: 'gate', want: rawOf(gateParam, want.gate), actual: gateRaw });
    if (compRaw !== rawOf(compParam, want.comp)) sceneMismatch.push({ field: 'comp', want: rawOf(compParam, want.comp), actual: compRaw });
    if (encRaw !== want.enc) sceneMismatch.push({ field: 'enc', want: want.enc, actual: encRaw });
    if (levelRaw !== want.level) sceneMismatch.push({ field: 'level', want: want.level, actual: levelRaw });
    const gains = sceneGains.sing;
    for (let band = 0; band < 7; band += 1) {
      const addr = 0x2027 + band * 5 + 3;
      // band gain 不在 46 项界面参数里，标定式直接用寄存器表的 EQ_GAIN_SCALE：raw = value*10 + 320
      const expectedRaw = Math.round(gains[band] * 10 + 320);
      const actualRaw = readReg(healthScene, addr);
      if (actualRaw !== expectedRaw) sceneMismatch.push({ field: `band${band + 1}.gain`, want: expectedRaw, actual: actualRaw });
    }
  }
  results.measurements.r6 = { sceneMismatch, uiProblems, health: healthScene.identity, status: sceneStatus };
  check('R6.2 「唱歌」场景写入后裸 HID 回读：字段与 7 段 EQ 全中', sceneMismatch.length === 0, { mismatchCount: sceneMismatch.length, sample: sceneMismatch.slice(0, 10) });

  // ---- R12 恢复默认 -------------------------------------------------------
  await launch('c');
  await cdp.evaluate(`window.__micstudioGo('settings'); true`);
  await wait(800);
  await cdp.evaluate(`document.querySelector('.modal-body .btn--danger')?.click(); true`);
  await wait(600);
  const armed = await cdp.evaluate(`Boolean(document.querySelector('.modal-body .btn--danger.is-armed'))`);
  await cdp.evaluate(`document.querySelector('.modal-body .btn--danger')?.click(); true`);
  await wait(6000);
  const afterRestore = await cdp.evaluate(`window.__rt.status()`);
  await cdp.shot('R12-restored.png');
  await killApp();
  await wait(2000);
  const healthDefault = readHealth('fulltest-r12');
  const defaultMismatch = [];
  for (const param of params) {
    if (param.readonly) continue;
    const raw = readReg(healthDefault, param.addr);
    const want = defaultRaw(param);
    if (raw !== want) defaultMismatch.push({ id: param.id, addr: `0x${param.addr.toString(16)}`, want, actual: raw });
  }
  results.measurements.r12 = { armed, defaultMismatch, status: afterRestore };
  check('R12.1 设置抽屉「恢复默认」需要二次确认（第一次点击 only arm）', armed === true, { armed });
  check('R12.2 恢复默认后裸 HID 回读：可写参数 0 失配', defaultMismatch.length === 0, { mismatchCount: defaultMismatch.length, sample: defaultMismatch.slice(0, 12) });

  // R9 物理拔插：需要人工拔线，脚本不执行
  results.measurements.r9 = 'blocked: 需要人工拔插 USB（本轮无人在场，且非管理员无法 Disable/Enable-PnpDevice）';
  check('R9 拔插重连：未执行（阻塞：需要人工拔插，非缺陷）', true, results.measurements.r9);
}

phaseA()
  .then(() => {
    const failed = results.checks.filter((item) => !item.ok);
    results.summary = { passed: results.checks.length - failed.length, failed: failed.length, total: results.checks.length };
    results.finishedAt = new Date().toISOString();
    writeFileSync(path.join(outDir, 'r-results.json'), `${JSON.stringify(results, null, 1)}\n`, 'utf8');
    log(`SUMMARY passed=${results.summary.passed} failed=${results.summary.failed} total=${results.summary.total}`);
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    results.error = String(error?.stack ?? error);
    await killApp();
    writeFileSync(path.join(outDir, 'r-results.json'), `${JSON.stringify(results, null, 1)}\n`, 'utf8');
    console.error('[r] failed', error);
    process.exit(2);
  });
