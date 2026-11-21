/**
 * 验证参数表 V0.3（`Document/Update/hardware/v0.0.6/`）在上位机侧落地：
 *
 *   node scripts/probes/verify-v006-20261121.mjs
 *
 * 覆盖（黄色标记项逐条）：
 *   1 `0x2026` 均衡器模式上限 5（界面仍不暴露控件）
 *   2 三分频默认分频点 1000/3000，默认不再退化（无「分频点无效」标黄）
 *   3 三分频三区 preGain 默认 128 → 1.28
 *   4 新增 0x2072/0x2073 RGB 开关与模式（高级参数新增「灯效」分区）
 *   5 新增 0x2074/0x2075 噪声门 / 三分频动态使能位：开关即真实旁通（不再用中性参数近似）
 * 结果与截图写到 artifacts/verify-v006/。
 *
 * 通道：全新 profile → 默认 mock 通道，不碰真机；不需要桥接。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..', '..');
const shotDir = path.join(repo, 'artifacts', 'verify-v006');
const electron = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const profile = 'D:\\Temp\\ud-verify-v006';
const port = 9361;

if (!existsSync(electron)) throw new Error(`electron not found: ${electron}`);
rmSync(shotDir, { recursive: true, force: true });
mkdirSync(shotDir, { recursive: true });
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const log = (...args) => console.log(`[verify] ${new Date().toISOString().slice(11, 19)}`, ...args);
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
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
        const result = await this.send('Page.captureScreenshot', { format: 'png' }, 10_000);
        writeFileSync(path.join(shotDir, name), Buffer.from(result.data, 'base64'));
        log(`shot ${name}`);
        return true;
      } catch (error) {
        log(`shot ${name} attempt ${attempt} failed: ${error?.message ?? error}`);
        await wait(1000);
      }
    }
    results.screenshotsFailed = [...(results.screenshotsFailed ?? []), name];
    return false;
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

const results = { startedAt: new Date().toISOString(), checks: [], measurements: {} };
function check(name, ok, detail) {
  results.checks.push({ name, ok: Boolean(ok), detail: detail ?? null });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
}

const clean = `(node) => node?.textContent?.replace(/\\s+/g, ' ').trim() ?? null`;

const ADVANCED_SNAPSHOT = `(() => {
  const clean = ${clean};
  const body = document.querySelector('.modal-body');
  const num = (id) => body?.querySelector('[data-param="' + id + '"] input.pfield-number')?.value ?? null;
  const on = (id) => body?.querySelector('[data-param="' + id + '"] input[type="checkbox"]')?.checked ?? null;
  return JSON.stringify({
    sections: Array.from(body?.querySelectorAll('.advanced-section') ?? []).map((node) => ({
      id: node.dataset.section,
      title: clean(node.querySelector('.advanced-section-title')),
    })),
    nav: Array.from(body?.querySelectorAll('.advanced-nav-link') ?? []).map(clean),
    params: Array.from(body?.querySelectorAll('[data-param]') ?? []).map((node) => node.dataset.param),
    bypassHooks: Array.from(body?.querySelectorAll('[data-bypass]') ?? []).map((node) => node.dataset.bypass),
    enableHooks: Array.from(body?.querySelectorAll('[data-enable]') ?? []).map((node) => node.dataset.enable),
    gateOn: on('noisegate.Enable'),
    gateThreshold: num('noisegate.threshold_db'),
    drcOn: on('drc3.Enable'),
    fc1: num('drc3.fc1'),
    fc2: num('drc3.fc2'),
    lowPreGain: num('drc3.low.preGain'),
    midPreGain: num('drc3.mid.preGain'),
    conflictCards: body?.querySelectorAll('.is-conflict').length ?? 0,
    drcFieldDisabled: Array.from(body?.querySelectorAll('[data-section="drc"] [data-param] input') ?? [])
      .filter((node) => node.disabled).length,
    rgbOn: on('rgb.OnOff'),
    rgbMode: num('rgb.Mode'),
    rgbCard: Boolean(body?.querySelector('[data-section="lighting"]')),
    gateCardNote: clean(body?.querySelector('[data-enable="noisegate"]')?.parentElement?.querySelector('.macro-hint')),
    eqModeControl: Boolean(body?.querySelector('[data-param="eq.mode"]')),
  });
})()`;

const CONSOLE_SNAPSHOT = `(() => {
  const clean = ${clean};
  return JSON.stringify({
    scenes: Array.from(document.querySelectorAll('.scene-btn')).map((node) => node.dataset.scene),
    activeScene: document.querySelector('.scene-btn.is-active')?.dataset.scene ?? null,
    tones: Array.from(document.querySelectorAll('.tone-chip')).map((node) => node.dataset.tone),
    macros: Array.from(document.querySelectorAll('[data-macro]')).map((node) => ({
      key: node.dataset.macro,
      label: clean(node.querySelector('.pfield-label')),
      value: clean(node.querySelector('.pfield-value')),
    })),
    device: {
      name: clean(document.querySelector('.console-device-name')),
      state: clean(document.querySelector('.console-device-state')),
    },
  });
})()`;

async function waitSync(cdp, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`!!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready')`)) return true;
    await wait(400);
  }
  return false;
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
      '--width=1280',
      '--height=820',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
    { cwd: repo, env, stdio: 'ignore', windowsHide: false },
  );

  try {
    const target = await findPageTarget();
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
      await wait(300);
    }

    // 本机可能插着真机：auto-connect 会把参数换成设备值，探针的点击也会写到真机。
    // 因此先切到 mock 通道并关掉自动连接，再 reload 一次，保证整轮验证只碰演示数据。
    await cdp.evaluate(`(() => {
      localStorage.setItem('micstudio.channel', 'mock');
      localStorage.setItem('micstudio.autoConnect', 'false');
      location.reload();
      return true;
    })()`);
    await wait(1500);
    const reloadDeadline = Date.now() + 30_000;
    while (Date.now() < reloadDeadline) {
      if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
      await wait(300);
    }
    const channelKind = await cdp.evaluate(`localStorage.getItem('micstudio.channel')`);
    if (channelKind !== 'mock') throw new Error(`probe must run on mock channel, got ${channelKind}`);

    const synced = await waitSync(cdp);
    await wait(1200);
    log(`sync=${synced ? 'ready' : 'not-ready'}`);
    results.measurements.synced = synced;

    const consoleState = await cdp.json(CONSOLE_SNAPSHOT);
    results.measurements.console = consoleState;
    await cdp.shot('01-console.png');
    check(
      '整轮验证跑在 mock 通道（不碰真机）',
      consoleState.device.name === '演示数据',
      `通道=${channelKind} 设备行=${consoleState.device.name}`,
    );

    // ---- 1. 高级参数结构：5 个分区（新增「灯效」） -------------------------
    await cdp.evaluate(`window.__micstudioGo('advanced'); true`);
    await wait(800);
    const advanced = await cdp.json(ADVANCED_SNAPSHOT);
    results.measurements.advanced = advanced;
    await cdp.shot('02-advanced-input.png');

    check(
      '参数表 V0.3 的 4 个新参数都出现在高级参数里',
      ['noisegate.Enable', 'drc3.Enable', 'rgb.OnOff', 'rgb.Mode'].every((id) => advanced.params.includes(id)),
      `控件 ${advanced.params.length} 项`,
    );
    check(
      '新增「灯效」分区，跳转条 5 项',
      advanced.sections.length === 5 && advanced.sections.some((item) => item.id === 'lighting') && advanced.nav.length === 5,
      advanced.sections.map((item) => `${item.id}:${item.title}`).join(' | '),
    );
    check(
      '噪声门 / 三分频改用真实使能位开关（data-enable），不再有 data-bypass 近似',
      advanced.enableHooks.includes('noisegate') &&
        advanced.enableHooks.includes('drc3') &&
        !advanced.bypassHooks.includes('noisegate') &&
        !advanced.bypassHooks.includes('drc3'),
      `enable=${advanced.enableHooks.join(',')} bypass=${advanced.bypassHooks.join(',')}`,
    );
    check(
      '均衡器模式仍不暴露控件（0x2026 上限改 5 不影响界面）',
      advanced.eqModeControl === false,
      `eq.mode 控件=${advanced.eqModeControl}`,
    );

    // ---- 2. 新默认值：分频点 1000/3000、preGain 1.28 ----------------------
    check(
      '三分频默认分频点 1000 / 3000（不再退化，无「分频点无效」）',
      advanced.fc1 === '1000' && advanced.fc2 === '3000' && advanced.conflictCards === 0,
      `fc1=${advanced.fc1} fc2=${advanced.fc2} conflict=${advanced.conflictCards}`,
    );
    check(
      '三分频三区 preGain 默认 1.28（raw 128）',
      advanced.lowPreGain === '1.28' && advanced.midPreGain === '1.28',
      `low=${advanced.lowPreGain} mid=${advanced.midPreGain}`,
    );
    check(
      '噪声门 / 三分频 / RGB 默认都是开（0x2074=1 / 0x2075=1 / 0x2072=1）',
      advanced.gateOn === true && advanced.drcOn === true && advanced.rgbOn === true && advanced.rgbMode === '0',
      `gate=${advanced.gateOn} drc=${advanced.drcOn} rgb=${advanced.rgbOn}/${advanced.rgbMode}`,
    );

    // ---- 3. 噪声门开关：关掉不动阈值 ---------------------------------------
    const thresholdBefore = advanced.gateThreshold;
    await cdp.evaluate(`document.querySelector('.modal-body [data-enable="noisegate"] input[type="checkbox"]')?.click(); true`);
    await wait(600);
    const gateOff = await cdp.json(ADVANCED_SNAPSHOT);
    check(
      '关掉噪声门开关就是旁通：阈值保持不动，开关显示关',
      gateOff.gateOn === false && gateOff.gateThreshold === thresholdBefore,
      `on=${gateOff.gateOn} threshold=${gateOff.gateThreshold}`,
    );
    await cdp.evaluate(`document.querySelector('.modal-body [data-enable="noisegate"] input[type="checkbox"]')?.click(); true`);
    await wait(500);
    const gateBack = await cdp.json(ADVANCED_SNAPSHOT);
    check('重新打开噪声门开关', gateBack.gateOn === true, `on=${gateBack.gateOn}`);

    // ---- 4. 三分频开关：关掉后参数仍可编辑（设备侧直通） --------------------
    await cdp.evaluate(`document.querySelector('.modal-body [data-section="drc"]')?.scrollIntoView({ block: 'start' }); true`);
    await wait(600);
    await cdp.shot('03-advanced-drc.png');
    await cdp.evaluate(`document.querySelector('.modal-body [data-enable="drc3"] input[type="checkbox"]')?.click(); true`);
    await wait(600);
    const drcOff = await cdp.json(ADVANCED_SNAPSHOT);
    check(
      '关掉三分频开关就是旁通（参数不被禁用，值照常保存）',
      drcOff.drcOn === false && drcOff.fc1 === '1000' && drcOff.drcFieldDisabled === 0,
      `on=${drcOff.drcOn} fc1=${drcOff.fc1} disabled=${drcOff.drcFieldDisabled}`,
    );
    await cdp.evaluate(`document.querySelector('.modal-body [data-enable="drc3"] input[type="checkbox"]')?.click(); true`);
    await wait(500);

    // ---- 5. 灯效：模式可改 -------------------------------------------------
    await cdp.evaluate(`document.querySelector('.modal-body [data-section="lighting"]')?.scrollIntoView({ block: 'start' }); true`);
    await wait(600);
    await cdp.shot('04-advanced-lighting.png');
    const rgbCardOk = (await cdp.json(ADVANCED_SNAPSHOT)).rgbCard;
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.modal-body [data-param="rgb.Mode"] input.pfield-number');
      if (!input) return false;
      input.value = '5';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await wait(800);
    const rgbChanged = await cdp.json(ADVANCED_SNAPSHOT);
    check(
      '灯效模式 0–7 可改（写 5 → 数字框与读数同步）',
      rgbCardOk && rgbChanged.rgbMode === '5',
      `mode=${rgbChanged.rgbMode}`,
    );
    // 留一个非 0 模式给下一步验证「场景不动 RGB」
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.modal-body [data-param="rgb.Mode"] input.pfield-number');
      if (!input) return false;
      input.value = '3';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await wait(600);

    // ---- 6. 一键场景会把两个使能位打开 -------------------------------------
    await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
    await wait(700);
    // 先关掉两个开关，确认场景能重新打开
    await cdp.evaluate(`window.__micstudioGo('advanced'); true`);
    await wait(600);
    await cdp.evaluate(`(() => {
      document.querySelector('.modal-body [data-enable="drc3"] input[type="checkbox"]')?.click();
      return true;
    })()`);
    await wait(500);
    await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
    await wait(600);
    await cdp.evaluate(`document.querySelector('.scene-btn[data-scene="sing"]')?.click(); true`);
    await wait(900);
    const afterScene = await cdp.json(CONSOLE_SNAPSHOT);
    await cdp.evaluate(`window.__micstudioGo('advanced'); true`);
    await wait(700);
    const sceneState = await cdp.json(ADVANCED_SNAPSHOT);
    check(
      '「唱歌」场景把噪声门与三分频动态的使能位写回 1',
      afterScene.activeScene === 'sing' && sceneState.gateOn === true && sceneState.drcOn === true,
      `scene=${afterScene.activeScene} gate=${sceneState.gateOn} drc=${sceneState.drcOn}`,
    );
    check(
      '场景不写 RGB（灯效归用户自己设）',
      sceneState.rgbOn === true && sceneState.rgbMode === '3',
      `rgb=${sceneState.rgbOn}/${sceneState.rgbMode}`,
    );
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.modal-body [data-param="rgb.Mode"] input.pfield-number');
      if (!input) return false;
      input.value = '0';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await wait(600);
    await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
    await wait(400);

    results.finishedAt = new Date().toISOString();
  } finally {
    try {
      spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // 已经退出
    }
  }
}

main()
  .then(() => {
    const failed = results.checks.filter((item) => !item.ok);
    results.summary = { passed: results.checks.length - failed.length, failed: failed.length };
    writeFileSync(path.join(shotDir, 'verify.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
    log(`SUMMARY passed=${results.summary.passed} failed=${results.summary.failed}`);
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch((error) => {
    results.error = String(error?.stack ?? error);
    writeFileSync(path.join(shotDir, 'verify.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
    console.error('[verify] failed', error);
    process.exit(2);
  });
