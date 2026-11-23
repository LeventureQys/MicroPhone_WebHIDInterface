/**
 * v1.1.3 追加：界面视觉审核（中英双语 × 三档视口 × 全部视图/抽屉）。
 *
 *   node scripts/probes/fulltest-ui-audit.mjs [--port=9387]
 *
 * 不只看"元素存在"，而是逐屏做 DOM 级审计：
 *   - 文本截断 / nowrap 溢出 / 输入框数字被裁 / 零尺寸
 *   - 元素越界（横向出视口、主界面纵向溢出、抽屉横向滚动）
 *   - 同父容器内可见元素重叠（>16 px²）
 *   - 同组分段/场景/音色/导航出现多个 is-active
 *   - 状态冲突（顶栏 tone vs sync、场景 vs 音色、旁通 vs 控件禁用、ENC 关 vs 档位）
 *   - i18n key 原文 / 英文界面残留中文
 *   - 低对比度文本（亮度比 < 2.5，近似值，只做提示）
 * 每个视图出图：artifacts/fulltest-20261121/ui-audit/<size>-<lang>-<view>.png
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
const port = Number(args.get('port') ?? 9387);
const exe = args.get('exe') ?? 'D:\\Temp\\micstudio-fulltest\\v1.1.3-baseline\\release\\MicStudio-1.1.2-portable.exe';
const outDir = args.get('out') ? path.resolve(args.get('out')) : path.join(repo, 'artifacts', 'fulltest-20261121', 'ui-audit');
const profile = 'D:\\Temp\\micstudio-fulltest\\userdata-ui-audit';
mkdirSync(outDir, { recursive: true });
if (!existsSync(exe)) throw new Error(`exe not found: ${exe}`);

const SIZES = [
  { id: '1266x783', width: 1266, height: 783 },
  { id: '1086x663', width: 1086, height: 663 },
  { id: '1426x863', width: 1426, height: 863 },
];
const VIEWS = [
  { id: 'console', drawer: null },
  { id: 'advanced-input', drawer: 'advanced', scroll: '[data-section="input"]' },
  { id: 'advanced-dynamics', drawer: 'advanced', scroll: '[data-section="dynamics"]' },
  { id: 'advanced-eq', drawer: 'advanced', scroll: '[data-section="eq"]' },
  { id: 'advanced-drc', drawer: 'advanced', scroll: '[data-section="drc"]' },
  { id: 'advanced-lighting', drawer: 'advanced', scroll: '[data-section="lighting"]' },
  { id: 'device', drawer: 'device' },
  { id: 'settings', drawer: 'settings' },
  { id: 'firmware', drawer: 'firmware' },
];

const results = { startedAt: new Date().toISOString(), checks: [], scans: [], measurements: {} };
const log = (...items) => console.log(`[ui-audit]`, new Date().toISOString().slice(11, 19), ...items);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  send(method, params = {}, timeoutMs = 30_000) {
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
    const result = await this.send('Page.captureScreenshot', { format: 'png' }, 20_000);
    writeFileSync(path.join(outDir, name), Buffer.from(result.data, 'base64'));
    return name;
  }
}

const HELPERS = `(() => {
  const visible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };
  const describe = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.')
      : '';
    return el.tagName.toLowerCase() + id + cls;
  };
  const textOf = (el) => (el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 90);
  const luminance = (rgb) => {
    const parts = String(rgb).replace(/[^0-9.,]/g, '').split(',').map(Number);
    if (parts.length < 3) return null;
    const [r, g, b] = parts.slice(0, 3).map((value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const effectiveBg = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      const bg = cs.backgroundColor;
      const parts = bg.replace(/[^0-9.,]/g, '').split(',').map(Number);
      const alpha = parts.length >= 4 ? parts[3] : 1;
      if (alpha > 0.5 && !/rgba?\\(0, 0, 0, 0\\)/.test(bg)) return bg;
      node = node.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor || 'rgb(0,0,0)';
  };
  window.__audit = {
    scan() {
      const issues = [];
      const seen = new Set();
      const push = (issue) => {
        const key = issue.type + '|' + issue.target + '|' + (issue.text ?? '');
        if (seen.has(key) || issues.length >= 60) return;
        seen.add(key);
        issues.push(issue);
      };
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const all = Array.from(document.querySelectorAll('body *')).filter(visible);

      // 1) 文本截断 / nowrap 溢出 / 输入框数字被裁
      for (const el of all) {
        const cs = getComputedStyle(el);
        const value = el.value ?? null;
        const hasText = (el.textContent ?? '').trim().length > 0 || (value !== null && String(value).length > 0);
        if (!hasText) continue;
        const clippedX = el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0;
        const ellipsis = cs.textOverflow === 'ellipsis' && clippedX;
        const nowrap = cs.whiteSpace === 'nowrap' && clippedX;
        if (ellipsis || nowrap) {
          push({ type: 'text-clipped', target: describe(el), text: textOf(el) || String(value ?? ''), clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, hasTitle: Boolean(el.title || el.getAttribute('aria-label')) });
          continue;
        }
        if (el.tagName === 'INPUT' && clippedX) {
          push({ type: 'input-clipped', target: describe(el), text: String(value ?? ''), clientWidth: el.clientWidth, scrollWidth: el.scrollWidth });
        }
      }

      // 2) 横向出视口（跳过 html/body 与可横向滚动的容器自身）
      for (const el of all) {
        if (el === document.body || el === document.documentElement) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0) continue;
        if (rect.left < -1 || rect.right > vw + 1) {
          const parent = el.parentElement;
          const parentScrollable = parent && getComputedStyle(parent).overflowX !== 'visible';
          if (!parentScrollable) push({ type: 'out-of-viewport-x', target: describe(el), text: textOf(el), left: Math.round(rect.left), right: Math.round(rect.right), vw });
        }
      }

      // 3) 主界面 / 抽屉的纵向溢出（可滚动容器自身不算）
      const consoleHost = document.querySelector('.console');
      if (consoleHost && visible(consoleHost)) {
        const cs = getComputedStyle(consoleHost);
        if (cs.overflowY === 'visible' && consoleHost.scrollHeight > consoleHost.clientHeight + 2) {
          push({ type: 'console-vscroll', target: describe(consoleHost), scrollHeight: consoleHost.scrollHeight, clientHeight: consoleHost.clientHeight });
        }
        if (cs.overflowX === 'visible' && consoleHost.scrollWidth > consoleHost.clientWidth + 2) {
          push({ type: 'console-hscroll', target: describe(consoleHost), scrollWidth: consoleHost.scrollWidth, clientWidth: consoleHost.clientWidth });
        }
      }
      for (const body of Array.from(document.querySelectorAll('.modal-body'))) {
        const cs = getComputedStyle(body);
        if (cs.overflowX === 'visible' && body.scrollWidth > body.clientWidth + 2) {
          push({ type: 'modal-hscroll', target: describe(body), scrollWidth: body.scrollWidth, clientWidth: body.clientWidth });
        }
      }

      // 4) 同父容器内可见元素重叠
      const candidates = all.filter((el) => el.matches('.card, .pfield, .switch-row, .scene-btn, .tone-chip, .btn, .device-row, .eq-row, .fw-step, .settings-pair, .segmented, .advanced-nav-link, .diag-stats > *, .console-gain-item, .pfield-label, .pfield-value, .pfield-unit, .console-gain-value'));
      const byParent = new Map();
      for (const el of candidates) {
        const parent = el.parentElement;
        if (!parent) continue;
        if (!byParent.has(parent)) byParent.set(parent, []);
        byParent.get(parent).push(el);
      }
      for (const [parent, items] of byParent) {
        for (let i = 0; i < items.length; i += 1) {
          for (let j = i + 1; j < items.length; j += 1) {
            const a = items[i].getBoundingClientRect();
            const b = items[j].getBoundingClientRect();
            const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (overlapX > 4 && overlapY > 4) {
              if (items[i].contains(items[j]) || items[j].contains(items[i])) continue;
              push({ type: 'overlap', target: describe(items[i]) + ' <> ' + describe(items[j]), text: textOf(items[i]) + ' | ' + textOf(items[j]), overlap: Math.round(overlapX) + 'x' + Math.round(overlapY) });
            }
          }
        }
      }

      // 5) 同组多个 is-active
      for (const group of ['.scene-row', '.tone-chips', '.advanced-nav', '.segmented', '.switch-grid', '.tune-switch-grid']) {
        for (const node of Array.from(document.querySelectorAll(group))) {
          if (!visible(node)) continue;
          const active = Array.from(node.querySelectorAll('.is-active')).filter(visible);
          if (active.length > 1) push({ type: 'multi-active', target: describe(node), text: active.map(describe).join(' , ') });
        }
      }

      // 6) 零尺寸 / 被压扁的文字元素（只报真正不可见的，单位 "s"、短数值这类窄元素属正常）
      for (const el of all) {
        if (!(el.textContent ?? '').trim()) continue;
        if (el.children.length > 0) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 3 || rect.height < 3) push({ type: 'collapsed-text', target: describe(el), text: textOf(el), w: Math.round(rect.width), h: Math.round(rect.height) });
      }

      // 7) 折行 / 同排高度不齐（英文比中文长，最容易露出来）
      const lineCount = (el) => {
        try {
          const range = document.createRange();
          range.selectNodeContents(el);
          const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
          return Math.max(1, new Set(rects.map((rect) => Math.round(rect.top))).size);
        } catch {
          return 1;
        }
      };
      for (const group of ['.tone-chips', '.scene-row', '.advanced-nav', '.segmented']) {
        for (const row of Array.from(document.querySelectorAll(group))) {
          if (!visible(row)) continue;
          const chips = Array.from(row.children).filter(visible);
          const byClass = new Map();
          for (const chip of chips) {
            const key = typeof chip.className === 'string' ? chip.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
            if (!byClass.has(key)) byClass.set(key, []);
            byClass.get(key).push(chip);
          }
          for (const [key, nodes] of byClass) {
            if (nodes.length < 2) continue;
            const heights = nodes.map((node) => Math.round(node.getBoundingClientRect().height));
            if (Math.max(...heights) - Math.min(...heights) > 4) {
              push({ type: 'uneven-row-height', target: describe(row) + ' > .' + key, text: 'heights=' + heights.join(',') });
            }
            const lines = nodes.map(lineCount);
            if (Math.max(...lines) > 1 && Math.min(...lines) === 1) {
              push({ type: 'inconsistent-wrap', target: describe(row) + ' > .' + key, text: nodes.map((node, index) => textOf(node) + ':' + lines[index] + '行').join(' | ') });
            }
            const explicit = nodes.filter((node) => lineCount(node) > 1);
            if (explicit.length > 0 && !(group === '.scene-row')) {
              push({ type: 'wrapped-text', target: describe(row) + ' > .' + key, text: explicit.map((node) => textOf(node)).join(' | ') });
            }
          }
        }
      }

      // 8) 低对比度（近似；只提示，不判死）
      for (const el of all) {
        if (el.children.length > 0 || !(el.textContent ?? '').trim()) continue;
        const cs = getComputedStyle(el);
        const fg = luminance(cs.color);
        const bg = luminance(effectiveBg(el));
        if (fg === null || bg === null) continue;
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        if (ratio < 2.2) push({ type: 'low-contrast', target: describe(el), text: textOf(el), ratio: Number(ratio.toFixed(2)) });
      }

      // 8) i18n key 原文 / 英文界面残留中文
      // 语言切换自身的“中文/English”是选项名，不算漏翻：把所有带 zh 选项的分段控件文本剔除
      const langNodes = Array.from(document.querySelectorAll('.segmented')).filter((node) => node.querySelector('.seg-btn[data-value="zh"]'));
      let bodyText = document.body.innerText;
      for (const node of langNodes) bodyText = bodyText.split(node.innerText).join('');
      const rawKeys = bodyText.match(/(^|\\s)(console|param|settings|fw|device|diag|common|drc|module|sync|scene|tone)\\.[a-zA-Z0-9_.]+(\\s|$)/g) ?? [];
      if (rawKeys.length > 0) push({ type: 'i18n-raw-key', target: 'body', text: rawKeys.slice(0, 6).join(' | ') });
      const lang = document.querySelector('.segmented--lang .seg-btn.is-active')?.dataset.value ?? null;
      if (lang === 'en') {
        const cjk = bodyText.match(/[\\u4e00-\\u9fff]+/g) ?? [];
        if (cjk.length > 0) push({ type: 'cjk-in-en', target: 'body', text: cjk.slice(0, 6).join(' | ') });
      }

      // 9) 状态一致性
      const syncPill = document.querySelector('#sync-pill');
      const tone = document.querySelector('#connect-btn')?.dataset.tone ?? null;
      const syncReady = Boolean(syncPill?.classList.contains('state-pill--ready'));
      if (tone === 'error' && syncReady) push({ type: 'state-conflict', target: '#connect-btn / #sync-pill', text: 'tone=error 但 sync pill=ready' });
      if (tone === 'demo' && !document.querySelector('#source-pill')?.classList.contains('is-demo')) {
        push({ type: 'state-conflict', target: '#connect-btn / #source-pill', text: 'tone=demo 但 source pill 未标 is-demo' });
      }
      const activeScenes = Array.from(document.querySelectorAll('.scene-btn.is-active')).filter(visible);
      const activeTone = document.querySelector('.tone-chip.is-active')?.dataset.tone ?? null;
      const sceneTone = { quiet: 'flat', meeting: 'vocal', podcast: 'warm', sing: 'bright', custom: 'custom' };
      for (const scene of activeScenes) {
        const want = sceneTone[scene.dataset.scene];
        if (want && activeTone && want !== activeTone) push({ type: 'state-conflict', target: '.scene-btn[data-scene=' + scene.dataset.scene + ']', text: '场景期望音色 ' + want + '，实际 ' + activeTone });
      }
      const eqBypass = document.querySelector('.modal-body [data-bypass="eq"] input[type="checkbox"]');
      if (eqBypass && eqBypass.checked) {
        const enabled = Array.from(document.querySelectorAll('.modal-body .eq-list input')).filter((node) => !node.disabled).length;
        if (enabled > 0) push({ type: 'state-conflict', target: '[data-bypass=eq]', text: '旁通开启但仍有 ' + enabled + ' 个 EQ 输入可用' });
      }
      const encOff = document.querySelector('[data-param="enc.OnOff"] input[type="checkbox"]');
      if (encOff && !encOff.checked) {
        const consoleLevel = Array.from(document.querySelectorAll('.switch-grid .seg-btn')).filter((node) => !node.disabled).length;
        if (consoleLevel > 0) push({ type: 'state-conflict', target: 'console .switch-grid enc level', text: 'ENC 关闭但主界面仍有 ' + consoleLevel + ' 个档位可点（已知 O-02）' });
      }

      return {
        viewport: { width: vw, height: vh },
        lang,
        issues,
        metrics: {
          nodes: document.getElementsByTagName('*').length,
          cards: Array.from(document.querySelectorAll('.console .card')).length,
          modal: document.querySelectorAll('.modal').length,
          modalBodyScrollHeight: document.querySelector('.modal-body')?.scrollHeight ?? null,
          modalBodyClientHeight: document.querySelector('.modal-body')?.clientHeight ?? null,
          consoleScrollHeight: consoleHost?.scrollHeight ?? null,
          consoleClientHeight: consoleHost?.clientHeight ?? null,
          bodyScrollWidth: document.body.scrollWidth,
        },
      };
    },
  };
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
      // 解包中
    }
    await wait(300);
  }
  return null;
}

async function main() {
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MICSTUDIO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(exe, ['--no-sandbox', `--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], { env, stdio: 'ignore', windowsHide: false });
  const target = await findTarget(90_000);
  if (!target) throw new Error('devtools target not found');
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
  const bootDeadline = Date.now() + 40_000;
  while (Date.now() < bootDeadline) {
    if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
    await wait(300);
  }
  // mock 隔离：不碰真机
  await cdp.evaluate(`(() => { localStorage.setItem('micstudio.channel','mock'); localStorage.setItem('micstudio.autoConnect','0'); location.reload(); return true; })()`);
  await wait(2200);
  const reloadDeadline = Date.now() + 30_000;
  while (Date.now() < reloadDeadline) {
    if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
    await wait(300);
  }
  await cdp.evaluate(HELPERS);
  await wait(1200);

  const totalIssues = [];
  for (const size of SIZES) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false }, 10_000);
    await wait(700);
    for (const lang of ['zh', 'en']) {
      await cdp.evaluate(`(() => { const box = document.querySelector('.segmented--lang'); const btn = box?.querySelector('.seg-btn[data-value="${lang}"]'); if (btn && !btn.classList.contains('is-active')) btn.click(); return true; })()`);
      await wait(900);
      await cdp.evaluate(HELPERS);
      for (const view of VIEWS) {
        try {
          if (view.drawer) {
            await cdp.evaluate(`window.__micstudioGo(${JSON.stringify(view.drawer)}); true`);
            await wait(650);
            if (view.scroll) {
              await cdp.evaluate(`document.querySelector(${JSON.stringify(view.scroll)})?.scrollIntoView({ block: 'start' }); true`);
              await wait(450);
            }
          } else {
            await cdp.evaluate(`window.__micstudioGo('none'); true`);
            await wait(350);
          }
          const scan = await cdp.evaluate(`window.__audit.scan()`);
          const shot = await cdp.shot(`ui-audit-${size.id}-${lang}-${view.id}.png`);
          const record = { size: size.id, lang, view: view.id, shot, ...scan };
          results.scans.push(record);
          for (const issue of scan.issues) totalIssues.push({ size: size.id, lang, view: view.id, ...issue });
          if (scan.issues.length > 0) {
            log(`${size.id} ${lang} ${view.id}: ${scan.issues.length} issues -> ${scan.issues.map((item) => item.type).join(',')}`);
          }
        } catch (error) {
          results.scans.push({ size: size.id, lang, view: view.id, error: String(error?.message ?? error) });
          log(`${size.id} ${lang} ${view.id} scan failed: ${error?.message ?? error}`);
        }
        if (view.drawer) {
          await cdp.keyEscape();
          await wait(300);
        }
      }
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, 10_000).catch(() => undefined);
  // 错误态：虚拟桥死端口
  try {
    await cdp.evaluate(`window.__micstudioGo('settings'); true`);
    await wait(600);
    await cdp.evaluate(`document.querySelector('[data-channel-control="kind"] .seg-btn[data-value="virtual"]')?.click(); true`);
    await wait(400);
    await cdp.evaluate(`(() => { const input = document.querySelector('[data-field="bridgeUrl"]'); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, 'ws://127.0.0.1:9/ws'); input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await wait(500);
    await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
    await cdp.evaluate(`location.reload(); true`);
    await wait(2400);
    await cdp.evaluate(HELPERS);
    await cdp.evaluate(`window.__micstudioGo('device'); true`);
    await wait(700);
    await cdp.evaluate(`document.querySelector('.device-actions .btn')?.click(); true`);
    await wait(3800);
    const errorScan = await cdp.evaluate(`window.__audit.scan()`);
    const errorShot = await cdp.shot('ui-audit-error-device.png');
    results.errorState = { shot: errorShot, ...errorScan };
    for (const issue of errorScan.issues) totalIssues.push({ lang: errorScan.lang, view: 'device-error', ...issue });
  } catch (error) {
    results.errorState = { error: String(error?.message ?? error) };
  }

  // ---- 汇总 ----------------------------------------------------------------
  const byType = {};
  for (const issue of totalIssues) byType[issue.type] = (byType[issue.type] ?? 0) + 1;
  results.summary = {
    scans: results.scans.length,
    screenshots: results.scans.filter((item) => item.shot).length + (results.errorState?.shot ? 1 : 0),
    issueCount: totalIssues.length,
    byType,
    byView: totalIssues.reduce((acc, item) => { const key = `${item.view}/${item.lang}`; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {}),
  };
  results.issues = totalIssues;
  results.finishedAt = new Date().toISOString();
  writeFileSync(path.join(outDir, 'ui-audit.json'), `${JSON.stringify(results, null, 1)}\n`, 'utf8');

  // markdown 摘要
  const lines = ['# 界面审核结果（自动生成）', '', `生成时间：${results.finishedAt}`, '', `扫描 ${results.summary.scans} 屏，截图 ${results.summary.screenshots} 张，问题 ${results.summary.issueCount} 条`, '', '## 按类型', ''];
  for (const [type, count] of Object.entries(byType)) lines.push(`- **${type}**：${count}`);
  lines.push('', '## 问题明细', '', '| 视口 | 语言 | 视图 | 类型 | 目标 | 文本/说明 |', '|---|---|---|---|---|---|');
  for (const issue of totalIssues.slice(0, 200)) {
    lines.push(`| ${issue.size ?? '-'} | ${issue.lang} | ${issue.view} | ${issue.type} | ${String(issue.target ?? '').replace(/\|/g, '/')} | ${String(issue.text ?? '').replace(/\|/g, '/').slice(0, 100)} |`);
  }
  writeFileSync(path.join(outDir, 'ui-audit.md'), `${lines.join('\n')}\n`, 'utf8');
  log(`SUMMARY scans=${results.summary.scans} shots=${results.summary.screenshots} issues=${results.summary.issueCount} ${JSON.stringify(byType)}`);
  try { spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(0);
}

main().catch((error) => {
  results.error = String(error?.stack ?? error);
  results.finishedAt = new Date().toISOString();
  writeFileSync(path.join(outDir, 'ui-audit.json'), `${JSON.stringify(results, null, 1)}\n`, 'utf8');
  console.error('[ui-audit] failed', error);
  try { spawn('taskkill', ['/PID', String(port), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(2);
});
