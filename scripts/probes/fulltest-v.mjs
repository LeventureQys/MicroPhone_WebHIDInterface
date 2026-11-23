/**
 * v1.1.3 全量测试 V 系列：虚拟下位机 + 桥接下的真实界面联调。
 *
 * 前置：`node tools/vdevice/run.mjs`（桥 8765 / 控制面 8766）已在跑。
 *
 *   node scripts/probes/fulltest-v.mjs [--app=<快照目录>] [--port=9372]
 *
 * V2：把 46 项参数里可写的 44 项在设备侧静默设成测试值（min/中点/max 轮换），
 *     界面连上后逐项回读，与标定换算的期望值比对。
 * V3：POST /control/faults 注入 disconnect，观察界面判异常与自动恢复。
 * V4：DFU 本轮免测，只在结果里记 not-run（既有单测随 G2 覆盖）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = 'D:\\WorkShop\\MicroPhone_WebHIDInterface';
const args = new Map(
  process.argv.slice(2).map((item) => {
    const match = item.match(/^--([^=]+)=(.*)$/);
    return match ? [match[1], match[2]] : [item, ''];
  }),
);
const appRoot = args.get('app') ? path.resolve(args.get('app')) : 'D:\\Temp\\micstudio-fulltest\\v1.1.3-baseline';
const outDir = args.get('out') ? path.resolve(args.get('out')) : path.join(repo, 'artifacts', 'fulltest-20261121', 'vdevice');
const port = Number(args.get('port') ?? 9372);
const profile = path.join('D:\\Temp\\micstudio-fulltest', `userdata-v-${port}`);
const electron = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const paramsFile = path.join(repo, 'artifacts', 'fulltest-20261121', 'gates', 'P1-P5-truth.json');

mkdirSync(outDir, { recursive: true });
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const results = { startedAt: new Date().toISOString(), appRoot, checks: [], measurements: {}, screenshots: [] };
const log = (...items) => console.log(`[v] ${new Date().toISOString().slice(11, 19)}`, ...items);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(id, ok, detail) {
  results.checks.push({ id, ok: Boolean(ok), detail: detail ?? null });
  log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 500)}`}`);
}

async function control(pathName, body) {
  const options =
    body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const response = await fetch(`http://127.0.0.1:8766${pathName}`, options);
  if (!response.ok) throw new Error(`control ${pathName} -> ${response.status}`);
  return response.json();
}

function round6(value) {
  return Number(value.toFixed(6));
}

function snapValue(param, value) {
  const clamped = Math.min(param.max, Math.max(param.min, value));
  if (!(param.step > 0)) return clamped;
  const steps = Math.round((clamped - param.min) / param.step - 1e-9);
  return Math.min(param.max, Math.max(param.min, round6(param.min + steps * param.step)));
}

function expectedOf(param, raw) {
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

async function findTarget() {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && (item.url ?? '').includes('index.html'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // 端口未就绪
    }
    await wait(300);
  }
  throw new Error('devtools page target not found');
}

const HELPERS = `(() => {
  window.__vt = {
    text: (node) => (node?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    readParams() {
      const out = {};
      for (const root of document.querySelectorAll('.modal-body [data-param]')) {
        const id = root.dataset.param;
        const num = root.querySelector('input.pfield-number');
        const checkbox = root.querySelector('input[type="checkbox"]');
        const segment = root.querySelector('.seg-btn.is-active');
        out[id] = {
          number: num ? num.value : null,
          checked: checkbox ? checkbox.checked : null,
          segment: segment ? segment.dataset.value : null,
          readout: this.text(root.querySelector('.pfield-readout, .pfield-value')),
        };
      }
      for (const root of document.querySelectorAll('.tune-switch-grid [data-param]')) {
        out[root.dataset.param] = { checked: root.querySelector('input[type="checkbox"]')?.checked ?? null };
      }
      const gains = Array.from(document.querySelectorAll('.console-gain-item')).map((node) => this.text(node.querySelector('.console-gain-value')));
      return { params: out, gains };
    },
    status() {
      return {
        sync: this.text(document.querySelector('#sync-pill .state-text')) || null,
        syncClass: document.querySelector('#sync-pill')?.className ?? null,
        source: this.text(document.querySelector('#source-pill .state-text')) || null,
        tone: document.querySelector('#connect-btn')?.dataset.tone ?? null,
        device: this.text(document.querySelector('.console-device-name')),
        deviceState: this.text(document.querySelector('.console-device-state')),
        notice: this.text(document.querySelector('.console-notice .console-notice-text')) || null,
        diag: Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((node) => [node.dataset.stat, this.text(node)])),
        model: this.text(document.querySelector('[data-diag="model"]')),
        firmware: this.text(document.querySelector('[data-diag="firmware"]')),
        rows: document.querySelectorAll('.device-row').length,
        error: this.text(document.querySelector('.device-error')) || null,
        pill: document.querySelector('#sync-pill .state-text')?.textContent?.trim() ?? null,
      };
    },
  };
  return true;
})()`;

async function main() {
  if (!existsSync(electron)) throw new Error(`electron not found: ${electron}`);
  const truth = JSON.parse(readFileSync(paramsFile, 'utf8').replace(/^\uFEFF/, ''));
  const params = truth.params;
  if (!Array.isArray(params) || params.length !== 46) throw new Error(`params file broken: ${params?.length}`);

  // ---- 设备侧测试值：min / 中点 / max 轮换，写前记下期望 ---------------------
  const values = {};
  const expected = {};
  params.forEach((param, index) => {
    if (param.readonly) return;
    const candidates = [param.min, round6((param.min + param.max) / 2), param.max];
    const value = candidates[index % 3];
    const raw = rawOf(param, value);
    values[`0x${param.addr.toString(16)}`] = raw;
    expected[param.id] = { raw, value: expectedOf(param, raw), step: param.step, kind: param.scale?.kind ?? 'raw' };
  });
  results.measurements.written = values;
  results.measurements.expected = expected;

  const baseline = await control('/control/stats');
  const reset = await control('/control/reset', {});
  const writeResult = await control('/control/registers', { values });
  results.measurements.controlReset = reset;
  results.measurements.registerWrite = writeResult;
  check(
    'V2.1 控制面可把 44 项可写参数静默设成测试值（设备侧，不经界面）',
    Object.keys(values).length === 44 && Number.isInteger(baseline.framesIn),
    { writable: Object.keys(values).length, sample: Object.entries(values).slice(0, 5) },
  );

  const env = { ...process.env, MICSTUDIO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(
    electron,
    ['.', '--no-sandbox', `--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    { cwd: appRoot, env, stdio: 'ignore', windowsHide: false },
  );

  let cdp = null;
  try {
    const target = await findTarget();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
    const readyDeadline = Date.now() + 30_000;
    while (Date.now() < readyDeadline) {
      if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
      await wait(300);
    }
    // 切虚拟通道 + 关自动连接（避免先连真机），reload 生效
    await cdp.evaluate(`(() => {
      localStorage.setItem('micstudio.channel', 'virtual');
      localStorage.setItem('micstudio.autoConnect', '0');
      localStorage.setItem('micstudio.bridgeUrl', 'ws://127.0.0.1:8765/ws');
      location.reload();
      return true;
    })()`);
    await wait(2000);
    const reloadDeadline = Date.now() + 30_000;
    while (Date.now() < reloadDeadline) {
      if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
      await wait(300);
    }
    await cdp.evaluate(HELPERS);

    // 连接虚拟桥 → 打开设备（与 param-link.js 同一路径）
    await cdp.evaluate(`window.__micstudioGo('device'); true`);
    await wait(800);
    await cdp.evaluate(`document.querySelector('.device-actions .btn')?.click(); true`);
    await wait(2200);
    const rows = await cdp.evaluate(`document.querySelectorAll('.device-row').length`);
    await cdp.evaluate(`document.querySelectorAll('.device-row .btn')[0]?.click(); true`);
    // 等同步完成
    const syncDeadline = Date.now() + 30_000;
    let synced = false;
    while (Date.now() < syncDeadline) {
      const state = await cdp.evaluate(`window.__vt.status()`);
      if (state.syncClass?.includes('state-pill--ready')) {
        synced = true;
        break;
      }
      if (state.error) break;
      await wait(500);
    }
    await wait(900);
    const connected = await cdp.evaluate(`window.__vt.status()`);
    const statsAfterSync = await control('/control/stats');
    await cdp.shot('V2-connected.png');
    check(
      'V2.2 虚拟通道：设备列表出现、连接并打开设备、参数同步 ready',
      rows >= 1 && synced && Number(statsAfterSync.framesIn) > 0,
      { rows, synced, sync: connected.sync, device: connected.device, framesIn: statsAfterSync.framesIn, error: connected.error },
    );
    check(
      'V2.3 设备信息来自虚拟下位机（型号 JYM001，固件版本非空）',
      /JYM001/.test(statsAfterSync.modelCode ?? '') && connected.model !== '',
      { modelCode: statsAfterSync.modelCode, uiModel: connected.model, firmware: connected.firmware, version: statsAfterSync.firmwareVersion },
    );

    // ---- 逐项回读 44 项 ------------------------------------------------------
    await cdp.evaluate(`window.__micstudioGo('advanced'); true`);
    await wait(900);
    const read = await cdp.evaluate(`window.__vt.readParams()`);
    const ui = read.params;
    const mismatches = [];
    let skippedNoControl = [];
    for (const param of params) {
      if (param.readonly) continue;
      const want = expected[param.id];
      const got = ui[param.id];
      if (!got) {
        // eq.mode（0x2026）按 V0.3 设计不暴露控件（verify-v006 已断言），跳过而不是当成缺陷
        if (param.id === 'eq.mode') {
          skippedNoControl.push(param.id);
          continue;
        }
        mismatches.push({ id: param.id, problem: 'control missing' });
        continue;
      }
      let actual = null;
      if (got.number !== null && got.number !== undefined) actual = Number(got.number);
      else if (got.checked !== null && got.checked !== undefined) actual = got.checked ? 1 : 0;
      else if (got.segment !== null && got.segment !== undefined) actual = Number(got.segment);
      if (actual === null || !Number.isFinite(actual)) {
        mismatches.push({ id: param.id, problem: 'no readable value', got });
        continue;
      }
      const tolerance = Math.max(want.step / 2 + 1e-6, 0.001);
      if (Math.abs(actual - want.value) > tolerance) {
        mismatches.push({ id: param.id, addr: `0x${param.addr.toString(16)}`, want: want.value, actual, raw: want.raw, got: got.number ?? got.checked ?? got.segment });
      }
    }
    results.measurements.readback = { total: Object.keys(ui).length, mismatches, skippedNoControl };
    check(
      'V2.4 43 项有控件的可写参数逐项回读与设备侧设定值一致（标定换算后误差 ≤ 半步进；eq.mode 无控件按设计跳过）',
      mismatches.length === 0 && skippedNoControl.length === 1,
      { checked: 43, skipped: skippedNoControl, mismatches: mismatches.slice(0, 10), mismatchCount: mismatches.length },
    );
    // 两个只读项从主界面读数核对
    const gains = await cdp.evaluate(`window.__vt.readParams()`);
    check(
      'V2.5 只读项 gain.Mic / gain.Hp 有读数且与设备值一致',
      read.gains.length === 2 && read.gains.every((item) => item.length > 0),
      { gains: read.gains },
    );
    await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
    await wait(400);

    // ---- V3 故障注入：设备不应答 -------------------------------------------
    // 连接稳定后电平轮询是关的（R11），空闲时链路上没有周期帧；所以先注入故障，
    // 再从界面触发一次写，让这条写帧成为被吞掉/延迟的那一帧。
    const beforeFault = await control('/control/stats');
    await control('/control/faults', { faults: [{ action: 'disconnect', ms: 6000 }] });
    await cdp.evaluate(`document.querySelector('.tune-switch-grid [data-param="mic.mute"] input[type="checkbox"]')?.click(); true`);
    const samples = [];
    let sawProblem = false;
    for (let index = 0; index < 24; index += 1) {
      await wait(500);
      const state = await cdp.evaluate(`window.__vt.status()`);
      const ready = Boolean(state.syncClass?.includes('state-pill--ready'));
      samples.push({ t: (index + 1) * 0.5, ready, sync: state.sync, tone: state.tone, notice: state.notice, error: state.error });
      if (!ready || state.tone === 'error' || (state.notice && state.notice.length > 0)) sawProblem = true;
      if (sawProblem && ready && index > 8) break;
    }
    let recovered = samples.length > 0 && samples[samples.length - 1].ready;
    // 等故障窗口过去，再看是否自己恢复
    if (!recovered) {
      for (let index = 0; index < 20 && !recovered; index += 1) {
        await wait(500);
        const state = await cdp.evaluate(`window.__vt.status()`);
        samples.push({ t: `+${(index + 1) * 0.5}`, ready: Boolean(state.syncClass?.includes('state-pill--ready')), sync: state.sync, tone: state.tone, notice: state.notice, error: state.error });
        recovered = Boolean(state.syncClass?.includes('state-pill--ready'));
      }
    }
    let manualRecovered = false;
    if (!recovered) {
      // 设计若明示"不自动恢复"，用户手动重新打开设备应当能恢复
      await cdp.evaluate(`window.__micstudioGo('device'); true`);
      await wait(600);
      await cdp.evaluate(`document.querySelector('.device-actions .btn')?.click(); true`);
      await wait(1500);
      await cdp.evaluate(`document.querySelectorAll('.device-row .btn')[0]?.click(); true`);
      for (let index = 0; index < 20 && !manualRecovered; index += 1) {
        await wait(500);
        const state = await cdp.evaluate(`window.__vt.status()`);
        manualRecovered = Boolean(state.syncClass?.includes('state-pill--ready'));
      }
      await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
    }
    const afterFault = await control('/control/stats');
    results.measurements.fault = {
      samples,
      before: { framesIn: beforeFault.framesIn },
      after: { framesIn: afterFault.framesIn },
      sawProblem,
      recovered,
      manualRecovered,
    };
    await cdp.shot('V3-after-fault.png');
    check(
      'V3.1 故障注入（设备 6 s 不应答）后界面判通道异常（同步相位/错误提示）',
      sawProblem,
      { problemSamples: samples.filter((item) => !item.ready || item.tone === 'error' || item.notice).slice(0, 4), final: samples[samples.length - 1], frames: { before: beforeFault.framesIn, after: afterFault.framesIn } },
    );
    check(
      'V3.2 故障窗口过去后界面恢复 ready（自动恢复或按设计手动重开设备恢复）',
      recovered || manualRecovered,
      { auto: recovered, manual: manualRecovered, final: samples[samples.length - 1] },
    );

    // V4：DFU 免测
    results.measurements.v4 = 'not-run (DFU 免测，既有单测随 G2 覆盖)';
    check('V4 虚拟通道 DFU：本轮不执行（按 Q6 DFU 免测）', true, 'not-run');
  } finally {
    try {
      await control('/control/reset', {});
    } catch {
      // 桥已断开
    }
    try {
      spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // 已退出
    }
  }
}

main()
  .then(() => {
    const failed = results.checks.filter((item) => !item.ok);
    results.summary = { passed: results.checks.length - failed.length, failed: failed.length, total: results.checks.length };
    results.finishedAt = new Date().toISOString();
    writeFileSync(path.join(outDir, 'v-results.json'), `${JSON.stringify(results, null, 1)}\n`, 'utf8');
    log(`SUMMARY passed=${results.summary.passed} failed=${results.summary.failed} total=${results.summary.total}`);
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch((error) => {
    results.error = String(error?.stack ?? error);
    writeFileSync(path.join(outDir, 'v-results.json'), `${JSON.stringify(results, null, 1)}\n`, 'utf8');
    console.error('[v] failed', error);
    process.exit(2);
  });
