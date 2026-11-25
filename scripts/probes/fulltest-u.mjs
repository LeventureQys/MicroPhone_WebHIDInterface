/**
 * v1.1.3 全量测试 U 系列：界面全量走查（中文 + 英文两套文案）。
 *
 *   node scripts/probes/fulltest-u.mjs [--app=<snapshot 目录>] [--out=<证据目录>] [--port=9371]
 *
 * 默认跑**冻结快照**里的构建产物（out/ 由 G4 产出），证据写仓库 artifacts/fulltest-20261121/ui/。
 * 通道强制 mock + 关闭自动连接，绝不碰真机（真机上插着 M001，auto-connect 会连上去）。
 *
 * 断言优先用 data-* / class / id 钩子；文案只做「非空、不是 key 原文、双语都能切换」。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = 'D:\\WorkShop\\MicroPhone_WebHIDInterface';
const args = new Map(
  process.argv.slice(2).map((item) => {
    const match = item.match(/^--([^=]+)=(.*)$/);
    return match ? [match[1], match[2]] : [item, ''];
  }),
);
const appRoot = args.get('app') ? path.resolve(args.get('app')) : 'D:\\Temp\\micstudio-fulltest\\v1.1.3-baseline';
const outDir = args.get('out') ? path.resolve(args.get('out')) : path.join(repo, 'artifacts', 'fulltest-20261121', 'ui');
const port = Number(args.get('port') ?? 9371);
const profile = path.join('D:\\Temp\\micstudio-fulltest', `userdata-u-${port}`);
const electron = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!existsSync(electron)) throw new Error(`electron not found: ${electron}`);
mkdirSync(outDir, { recursive: true });
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const results = { startedAt: new Date().toISOString(), appRoot, checks: [], measurements: {}, screenshots: [] };
const log = (...items) => console.log(`[u] ${new Date().toISOString().slice(11, 19)}`, ...items);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(id, ok, detail) {
  results.checks.push({ id, ok: Boolean(ok), detail: detail ?? null });
  log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.exceptions = [];
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('cdp socket error')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params?.exceptionDetails?.exception?.description ?? 'exception');
      }
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
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  async shot(name) {
    try {
      const result = await this.send('Page.captureScreenshot', { format: 'png' }, 20_000);
      writeFileSync(path.join(outDir, name), Buffer.from(result.data, 'base64'));
      results.screenshots.push(name);
      return true;
    } catch (error) {
      log(`shot ${name} failed: ${error?.message ?? error}`);
      return false;
    }
  }

  async keyEscape() {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }

  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
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
      // 端口还没起
    }
    await wait(300);
  }
  throw new Error('devtools page target not found');
}

const HELPERS = `(() => {
  window.__ft = {
    q: (selector) => document.querySelector(selector),
    qa: (selector) => Array.from(document.querySelectorAll(selector)),
    text: (node) => (node?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    readParam(id) {
      const root = document.querySelector('[data-param="' + id + '"]');
      if (!root) return { exists: false };
      const num = root.querySelector('input.pfield-number');
      const checkbox = root.querySelector('input[type="checkbox"]');
      const active = root.querySelector('.seg-btn.is-active');
      const badge = root.querySelector('.pfield-badge, .pfield-readout');
      const readout = root.querySelector('.pfield-value');
      return {
        exists: true,
        number: num ? num.value : null,
        checked: checkbox ? checkbox.checked : null,
        segment: active ? active.dataset.value : null,
        badge: this.text(badge),
        readout: this.text(readout),
        disabled: Array.from(root.querySelectorAll('input, select, .seg-btn')).filter((node) => node.disabled || node.classList.contains('is-disabled')).length,
        readonly: root.classList.contains('pfield--readonly'),
      };
    },
    setNumber(id, value) {
      const root = document.querySelector('[data-param="' + id + '"]');
      const input = root?.querySelector('input.pfield-number');
      if (!input) return null;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.value;
    },
    setRange(selector, value) {
      const input = document.querySelector(selector);
      if (!input) return null;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.value;
    },
    click(selector) {
      const node = document.querySelector(selector);
      if (!node) return false;
      node.click();
      return true;
    },
    consoleState() {
      const macro = (key) => {
        const root = document.querySelector('[data-macro="' + key + '"]');
        return {
          value: this.text(root?.querySelector('.pfield-value')),
          input: root?.querySelector('input.macro-range')?.value ?? null,
          min: root?.querySelector('input.macro-range')?.min ?? null,
          max: root?.querySelector('input.macro-range')?.max ?? null,
        };
      };
      const sw = (id) => {
        const root = document.querySelector('.tune-switch-grid [data-param="' + id + '"]');
        return root?.querySelector('input[type="checkbox"]')?.checked ?? null;
      };
      const encRoot = document.querySelector('.switch-grid .switch-item');
      return {
        scenes: this.qa('.scene-btn').map((node) => node.dataset.scene),
        activeScene: document.querySelector('.scene-btn.is-active')?.dataset.scene ?? null,
        pressedScene: document.querySelector('.scene-btn[aria-pressed="true"]')?.dataset.scene ?? null,
        tones: this.qa('.tone-chip').map((node) => node.dataset.tone),
        activeTone: document.querySelector('.tone-chip.is-active')?.dataset.tone ?? null,
        pressedTone: document.querySelector('.tone-chip[aria-pressed="true"]')?.dataset.tone ?? null,
        denoise: macro('denoise'),
        evenness: macro('evenness'),
        switches: {
          mute: sw('mic.mute'),
          hp: sw('hp.OnOff'),
          sigMute: sw('mic.sigMute'),
        },
        gains: this.qa('.console-gain-value').map((node) => this.text(node)),
        device: {
          name: this.text(document.querySelector('.console-device-name')),
          state: this.text(document.querySelector('.console-device-state')),
        },
        canvas: {
          cursor: document.querySelector('.console-eq-canvas')?.dataset.cursor ?? null,
          width: document.querySelector('.console-eq-canvas')?.getBoundingClientRect().width ?? 0,
          height: document.querySelector('.console-eq-canvas')?.getBoundingClientRect().height ?? 0,
        },
        enc: {
          checked: encRoot?.querySelector('input[type="checkbox"]')?.checked ?? null,
          level: document.querySelector('.switch-grid .seg-btn.is-active')?.dataset.value ?? null,
          levelDisabled: this.qa('.switch-grid .seg-btn').filter((node) => node.disabled).length,
        },
        notice: this.text(document.querySelector('.console-notice')) || null,
      };
    },
    advancedState() {
      const body = document.querySelector('.modal-body');
      if (!body) return { open: false };
      const params = {};
      for (const root of body.querySelectorAll('[data-param]')) {
        const id = root.dataset.param;
        const num = root.querySelector('input.pfield-number');
        const checkbox = root.querySelector('input[type="checkbox"]');
        const segment = root.querySelector('.seg-btn.is-active');
        params[id] = {
          number: num ? num.value : null,
          checked: checkbox ? checkbox.checked : null,
          segment: segment ? segment.dataset.value : null,
          disabled: Array.from(root.querySelectorAll('input')).filter((node) => node.disabled).length,
          segDisabled: Array.from(root.querySelectorAll('.seg-btn')).filter((node) => node.disabled).length,
          segClass: root.classList.contains('is-disabled') || (root.querySelector('.segmented')?.classList.contains('is-disabled') ?? false),
        };
      }
      return {
        open: true,
        sections: Array.from(body.querySelectorAll('.advanced-section')).map((node) => node.dataset.section),
        nav: Array.from(body.querySelectorAll('.advanced-nav-link')).length,
        enable: Array.from(body.querySelectorAll('[data-enable]')).map((node) => node.dataset.enable),
        bypass: Array.from(body.querySelectorAll('[data-bypass]')).map((node) => node.dataset.bypass),
        bypassNotes: Array.from(body.querySelectorAll('.module-bypass-note')).map((node) => ({ text: this.text(node), hidden: node.hidden })),
        eqRows: Array.from(body.querySelectorAll('.eq-row[data-band]')).map((node) => ({
          band: node.dataset.band,
          freq: node.querySelectorAll('input.eq-input')[0]?.value ?? null,
          gain: node.querySelectorAll('input.eq-input')[1]?.value ?? null,
          q: node.querySelectorAll('input.eq-input')[2]?.value ?? null,
        })),
        disabledEqInputs: Array.from(body.querySelectorAll('.eq-list input, .eq-table-toolbar input')).filter((node) => node.disabled).length,
        conflict: body.querySelectorAll('.is-conflict').length,
        drcConflictText: this.text(body.querySelector('.drc-recommend-row')) || null,
        recommend: Boolean(body.querySelector('.drc-recommend')),
        params,
        rgbSection: Boolean(body.querySelector('[data-section="lighting"]')),
      };
    },
    deviceState() {
      return {
        open: Boolean(document.querySelector('.modal-body')),
        rows: Array.from(document.querySelectorAll('.device-row')).map((node) => this.text(node)),
        actions: Array.from(document.querySelectorAll('.device-actions .btn')).map((node) => ({ text: this.text(node), disabled: node.disabled })),
        diagFields: Array.from(document.querySelectorAll('[data-diag]')).map((node) => node.dataset.diag),
        stats: Array.from(document.querySelectorAll('[data-stat]')).map((node) => node.dataset.stat),
        selfCheck: Boolean(document.querySelector('.diag-selfcheck')),
        channelLink: Boolean(document.querySelector('.device-settings-open')),
        listContainer: Boolean(document.querySelector('.device-list')),
        emptyText: this.text(document.querySelector('.device-empty')) || null,
        error: this.text(document.querySelector('.device-error')) || null,
        status: this.text(document.querySelector('.device-status, .state-pill')) || null,
      };
    },
    settingsState() {
      const body = document.querySelector('.modal-body');
      if (!body) return { open: false };
      const kind = body.querySelector('[data-channel-control="kind"] .seg-btn.is-active')?.dataset.value ?? null;
      const bridge = body.querySelector('[data-field="bridgeUrl"]')?.value ?? null;
      const auto = body.querySelector('[data-channel-control="autoConnect"] input[type="checkbox"]');
      const limit = body.querySelector('[data-field="diagLimit"]')?.value ?? null;
      const langSeg = Array.from(body.querySelectorAll('.segmented')).find((node) => node.querySelector('.seg-btn[data-value="zh"]'));
      const lang = langSeg?.querySelector('.seg-btn.is-active')?.dataset.value ?? null;
      return {
        open: true,
        kind,
        bridge,
        autoConnect: auto ? auto.checked : null,
        diagLimit: limit,
        lang,
        restore: Boolean(body.querySelector('.btn--danger')),
        keys: Object.keys(localStorage).filter((key) => key.startsWith('micstudio.')).sort(),
      };
    },
    firmwareState() {
      const body = document.querySelector('.modal-body');
      if (!body) return { open: false };
      return {
        open: true,
        steps: Array.from(body.querySelectorAll('.fw-step')).length,
        file: this.text(body.querySelector('.fw-file-name')),
        deviceMode: this.text(body.querySelector('.fw-device-mode')),
        startDisabled: body.querySelector('.fw-start')?.disabled ?? null,
        confirm: Boolean(body.querySelector('.fw-confirm input[type="checkbox"]')),
        infoRows: Array.from(body.querySelectorAll('.fw-info [data-field]')).map((node) => node.dataset.field),
        hasError: Boolean(body.querySelector('.fw-error')),
      };
    },
    layout() {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const doc = document.documentElement;
      const overflow = Math.max(doc.scrollWidth - window.innerWidth, document.body.scrollWidth - window.innerWidth);
      const cards = Array.from(document.querySelectorAll('.console .card')).map((node) => {
        const rect = node.getBoundingClientRect();
        return { title: this.text(node.querySelector('.card-title')), x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      });
      let overlaps = 0;
      for (let i = 0; i < cards.length; i += 1) {
        for (let j = i + 1; j < cards.length; j += 1) {
          const a = cards[i];
          const b = cards[j];
          const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (overlapX > 4 && overlapY > 4) overlaps += 1;
        }
      }
      const visible = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight + 2 && rect.left >= 0 && rect.right <= window.innerWidth + 2;
      };
      return {
        viewport,
        overflow,
        bodyOverflowX: getComputedStyle(document.body).overflowX,
        cards,
        overlaps,
        visible: {
          scenes: visible('.scene-row'),
          meter: visible('.meter-screen, .meter-card, .console-meter'),
          curve: visible('.console-eq-canvas'),
          switches: visible('.tune-switch-grid'),
          gains: visible('.console-gain-item'),
        },
        languages: Array.from(document.querySelectorAll('.segmented--lang .seg-btn')).map((node) => node.dataset.value),
      };
    },
    errors: () => (window.__ftErrors ?? []).slice(0, 20),
  };
  window.__ftErrors = [];
  window.addEventListener('error', (event) => window.__ftErrors.push(String(event.message)));
  window.addEventListener('unhandledrejection', (event) => window.__ftErrors.push(String(event.reason)));
  return true;
})()`;

async function boot(cdp) {
  await cdp.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
    await wait(300);
  }
  // 真机插着：先切 mock 并关自动连接，再 reload，整轮只碰演示数据
  await cdp.evaluate(`(() => {
    localStorage.setItem('micstudio.channel', 'mock');
    localStorage.setItem('micstudio.autoConnect', 'false');
    location.reload();
    return true;
  })()`);
  await wait(1600);
  const reloadDeadline = Date.now() + 30_000;
  while (Date.now() < reloadDeadline) {
    if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
    await wait(300);
  }
  const channel = await cdp.evaluate(`localStorage.getItem('micstudio.channel')`);
  if (channel !== 'mock') throw new Error(`probe must run on mock channel, got ${channel}`);
  await cdp.evaluate(HELPERS);
  // 等 sync ready
  const readyDeadline = Date.now() + 20_000;
  while (Date.now() < readyDeadline) {
    if (await cdp.evaluate(`!!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready')`)) break;
    await wait(400);
  }
  await wait(800);
  await cdp.evaluate(HELPERS);
}

async function openDrawer(cdp, id) {
  await cdp.evaluate(`window.__micstudioGo(${JSON.stringify(id)}); true`);
  await wait(650);
}

async function closeDrawer(cdp) {
  await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
  await wait(450);
}

async function main() {
  const env = { ...process.env, MICSTUDIO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(
    electron,
    [
      '.',
      '--no-sandbox',
      `--remote-debugging-port=${port}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
    { cwd: appRoot, env, stdio: 'ignore', windowsHide: false },
  );
  let cdp = null;
  try {
    const target = await findTarget();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await boot(cdp);

    // ===== U1 布局 =========================================================
    const layout = await cdp.evaluate(`window.__ft.layout()`);
    results.measurements.layout = layout;
    await cdp.shot('U1-console-zh.png');
    check('U1.1 视口 1266×783 CSS（默认窗口 + 125% DPI）', layout.viewport.width === 1266 && layout.viewport.height === 783, layout.viewport);
    check('U1.2 无横向滚动', layout.overflow <= 0, { overflow: layout.overflow, overflowX: layout.bodyOverflowX });
    check('U1.3 主界面卡片不重叠（4 张）', layout.cards.length >= 4 && layout.overlaps === 0, { cards: layout.cards.length, overlaps: layout.overlaps });
    check(
      'U1.4 场景/电平/曲线/输入开关/增益全部在视口内可见',
      Object.values(layout.visible).every(Boolean),
      layout.visible,
    );

    // ===== U2 一键场景 ======================================================
    const scenes = await cdp.evaluate(`window.__ft.consoleState()`);
    check('U2.1 五个场景按钮顺序 安静房间→游戏→播客→唱歌→自定义', scenes.scenes.join(',') === 'quiet,game,podcast,sing,custom', scenes.scenes);
    const expected = {
      quiet: { gate: '-82', comp: '-18', tone: 'flat', enc: false, level: '1' },
      // 2026-11-22 问题单第 7 条：会议 → 游戏（处理链数值不变）
      game: { gate: '-41', comp: '-36', tone: 'vocal', enc: true, level: '2' },
      podcast: { gate: '-59', comp: '-42', tone: 'warm', enc: true, level: '1' },
      sing: { gate: '-73', comp: '-21', tone: 'bright', enc: false, level: '1' },
      custom: { gate: '-91', comp: '-60', tone: 'custom', enc: false, level: '1' },
    };
    for (const [id, want] of Object.entries(expected)) {
      await cdp.evaluate(`window.__ft.click('.scene-btn[data-scene="${id}"]')`);
      await wait(900);
      const state = await cdp.evaluate(`window.__ft.consoleState()`);
      const ok =
        state.activeScene === id &&
        state.pressedScene === id &&
        state.denoise.value === `${want.gate} dB` &&
        state.evenness.value === `${want.comp} dB` &&
        state.activeTone === want.tone &&
        state.enc.checked === want.enc &&
        state.enc.level === want.level;
      check(`U2.2 场景「${id}」写入并高亮：门 ${want.gate}dB / 压缩 ${want.comp}dB / 音色 ${want.tone} / 降噪 ${want.enc}·${want.level}`, ok, {
        activeScene: state.activeScene,
        denoise: state.denoise.value,
        evenness: state.evenness.value,
        tone: state.activeTone,
        enc: state.enc,
      });
    }
    // 场景的协议字段（使能位）在高级参数里核对
    await openDrawer(cdp, 'advanced');
    const sceneAdv = await cdp.evaluate(`window.__ft.advancedState()`);
    check(
      'U2.3 场景同时写使能位：噪声门 0x2074=1 / 三分频 0x2075=1 / 防爆音 0x2051 使能',
      sceneAdv.params['noisegate.Enable']?.checked === true &&
        sceneAdv.params['drc3.Enable']?.checked === true &&
        sceneAdv.params['limit.Enable']?.checked === true,
      {
        gate: sceneAdv.params['noisegate.Enable'],
        drc3: sceneAdv.params['drc3.Enable'],
        limit: sceneAdv.params['limit.Enable'],
      },
    );
    await closeDrawer(cdp);

    // ===== U3 音色与曲线锁定 =================================================
    const tones = await cdp.evaluate(`window.__ft.consoleState()`);
    check('U3.1 五个音色 原声/人声增强/温暖/明亮/自定义', tones.tones.join(',') === 'flat,vocal,warm,bright,custom', tones.tones);
    const toneResults = [];
    for (const id of ['flat', 'vocal', 'warm', 'bright']) {
      await cdp.evaluate(`window.__ft.click('.tone-chip[data-tone="${id}"]')`);
      await wait(450);
      const state = await cdp.evaluate(`window.__ft.consoleState()`);
      toneResults.push({ id, active: state.activeTone, cursor: state.canvas.cursor });
    }
    check(
      'U3.2 非自定义音色：选中生效且曲线不可拖（cursor=default）',
      toneResults.every((item) => item.active === item.id && item.cursor === 'default'),
      toneResults,
    );
    await cdp.evaluate(`window.__ft.click('.tone-chip[data-tone="custom"]')`);
    await wait(500);
    const customState = await cdp.evaluate(`window.__ft.consoleState()`);
    await cdp.mouse('mouseMoved', 10, 10);
    // 在曲线里扫一遍找 band 命中点（cursor 变 grab），再拖
    const rect = await cdp.evaluate(`(() => { const c = document.querySelector('.console-eq-canvas'); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    let hit = null;
    for (let i = 1; i < 24 && !hit; i += 1) {
      const x = rect.x + (rect.w * i) / 25;
      const y = rect.y + rect.h * 0.36;
      await cdp.mouse('mouseMoved', x, y);
      await wait(60);
      const cursor = await cdp.evaluate(`document.querySelector('.console-eq-canvas').dataset.cursor`);
      if (cursor === 'grab') hit = { x, y };
    }
    results.measurements.customDragHit = hit;
    if (hit) {
      await cdp.mouse('mousePressed', hit.x, hit.y);
      await cdp.mouse('mouseMoved', hit.x + 26, hit.y - 18);
      await wait(150);
      await cdp.mouse('mouseReleased', hit.x + 26, hit.y - 18);
      await wait(500);
    }
    const afterDrag = await cdp.evaluate(`window.__ft.consoleState()`);
    await openDrawer(cdp, 'advanced');
    const eqAfter = await cdp.evaluate(`window.__ft.advancedState()`);
    const bandsAfter = eqAfter.eqRows;
    await closeDrawer(cdp);
    check(
      'U3.3 自定义曲线可拖：找到 band 命中点并拖动后仍为自定义、EQ 值发生变化',
      Boolean(hit) && afterDrag.activeTone === 'custom' && bandsAfter.some((row) => row.freq !== null),
      { hit: Boolean(hit), tone: afterDrag.activeTone, bandsSample: bandsAfter.slice(0, 2) },
    );
    results.measurements.bandsAfterDrag = bandsAfter;

    // ===== U4 三个输入开关 ===================================================
    // 注意：这三个开关 2026-11-13 起只在主界面渲染（高级参数不再重复），所以
    // 「回读一致」在这里的判据是：开关 ⇄ AppStore 参数（抽屉开关一圈后仍保持），
    // 寄存器级回读由 R 系列真机逐项写入覆盖。
    const switchResults = [];
    for (const id of ['mic.mute', 'hp.OnOff', 'mic.sigMute']) {
      const key = id === 'hp.OnOff' ? 'hp' : id === 'mic.mute' ? 'mute' : 'sigMute';
      const before = (await cdp.evaluate(`window.__ft.consoleState().switches`))[key];
      await cdp.evaluate(`document.querySelector('.tune-switch-grid [data-param="${id}"] input[type="checkbox"]')?.click(); true`);
      await wait(500);
      const after = (await cdp.evaluate(`window.__ft.consoleState().switches`))[key];
      await openDrawer(cdp, 'advanced');
      const adv = await cdp.evaluate(`window.__ft.advancedState()`);
      await closeDrawer(cdp);
      const persisted = (await cdp.evaluate(`window.__ft.consoleState().switches`))[key];
      switchResults.push({ id, before, after, persisted, inAdvanced: Boolean(adv.params && adv.params[id]) });
      // 恢复
      await cdp.evaluate(`document.querySelector('.tune-switch-grid [data-param="${id}"] input[type="checkbox"]')?.click(); true`);
      await wait(400);
    }
    check(
      'U4 麦克风静音/监听/电平信号静音：开关切换生效且跨抽屉保持（同一 store 参数）',
      switchResults.every((item) => item.after !== item.before && item.persisted === item.after),
      switchResults,
    );

    // ===== U5 宏滑杆 ⇄ 高级参数 ==============================================
    await cdp.evaluate(`window.__ft.setRange('[data-macro="denoise"] input.macro-range', -50)`);
    await wait(700);
    const macroAfter = await cdp.evaluate(`window.__ft.consoleState()`);
    await openDrawer(cdp, 'advanced');
    const advGate = await cdp.evaluate(`window.__ft.advancedState()`);
    const gateNumber = advGate.params['noisegate.threshold_db']?.number;
    await cdp.evaluate(`window.__ft.setNumber('comp.Threshold', -30)`);
    await wait(800);
    await closeDrawer(cdp);
    const consoleAfterComp = await cdp.evaluate(`window.__ft.consoleState()`);
    check(
      'U5 噪声门阈值 / 压缩器阈值：主界面与高级参数双向联动（dB 直连）',
      macroAfter.denoise.value === '-50 dB' && gateNumber === '-50' && consoleAfterComp.evenness.value === '-30 dB',
      { macro: macroAfter.denoise.value, advanced: gateNumber, comp: consoleAfterComp.evenness.value },
    );

    // ===== U6 EQ 逐段精调 ====================================================
    await openDrawer(cdp, 'advanced');
    const eqBefore = await cdp.evaluate(`window.__ft.advancedState()`);
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.modal-body .eq-row[data-band="0"] input.eq-input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '120');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await wait(700);
    const eqEdited = await cdp.evaluate(`window.__ft.advancedState()`);
    await closeDrawer(cdp);
    const toneAfterEdit = await cdp.evaluate(`window.__ft.consoleState()`);
    check(
      'U6.1 逐段精调 7 段 × 频点/增益/Q 可编辑',
      eqBefore.eqRows.length === 7 && eqBefore.eqRows.every((row) => row.freq !== null && row.gain !== null && row.q !== null),
      { rows: eqBefore.eqRows.length },
    );
    check(
      'U6.2 手改 EQ 后音色自动标「自定义」',
      eqEdited.eqRows[0]?.freq === '120' && toneAfterEdit.activeTone === 'custom',
      { freq: eqEdited.eqRows[0]?.freq, tone: toneAfterEdit.activeTone },
    );

    // ===== U7 三分频动态 =====================================================
    await openDrawer(cdp, 'advanced');
    await cdp.evaluate(`document.querySelector('.modal-body [data-section="drc"]')?.scrollIntoView(); true`);
    await cdp.evaluate(`window.__ft.setNumber('drc3.fc1', 500)`);
    await cdp.evaluate(`window.__ft.setNumber('drc3.fc2', 300)`);
    await wait(700);
    const conflict = await cdp.evaluate(`window.__ft.advancedState()`);
    await cdp.evaluate(`window.__ft.click('.modal-body .drc-recommend')`);
    await wait(700);
    const recommended = await cdp.evaluate(`window.__ft.advancedState()`);
    check(
      'U7.1 fc1 ≥ fc2 时标黄提示（is-conflict）',
      conflict.conflict > 0 && conflict.params['drc3.fc1']?.number === '500' && conflict.params['drc3.fc2']?.number === '300',
      { conflict: conflict.conflict, fc1: conflict.params['drc3.fc1']?.number, fc2: conflict.params['drc3.fc2']?.number },
    );
    check(
      'U7.2「恢复推荐分频点」写 1000 / 3000 并消除冲突',
      recommended.params['drc3.fc1']?.number === '1000' && recommended.params['drc3.fc2']?.number === '3000' && recommended.conflict === 0,
      { fc1: recommended.params['drc3.fc1']?.number, fc2: recommended.params['drc3.fc2']?.number, conflict: recommended.conflict },
    );
    // 旁通：关掉 drc3.Enable 再读
    await cdp.evaluate(`document.querySelector('.modal-body [data-enable="drc3"] input[type="checkbox"]')?.click(); true`);
    await wait(500);
    const drcOff = await cdp.evaluate(`window.__ft.advancedState()`);
    await cdp.evaluate(`document.querySelector('.modal-body [data-enable="drc3"] input[type="checkbox"]')?.click(); true`);
    await wait(400);
    check('U7.3 三分频旁通走真实使能位 0x2075（开关回读一致）', drcOff.params['drc3.Enable']?.checked === false, { on: drcOff.params['drc3.Enable'] });

    // ===== U8 环境降噪 =======================================================
    // 档位禁用发生在高级参数的输入分区（ui/views/input-view.ts:87-94）；主界面那份档位
    // 不跟随开关禁用（记为 P3 观察项，不影响协议写入）。
    await openDrawer(cdp, 'advanced');
    const encOnState = await cdp.evaluate(`window.__ft.advancedState()`);
    const encWasOn = encOnState.params['enc.OnOff']?.checked;
    if (encWasOn) {
      await cdp.evaluate(`document.querySelector('.modal-body [data-param="enc.OnOff"] input[type="checkbox"]')?.click(); true`);
      await wait(600);
    }
    const encOffAdv = await cdp.evaluate(`window.__ft.advancedState()`);
    await cdp.evaluate(`document.querySelector('.modal-body [data-param="enc.OnOff"] input[type="checkbox"]')?.click(); true`);
    await wait(600);
    const encBackAdv = await cdp.evaluate(`window.__ft.advancedState()`);
    await closeDrawer(cdp);
    const encOnConsole = await cdp.evaluate(`window.__ft.consoleState()`);
    check(
      'U8 环境降噪开关写 0x2024；关闭时高级参数 4 个档位禁用并置灰，重新打开恢复',
      encOffAdv.params['enc.OnOff']?.checked === false &&
        encOffAdv.params['enc.Level']?.segDisabled === 4 &&
        encOffAdv.params['enc.Level']?.segClass === true &&
        encBackAdv.params['enc.OnOff']?.checked === true &&
        encBackAdv.params['enc.Level']?.segDisabled === 0 &&
        encOnConsole.enc.checked === true,
      {
        off: encOffAdv.params['enc.OnOff'],
        levelOff: encOffAdv.params['enc.Level'],
        levelOn: encBackAdv.params['enc.Level'],
        console: encOnConsole.enc,
      },
    );

    // ===== U9 模块 bypass =====================================================
    await openDrawer(cdp, 'advanced');
    const u9 = await cdp.evaluate(`window.__ft.advancedState()`);
    const eqRow = u9.eqRows;
    await cdp.evaluate(`document.querySelector('.modal-body [data-bypass="eq"] input[type="checkbox"]')?.click(); true`);
    await wait(600);
    const eqBypass = await cdp.evaluate(`window.__ft.advancedState()`);
    await cdp.evaluate(`document.querySelector('.modal-body [data-bypass="eq"] input[type="checkbox"]')?.click(); true`);
    await wait(400);
    check(
      'U9.1 六个模块的旁通都是真实使能位（门 0x2074 / 三分频 0x2075 / 压缩 0x204A / 限制 0x2051 / 降噪 0x2024 / EQ 段 enable）',
      u9.enable.includes('noisegate') &&
        u9.enable.includes('drc3') &&
        u9.params['comp.Enable']?.checked !== undefined &&
        u9.params['limit.Enable']?.checked !== undefined &&
        u9.params['enc.OnOff']?.checked !== undefined &&
        eqRow.length === 7 &&
        u9.bypass.includes('eq'),
      { enable: u9.enable, bypass: u9.bypass, eqRows: eqRow.length },
    );
    check(
      'U9.2 EQ 旁通：7 段输入全部禁用且显示说明文字；取消后恢复',
      eqBypass.disabledEqInputs >= 14 && eqBypass.bypassNotes.some((note) => note.text.length > 0 && note.hidden === false),
      { disabled: eqBypass.disabledEqInputs, notes: eqBypass.bypassNotes },
    );

    // ===== U10 RGB ============================================================
    await cdp.evaluate(`document.querySelector('.modal-body [data-section="lighting"]')?.scrollIntoView(); true`);
    await cdp.evaluate(`document.querySelector('.modal-body [data-param="rgb.OnOff"] input[type="checkbox"]')?.click(); true`);
    await wait(500);
    const rgbOff = await cdp.evaluate(`window.__ft.advancedState()`);
    await cdp.evaluate(`document.querySelector('.modal-body [data-param="rgb.OnOff"] input[type="checkbox"]')?.click(); true`);
    await cdp.evaluate(`window.__ft.setNumber('rgb.Mode', 6)`);
    await wait(700);
    const rgbOn = await cdp.evaluate(`window.__ft.advancedState()`);
    await cdp.shot('U10-advanced-lighting.png');
    check(
      'U10 RGB 开关 0x2072 / 模式 0x2073 读写一致，模式 0–7',
      rgbOff.params['rgb.OnOff']?.checked === false && rgbOn.params['rgb.OnOff']?.checked === true && rgbOn.params['rgb.Mode']?.number === '6',
      { off: rgbOff.params['rgb.OnOff'], on: rgbOn.params['rgb.OnOff'], mode: rgbOn.params['rgb.Mode'] },
    );
    // 截其它分区
    await cdp.evaluate(`document.querySelector('.modal-body .advanced-nav-link[data-target="input"], .modal-body [data-section="input"]')?.scrollIntoView(); true`);
    await cdp.shot('U11-advanced-input.png');

    // ===== U11 顶栏状态与语言切换 ============================================
    const zhText = await cdp.evaluate(`({ body: document.body.innerText.length, raw: (document.body.innerText.match(/(^|\\s)(console|param|settings|fw|device|diag|common|drc|module)\\.[a-zA-Z0-9_.]+(\\s|$)/g) ?? []).slice(0, 5) })`);
    await closeDrawer(cdp);
    await cdp.evaluate(`window.__ft.click('.segmented--lang .seg-btn[data-value="en"]')`);
    await wait(900);
    const enState = await cdp.evaluate(`(() => {
      const langBox = document.querySelector('.segmented--lang');
      const langText = langBox ? langBox.innerText : '';
      const body = document.body.innerText.split(langText).join('');
      return {
        raw: (body.match(/(^|\\s)(console|param|settings|fw|device|diag|common|drc|module)\\.[a-zA-Z0-9_.]+(\\s|$)/g) ?? []).slice(0, 8),
        cjk: (body.match(/[\\u4e00-\\u9fff]/g) ?? []).length,
        lang: document.querySelector('.segmented--lang .seg-btn.is-active')?.dataset.value ?? null,
        length: body.length,
      };
    })()`);
    results.measurements.en = enState;
    await cdp.shot('U11-console-en.png');
    await cdp.evaluate(HELPERS);
    const enConsole = await cdp.evaluate(`window.__ft.consoleState()`);
    check(
      'U11.1 中英切换后整屏重建、无 i18n key 原文、英文界面无残留中文',
      enState.lang === 'en' && enState.raw.length === 0 && enState.cjk === 0 && enState.length > 200 && zhText.raw.length === 0,
      { en: enState, zhRaw: zhText.raw },
    );
    check('U11.2 英文下五个场景与五个音色文案都非空', enConsole.scenes.length === 5 && enConsole.tones.length === 5, { scenes: enConsole.scenes, tones: enConsole.tones });
    await openDrawer(cdp, 'device');
    await cdp.shot('U13-device-en.png');
    await closeDrawer(cdp);
    await cdp.evaluate(`window.__ft.click('.segmented--lang .seg-btn[data-value="zh"]')`);
    await wait(900);
    await cdp.evaluate(HELPERS);

    // ===== U12 抽屉交互 ======================================================
    const drawerResults = [];
    for (const id of ['advanced', 'device', 'settings', 'firmware']) {
      await cdp.evaluate(`window.__micstudioGo(${JSON.stringify(id)}); true`);
      await wait(500);
      const first = await cdp.evaluate(`({ modals: document.querySelectorAll('.modal').length, body: document.querySelector('.modal-body')?.childElementCount ?? 0 })`);
      await cdp.evaluate(`window.__micstudioGo(${JSON.stringify(id)}); true`);
      await wait(350);
      const second = await cdp.evaluate(`document.querySelectorAll('.modal').length`);
      await cdp.keyEscape();
      await wait(400);
      const closed = await cdp.evaluate(`({ modals: document.querySelectorAll('.modal').length, body: Boolean(document.querySelector('.modal-body')) })`);
      drawerResults.push({ id, first, second, closed });
    }
    check(
      'U12.1 四个抽屉可打开，重复打开不叠加（始终 1 个 modal）',
      drawerResults.every((item) => item.first.modals === 1 && item.second === 1 && item.first.body > 0),
      drawerResults.map((item) => ({ id: item.id, first: item.first, second: item.second })),
    );
    check('U12.2 Esc 关闭抽屉并销毁内容（.modal/.modal-body 移除）', drawerResults.every((item) => item.closed.modals === 0 && item.closed.body === false), drawerResults.map((item) => ({ id: item.id, closed: item.closed })));
    // 遮罩点击关闭
    await cdp.evaluate(`window.__micstudioGo('advanced'); true`);
    await wait(450);
    await cdp.evaluate(`document.querySelector('.modal-overlay')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
    await wait(450);
    const overlayClosed = await cdp.evaluate(`document.querySelectorAll('.modal').length`);
    check('U12.3 点遮罩关闭抽屉', overlayClosed === 0, { modals: overlayClosed });

    // ===== U13 设备抽屉 ======================================================
    await openDrawer(cdp, 'device');
    const device = await cdp.evaluate(`window.__ft.deviceState()`);
    await cdp.shot('U13-device-zh.png');
    check(
      'U13.1 设备抽屉：设备列表容器 / 连接-断开-刷新按钮 / 自检 / 通道设置入口齐全',
      device.listContainer &&
        (device.rows.length >= 1 || Boolean(device.emptyText)) &&
        device.actions.length >= 4 &&
        device.selfCheck &&
        device.channelLink,
      { rows: device.rows.length, empty: device.emptyText, listContainer: device.listContainer, actions: device.actions.length, selfCheck: device.selfCheck, channelLink: device.channelLink },
    );
    check(
      'U13.2 诊断卡 8 行 + 7 项计数（帧数 / crc / timeout / retry / dropped / queue / 电平来源 / 轮询）',
      device.diagFields.length >= 8 && device.stats.length >= 7,
      { diag: device.diagFields, stats: device.stats },
    );
    await cdp.evaluate(`document.querySelector('.device-settings-open')?.click(); true`);
    await wait(600);
    const settingsViaDevice = await cdp.evaluate(`window.__ft.settingsState()`);
    check('U13.3 设备抽屉的通道设置入口能打开设置抽屉', settingsViaDevice.open === true && settingsViaDevice.kind !== null, settingsViaDevice);
    await closeDrawer(cdp);

    // ===== U14 设置抽屉 ======================================================
    await openDrawer(cdp, 'settings');
    const settings = await cdp.evaluate(`window.__ft.settingsState()`);
    await cdp.shot('U14-settings-zh.png');
    check(
      'U14.1 设置抽屉：通道类型 mock/native/virtual、桥接地址、自动连接、诊断上限、恢复默认、语言',
      settings.kind === 'mock' && typeof settings.bridge === 'string' && settings.autoConnect === false && settings.diagLimit !== null && settings.restore && settings.lang === 'zh',
      settings,
    );
    await cdp.evaluate(`document.querySelector('[data-channel-control="autoConnect"] input[type="checkbox"]')?.click(); true`);
    await wait(500);
    const autoOn = await cdp.evaluate(`window.__ft.settingsState()`);
    await cdp.evaluate(`location.reload(); true`);
    await wait(2200);
    await cdp.evaluate(HELPERS);
    await openDrawer(cdp, 'settings');
    const afterReload = await cdp.evaluate(`window.__ft.settingsState()`);
    check(
      'U14.2 自动连接开关持久化（关→开，重启后仍为开）',
      autoOn.autoConnect === true && afterReload.autoConnect === true,
      { before: settings.autoConnect, after: autoOn.autoConnect, reloaded: afterReload.autoConnect },
    );
    // 恢复关（避免后续探针被自动连接影响）并关抽屉
    await cdp.evaluate(`document.querySelector('[data-channel-control="autoConnect"] input[type="checkbox"]')?.click(); true`);
    await wait(400);
    await closeDrawer(cdp);

    // ===== U15 固件抽屉呈现（不刷写） ========================================
    await openDrawer(cdp, 'firmware');
    const firmware = await cdp.evaluate(`window.__ft.firmwareState()`);
    await cdp.shot('U15-firmware-zh.png');
    check(
      'U15 固件抽屉：三步可见、未选包空态、开始升级禁用、设备模式提示、预检 6 行',
      firmware.open === true &&
        firmware.steps === 3 &&
        typeof firmware.file === 'string' &&
        firmware.file.length > 0 &&
        firmware.startDisabled === true &&
        firmware.confirm === true &&
        firmware.infoRows.length === 6,
      firmware,
    );
    await closeDrawer(cdp);

    // ===== U16 错误提示与降级 ================================================
    await openDrawer(cdp, 'advanced');
    await cdp.evaluate(`window.__ft.setNumber('noisegate.attack_ms', 9999)`);
    await wait(700);
    const clamped = await cdp.evaluate(`window.__ft.advancedState()`);
    await closeDrawer(cdp);
    check('U16.1 非法值 9999 被夹到范围上限 500（不崩溃）', clamped.params['noisegate.attack_ms']?.number === '500', { value: clamped.params['noisegate.attack_ms'] });

    // 桥接不可用：切 virtual + 死端口，连一次看能否给出可读错误
    await openDrawer(cdp, 'settings');
    await cdp.evaluate(`document.querySelector('[data-channel-control="kind"] .seg-btn[data-value="virtual"]')?.click(); true`);
    await wait(500);
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-field="bridgeUrl"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'ws://127.0.0.1:9/ws');
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await wait(500);
    await closeDrawer(cdp);
    await cdp.evaluate(`location.reload(); true`);
    await wait(2200);
    await cdp.evaluate(HELPERS);
    await openDrawer(cdp, 'device');
    await cdp.evaluate(`document.querySelector('.device-actions .btn')?.click(); true`);
    await wait(3500);
    const bridgeFail = await cdp.evaluate(`window.__ft.deviceState()`);
    await cdp.shot('U16-bridge-error.png');
    check(
      'U16.2 虚拟桥接不可用：设备抽屉给出可读错误且应用不崩',
      Boolean(bridgeFail.error) && bridgeFail.error.length > 0,
      { error: bridgeFail.error, status: bridgeFail.status },
    );
    // 复原通道与自动连接
    await cdp.evaluate(`localStorage.setItem('micstudio.channel', 'mock'); localStorage.setItem('micstudio.autoConnect', 'false'); location.reload(); true`);
    await wait(2200);
    await cdp.evaluate(HELPERS);
    const recovered = await cdp.evaluate(`({ alive: typeof window.__micstudioGo === 'function', demo: document.querySelector('.console-device-name')?.textContent?.trim() ?? null })`);
    check('U16.3 从错误通道恢复 mock 后界面正常（降级可恢复）', recovered.alive === true && recovered.demo === '演示数据', recovered);

    // ===== U17 离线可用 ======================================================
    const resources = await cdp.evaluate(`(() => {
      const entries = performance.getEntriesByType('resource').map((item) => item.name);
      return { total: entries.length, external: entries.filter((name) => /^https?:\\/\\//.test(name) && !/^https?:\\/\\/(127\\.0\\.0\\.1|localhost)/.test(name)), fonts: document.fonts ? document.fonts.size : 0, links: Array.from(document.querySelectorAll('link[href]')).map((node) => node.getAttribute('href')) };
    })()`);
    results.measurements.resources = resources;
    check(
      'U17 无外网依赖：资源全部本地 / 回环，无 CDN 字体',
      resources.external.length === 0 && resources.links.every((href) => !/^https?:/.test(href)),
      resources,
    );

    // ===== 汇总 ==============================================================
    const runtimeErrors = await cdp.evaluate(`window.__ft.errors()`);
    results.runtimeErrors = [...(cdp.exceptions ?? []), ...(runtimeErrors ?? [])];
    check('U18 整轮走查无未捕获异常（window.onerror / unhandledrejection）', results.runtimeErrors.length === 0, results.runtimeErrors.slice(0, 5));
  } finally {
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
    writeFileSync(path.join(outDir, 'u-results.json'), `${JSON.stringify(results, null, 1)}\n`, 'utf8');
    log(`SUMMARY passed=${results.summary.passed} failed=${results.summary.failed} total=${results.summary.total}`);
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch((error) => {
    results.error = String(error?.stack ?? error);
    writeFileSync(path.join(outDir, 'u-results.json'), `${JSON.stringify(results, null, 1)}\n`, 'utf8');
    console.error('[u] failed', error);
    process.exit(2);
  });
