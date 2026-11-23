/**
 * v1.1.3 追加：深度冒烟测试（打包产物，真机 M001）。
 *
 *   node scripts/probes/fulltest-smoke.mjs [--exe=<portable.exe>] [--port=9381]
 *
 * 与 N7/N8 的区别：跑**交付产物**（portable exe）而不是 out/ 构建，走完整用户旅程：
 * 冷启动 → 自动连接真机 → 场景/写入/自检 → 四抽屉 → 中英切换 → 固件抽屉（不刷写）
 * → 非法值 → 恢复默认 → 关窗退出 → 二次启动持久化 + 单实例 → mock 离线启动。
 * 证据写 artifacts/fulltest-20261121/smoke/。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = 'D:\\WorkShop\\MicroPhone_WebHIDInterface';
const args = new Map(
  process.argv.slice(2).map((item) => {
    const match = item.match(/^--([^=]+)=(.*)$/);
    return match ? [match[1], match[2]] : [item, ''];
  }),
);
const exe = args.get('exe') ?? 'D:\\Temp\\micstudio-fulltest\\v1.1.3-baseline\\release\\MicStudio-1.1.2-portable.exe';
const port = Number(args.get('port') ?? 9381);
const outDir = args.get('out') ? path.resolve(args.get('out')) : path.join(repo, 'artifacts', 'fulltest-20261121', 'smoke');
const python = 'C:\\Users\\a5935\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const truthFile = path.join(repo, 'artifacts', 'fulltest-20261121', 'gates', 'P1-P5-truth.json');
mkdirSync(outDir, { recursive: true });
if (!existsSync(exe)) throw new Error(`exe not found: ${exe}`);

const results = { startedAt: new Date().toISOString(), exe, checks: [], measurements: {}, screenshots: [] };
const log = (...items) => console.log(`[smoke] ${new Date().toISOString().slice(11, 19)}`, ...items);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function check(id, ok, detail) {
  results.checks.push({ id, ok: Boolean(ok), detail: detail ?? null });
  log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
}

class Cdp {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.exceptions = []; }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('cdp socket error')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') this.exceptions.push(message.params?.exceptionDetails?.exception?.description ?? 'exception');
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
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`cdp timeout: ${method}`)); }, timeoutMs);
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  async keyEscape() {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
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

function findTarget(deadlineMs = 60_000) {
  return (async () => {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = await response.json();
        const page = targets.find((item) => item.type === 'page' && (item.url ?? '').includes('index.html'));
        if (page?.webSocketDebuggerUrl) return page;
      } catch {
        // 解包器还在解压
      }
      await wait(300);
    }
    return null;
  })();
}

const HELPERS = `(() => {
  window.__sm = {
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
      };
    },
    diag() {
      const pick = (key) => this.text(document.querySelector('[data-diag="' + key + '"]'));
      return {
        model: pick('model'), firmware: pick('firmware'), vidpid: pick('vidpid'), audio: pick('audio'), poll: pick('poll'),
        stats: Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((node) => [node.dataset.stat, this.text(node)])),
      };
    },
    ui() {
      return {
        scenes: document.querySelectorAll('.scene-btn').length,
        tones: document.querySelectorAll('.tone-chip').length,
        macros: document.querySelectorAll('[data-macro]').length,
        canvas: Boolean(document.querySelector('.console-eq-canvas')),
        switches: document.querySelectorAll('.tune-switch-grid [data-param]').length,
        gains: document.querySelectorAll('.console-gain-value').length,
        modals: document.querySelectorAll('.modal').length,
        lang: document.querySelector('.segmented--lang .seg-btn.is-active')?.dataset.value ?? null,
        body: document.body.innerText.length,
      };
    },
    sceneValue(key) {
      return this.text(document.querySelector('[data-macro="' + key + '"] .pfield-value'));
    },
    readParam(id) {
      const root = document.querySelector('.modal-body [data-param="' + id + '"]');
      if (!root) return null;
      const num = root.querySelector('input.pfield-number');
      const checkbox = root.querySelector('input[type="checkbox"]');
      return num ? num.value : checkbox ? checkbox.checked : null;
    },
    setNumber(id, value) {
      const input = document.querySelector('.modal-body [data-param="' + id + '"] input.pfield-number');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    selfcheckSteps() {
      return Array.from(document.querySelectorAll('.diag-selfcheck-steps > *')).map((node) => ({ text: this.text(node), error: node.className.includes('is-error') }));
    },
    errors() { return (window.__smErrors ?? []).slice(0, 20); },
  };
  window.__smErrors = [];
  window.addEventListener('error', (event) => window.__smErrors.push(String(event.message)));
  window.addEventListener('unhandledrejection', (event) => window.__smErrors.push(String(event.reason)));
  return true;
})()`;

async function launch(exePath, profile, extraArgs = [], fresh = true) {
  if (fresh) {
    rmSync(profile, { recursive: true, force: true });
  }
  mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MICSTUDIO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  const child = spawn(exePath, ['--no-sandbox', `--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding', ...extraArgs], {
    env,
    stdio: 'ignore',
    windowsHide: false,
  });
  return { child, profile, started };
}

async function attach(deadlineMs = 60_000) {
  const target = await findTarget(deadlineMs);
  if (!target) throw new Error('devtools target not found');
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
    await wait(300);
  }
  await cdp.evaluate(HELPERS);
  return cdp;
}

async function waitReady(cdp, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`window.__sm.status()`);
    if (state.ready && state.device && state.device !== '演示数据') return state;
    await wait(300);
  }
  return await cdp.evaluate(`window.__sm.status()`);
}

function killTree(child) {
  try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
}

function readHealth(tag) {
  execFileSync(python, ['scripts/probes/real8-health.py', tag], {
    cwd: repo,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONPATH: '' },
    stdio: 'pipe',
    timeout: 120_000,
  });
  const file = path.join(repo, 'artifacts', 'dfu-check-20261121', `health-${tag}.json`);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(path.join(outDir, `R-${tag}.json`), JSON.stringify(data, null, 1), 'utf8');
  return data;
}

async function main() {
  const truth = JSON.parse(readFileSync(truthFile, 'utf8').replace(/^\uFEFF/, ''));
  const params = truth.params;
  const profileA = 'D:\\Temp\\micstudio-fulltest\\userdata-smoke-a';
  const profileB = 'D:\\Temp\\micstudio-fulltest\\userdata-smoke-mock';

  // ===== 第 1 次启动：完整旅程 ============================================
  const app = await launch(exe, profileA);
  const cdp = await attach();
  const tTarget = Date.now();
  const state0 = await waitReady(cdp);
  const tReady = Date.now();
  results.measurements.boot = { exeStartToTargetMs: tTarget - app.started, targetToReadyMs: tReady - tTarget, totalMs: tReady - app.started };
  const startupLog = path.join(profileA, 'startup.log');
  const startupText = existsSync(startupLog) ? readFileSync(startupLog, 'utf8') : '';
  writeFileSync(path.join(outDir, 'smoke-startup-a.log'), startupText, 'utf8');
  check('SM1.1 打包产物冷启动：DevTools 目标可连、进入「已连接/已同步」', state0.ready && state0.device !== '演示数据', { boot: results.measurements.boot, state: state0 });
  check('SM1.2 startup.log 标记齐全：boot packaged=true / ready / window-created / renderer ready，且无崩溃标记', /boot packaged=true/.test(startupText) && /ready/.test(startupText) && /window-created/.test(startupText) && /\[boot\] renderer ready/.test(startupText) && !/uncaught|unhandledRejection|did-fail-load/i.test(startupText), { length: startupText.length });

  const ui0 = await cdp.evaluate(`window.__sm.ui()`);
  check('SM1.3 主界面元素齐全（5 场景 / 5 音色 / 2 宏滑杆 / 曲线 / 3 输入开关 / 2 增益）', ui0.scenes === 5 && ui0.tones === 5 && ui0.macros === 2 && ui0.canvas && ui0.switches === 3 && ui0.gains === 2, ui0);

  // 设备信息
  await cdp.evaluate(`window.__micstudioGo('device'); true`);
  await wait(900);
  const diag = await cdp.evaluate(`window.__sm.diag()`);
  check('SM1.4 真机信息：型号 JYM001 / 固件 0.0.6.0 / VID-PID 0A67-0010', /JYM001|M001/.test(diag.model) && /0\.0\.6/.test(diag.firmware) && /0A67/i.test(diag.vidpid), diag);
  check('SM1.5 电平来源 = 音频输入、设备轮询 = 关', /音频输入/.test(diag.audio) && /关/.test(diag.poll), { audio: diag.audio, poll: diag.poll });

  // 自检
  const scStart = Date.now();
  await cdp.evaluate(`document.querySelector('.diag-selfcheck')?.click(); true`);
  let steps = [];
  for (let index = 0; index < 40; index += 1) {
    await wait(400);
    steps = await cdp.evaluate(`window.__sm.selfcheckSteps()`);
    const busy = await cdp.evaluate(`Boolean(document.querySelector('.diag-selfcheck[disabled]'))`);
    if (steps.length > 0 && !busy) break;
  }
  const scMs = Date.now() - scStart;
  check('SM1.6 一键自检 3/3 全绿（打包产物 + 真机）', steps.length === 3 && steps.every((step) => !step.error), { steps, ms: scMs });
  await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
  await wait(500);

  // 场景 + 读数
  await cdp.evaluate(`document.querySelector('.scene-btn[data-scene="quiet"]')?.click(); true`);
  await wait(1200);
  const quiet = await cdp.evaluate(`({ scene: document.querySelector('.scene-btn.is-active')?.dataset.scene, gate: window.__sm.sceneValue('denoise'), comp: window.__sm.sceneValue('evenness'), tone: document.querySelector('.tone-chip.is-active')?.dataset.tone })`);
  check('SM1.7 场景「安静房间」写入并回读（-82 dB / -18 dB / flat）', quiet.scene === 'quiet' && quiet.gate === '-82 dB' && quiet.comp === '-18 dB' && quiet.tone === 'flat', quiet);

  // 参数写入 + 高级参数回读
  await cdp.evaluate(`document.querySelector('[data-macro="denoise"] input.macro-range')?.dispatchEvent(new Event('focus')); true`);
  await cdp.evaluate(`(() => {
    const input = document.querySelector('[data-macro="denoise"] input.macro-range');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '-60');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await wait(900);
  await cdp.evaluate(`window.__micstudioGo('advanced'); true`);
  await wait(800);
  const gateValue = await cdp.evaluate(`window.__sm.readParam('noisegate.threshold_db')`);
  check('SM1.8 主界面滑杆写 -60 dB 后高级参数同值（真实写设备）', gateValue === '-60', { gateValue });

  // 非法值夹紧
  await cdp.evaluate(`window.__sm.setNumber('noisegate.attack_ms', 9999)`);
  await wait(700);
  const clamped = await cdp.evaluate(`window.__sm.readParam('noisegate.attack_ms')`);
  check('SM1.9 非法值 9999 被夹到 500，不崩溃', clamped === '500', { clamped });

  // 四抽屉
  const drawers = [];
  for (const id of ['advanced', 'device', 'settings', 'firmware']) {
    await cdp.evaluate(`window.__micstudioGo(${JSON.stringify(id)}); true`);
    await wait(500);
    const open = await cdp.evaluate(`document.querySelectorAll('.modal').length`);
    await cdp.keyEscape();
    await wait(350);
    const closed = await cdp.evaluate(`document.querySelectorAll('.modal').length`);
    drawers.push({ id, open, closed });
  }
  check('SM1.10 四个抽屉可开可关（Esc），关闭后无残留', drawers.every((item) => item.open === 1 && item.closed === 0), drawers);

  // 语言切换
  await cdp.evaluate(`document.querySelector('.segmented--lang .seg-btn[data-value="en"]')?.click(); true`);
  await wait(900);
  const en = await cdp.evaluate(`(() => {
    const langText = document.querySelector('.segmented--lang')?.innerText ?? '';
    const body = document.body.innerText.split(langText).join('');
    return { lang: document.querySelector('.segmented--lang .seg-btn.is-active')?.dataset.value, cjk: (body.match(/[\\u4e00-\\u9fff]/g) ?? []).length, raw: (body.match(/(^|\\s)(console|param|settings|fw|device|diag|common|drc|module)\\.[a-zA-Z0-9_.]+(\\s|$)/g) ?? []).length };
  })()`);
  check('SM1.11 英文界面无缺键（key 原文 0、残留中文 0）', en.lang === 'en' && en.cjk === 0 && en.raw === 0, en);
  await cdp.shot('smoke-01-console-en.png');
  await cdp.evaluate(`document.querySelector('.segmented--lang .seg-btn[data-value="zh"]')?.click(); true`);
  await wait(800);

  // 固件抽屉只验界面
  await cdp.evaluate(`window.__micstudioGo('firmware'); true`);
  await wait(700);
  const fw = await cdp.evaluate(`({ file: window.__sm.text(document.querySelector('.fw-file-name')), start: document.querySelector('.fw-start')?.disabled, steps: document.querySelectorAll('.fw-step').length })`);
  check('SM1.12 固件抽屉空态正确、开始升级禁用（不刷写）', fw.steps === 3 && fw.start === true && fw.file.length > 0, fw);
  await cdp.keyEscape();
  await wait(400);

  // 恢复默认（收尾前）
  await cdp.evaluate(`window.__micstudioGo('settings'); true`);
  await wait(700);
  await cdp.evaluate(`document.querySelector('.modal-body .btn--danger')?.click(); true`);
  await wait(500);
  const armed = await cdp.evaluate(`Boolean(document.querySelector('.modal-body .btn--danger.is-armed'))`);
  await cdp.evaluate(`document.querySelector('.modal-body .btn--danger')?.click(); true`);
  await wait(7000);
  const restored = await cdp.evaluate(`window.__sm.status()`);
  check('SM1.13 恢复默认：二次确认生效、链路保持 ready', armed === true && restored.ready === true, { armed, sync: restored.sync });
  await cdp.evaluate(`document.querySelector('.segmented--lang .seg-btn[data-value="en"]')?.click(); true`);
  await wait(700);
  await cdp.shot('smoke-02-settings-en.png');

  // 关窗退出
  const errorsBeforeClose = [...cdp.exceptions, ...((await cdp.evaluate(`window.__sm.errors()`)) ?? [])];
  await cdp.evaluate(`window.close(); true`).catch(() => undefined);
  let exited = false;
  for (let index = 0; index < 40; index += 1) {
    await wait(300);
    if (app.child.exitCode !== null) { exited = true; break; }
  }
  const logAfter = existsSync(startupLog) ? readFileSync(startupLog, 'utf8') : '';
  writeFileSync(path.join(outDir, 'smoke-startup-a-end.log'), logAfter, 'utf8');
  check('SM1.14 关窗后进程自行退出（≤12 s）', exited, { exitCode: app.child.exitCode });
  check('SM1.15 整轮旅程无未捕获异常 / 渲染进程异常', errorsBeforeClose.length === 0, errorsBeforeClose.slice(0, 5));
  if (!exited) killTree(app.child);

  // ===== 第 2 次启动：持久化 + 单实例 =====================================
  const app2 = await launch(exe, profileA, [], false);
  const cdp2 = await attach(60_000);
  await waitReady(cdp2);
  const langAfterRestart = await cdp2.evaluate(`document.querySelector('.segmented--lang .seg-btn.is-active')?.dataset.value`);
  check('SM2.1 重启后语言设置持久化（关闭前切 EN，重启仍是 EN）', langAfterRestart === 'en', { langAfterRestart });
  // 单实例：同一 userData 再起一个（换端口避免调试端口冲突）
  const third = spawn(exe, ['--no-sandbox', '--remote-debugging-port=9399'], {
    env: (() => { const env = { ...process.env, MICSTUDIO_USER_DATA: profileA }; delete env.ELECTRON_RUN_AS_NODE; return env; })(),
    stdio: 'ignore',
    windowsHide: false,
  });
  let thirdExited = false;
  // portable 解包器要先把 exe 解到 %TEMP% 再启动，单实例判定前的解包约 15 s（实测 19.5 s 退出）
  for (let index = 0; index < 100; index += 1) {
    await wait(300);
    if (third.exitCode !== null) { thirdExited = true; break; }
  }
  const secondAlive = app2.child.exitCode === null;
  check('SM2.2 单实例：同 userData 的三次启动自行退出，已有实例存活', thirdExited && secondAlive, { thirdExited, thirdCode: third.exitCode, secondAlive });
  if (!thirdExited) { try { spawn('taskkill', ['/PID', String(third.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
  // 切回中文并关窗
  await cdp2.evaluate(`document.querySelector('.segmented--lang .seg-btn[data-value="zh"]')?.click(); true`);
  await wait(700);
  await cdp2.evaluate(`window.close(); true`).catch(() => undefined);
  for (let index = 0; index < 30; index += 1) { await wait(300); if (app2.child.exitCode !== null) break; }
  if (app2.child.exitCode === null) killTree(app2.child);

  // ===== 第 3 次启动：mock 离线可用 =======================================
  const app3 = await launch(exe, profileB);
  const cdp3 = await attach(60_000);
  await cdp3.evaluate(`(() => { localStorage.setItem('micstudio.channel','mock'); localStorage.setItem('micstudio.autoConnect','0'); location.reload(); return true; })()`);
  await wait(2500);
  const bootDeadline = Date.now() + 30_000;
  while (Date.now() < bootDeadline) {
    if (await cdp3.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
    await wait(300);
  }
  await cdp3.evaluate(HELPERS);
  await wait(1200);
  await cdp3.evaluate(`document.querySelector('.scene-btn[data-scene="meeting"]')?.click(); true`);
  await wait(800);
  await cdp3.evaluate(`window.__micstudioGo('advanced'); true`);
  await wait(600);
  await cdp3.keyEscape();
  const mockState = await cdp3.evaluate(`({ device: window.__sm.status().device, scene: document.querySelector('.scene-btn.is-active')?.dataset.scene, body: document.body.innerText.length, errors: window.__sm.errors() })`);
  await cdp3.shot('smoke-03-mock.png');
  check('SM3.1 mock 通道（无设备）启动后界面完整、场景可用、无异常', mockState.device === '演示数据' && mockState.scene === 'meeting' && mockState.body > 200 && mockState.errors.length === 0, mockState);
  await cdp3.evaluate(`window.close(); true`).catch(() => undefined);
  for (let index = 0; index < 30; index += 1) { await wait(300); if (app3.child.exitCode !== null) break; }
  if (app3.child.exitCode === null) killTree(app3.child);

  // ===== 收尾：裸 HID 校验恢复默认 =======================================
  await wait(2000);
  const health = readHealth('fulltest-smoke-final');
  const toRaw = (param, value) => {
    const scale = param.scale ?? { kind: 'raw' };
    const snapped = Math.min(param.max, Math.max(param.min, value));
    const raw = scale.kind === 'raw' ? snapped : Math.round(Number(((snapped - scale.add) / scale.mul).toFixed(6)));
    return raw;
  };
  const mismatches = [];
  for (const param of params) {
    if (param.readonly) continue;
    const addr = param.addr;
    const expected = toRaw(param, param.default);
    const actual = addr >= 0x2000 ? health.raw.preset?.[addr - 0x2000] : addr >= 0x1000 ? health.raw.config?.[addr - 0x1000] : health.raw.info?.[addr];
    if (actual !== expected) mismatches.push({ id: param.id, want: expected, actual });
  }
  check('SM4.1 冒烟结束恢复 V0.3 默认值，裸 HID 回读 0 失配', mismatches.length === 0, { mismatchCount: mismatches.length, sample: mismatches.slice(0, 8) });
}

main()
  .then(() => {
    const failed = results.checks.filter((item) => !item.ok);
    results.summary = { passed: results.checks.length - failed.length, failed: failed.length, total: results.checks.length };
    results.finishedAt = new Date().toISOString();
    writeFileSync(path.join(outDir, 'smoke-results.json'), `${JSON.stringify(results, null, 1)}\n`, 'utf8');
    log(`SUMMARY passed=${results.summary.passed} failed=${results.summary.failed} total=${results.summary.total}`);
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch((error) => {
    results.error = String(error?.stack ?? error);
    writeFileSync(path.join(outDir, 'smoke-results.json'), `${JSON.stringify(results, null, 1)}\n`, 'utf8');
    console.error('[smoke] failed', error);
    process.exit(2);
  });
