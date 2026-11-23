/**
 * v1.1.3 追加：两小时级耐久测试（打包产物）。
 *
 *   node scripts/probes/fulltest-endurance.mjs --mode=real --minutes=135 --port=9385
 *   node scripts/probes/fulltest-endurance.mjs --mode=mock --minutes=135 --port=9386
 *
 * real：真机 M001（打包产物 + 自动连接）。周期性场景写入（8 min）、单参数写（6 min）、
 *       一键自检（15 min）、抽屉/语言 churn（30 s），中间两段静置（不做任何操作）。
 * mock：mock 通道 + 关闭自动连接，只做 UI 高频 churn（30 s）、场景（4 min）、语言（5 min），
 *       用来单独压渲染层。
 *
 * 每 30 s 采样：链路状态 / 诊断计数 / CDP JS 堆与 DOM / 窗口异常；每 10 min 采样进程内存；
 * 每 15 min 截图。崩溃自动重启并记录。real 模式结束恢复 V0.3 默认值 + 裸 HID 回读。
 * 数据写 artifacts/fulltest-20261121/endurance/。
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = 'D:\\WorkShop\\MicroPhone_WebHIDInterface';
const python = 'C:\\Users\\a5935\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const args = new Map(
  process.argv.slice(2).map((item) => {
    const match = item.match(/^--([^=]+)=(.*)$/);
    return match ? [match[1], match[2]] : [item, ''];
  }),
);
const mode = args.get('mode') === 'mock' ? 'mock' : 'real';
const minutes = Number(args.get('minutes') ?? 135);
const port = Number(args.get('port') ?? (mode === 'real' ? 9385 : 9386));
const exe = args.get('exe') ?? 'D:\\Temp\\micstudio-fulltest\\v1.1.3-baseline\\release\\MicStudio-1.1.2-portable.exe';
const outDir = args.get('out') ? path.resolve(args.get('out')) : path.join(repo, 'artifacts', 'fulltest-20261121', 'endurance');
const profile = path.join('D:\\Temp\\micstudio-fulltest', `userdata-endurance-${mode}`);
mkdirSync(outDir, { recursive: true });
if (!existsSync(exe)) throw new Error(`exe not found: ${exe}`);

const jsonlPath = path.join(outDir, `endurance-${mode}.jsonl`);
rmSync(jsonlPath, { force: true });
const log = (...items) => console.log(`[endurance-${mode}]`, new Date().toISOString().slice(11, 19), ...items);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const summary = {
  mode,
  minutes,
  startedAt: new Date().toISOString(),
  samples: 0,
  events: [],
  actions: { drawers: 0, scenes: 0, writes: 0, selfChecks: 0, languages: 0, screenshots: 0 },
  selfCheckFailures: 0,
  restarts: 0,
  writeLatencies: [],
  selfCheckMs: [],
  errors: [],
  heap: [],
  os: [],
};
const samples = [];
let app = null;
let cdp = null;
let consecutiveFailures = 0;
let startedMs = Date.now();
let profileForOs = profile;

function record(type, data) {
  const entry = { ts: new Date().toISOString(), elapsedMin: Number(((Date.now() - startedMs) / 60_000).toFixed(2)), type, ...data };
  appendFileSync(jsonlPath, `${JSON.stringify(entry)}\n`, 'utf8');
  if (type === 'event') summary.events.push(entry);
  if (type === 'sample') summary.samples += 1;
  return entry;
}

class Cdp {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.exceptions = []; this.closed = false; }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('cdp socket error')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        const text = message.params?.exceptionDetails?.exception?.description ?? 'exception';
        this.exceptions.push(text);
        if (this.exceptions.length === 1) record('event', { kind: 'runtime-exception', text });
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    this.ws.addEventListener('close', () => { this.closed = true; });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Performance.enable', {}, 10_000).catch(() => undefined);
  }
  send(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('cdp closed')); return; }
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`cdp timeout: ${method}`)); }, timeoutMs);
    });
  }
  async evaluate(expression, timeoutMs = 30_000) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, timeoutMs);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  async keyEscape() {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 10_000);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 10_000);
  }
  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' }, 20_000);
    writeFileSync(path.join(outDir, name), Buffer.from(result.data, 'base64'));
    summary.actions.screenshots += 1;
    return true;
  }
}

const HELPERS = `(() => {
  window.__ed = {
    text: (node) => (node?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    status() {
      const pill = document.querySelector('#sync-pill');
      return {
        sync: this.text(document.querySelector('#sync-pill .state-text')),
        ready: Boolean(pill?.classList.contains('state-pill--ready')),
        tone: document.querySelector('#connect-btn')?.dataset.tone ?? null,
        device: this.text(document.querySelector('.console-device-name')),
        notice: this.text(document.querySelector('.console-notice .console-notice-text')) || null,
        audio: this.text(document.querySelector('[data-diag="audio"]')),
        poll: this.text(document.querySelector('[data-diag="poll"]')),
        stats: Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((node) => [node.dataset.stat, this.text(node)])),
        modals: document.querySelectorAll('.modal').length,
        lang: document.querySelector('.segmented--lang .seg-btn.is-active')?.dataset.value ?? null,
        nodes: document.getElementsByTagName('*').length,
        errors: (window.__edErrors ?? []).slice(-5),
        resources: performance.getEntriesByType('resource').length,
      };
    },
    selfcheckSteps() {
      return Array.from(document.querySelectorAll('.diag-selfcheck-steps > *')).map((node) => ({ text: this.text(node), error: node.className.includes('is-error') }));
    },
    errors() { return (window.__edErrors ?? []).slice(0, 20); },
  };
  window.__edErrors = [];
  window.addEventListener('error', (event) => window.__edErrors.push(String(event.message)));
  window.addEventListener('unhandledrejection', (event) => window.__edErrors.push(String(event.reason)));
  return true;
})()`;

async function findTarget(deadlineMs = 60_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && (item.url ?? '').includes('index.html'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // 解包/启动中
    }
    await wait(300);
  }
  return null;
}

function killTree() {
  if (!app) return;
  try { spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  app = null;
  cdp = null;
}

async function launchApp() {
  if (!app) {
    const env = { ...process.env, MICSTUDIO_USER_DATA: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    app = spawn(exe, ['--no-sandbox', `--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], {
      env,
      stdio: 'ignore',
      windowsHide: false,
    });
    record('event', { kind: 'launch', pid: app.pid });
  }
  const target = await findTarget();
  if (!target) throw new Error('devtools target not found');
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
    await wait(300);
  }
  if (mode === 'mock') {
    const current = await cdp.evaluate(`localStorage.getItem('micstudio.channel')`);
    if (current !== 'mock') {
      await cdp.evaluate(`(() => { localStorage.setItem('micstudio.channel','mock'); localStorage.setItem('micstudio.autoConnect','0'); location.reload(); return true; })()`);
      await wait(2200);
      const reloadDeadline = Date.now() + 30_000;
      while (Date.now() < reloadDeadline) {
        if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
        await wait(300);
      }
    }
  }
  await cdp.evaluate(HELPERS);
  // 等链路 ready
  const readyDeadline = Date.now() + 30_000;
  while (Date.now() < readyDeadline) {
    const state = await cdp.evaluate(`window.__ed.status()`);
    if (mode === 'mock') { if (state.ready) return state; }
    else if (state.ready && state.device !== '演示数据') return state;
    await wait(300);
  }
  return await cdp.evaluate(`window.__ed.status()`);
}

async function osMemory() {
  try {
    const script = `$items = Get-CimInstance Win32_Process -Filter "Name='MicStudio.exe' OR Name='electron.exe'" | Where-Object { $_.CommandLine -like '*--remote-debugging-port=${port}*' }; if (-not $items) { '0,0' } else { '{0},{1}' -f ($items | Measure-Object WorkingSetSize -Sum).Sum, ($items | Measure-Object).Count }`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30_000 }).trim();
    const [bytes, count] = out.split(',').map((item) => Number(item));
    return { workingSetMB: Math.round(bytes / 1048576), processes: count };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

async function readStatusWithStats() {
  const hasStats = await cdp.evaluate(`Boolean(document.querySelector('[data-stat]'))`);
  if (!hasStats) {
    await cdp.evaluate(`window.__micstudioGo('device'); true`);
    await wait(450);
  }
  const state = await cdp.evaluate(`window.__ed.status()`);
  if (!hasStats) {
    await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
    await wait(250);
  }
  return state;
}

async function sample() {
  const status = await readStatusWithStats();
  const metrics = await cdp.send('Performance.getMetrics', {}, 10_000).catch(() => null);
  const dom = await cdp.send('Memory.getDOMCounters', {}, 10_000).catch(() => null);
  const pick = (name) => Number(metrics?.metrics?.find((item) => item.name === name)?.value ?? 0);
  const entry = {
    sync: status.sync,
    ready: status.ready,
    tone: status.tone,
    device: status.device,
    notice: status.notice,
    audio: status.audio,
    poll: status.poll,
    stats: status.stats,
    modals: status.modals,
    lang: status.lang,
    nodes: status.nodes,
    resources: status.resources,
    heapMB: Number((pick('JSHeapUsedSize') / 1048576).toFixed(2)),
    heapTotalMB: Number((pick('JSHeapTotalSize') / 1048576).toFixed(2)),
    documents: dom?.documents ?? null,
    domNodes: dom?.nodes ?? null,
    listeners: dom?.jsEventListeners ?? null,
    pageErrors: status.errors,
  };
  summary.heap.push({ elapsedMin: Number(((Date.now() - startedMs) / 60_000).toFixed(2)), heapMB: entry.heapMB, nodes: entry.nodes, listeners: entry.listeners });
  for (const text of status.errors ?? []) {
    if (!summary.errors.includes(text)) summary.errors.push(text);
  }
  for (const text of cdp.exceptions ?? []) {
    if (!summary.errors.includes(text)) summary.errors.push(text);
  }
  samples.push(entry);
  record('sample', entry);
  consecutiveFailures = 0;
  return entry;
}

function countStats(stats, key) {
  const value = Number(String(stats?.[key] ?? '0').replace(/[^0-9]/g, ''));
  return Number.isFinite(value) ? value : 0;
}

async function uiAction() {
  const order = ['advanced', 'device', 'settings'];
  const id = order[summary.actions.drawers % order.length];
  await cdp.evaluate(`window.__micstudioGo(${JSON.stringify(id)}); true`);
  await wait(400);
  const open = await cdp.evaluate(`document.querySelectorAll('.modal').length`);
  await cdp.keyEscape();
  await wait(300);
  const closed = await cdp.evaluate(`document.querySelectorAll('.modal').length`);
  summary.actions.drawers += 1;
  if (open !== 1 || closed !== 0) record('event', { kind: 'drawer-anomaly', id, open, closed });
}

async function applyScene(index) {
  const scenes = ['quiet', 'meeting', 'podcast', 'sing', 'custom'];
  const scene = scenes[index % scenes.length];
  await cdp.evaluate(`document.querySelector('.scene-btn[data-scene="${scene}"]')?.click(); true`);
  await wait(1400);
  summary.actions.scenes += 1;
  const active = await cdp.evaluate(`document.querySelector('.scene-btn.is-active')?.dataset.scene`);
  if (active !== scene) record('event', { kind: 'scene-anomaly', want: scene, active });
}

async function toggleWrite() {
  const started = Date.now();
  // 诊断卡只在设备抽屉里渲染；测量写时延时让抽屉保持打开（覆盖层不影响 JS click）
  await cdp.evaluate(`window.__micstudioGo('device'); true`);
  await wait(600);
  const before = await cdp.evaluate(`window.__ed.status()`);
  const outBefore = countStats(before.stats, 'out');
  if (mode === 'real') {
    await cdp.evaluate(`document.querySelector('.tune-switch-grid [data-param="mic.sigMute"] input[type="checkbox"]')?.click(); true`);
  } else {
    await cdp.evaluate(`(() => { const root = document.querySelector('.switch-grid .segmented'); const btn = root?.querySelector('.seg-btn[data-value="3"]'); if (btn) btn.click(); return true; })()`);
  }
  summary.actions.writes += 1;
  let latency = null;
  for (let index = 0; index < 60; index += 1) {
    await wait(100);
    const now = await cdp.evaluate(`window.__ed.status()`);
    if (countStats(now.stats, 'out') > outBefore) { latency = Date.now() - started; break; }
  }
  if (latency !== null) summary.writeLatencies.push(latency);
  else record('event', { kind: 'write-no-frame', mode, outBefore, statsNow: (await cdp.evaluate('window.__ed.status()')).stats });
  await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
  await wait(300);
}

async function runSelfCheck() {
  const started = Date.now();
  await cdp.evaluate(`window.__micstudioGo('device'); true`);
  await wait(600);
  await cdp.evaluate(`document.querySelector('.diag-selfcheck')?.click(); true`);
  let steps = [];
  for (let index = 0; index < 60; index += 1) {
    await wait(400);
    steps = await cdp.evaluate(`window.__ed.selfcheckSteps()`);
    const busy = await cdp.evaluate(`Boolean(document.querySelector('.diag-selfcheck[disabled]'))`);
    if (steps.length > 0 && !busy) break;
  }
  const ms = Date.now() - started;
  summary.actions.selfChecks += 1;
  summary.selfCheckMs.push(ms);
  if (steps.length !== 3 || steps.some((step) => step.error)) {
    summary.selfCheckFailures += 1;
    record('event', { kind: 'selfcheck-fail', steps, ms });
  }
  await cdp.keyEscape();
  await wait(300);
}

async function toggleLanguage() {
  const current = await cdp.evaluate(`document.querySelector('.segmented--lang .seg-btn.is-active')?.dataset.value`);
  const next = current === 'en' ? 'zh' : 'en';
  await cdp.evaluate(`document.querySelector('.segmented--lang .seg-btn[data-value="${next}"]')?.click(); true`);
  await wait(700);
  summary.actions.languages += 1;
}

async function main() {
  log(`start mode=${mode} minutes=${minutes} exe=${exe}`);
  const initial = await launchApp();
  record('event', { kind: 'ready', state: initial });
  if (!initial.ready) record('event', { kind: 'not-ready-at-start', state: initial });

  const totalMs = minutes * 60_000;
  let lastSampleAt = 0;
  let lastDrawer = 0;
  let lastScene = 0;
  let lastWrite = 0;
  let lastSelfCheck = 0;
  let lastLanguage = 0;
  let lastShot = 0;
  let lastOs = 0;
  let lastPhase = null;

  while (Date.now() - startedMs < totalMs) {
    const elapsed = Date.now() - startedMs;
    const minutesNow = elapsed / 60_000;
    // 阶段：A 交互 0–50；B 静置 50–70；C 写入 70–105；D 轻量 105–end
    const phase = mode === 'mock'
      ? (minutesNow < 50 ? 'A-active' : minutesNow < 70 ? 'B-quiet' : minutesNow < 105 ? 'C-active' : 'D-light')
      : (minutesNow < 50 ? 'A-active' : minutesNow < 70 ? 'B-quiet' : minutesNow < 105 ? 'C-active-write' : 'D-light');
    if (phase !== lastPhase) {
      lastPhase = phase;
      record('event', { kind: 'phase', phase });
      log(`phase -> ${phase}`);
    }
    const quiet = phase === 'B-quiet';
    const light = phase === 'D-light';

    // 采样 30 s
    if (elapsed - lastSampleAt >= 30_000) {
      lastSampleAt = elapsed;
      try {
        const entry = await sample();
        if (summary.samples % 10 === 0) log(`sample t=${minutesNow.toFixed(0)}m sync=${entry.sync} tone=${entry.tone} heap=${entry.heapMB}MB nodes=${entry.nodes} stats=${JSON.stringify(entry.stats)}`);
      } catch (error) {
        consecutiveFailures += 1;
        record('event', { kind: 'sample-fail', message: String(error?.message ?? error), consecutiveFailures });
        if (consecutiveFailures >= 3) {
          summary.restarts += 1;
          record('event', { kind: 'restart', atMin: Number(minutesNow.toFixed(2)), reason: 'three consecutive sample failures' });
          log('app appears dead — restarting');
          killTree();
          await wait(3000);
          try {
            const state = await launchApp();
            record('event', { kind: 'restarted', state });
          } catch (restartError) {
            record('event', { kind: 'restart-failed', message: String(restartError?.message ?? restartError) });
            throw restartError;
          }
          consecutiveFailures = 0;
        }
      }
    }

    // 操作（静置阶段只截图/采样）
    if (!quiet) {
      const drawerEvery = mode === 'mock' ? 30_000 : 30_000;
      if (elapsed - lastDrawer >= drawerEvery) {
        lastDrawer = elapsed;
        try { await uiAction(); } catch (error) { record('event', { kind: 'action-fail', action: 'drawer', message: String(error?.message ?? error) }); }
      }
      const sceneEvery = mode === 'mock' ? 4 * 60_000 : 8 * 60_000;
      if (!light && elapsed - lastScene >= sceneEvery) {
        lastScene = elapsed;
        try { await applyScene(summary.actions.scenes); } catch (error) { record('event', { kind: 'action-fail', action: 'scene', message: String(error?.message ?? error) }); }
      }
      const writeEvery = mode === 'mock' ? 6 * 60_000 : 6 * 60_000;
      if (mode === 'real' && !light && elapsed - lastWrite >= writeEvery) {
        lastWrite = elapsed;
        try { await toggleWrite(); } catch (error) { record('event', { kind: 'action-fail', action: 'write', message: String(error?.message ?? error) }); }
      }
      if (mode === 'real' && !light && elapsed - lastSelfCheck >= 15 * 60_000) {
        lastSelfCheck = elapsed;
        try { await runSelfCheck(); } catch (error) { record('event', { kind: 'action-fail', action: 'selfcheck', message: String(error?.message ?? error) }); }
      }
      if (mode === 'mock' && elapsed - lastLanguage >= 5 * 60_000) {
        lastLanguage = elapsed;
        try { await toggleLanguage(); } catch (error) { record('event', { kind: 'action-fail', action: 'language', message: String(error?.message ?? error) }); }
      }
    }
    if (elapsed - lastShot >= 15 * 60_000) {
      lastShot = elapsed;
      try { await cdp.shot(`endurance-${mode}-t${Math.floor(minutesNow)}.png`); } catch (error) { record('event', { kind: 'shot-fail', message: String(error?.message ?? error) }); }
    }
    if (elapsed - lastOs >= 10 * 60_000) {
      lastOs = elapsed;
      const os = await osMemory();
      summary.os.push({ elapsedMin: Number(minutesNow.toFixed(2)), ...os });
      record('event', { kind: 'os-memory', ...os });
    }
    await wait(5000);
  }

  // ---- 收尾 ----------------------------------------------------------------
  record('event', { kind: 'soak-finished' });
  let finalState = null;
  try {
    finalState = await cdp.evaluate(`window.__ed.status()`);
  } catch {
    finalState = null;
  }
  let restore = null;
  if (mode === 'real') {
    try {
      await cdp.evaluate(`window.__micstudioGo('settings'); true`);
      await wait(800);
      await cdp.evaluate(`document.querySelector('.modal-body .btn--danger')?.click(); true`);
      await wait(600);
      const armed = await cdp.evaluate(`Boolean(document.querySelector('.modal-body .btn--danger.is-armed'))`);
      await cdp.evaluate(`document.querySelector('.modal-body .btn--danger')?.click(); true`);
      await wait(9000);
      restore = { armed, state: await cdp.evaluate(`window.__ed.status()`) };
      record('event', { kind: 'restore', ...restore });
    } catch (error) {
      record('event', { kind: 'restore-fail', message: String(error?.message ?? error) });
    }
  }
  try { await cdp.shot(`endurance-${mode}-final.png`); } catch { /* ignore */ }
  try { await cdp.evaluate(`window.close(); true`); } catch { /* ignore */ }
  await wait(4000);
  killTree();
  await wait(2000);

  // ---- 裸 HID 校验默认值（仅 real） --------------------------------------
  if (mode === 'real') {
    try {
      execFileSync(python, ['scripts/probes/real8-health.py', 'fulltest-endurance-final'], {
        cwd: repo,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONPATH: '' },
        stdio: 'pipe',
        timeout: 120_000,
      });
      const health = JSON.parse(readFileSync(path.join(repo, 'artifacts', 'dfu-check-20261121', 'health-fulltest-endurance-final.json'), 'utf8'));
      writeFileSync(path.join(outDir, 'R-fulltest-endurance-final.json'), JSON.stringify(health, null, 1), 'utf8');
      const truth = JSON.parse(readFileSync(path.join(repo, 'artifacts', 'fulltest-20261121', 'gates', 'P1-P5-truth.json'), 'utf8').replace(/^\uFEFF/, ''));
      const mismatches = [];
      for (const param of truth.params) {
        if (param.readonly) continue;
        const scale = param.scale ?? { kind: 'raw' };
        const raw = scale.kind === 'raw' ? param.default : Math.round(Number(((param.default - scale.add) / scale.mul).toFixed(6)));
        const addr = param.addr;
        const actual = addr >= 0x2000 ? health.raw.preset?.[addr - 0x2000] : addr >= 0x1000 ? health.raw.config?.[addr - 0x1000] : health.raw.info?.[addr];
        if (actual !== raw) mismatches.push({ id: param.id, want: raw, actual });
      }
      summary.finalRestore = { mismatches: mismatches.length, sample: mismatches.slice(0, 10) };
    } catch (error) {
      summary.finalRestore = { error: String(error?.message ?? error) };
    }
  }

  // ---- 汇总 ----------------------------------------------------------------
  const heapValues = summary.heap.map((item) => item.heapMB).filter((value) => Number.isFinite(value));
  const n = heapValues.length;
  let slope = 0;
  if (n >= 3) {
    const xs = summary.heap.map((item) => item.elapsedMin);
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = heapValues.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let index = 0; index < n; index += 1) {
      num += (xs[index] - meanX) * (heapValues[index] - meanY);
      den += (xs[index] - meanX) ** 2;
    }
    slope = den === 0 ? 0 : num / den;
  }
  const firstSample = samples[0] ?? null;
  const lastSample = samples[samples.length - 1] ?? null;
  summary.heapTrend = {
    firstMB: heapValues[0] ?? null,
    lastMB: heapValues[heapValues.length - 1] ?? null,
    maxMB: heapValues.length ? Math.max(...heapValues) : null,
    slopeMBPerMin: Number(slope.toFixed(3)),
    nodesFirst: firstSample?.nodes ?? null,
    nodesLast: lastSample?.nodes ?? null,
    listenersFirst: firstSample?.listeners ?? null,
    listenersLast: lastSample?.listeners ?? null,
  };
  summary.stats = {
    first: firstSample?.stats ?? null,
    last: lastSample?.stats ?? null,
    crcDelta: lastSample && firstSample ? countStats(lastSample.stats, 'crc') - countStats(firstSample.stats, 'crc') : null,
    timeoutDelta: lastSample && firstSample ? countStats(lastSample.stats, 'timeout') - countStats(firstSample.stats, 'timeout') : null,
    retryDelta: lastSample && firstSample ? countStats(lastSample.stats, 'retry') - countStats(firstSample.stats, 'retry') : null,
    droppedDelta: lastSample && firstSample ? countStats(lastSample.stats, 'dropped') - countStats(firstSample.stats, 'dropped') : null,
  };
  summary.writeLatency = {
    count: summary.writeLatencies.length,
    minMs: summary.writeLatencies.length ? Math.min(...summary.writeLatencies) : null,
    avgMs: summary.writeLatencies.length ? Math.round(summary.writeLatencies.reduce((a, b) => a + b, 0) / summary.writeLatencies.length) : null,
    maxMs: summary.writeLatencies.length ? Math.max(...summary.writeLatencies) : null,
  };
  summary.selfCheckDuration = {
    count: summary.selfCheckMs.length,
    minMs: summary.selfCheckMs.length ? Math.min(...summary.selfCheckMs) : null,
    avgMs: summary.selfCheckMs.length ? Math.round(summary.selfCheckMs.reduce((a, b) => a + b, 0) / summary.selfCheckMs.length) : null,
    maxMs: summary.selfCheckMs.length ? Math.max(...summary.selfCheckMs) : null,
    failures: summary.selfCheckFailures,
  };
  summary.durationMin = Number(((Date.now() - startedMs) / 60_000).toFixed(2));
  summary.finishedAt = new Date().toISOString();
  summary.finalState = finalState;
  summary.restore = restore;
  writeFileSync(path.join(outDir, `endurance-${mode}.json`), `${JSON.stringify(summary, null, 1)}\n`, 'utf8');
  log(`DONE mode=${mode} duration=${summary.durationMin}min samples=${summary.samples} restarts=${summary.restarts} errors=${summary.errors.length}`);
  log(`heap ${summary.heapTrend.firstMB}->${summary.heapTrend.lastMB}MB slope=${summary.heapTrend.slopeMBPerMin}MB/min nodes ${summary.heapTrend.nodesFirst}->${summary.heapTrend.nodesLast}`);
  log(`stats crc+${summary.stats.crcDelta} timeout+${summary.stats.timeoutDelta} retry+${summary.stats.retryDelta} dropped+${summary.stats.droppedDelta}`);
  process.exit(0);
}

main().catch(async (error) => {
  record('event', { kind: 'fatal', message: String(error?.stack ?? error) });
  try { await cdp?.shot(`endurance-${mode}-fatal.png`); } catch { /* ignore */ }
  killTree();
  summary.durationMin = Number(((Date.now() - startedMs) / 60_000).toFixed(2));
  summary.finishedAt = new Date().toISOString();
  summary.fatal = String(error?.stack ?? error);
  writeFileSync(path.join(outDir, `endurance-${mode}.json`), `${JSON.stringify(summary, null, 1)}\n`, 'utf8');
  console.error(`[endurance-${mode}] fatal`, error);
  process.exit(2);
});
