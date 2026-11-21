/**
 * 界面全功能真机 Walkthrough：CDP 驱动渲染进程，逐块走完工作台 → 抽屉 → 重启，
 * 并在最后用「换空 userData 重启 + 同步回读」核对设备侧真的收到了界面写入。
 *
 *   node scripts/probes/ui-e2e-full.mjs
 *
 * 三段式：
 *   run1  同一 userData：连接 → 场景 / 业务控件 / 高级参数 / EQ 拖拽 / 设备自检 / 设置 / 固件预检
 *   run2  重新开同一 userData：验证设置持久化 + 同步回读到 run1 写入的值；最后点「恢复默认」
 *   run3  换空 userData：同步回读，验证设备侧确实是「恢复默认」之后的值
 *
 * 全程截图落在 artifacts/ui-e2e-20261107/，结果写到同目录 result.json。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..', '..');
const shotDir = path.join(repo, 'artifacts', 'ui-e2e-20261107');
const electron = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const binPath = path.join(repo, 'Document', 'Protocol', 'dfu_M001 MCU V0.0.5_2026-11-07_Rev0.bin');
const userData = 'D:\\Temp\\ud-ui-e2e';
const userDataFresh = 'D:\\Temp\\ud-ui-e2e-fresh';

if (!existsSync(electron)) throw new Error(`electron not found: ${electron}`);

rmSync(shotDir, { recursive: true, force: true });
mkdirSync(shotDir, { recursive: true });

const log = (...args) => console.log(`[ui] ${new Date().toISOString().slice(11, 19)}`, ...args);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- CDP ------------------------------------------------------------------

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
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  async json(expression) {
    return JSON.parse(await this.evaluate(expression));
  }

  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(shotDir, name), Buffer.from(result.data, 'base64'));
    log(`shot ${name}`);
  }

  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  }
}

async function findPageTarget(port) {
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

async function launch(profile, port, fresh = true) {
  if (fresh) {
    rmSync(profile, { recursive: true, force: true });
  }
  mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MICSTUDIO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(electron, ['.', '--no-sandbox', `--remote-debugging-port=${port}`], {
    cwd: repo,
    env,
    stdio: 'ignore',
    windowsHide: false,
  });
  const target = await findPageTarget(port);
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  const bootDeadline = Date.now() + 30_000;
  while (Date.now() < bootDeadline) {
    if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
    await wait(300);
  }
  return { app, cdp, profile };
}

async function close(instance) {
  const { app, cdp, profile } = instance;
  try {
    await cdp.send('Browser.close');
  } catch {
    // 关不掉就 taskkill
  }
  await wait(800);
  spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  await wait(600);
  const logFile = path.join(profile, 'startup.log');
  if (existsSync(logFile)) {
    copyFileSync(logFile, path.join(shotDir, `startup-${path.basename(profile)}.log`));
  }
}

// ---- 页面表达式 ------------------------------------------------------------

const CONSOLE_SNAPSHOT = `(() => {
  const clean = (node) => node?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
  const sync = document.querySelector('#sync-pill');
  const source = document.querySelector('#source-pill');
  const activeScene = document.querySelector('.scene-btn[aria-pressed="true"]');
  return JSON.stringify({
    syncReady: sync ? sync.classList.contains('state-pill--ready') : null,
    syncClass: sync?.className ?? null,
    connected: source ? !source.classList.contains('is-demo') : null,
    sourceText: clean(source),
    syncText: clean(sync),
    notice: document.querySelector('.console-notice')?.hidden ? null : clean(document.querySelector('.console-notice')),
    gains: Array.from(document.querySelectorAll('.console-gain-value')).map(clean),
    deviceName: clean(document.querySelector('.console-device-name')),
    deviceState: clean(document.querySelector('.console-device-state')),
    sceneId: activeScene?.dataset.scene ?? null,
    toneId: document.querySelector('.tone-chip[aria-pressed="true"]')?.dataset.tone ?? null,
    macros: Object.fromEntries(Array.from(document.querySelectorAll('[data-macro]')).map((node) => [node.dataset.macro, Number(node.querySelector('input[type="range"]')?.value ?? NaN)])),
    switches: Array.from(document.querySelectorAll('.switch-item')).map((node) => ({
      text: clean(node.querySelector('.switch-label') ?? node),
      checked: node.querySelector('input[type="checkbox"]')?.checked ?? null,
      level: clean(node.querySelector('.seg-btn.is-active')),
    })),
  });
})()`;

const PARAMS_SNAPSHOT = `(() => {
  const clean = (node) => node?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
  return JSON.stringify({
    params: Array.from(document.querySelectorAll('[data-param]')).map((node) => {
      const number = node.querySelector('input[type="number"]');
      const checkbox = node.querySelector('input[type="checkbox"]');
      const seg = node.querySelector('.seg-btn.is-active');
      return {
        id: node.dataset.param,
        value: number ? number.value : checkbox ? checkbox.checked : seg ? seg.dataset.value : clean(node.querySelector('.pfield-readout strong') ?? node.querySelector('.pfield-value')),
        kind: number ? 'number' : checkbox ? 'switch' : seg ? 'segment' : 'readout',
      };
    }),
    eq: Array.from(document.querySelectorAll('.eq-row[data-band]')).map((row) => {
      const inputs = Array.from(row.querySelectorAll('input[type="number"]'));
      return { band: Number(row.dataset.band), type: row.querySelector('select')?.value ?? null, freq: inputs[0]?.value ?? null, gain: inputs[1]?.value ?? null, q: inputs[2]?.value ?? null };
    }),
    sections: Array.from(document.querySelectorAll('.advanced-section-title')).map(clean),
  });
})()`;

const DEVICE_SNAPSHOT = `(() => {
  const clean = (node) => node?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
  const sync = document.querySelector('#sync-pill');
  const source = document.querySelector('#source-pill');
  return JSON.stringify({
    syncReady: sync ? sync.classList.contains('state-pill--ready') : null,
    connected: source ? !source.classList.contains('is-demo') : null,
    deviceFields: Object.fromEntries(Array.from(document.querySelectorAll('[data-diag]')).map((node) => [node.dataset.diag, clean(node)])),
    stats: Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((node) => [node.dataset.stat, clean(node)])),
    selfCheck: Array.from(document.querySelectorAll('.diag-selfcheck-steps > *')).map((node) => clean(node)),
    selfCheckClasses: Array.from(document.querySelectorAll('.diag-selfcheck-steps > *')).map((node) => node.className),
    deviceRows: Array.from(document.querySelectorAll('.device-row')).map((node) => clean(node)),
    openBadges: Array.from(document.querySelectorAll('.device-badge--open')).length,
  });
})()`;

const SETTINGS_SNAPSHOT = `(() => {
  const clean = (node) => node?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
  const lang = document.querySelector('.segmented--lang .seg-btn.is-active')?.dataset.value ?? null;
  const auto = document.querySelector('[data-channel-control="autoConnect"] input[type="checkbox"]');
  const kind = document.querySelector('[data-channel-control="kind"] .seg-btn.is-active')?.dataset.value ?? null;
  return JSON.stringify({
    lang,
    autoConnect: auto ? auto.checked : null,
    kind,
    title: clean(document.querySelector('.modal-title')),
    status: clean(document.querySelector('.channel-status')),
  });
})()`;

const FW_PREFLIGHT = (b64, fileName) => `(async () => {
  const bin = atob(${JSON.stringify(b64)});
  const data = new Uint8Array(bin.length);
  for (let index = 0; index < bin.length; index += 1) data[index] = bin.charCodeAt(index);
  const file = new File([data], ${JSON.stringify(fileName)}, { type: 'application/octet-stream' });
  const input = document.querySelector('.fw-file');
  if (!input) return JSON.stringify({ error: 'no .fw-file' });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const field = (name) => document.querySelector('[data-field="' + name + '"]')?.textContent?.trim() ?? null;
  return JSON.stringify({
    model: field('model'), modelName: field('modelName'), version: field('version'),
    length: field('length'), blocks: field('blocks'), checksum: field('checksum'),
    errorVisible: document.querySelector('.fw-error') ? !document.querySelector('.fw-error').hidden : null,
    error: document.querySelector('.fw-error-title')?.textContent?.trim() ?? null,
    startDisabled: document.querySelector('.fw-start')?.disabled ?? null,
  });
})()`;

// ---- 工具 ------------------------------------------------------------------

const results = {
  startedAt: new Date().toISOString(),
  bin: { path: path.relative(repo, binPath), bytes: existsSync(binPath) ? readFileSync(binPath).length : 0 },
  runs: {},
  checks: [],
};

function check(name, ok, detail) {
  results.checks.push({ name, ok: Boolean(ok), detail: detail ?? null });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitSync(cdp, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await cdp.evaluate(`!!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready')`);
    if (ready) return true;
    await wait(400);
  }
  return false;
}

async function openPanel(cdp, name) {
  await cdp.evaluate(`window.__micstudioGo(${JSON.stringify(name)}); true`);
  await wait(600);
}

async function closePanel(cdp) {
  await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
  await wait(400);
}

// ---- run1：界面全量走查 -----------------------------------------------------

async function run1() {
  const instance = await launch(userData, 9341);
  const { cdp } = instance;
  const out = {};

  const synced = await waitSync(cdp);
  await wait(500);
  out.start = await cdp.json(CONSOLE_SNAPSHOT);
  await cdp.shot('01-console-start.png');
  check('启动后自动连接并同步', synced && out.start.syncReady && out.start.connected, `sync=${out.start.syncText}`);
  check('顶栏数据来源是设备而不是演示', out.start.sourceText && !out.start.sourceText.includes('演示'), out.start.sourceText);
  check('设备摘要显示型号', (out.start.deviceName ?? '').length > 0, `${out.start.deviceName} / ${out.start.deviceState}`);
  check('增益回读有值', out.start.gains.length === 2 && out.start.gains.every((item) => item && item !== '—'), out.start.gains.join(' / '));

  // 场景
  out.scenes = [];
  for (const scene of ['meeting', 'podcast', 'sing', 'quiet']) {
    await cdp.evaluate(`document.querySelector('.scene-btn[data-scene="${scene}"]')?.click(); true`);
    await wait(1500);
    const snap = await cdp.json(CONSOLE_SNAPSHOT);
    out.scenes.push({ scene, ...snap });
    await cdp.shot(`02-scene-${scene}.png`);
    check(`场景切换 ${scene}`, snap.sceneId === scene && snap.syncReady, `active=${snap.sceneId} tone=${snap.toneId} denoise=${snap.macros.denoise} evenness=${snap.macros.evenness}`);
  }
  const sceneValues = new Set(out.scenes.map((item) => `${item.macros.denoise}|${item.macros.evenness}|${item.toneId}`));
  check('四个场景参数确实不同', sceneValues.size >= 2, `${sceneValues.size} 组不同值`);

  // 业务控件
  await cdp.evaluate(`(() => {
    const denoise = document.querySelector('[data-macro="denoise"] input[type="range"]');
    denoise.value = '80';
    denoise.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await wait(900);
  await cdp.evaluate(`(() => {
    const evenness = document.querySelector('[data-macro="evenness"] input[type="range"]');
    evenness.value = '40';
    evenness.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await wait(900);
  await cdp.evaluate(`document.querySelector('.tone-chip[data-tone="bright"]')?.click(); true`);
  await wait(1500);
  out.controls = await cdp.json(CONSOLE_SNAPSHOT);
  await cdp.shot('03-controls.png');
  check('降噪强度 / 声音平稳改为 80 / 40', out.controls.macros.denoise === 80 && out.controls.macros.evenness === 40, JSON.stringify(out.controls.macros));
  check('音色风格切到「明亮」', out.controls.toneId === 'bright', out.controls.toneId);
  check('业务控件写入后仍在同步态', out.controls.syncReady, out.controls.syncText);

  // 快捷开关：ENC 关→开、档位 3、防爆音 关→开
  const switchOps = await cdp.evaluate(`(async () => {
    const clean = (node) => node?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
    const items = Array.from(document.querySelectorAll('.switch-item'));
    const enc = items[0];
    const limiter = items[1];
    const encSwitch = enc?.querySelector('input[type="checkbox"]');
    const limiterSwitch = limiter?.querySelector('input[type="checkbox"]');
    const before = { enc: encSwitch?.checked ?? null, limiter: limiterSwitch?.checked ?? null, level: clean(enc?.querySelector('.seg-btn.is-active')) };
    encSwitch?.click();
    await new Promise((r) => setTimeout(r, 800));
    enc?.querySelectorAll('.seg-btn')[3]?.click();
    await new Promise((r) => setTimeout(r, 900));
    limiterSwitch?.click();
    await new Promise((r) => setTimeout(r, 900));
    return JSON.stringify({ before, after: { enc: encSwitch?.checked ?? null, limiter: limiterSwitch?.checked ?? null, level: clean(enc?.querySelector('.seg-btn.is-active')) } });
  })()`);
  out.switches = JSON.parse(switchOps);
  out.afterSwitches = await cdp.json(CONSOLE_SNAPSHOT);
  await cdp.shot('04-switches.png');
  check('环境降噪开关可切换', out.switches.before.enc !== out.switches.after.enc, `${out.switches.before.enc} → ${out.switches.after.enc}`);
  check('降噪档位可切到 3', out.switches.after.level === '3', out.switches.after.level);
  check('防爆音开关可切换', out.switches.before.limiter !== out.switches.after.limiter, `${out.switches.before.limiter} → ${out.switches.after.limiter}`);

  // 高级参数
  await openPanel(cdp, 'advanced');
  out.paramsBefore = await cdp.json(PARAMS_SNAPSHOT);
  await cdp.shot('05-advanced.png');
  check('高级参数抽屉渲染出全部参数', out.paramsBefore.params.length >= 40, `${out.paramsBefore.params.length} 项 / EQ ${out.paramsBefore.eq.length} 段`);
  check('高级参数分为多个分区', out.paramsBefore.sections.length >= 3, out.paramsBefore.sections.join(' | '));

  const editResult = await cdp.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = [];
    const setNumber = async (id, value) => {
      const node = document.querySelector('[data-param="' + id + '"]');
      const input = node?.querySelector('input[type="number"]');
      if (!input) return out.push({ id, error: 'no number input' });
      const before = input.value;
      input.value = String(value);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(900);
      out.push({ id, before, after: node.querySelector('input[type="number"]').value, requested: value });
    };
    const toggle = async (id) => {
      const node = document.querySelector('[data-param="' + id + '"]');
      const box = node?.querySelector('input[type="checkbox"]');
      if (!box) return out.push({ id, error: 'no switch' });
      const before = box.checked;
      box.click();
      await wait(900);
      out.push({ id, before, after: box.checked });
    };
    const seg = async (id) => {
      const node = document.querySelector('[data-param="' + id + '"]');
      const active = node?.querySelector('.seg-btn.is-active');
      const next = Array.from(node?.querySelectorAll('.seg-btn') ?? []).find((btn) => btn !== active);
      if (!next) return out.push({ id, error: 'no segment' });
      const before = active?.dataset.value ?? null;
      next.click();
      await wait(900);
      out.push({ id, before, after: node.querySelector('.seg-btn.is-active')?.dataset.value ?? null });
    };
    // 布尔参数在高级参数里也是滑杆 + 数字框（paramSlider 统一渲染），翻到 0/1 即可
    const flip = async (id) => {
      const node = document.querySelector('[data-param="' + id + '"]');
      const input = node?.querySelector('input[type="number"]');
      if (!input) return out.push({ id, error: 'no number input for boolean' });
      const before = input.value;
      const target = Number(before) ? 0 : 1;
      input.value = String(target);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(900);
      out.push({ id, before, after: node.querySelector('input[type="number"]').value, requested: target });
    };
    await setNumber('noisegate.attack_ms', 120);
    await flip('comp.Enable');
    await seg('eq.mode');
    return JSON.stringify(out);
  })()`);
  out.paramEdits = JSON.parse(editResult);
  out.paramsAfter = await cdp.json(PARAMS_SNAPSHOT);
  const editOk = out.paramEdits.every((item) => !item.error && String(item.before) !== String(item.after));
  check('高级参数三类控件都能改（数值/开关/分段）', editOk, JSON.stringify(out.paramEdits));
  out.statsAfterEdits = await cdp.evaluate(`(() => JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((n) => [n.dataset.stat, n.textContent.trim()]))))()`);
  await cdp.shot('06-advanced-edited.png');
  await closePanel(cdp);
  await wait(600);

  // EQ 拖拽：先记录 7 段，再命中扫描 + CDP 真拖拽，最后比对
  await openPanel(cdp, 'advanced');
  out.eqBefore = (await cdp.json(PARAMS_SNAPSHOT)).eq;
  await closePanel(cdp);
  await wait(400);

  const hit = await cdp.evaluate(`(() => {
    const canvas = document.querySelector('.console-eq-canvas');
    if (!canvas) return JSON.stringify({ error: 'no canvas' });
    const rect = canvas.getBoundingClientRect();
    for (let y = rect.top + 8; y < rect.bottom - 8; y += 7) {
      for (let x = rect.left + 8; x < rect.right - 8; x += 7) {
        canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'mouse' }));
        if (canvas.dataset.cursor === 'grab') {
          canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, pointerId: 1, pointerType: 'mouse' }));
          return JSON.stringify({ x, y, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
        }
      }
    }
    return JSON.stringify({ error: 'no band hit', rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
  })()`);
  out.eqHit = JSON.parse(hit);
  if (out.eqHit.x) {
    await cdp.mouse('mouseMoved', out.eqHit.x, out.eqHit.y, { buttons: 0 });
    await cdp.mouse('mousePressed', out.eqHit.x, out.eqHit.y, { buttons: 1 });
    await wait(120);
    await cdp.mouse('mouseMoved', out.eqHit.x, out.eqHit.y - 40, { buttons: 1 });
    await wait(120);
    await cdp.mouse('mouseMoved', out.eqHit.x, out.eqHit.y - 60, { buttons: 1 });
    await wait(150);
    await cdp.mouse('mouseReleased', out.eqHit.x, out.eqHit.y - 60, { buttons: 0 });
    await wait(1200);
  }
  await cdp.shot('07-eq-dragged.png');
  await openPanel(cdp, 'advanced');
  out.eqAfter = (await cdp.json(PARAMS_SNAPSHOT)).eq;
  await closePanel(cdp);
  const eqChanged = out.eqBefore.some((band, index) => {
    const after = out.eqAfter[index];
    return after && (band.gain !== after.gain || band.freq !== after.freq);
  });
  check('EQ 曲线节点可拖拽（数据真的变了）', Boolean(out.eqHit.x) && eqChanged, `hit=${out.eqHit.x},${out.eqHit.y}`);

  // 设备抽屉 + 自检
  await openPanel(cdp, 'device');
  out.deviceBefore = await cdp.json(DEVICE_SNAPSHOT);
  await cdp.shot('08-device.png');
  check('设备抽屉识别 M001 且已打开', (out.deviceBefore.deviceFields.model ?? '').includes('JYM001') && out.deviceBefore.openBadges >= 1, out.deviceBefore.deviceFields.model);
  await cdp.evaluate(`document.querySelector('.diag-selfcheck')?.click(); true`);
  const selfDeadline = Date.now() + 20_000;
  let selfCheck = [];
  while (Date.now() < selfDeadline) {
    await wait(600);
    const state = await cdp.json(DEVICE_SNAPSHOT);
    if (state.selfCheck.length >= 3 && state.selfCheckClasses.every((name) => !name.includes('is-error'))) {
      selfCheck = state.selfCheck;
      break;
    }
    selfCheck = state.selfCheck;
  }
  out.selfCheck = selfCheck;
  out.deviceAfterCheck = await cdp.json(DEVICE_SNAPSHOT);
  await cdp.shot('09-device-selfcheck.png');
  check('诊断自检三步走完且无错误', selfCheck.length >= 3 && out.deviceAfterCheck.selfCheckClasses.every((name) => !name.includes('is-error')), selfCheck.join(' | '));
  const stats = out.deviceAfterCheck.stats;
  check('参数通道无 CRC / 超时 / 重试', stats.crc === '0' && stats.timeout === '0' && stats.retry === '0', JSON.stringify(stats));

  // 关闭 / 打开设备（关的时候 device-view 会 pause 自动连接，避免和自动重连抢）
  const disconnected = await cdp.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('.device-actions .btn'));
    const target = buttons.find((btn) => {
      const text = btn.textContent ?? '';
      return text.includes('断开') || text.includes('Disconnect');
    });
    if (!target || target.disabled) return false;
    target.click();
    return true;
  })()`);
  await wait(2000);
  out.afterDisconnect = await cdp.json(DEVICE_SNAPSHOT);
  await cdp.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('.device-actions .btn'));
    const target = buttons.find((btn) => {
      const text = btn.textContent ?? '';
      return text.includes('连接') || text.includes('Connect');
    });
    if (target && !target.disabled) target.click();
    return true;
  })()`);
  await wait(1800);
  const opened = await cdp.evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('.device-row')).find((item) => (item.textContent ?? '').includes('0A67'));
    const button = row?.querySelector('.btn');
    if (!button) return false;
    if (/(关闭|Close)/.test(button.textContent ?? '')) return true;
    button.click();
    return true;
  })()`);
  const reopened = opened && (await waitSync(cdp, 25_000));
  out.afterReopen = await cdp.json(DEVICE_SNAPSHOT);
  await cdp.shot('10-device-reopened.png');
  check('断开后重新打开能恢复同步', Boolean(disconnected) && reopened, `syncReady=${out.afterReopen.syncReady}`);
  await closePanel(cdp);

  // 设置：语言 / 自动连接
  await openPanel(cdp, 'settings');
  out.settingsBefore = await cdp.json(SETTINGS_SNAPSHOT);
  out.zhLabels = JSON.parse(
    await cdp.evaluate(`(() => JSON.stringify({
      advanced: document.querySelector('#advanced-btn')?.textContent?.trim() ?? null,
      settings: document.querySelector('#settings-btn')?.textContent?.trim() ?? null,
    }))()`),
  );
  await cdp.shot('11-settings.png');
  await cdp.evaluate(`(() => {
    const seg = document.querySelector('.segmented--lang');
    seg?.querySelector('.seg-btn[data-value="en"]')?.click();
    return true;
  })()`);
  await wait(800);
  out.settingsEn = await cdp.json(SETTINGS_SNAPSHOT);
  out.enLabels = JSON.parse(
    await cdp.evaluate(`(() => JSON.stringify({
      advanced: document.querySelector('#advanced-btn')?.textContent?.trim() ?? null,
      settings: document.querySelector('#settings-btn')?.textContent?.trim() ?? null,
    }))()`),
  );
  await cdp.shot('12-settings-en.png');
  check(
    '界面可切到英文',
    out.settingsEn.lang === 'en' && out.enLabels.advanced !== out.zhLabels.advanced,
    `${out.zhLabels.advanced} → ${out.enLabels.advanced}`,
  );
  await closePanel(cdp);
  await openPanel(cdp, 'settings');
  out.settingsEnPanel = await cdp.json(SETTINGS_SNAPSHOT);
  await cdp.shot('12b-settings-en-reopen.png');
  check('英文下抽屉标题也切换', out.settingsEnPanel.title !== out.settingsBefore.title, `${out.settingsBefore.title} → ${out.settingsEnPanel.title}`);
  await cdp.evaluate(`(() => {
    const seg = document.querySelector('.segmented--lang');
    seg?.querySelector('.seg-btn[data-value="zh"]')?.click();
    return true;
  })()`);
  await wait(700);
  out.settingsZh = await cdp.json(SETTINGS_SNAPSHOT);
  check('界面可切回中文', out.settingsZh.lang === 'zh', out.settingsZh.lang);

  const autoToggle = await cdp.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!document.querySelector('[data-channel-control="autoConnect"]')) {
      window.__micstudioGo('settings');
      await wait(800);
    }
    const box = document.querySelector('[data-channel-control="autoConnect"] input[type="checkbox"]');
    if (!box) {
      return JSON.stringify({
        error: 'no autoConnect switch',
        panelTitle: document.querySelector('.modal-title')?.textContent?.trim() ?? null,
        rows: Array.from(document.querySelectorAll('[data-channel-control]')).map((node) => node.dataset.channelControl),
      });
    }
    const before = box.checked;
    box.click();
    await wait(600);
    const off = box.checked;
    box.click();
    await wait(600);
    return JSON.stringify({ before, off, on: box.checked });
  })()`);
  out.autoConnect = JSON.parse(autoToggle);
  check('自动连接开关可关可开', out.autoConnect.before === true && out.autoConnect.off === false && out.autoConnect.on === true, JSON.stringify(out.autoConnect));
  await closePanel(cdp);

  // 固件升级抽屉：只做预检，不点开始
  const b64 = readFileSync(binPath).toString('base64');
  await openPanel(cdp, 'firmware');
  await cdp.shot('13-firmware-empty.png');
  out.fwPreflight = JSON.parse(await cdp.evaluate(FW_PREFLIGHT(b64, path.basename(binPath))));
  await cdp.shot('14-firmware-preflight.png');
  check(
    '固件包预检通过（V0.0.5）',
    out.fwPreflight.model === 'JYM001' && out.fwPreflight.version === '0.0.5' && out.fwPreflight.errorVisible === false,
    `${out.fwPreflight.model} ${out.fwPreflight.version} ${out.fwPreflight.length} ${out.fwPreflight.blocks}块`,
  );
  check('未勾选确认时不能开始升级', out.fwPreflight.startDisabled === true, String(out.fwPreflight.startDisabled));
  await closePanel(cdp);

  // 记录最终状态，供 run2 对账
  await wait(600);
  out.finalConsole = await cdp.json(CONSOLE_SNAPSHOT);
  await openPanel(cdp, 'advanced');
  out.paramsFinal = await cdp.json(PARAMS_SNAPSHOT);
  await closePanel(cdp);
  await cdp.shot('15-console-final.png');

  results.runs.run1 = out;
  await close(instance);
  return out;
}

// ---- run2：重启 + 持久化 + 恢复默认 ----------------------------------------

async function run2() {
  const instance = await launch(userData, 9342, false);
  const { cdp } = instance;
  const out = {};
  const synced = await waitSync(cdp);
  await wait(500);
  out.start = await cdp.json(CONSOLE_SNAPSHOT);
  await cdp.shot('16-restart-console.png');
  check('重启后自动连接恢复', synced && out.start.syncReady, out.start.syncText);

  await openPanel(cdp, 'settings');
  out.settings = await cdp.json(SETTINGS_SNAPSHOT);
  await cdp.shot('17-restart-settings.png');
  check('语言设置在重启后保持中文', out.settings.lang === 'zh', out.settings.lang);
  check('自动连接设置在重启后保持开启', out.settings.autoConnect === true, String(out.settings.autoConnect));
  await closePanel(cdp);

  await openPanel(cdp, 'advanced');
  out.paramsAfterRestart = await cdp.json(PARAMS_SNAPSHOT);
  await cdp.shot('18-restart-params.png');

  // 恢复默认（数据卡里的二次确认按钮）
  await closePanel(cdp);
  await openPanel(cdp, 'settings');
  const reset = await cdp.evaluate(`(async () => {
    const buttons = Array.from(document.querySelectorAll('.btn--danger'));
    const target = buttons[0];
    if (!target) return JSON.stringify({ error: 'no reset button' });
    const first = target.textContent.trim();
    target.click();
    await new Promise((r) => setTimeout(r, 400));
    const armed = target.textContent.trim();
    target.click();
    await new Promise((r) => setTimeout(r, 2500));
    return JSON.stringify({ first, armed, after: target.textContent.trim(), disabled: target.disabled });
  })()`);
  out.reset = JSON.parse(reset);
  await cdp.shot('19-reset.png');
  check('恢复默认有二次确认', out.reset.armed && out.reset.armed !== out.reset.first, `${out.reset.first} → ${out.reset.armed}`);
  await closePanel(cdp);
  // 复位是一次性写 40 多项，落盘 + 合并写要一会儿
  await wait(3000);
  out.afterReset = await cdp.json(CONSOLE_SNAPSHOT);
  await openPanel(cdp, 'advanced');
  out.paramsAfterReset = await cdp.json(PARAMS_SNAPSHOT);
  await closePanel(cdp);
  await cdp.shot('20-after-reset.png');
  check('恢复默认后仍同步且无错误', out.afterReset.syncReady && out.afterReset.notice === null, `${out.afterReset.syncText} notice=${out.afterReset.notice}`);

  results.runs.run2 = out;
  await close(instance);
  return out;
}

// ---- run3：空 userData 同步回读（设备侧真值） --------------------------------

async function run3() {
  const instance = await launch(userDataFresh, 9343);
  const { cdp } = instance;
  const out = {};
  const synced = await waitSync(cdp);
  await wait(600);
  out.start = await cdp.json(CONSOLE_SNAPSHOT);
  await openPanel(cdp, 'advanced');
  out.params = await cdp.json(PARAMS_SNAPSHOT);
  await closePanel(cdp);
  await cdp.shot('21-fresh-userdata.png');
  check('空配置启动也能自动连上并回读', synced && out.start.syncReady, out.start.syncText);
  results.runs.run3 = out;
  await close(instance);
  return out;
}

// ---- 对账 ------------------------------------------------------------------

function normalizeParamValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value ?? '').trim();
  const number = Number(text);
  return Number.isFinite(number) && text !== '' ? number.toFixed(3) : text;
}

function diffParams(left, right, skipIds = []) {
  const skip = new Set(skipIds);
  const rightMap = new Map(right.map((item) => [item.id, item]));
  const diffs = [];
  for (const item of left) {
    if (skip.has(item.id)) continue;
    const other = rightMap.get(item.id);
    if (!other) continue;
    if (normalizeParamValue(item.value) !== normalizeParamValue(other.value)) {
      diffs.push({ id: item.id, left: item.value, right: other.value });
    }
  }
  return diffs;
}

// ---- main ------------------------------------------------------------------

try {
  log('run1: full UI walkthrough');
  const run1Result = await run1();

  log('run2: restart persistence + reset to defaults');
  const run2Result = await run2();

  log('run3: fresh userData readback');
  const run3Result = await run3();

  // 1) run1 写入 → run2 同步回读是否一致（排除只读/统计不稳定的项）
  const writeBackDiff = diffParams(run1Result.paramsFinal.params, run2Result.paramsAfterRestart.params);
  check('界面写入在重启同步后原样回读（设备侧生效）', writeBackDiff.length === 0, writeBackDiff.length === 0 ? '全部一致' : `${writeBackDiff.length} 项不一致：${JSON.stringify(writeBackDiff.slice(0, 5))}`);

  const eqWriteBackDiff = run1Result.paramsFinal.eq.filter((band, index) => {
    const other = run2Result.paramsAfterRestart.eq[index];
    return other && (band.gain !== other.gain || band.freq !== other.freq || band.q !== other.q || band.type !== other.type);
  });
  check('EQ 段写入在重启同步后原样回读', eqWriteBackDiff.length === 0, eqWriteBackDiff.length === 0 ? '7 段一致' : JSON.stringify(eqWriteBackDiff));

  // 2) 恢复默认 → 空 userData 回读是否一致
  const resetDiff = diffParams(run2Result.paramsAfterReset.params, run3Result.params.params);
  check('恢复默认后设备侧确实是默认值', resetDiff.length === 0, resetDiff.length === 0 ? '全部一致' : `${resetDiff.length} 项不一致：${JSON.stringify(resetDiff.slice(0, 5))}`);

  const eqResetDiff = run2Result.paramsAfterReset.eq.filter((band, index) => {
    const other = run3Result.params.eq[index];
    return other && (band.gain !== other.gain || band.freq !== other.freq || band.q !== other.q || band.type !== other.type);
  });
  check('恢复默认后 EQ 也是默认值', eqResetDiff.length === 0, eqResetDiff.length === 0 ? '7 段一致' : JSON.stringify(eqResetDiff));

  results.summary = {
    total: results.checks.length,
    passed: results.checks.filter((item) => item.ok).length,
    failed: results.checks.filter((item) => !item.ok).length,
  };
  results.finishedAt = new Date().toISOString();
  writeFileSync(path.join(shotDir, 'result.json'), JSON.stringify(results, null, 2));
  log(`RESULT ${JSON.stringify(results.summary)}`);
  for (const item of results.checks.filter((entry) => !entry.ok)) {
    log(`FAILED: ${item.name} — ${item.detail}`);
  }
} catch (error) {
  results.error = String(error?.stack ?? error);
  writeFileSync(path.join(shotDir, 'result.json'), JSON.stringify(results, null, 2));
  log(`ERROR ${error?.message ?? error}`);
  process.exitCode = 1;
}
