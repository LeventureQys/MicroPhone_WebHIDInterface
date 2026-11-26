/**
 * 对照 `D:\Temp\usb audio demo buglist.docx`（2026-11-13）逐条验证上位机侧修复。
 *
 *   node scripts/probes/verify-buglist-20261113.mjs
 *
 * 真机插着时会自动连上（auto-connect），没有真机时退化为 mock 通道，界面检查照样成立。
 * 覆盖：
 *   1 耳机音量跳动 → 连续采样主界面增益读数，统计抖动次数（去抖后应几乎不变）
 *   2 频繁查询 USB/描述符 → 包住 navigator.hid.getDevices 计数，连接稳定后应为 0 次
 *   3 频繁调参压死设备 → 模拟 2.5 s 连续拖拽，看诊断卡 outFrames：拖拽期间 0 帧、停手后 1 帧
 *   4 界面文字/布局 → 场景顺序、音色、阈值直连、输入开关、高级参数无增益卡/无 EQ 模式、
 *     环境降噪可关、各模块旁通、自定义曲线只有「自定义」可拖、自定义场景
 *   5 三分频动态 → 退化分频提示、推荐分频点、阈值可改、旁通
 *
 * 结果与截图写到 artifacts/verify-20261113/。结束时把参数恢复成参数表默认值（等同设置页「恢复默认」）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..', '..');
const shotDir = path.join(repo, 'artifacts', 'verify-20261113');
const electron = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const profile = 'D:\\Temp\\ud-verify-buglist';
const port = 9353;

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
    // 截图失败不影响结论：检查项全部走 Runtime.evaluate
    results.screenshotsFailed = [...(results.screenshotsFailed ?? []), name];
    return false;
  }

  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
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

const CONSOLE_SNAPSHOT = `(() => {
  const clean = ${clean};
  const macro = (key) => {
    const node = document.querySelector('[data-macro="' + key + '"]');
    const range = node?.querySelector('input[type="range"]');
    return node ? {
      label: clean(node.querySelector('.pfield-label')),
      value: clean(node.querySelector('.pfield-value')),
      range: range ? { min: range.min, max: range.max, step: range.step, value: range.value } : null,
    } : null;
  };
  const tune = document.querySelector('.console-middle .card');
  const switches = document.querySelector('.console-middle .card:last-child');
  const tuneRect = tune?.getBoundingClientRect() ?? null;
  const switchRect = switches?.getBoundingClientRect() ?? null;
  return JSON.stringify({
    scenes: Array.from(document.querySelectorAll('.scene-btn')).map((node) => ({
      id: node.dataset.scene,
      name: clean(node.querySelector('.scene-name')),
      active: node.getAttribute('aria-pressed') === 'true',
    })),
    tones: Array.from(document.querySelectorAll('.tone-chip')).map((node) => ({
      id: node.dataset.tone,
      label: clean(node),
      active: node.getAttribute('aria-pressed') === 'true',
    })),
    macros: { denoise: macro('denoise'), evenness: macro('evenness') },
    inputSwitches: Array.from(document.querySelectorAll('.tune-switch-grid [data-param]')).map((node) => ({
      id: node.dataset.param,
      label: clean(node.querySelector('.switch-label') ?? node),
      checked: node.querySelector('input[type="checkbox"]')?.checked ?? null,
    })),
    gains: Array.from(document.querySelectorAll('.console-gain-value')).map(clean),
    eqModeOnConsole: Boolean(document.querySelector('[data-param="eq.mode"]')),
    eqDesc: clean(document.querySelector('.console-eq .card-desc')),
    notice: document.querySelector('.console-notice')?.hidden ? null : clean(document.querySelector('.console-notice')),
    device: { name: clean(document.querySelector('.console-device-name')), state: clean(document.querySelector('.console-device-state')) },
    layout: tuneRect && switchRect ? { tuneBottom: Math.round(tuneRect.bottom), switchTop: Math.round(switchRect.top) } : null,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  });
})()`;

const ADVANCED_SNAPSHOT = `(() => {
  const clean = ${clean};
  const body = document.querySelector('.modal-body');
  const num = (id) => body?.querySelector('[data-param="' + id + '"] input.pfield-number')?.value ?? null;
  const disabledCount = (sel) => Array.from(body?.querySelectorAll(sel) ?? []).filter((node) => node.disabled).length;
  return JSON.stringify({
    sections: Array.from(body?.querySelectorAll('.advanced-section') ?? []).map((node) => ({
      id: node.dataset.section,
      title: clean(node.querySelector('.advanced-section-title')),
      desc: clean(node.querySelector('.advanced-section-desc')),
    })),
    params: Array.from(body?.querySelectorAll('[data-param]') ?? []).map((node) => node.dataset.param),
    noisegateThreshold: num('noisegate.threshold_db'),
    fc1: num('drc3.fc1'),
    fc2: num('drc3.fc2'),
    eqRowDisabled: disabledCount('.eq-row[data-band] input, .eq-row[data-band] select'),
    levelSegDisabled: disabledCount('[data-param="enc.Level"] .seg-btn'),
    levelSegHasDisabledClass: body?.querySelector('[data-param="enc.Level"]')?.classList.contains('is-disabled') ?? null,
    encOn: body?.querySelector('[data-param="enc.OnOff"] input[type="checkbox"]')?.checked ?? null,
    gateThresholdDisabled: body?.querySelector('[data-param="noisegate.threshold_db"] input.pfield-range')?.disabled ?? null,
    // 2026-11-21 参数表 V0.3 起噪声门 / 三分频是真实使能位（data-enable），
    // 不再是「钉阈值 + 禁用字段」的中性旁通；下面两个键读取新开关
    gateEnable: body?.querySelector('[data-enable="noisegate"] input[type="checkbox"]')?.checked ?? null,
    drcEnable: body?.querySelector('[data-enable="drc3"] input[type="checkbox"]')?.checked ?? null,
    drcFieldDisabled: disabledCount('[data-section="drc"] [data-param] input, [data-section="drc"] [data-param] select'),
    eqBypass: body?.querySelector('[data-bypass="eq"] input[type="checkbox"]')?.checked ?? null,
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

function devicesOf() {
  return null;
}

async function main() {
  void devicesOf;
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
      // 窗口被别的窗口压住时 Chromium 会降频渲染 / 节流定时器，截图与拖拽会失真
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
    const synced = await waitSync(cdp);
    await wait(1200);
    log(`sync=${synced ? 'ready' : 'not-ready'}`);

    // ---- 1. 主界面：场景顺序 / 音色 / 阈值 / 输入开关 ------------------------
    const consoleState = await cdp.json(CONSOLE_SNAPSHOT);
    results.measurements.device = consoleState.device;
    results.measurements.gains = consoleState.gains;
    await cdp.shot('01-console.png');
    check(
      // 2026-11-22 问题单第 7 条：会议 → 游戏
      '一键场景顺序 安静房间-游戏-播客-唱歌-自定义',
      consoleState.scenes.map((item) => item.id).join(',') === 'quiet,game,podcast,sing,custom',
      consoleState.scenes.map((item) => item.name).join(' → '),
    );
    check(
      '音色为 原声/人声增强/温暖/明亮/自定义，且没有「音乐」',
      consoleState.tones.map((item) => item.label).join(',') === '原声,人声增强,温暖,明亮,自定义',
      consoleState.tones.map((item) => item.label).join(','),
    );
    check(
      '「降噪强度」→「噪声门阈值」（dB 直连）',
      consoleState.macros.denoise?.label === '噪声门阈值' && /dB$/.test(consoleState.macros.denoise?.value ?? ''),
      `${consoleState.macros.denoise?.label} = ${consoleState.macros.denoise?.value}`,
    );
    check(
      '「声音平稳」→「压缩器阈值」（dB 直连）',
      consoleState.macros.evenness?.label === '压缩器阈值' && /dB$/.test(consoleState.macros.evenness?.value ?? ''),
      `${consoleState.macros.evenness?.label} = ${consoleState.macros.evenness?.value}`,
    );
    check(
      '三个输入开关已移到主界面快速调音',
      consoleState.inputSwitches.map((item) => item.id).join(',') === 'mic.mute,hp.OnOff,mic.sigMute',
      JSON.stringify(consoleState.inputSwitches),
    );
    check(
      '中栏「快速调音」与「快捷开关」不重叠',
      consoleState.layout && consoleState.layout.tuneBottom <= consoleState.layout.switchTop + 1,
      JSON.stringify(consoleState.layout),
    );

    // ---- 2. 问题 1：耳机/麦克风增益读数是否还在跳 ----------------------------
    const jitter = await cdp.json(`(async () => {
      const read = () => Array.from(document.querySelectorAll('.console-gain-value')).map((node) => node.textContent.trim());
      const samples = [];
      const start = Date.now();
      while (Date.now() - start < 12_000) {
        samples.push(read().join('/'));
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const distinct = new Set(samples);
      let transitions = 0;
      for (let index = 1; index < samples.length; index += 1) if (samples[index] !== samples[index - 1]) transitions += 1;
      return JSON.stringify({ frames: samples.length, distinct: distinct.size, transitions, values: [...distinct].slice(0, 8) });
    })()`);
    results.measurements.gainJitter = jitter;
    check(
      '问题1：连续 12 s 采样增益读数，ADC 抖动没有传到界面',
      jitter.transitions <= 2,
      `${jitter.frames} 次采样（250 ms 一次）里变化 ${jitter.transitions} 次，出现 ${jitter.distinct} 个不同读数：${jitter.values.join(' , ')}`,
    );

    // ---- 3. 问题 2：连上以后还会不会反复查 USB / 描述符 ----------------------
    const probeCount = await cdp.json(`(async () => {
      const hid = navigator.hid;
      if (!hid) return JSON.stringify({ error: 'no navigator.hid' });
      window.__getDevicesCalls = 0;
      const original = hid.getDevices.bind(hid);
      hid.getDevices = (...args) => { window.__getDevicesCalls += 1; return original(...args); };
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      return JSON.stringify({ calls: window.__getDevicesCalls, connected: !!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready') });
    })()`);
    results.measurements.getDevicesCalls = probeCount;
    check(
      '问题2：连接稳定后 12 s 内不再调用 navigator.hid.getDevices（旧实现 1.5 s 一次≈8 次）',
      probeCount.calls === 0,
      `12 s 内 ${probeCount.calls} 次，连接状态 ready=${probeCount.connected}`,
    );

    // ---- 4. 阈值与高级参数同一个值 ------------------------------------------
    await cdp.evaluate(`(() => {
      const range = document.querySelector('[data-macro="denoise"] input[type="range"]');
      range.value = '-40';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await wait(900);
    const afterDrag = await cdp.json(CONSOLE_SNAPSHOT);
    await cdp.evaluate(`window.__micstudioGo('advanced'); true`);
    await wait(700);
    const advanced = await cdp.json(ADVANCED_SNAPSHOT);
    await cdp.shot('02-advanced-input.png');
    check(
      '主界面噪声门阈值与高级参数「噪声门 阈值」是同一个值',
      afterDrag.macros.denoise?.value === '-40 dB' && advanced.noisegateThreshold === '-40',
      `console=${afterDrag.macros.denoise?.value} advanced=${advanced.noisegateThreshold}`,
    );
    check(
      '高级参数不再有「增益」卡（三个输入开关只在主界面）',
      !advanced.sections.some((item) => /gain/i.test(item.id)) &&
        !advanced.params.some((id) => ['gain.Mic', 'gain.Hp', 'mic.mute', 'hp.OnOff', 'mic.sigMute'].includes(id)),
      advanced.sections.map((item) => item.title).join(' | '),
    );
    check(
      '高级参数不再有「均衡器模式」(eq.mode) 控件',
      !advanced.params.includes('eq.mode'),
      `控件 ${advanced.params.length} 项`,
    );

    // ---- 5. 环境降噪可关闭：关掉后档位禁用 ----------------------------------
    const encInitial = await cdp.json(`(() => JSON.stringify({
      checked: document.querySelector('.modal-body [data-param="enc.OnOff"] input[type="checkbox"]')?.checked ?? null,
    }))()`);
    if (encInitial.checked !== false) {
      await cdp.evaluate(`document.querySelector('.modal-body [data-param="enc.OnOff"] input[type="checkbox"]')?.click(); true`);
      await wait(600);
    }
    const encOff = await cdp.json(ADVANCED_SNAPSHOT);
    check(
      '高级参数里环境降噪可关闭，关闭后档位不可操作',
      encOff.encOn === false && encOff.levelSegDisabled === 4 && encOff.levelSegHasDisabledClass === true,
      `encOn=${encOff.encOn} disabledSegs=${encOff.levelSegDisabled}`,
    );
    if (encInitial.checked !== false) {
      await cdp.evaluate(`document.querySelector('.modal-body [data-param="enc.OnOff"] input[type="checkbox"]')?.click(); true`);
      await wait(600);
    }

    // ---- 6. 各模块旁通 ------------------------------------------------------
    // 2026-11-21 参数表 V0.3：噪声门改真实使能位（`0x2074`），关掉即直通，
    // 阈值不被动、字段不禁用——旧实现「钉 -91 dB + 禁用」已删除
    await cdp.evaluate(`document.querySelector('.modal-body [data-enable="noisegate"] input[type="checkbox"]')?.click(); true`);
    await wait(600);
    const gateOff = await cdp.json(ADVANCED_SNAPSHOT);
    check(
      '噪声门开关是真实使能位（关掉后阈值不动、字段仍可编辑）',
      gateOff.gateEnable === false && gateOff.noisegateThreshold === '-40' && gateOff.gateThresholdDisabled === false,
      `enable=${gateOff.gateEnable} threshold=${gateOff.noisegateThreshold} disabled=${gateOff.gateThresholdDisabled}`,
    );
    await cdp.evaluate(`document.querySelector('.modal-body [data-enable="noisegate"] input[type="checkbox"]')?.click(); true`);
    await wait(600);
    const gateRestored = await cdp.json(ADVANCED_SNAPSHOT);
    check(
      '重新打开噪声门开关后阈值保持原值',
      gateRestored.gateEnable === true && gateRestored.noisegateThreshold === '-40',
      `enable=${gateRestored.gateEnable} threshold=${gateRestored.noisegateThreshold}`,
    );

    await cdp.evaluate(`document.querySelector('.modal-body [data-bypass="eq"] input[type="checkbox"]')?.click(); true`);
    await wait(600);
    const eqBypassed = await cdp.json(ADVANCED_SNAPSHOT);
    await cdp.shot('03-advanced-eq-bypass.png');
    check(
      '均衡器有旁通开关（7 段全部禁用）',
      eqBypassed.eqBypass === true && eqBypassed.eqRowDisabled >= 7,
      `disabledInputs=${eqBypassed.eqRowDisabled}`,
    );
    await cdp.evaluate(`document.querySelector('.modal-body [data-bypass="eq"] input[type="checkbox"]')?.click(); true`);
    await wait(600);

    // ---- 7. 三分频动态：可调 + 退化分频提示 + 推荐分频点 --------------------
    await cdp.evaluate(`(() => {
      document.querySelector('.modal-body [data-section="drc"]')?.scrollIntoView({ block: 'start' });
      return true;
    })()`);
    await wait(700);
    // 先把两个分频点写成 50/50，制造退化分频（不依赖设备当前状态）
    await cdp.evaluate(`(() => {
      const set = (id, value) => {
        const input = document.querySelector('.modal-body [data-param="' + id + '"] input.pfield-number');
        if (!input) return;
        input.value = String(value);
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('drc3.fc1', 50);
      set('drc3.fc2', 50);
      return true;
    })()`);
    await wait(1200);
    const drcConflict = await cdp.json(`(() => {
      const clean = ${clean};
      const body = document.querySelector('.modal-body');
      return JSON.stringify({
        fc1: body?.querySelector('[data-param="drc3.fc1"] input.pfield-number')?.value ?? null,
        fc2: body?.querySelector('[data-param="drc3.fc2"] input.pfield-number')?.value ?? null,
        conflictCards: body?.querySelectorAll('.is-conflict').length ?? 0,
        conditions: Array.from(body?.querySelectorAll('[data-section="drc"] .card-desc') ?? []).map(clean).slice(0, 4),
      });
    })()`);
    await cdp.shot('04-advanced-drc.png');
    check(
      '三分频 50/50（中频段为空）会标黄并提示分频点无效',
      drcConflict.fc1 === '50' && drcConflict.fc2 === '50' && drcConflict.conflictCards >= 3 &&
        drcConflict.conditions.some((text) => (text ?? '').includes('分频点')),
      `fc1=${drcConflict.fc1} fc2=${drcConflict.fc2} conflict=${drcConflict.conflictCards} text=${drcConflict.conditions[0]}`,
    );
    await cdp.evaluate(`document.querySelector('.modal-body .drc-recommend')?.click(); true`);
    await wait(1200);
    const drcAfter = await cdp.json(`(() => {
      const body = document.querySelector('.modal-body');
      return JSON.stringify({
        fc1: body?.querySelector('[data-param="drc3.fc1"] input.pfield-number')?.value ?? null,
        fc2: body?.querySelector('[data-param="drc3.fc2"] input.pfield-number')?.value ?? null,
        conflictCards: body?.querySelectorAll('.is-conflict').length ?? 0,
      });
    })()`);
    check(
      '「恢复推荐分频点」写入 1000/3000 并清掉冲突',
      drcAfter.fc1 === '1000' && drcAfter.fc2 === '3000' && drcAfter.conflictCards === 0,
      `fc1=${drcAfter.fc1} fc2=${drcAfter.fc2} conflict=${drcAfter.conflictCards}`,
    );

    const drcBefore = await cdp.evaluate(`document.querySelector('.modal-body [data-param="drc3.low.threshold"] input.pfield-number')?.value ?? null`);
    const drcTarget = drcBefore === '-30' ? '-20' : '-30';
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.modal-body [data-param="drc3.low.threshold"] input.pfield-number');
      input.value = '${drcTarget}';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await wait(900);
    const drcDragState = await cdp.json(`(() => {
      const node = document.querySelector('.modal-body [data-param="drc3.low.threshold"]');
      return JSON.stringify({
        value: node?.querySelector('input.pfield-number')?.value ?? null,
        readout: node?.querySelector('.pfield-value')?.textContent?.trim() ?? null,
      });
    })()`);
    check(
      '三分频阈值可改（数字框与读数联动）',
      drcDragState.value === drcTarget && drcDragState.readout === drcTarget,
      `${drcBefore} → ${drcDragState.value}（读数 ${drcDragState.readout}）`,
    );

    // 2026-11-21 V0.3：三分频「旁通」换成三分频动态开关（`0x2075`），字段仍可编辑、值照常保存
    // 2026-11-22 起产品默认是"关"，所以先确保它在开上，再点一下测"关掉后字段仍可编辑"
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.modal-body [data-enable="drc3"] input[type="checkbox"]');
      if (input && !input.checked) input.click();
      return true;
    })()`);
    await wait(600);
    await cdp.evaluate(`document.querySelector('.modal-body [data-enable="drc3"] input[type="checkbox"]')?.click(); true`);
    await wait(700);
    const drcOff = await cdp.json(ADVANCED_SNAPSHOT);
    check(
      '三分频动态开关是真实使能位（关掉后字段仍可编辑）',
      drcOff.drcEnable === false && drcOff.drcFieldDisabled === 0,
      `enable=${drcOff.drcEnable} 禁用字段=${drcOff.drcFieldDisabled}`,
    );
    await cdp.evaluate(`document.querySelector('.modal-body [data-enable="drc3"] input[type="checkbox"]')?.click(); true`);
    await wait(500);
    await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
    await wait(600);

    // ---- 8. 问题 3：连续拖拽期间到底发了几帧 -------------------------------
    await cdp.evaluate(`window.__micstudioGo('device'); true`);
    await wait(1200);
    const runThrottleProbe = async () => cdp.json(`(async () => {
      const read = (key) => Number(document.querySelector('[data-stat="' + key + '"]')?.textContent?.trim() ?? NaN);
      const range = document.querySelector('[data-macro="denoise"] input[type="range"]');
      if (!range) return JSON.stringify({ error: 'no denoise slider' });
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const before = { out: read('out'), timeout: read('timeout'), retry: read('retry') };
      const start = Date.now();
      let index = 0;
      while (Date.now() - start < 2500) {
        range.value = String(-60 + (index % 30));
        range.dispatchEvent(new Event('input', { bubbles: true }));
        index += 1;
        await sleep(50);
      }
      const during = { out: read('out'), timeout: read('timeout'), retry: read('retry'), events: index };
      await sleep(1600);
      const after = { out: read('out'), timeout: read('timeout'), retry: read('retry') };
      return JSON.stringify({ before, during, after });
    })()`);
    let throttle = await runThrottleProbe();
    // 窗口在后台时 Chromium 会把 setTimeout 节流到秒级，拖拽序列变稀疏 → 重测一次
    if (!throttle.error && throttle.during.events < 25) {
      log(`timer throttled (${throttle.during.events} events), retry after bringToFront`);
      await cdp.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
      await wait(800);
      const again = await runThrottleProbe();
      if (!again.error && again.during.events > throttle.during.events) throttle = again;
    }
    results.measurements.writeThrottle = throttle;
    if (!throttle.error) {
      const deltaDuring = throttle.during.out - throttle.before.out;
      const deltaAfter = throttle.after.out - throttle.before.out;
      check(
        '问题3：2.5 s 连续拖拽期间不出写帧（尾沿合并），停手后只多 1 帧',
        deltaDuring === 0 && deltaAfter >= 1 && deltaAfter <= 2,
        `${throttle.during.events} 次 input：拖拽期间 +${deltaDuring} 帧，停手 1.6 s 后 +${deltaAfter} 帧（旧实现 120 ms 固定窗口 ≈ 20 帧）；timeout ${throttle.before.timeout}→${throttle.after.timeout}`,
      );
      check(
        '问题3：拖拽/写帧没有制造超时或重试',
        throttle.after.timeout === throttle.before.timeout && throttle.after.retry === throttle.before.retry,
        `timeout ${throttle.before.timeout}→${throttle.after.timeout} retry ${throttle.before.retry}→${throttle.after.retry}`,
      );
    } else {
      check('问题3：连续拖拽写帧测量', false, throttle.error);
    }

    // ---- 9. 任何音色都能拖曲线（2026-11-25 起不再锁在「自定义」） ------------
    // 11-13 问题单当年要求「非自定义音色锁定曲线」；2026-11-25 起主界面在任何音色下都能拖，
    // 固定音色的曲线改动记进场景 gains 覆盖（音色选择不变）。这里改成验证"能拖"。
    await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
    await wait(600);
    await cdp.evaluate(`document.querySelector('.tone-chip[data-tone="bright"]')?.click(); true`);
    await wait(700);
    const locked = await cdp.json(`(() => {
      const canvas = document.querySelector('.console-eq-canvas');
      const rect = canvas.getBoundingClientRect();
      let hit = null;
      for (let y = rect.top + 8; y < rect.bottom - 8 && !hit; y += 6) {
        for (let x = rect.left + 8; x < rect.right - 8; x += 6) {
          canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'mouse' }));
          if (canvas.dataset.cursor === 'grab') { hit = { x, y }; break; }
        }
      }
      return JSON.stringify({ hit, cursor: canvas.dataset.cursor, desc: document.querySelector('.console-eq .card-desc')?.textContent?.trim() ?? null });
    })()`);
    check(
      '固定音色（明亮）下曲线同样可拖（11-25 起不再锁定）',
      locked.hit !== null,
      `命中的可拖节点=${locked.hit ? `${Math.round(locked.hit.x)},${Math.round(locked.hit.y)}` : '无'} desc=${locked.desc}`,
    );

    await cdp.evaluate(`document.querySelector('.tone-chip[data-tone="custom"]')?.click(); true`);
    await wait(800);
    const hit = await cdp.json(`(() => {
      const canvas = document.querySelector('.console-eq-canvas');
      const rect = canvas.getBoundingClientRect();
      for (let y = rect.top + 8; y < rect.bottom - 8; y += 6) {
        for (let x = rect.left + 8; x < rect.right - 8; x += 6) {
          canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'mouse' }));
          if (canvas.dataset.cursor === 'grab') {
            return JSON.stringify({ x, y, desc: document.querySelector('.console-eq .card-desc')?.textContent?.trim() ?? null });
          }
        }
      }
      return JSON.stringify({ error: 'no band hit' });
    })()`);
    check(
      '选中「自定义」后曲线可拖（找得到可拖节点、卡片提示可调）',
      typeof hit.x === 'number',
      `hit=${hit.x},${hit.y} desc=${hit.desc}`,
    );

    let eqChanged = false;
    let eqBefore = null;
    let eqAfter = null;
    if (typeof hit.x === 'number') {
      const readEq = `(() => JSON.stringify(Array.from(document.querySelectorAll('.modal-body .eq-row[data-band]')).map((row) => {
        const inputs = Array.from(row.querySelectorAll('input[type="number"]'));
        return { type: row.querySelector('select')?.value ?? null, freq: inputs[0]?.value ?? null, gain: inputs[1]?.value ?? null };
      })))()`;
      const hitBand = `(() => {
        const canvas = document.querySelector('.console-eq-canvas');
        const rect = canvas.getBoundingClientRect();
        for (let y = rect.top + 8; y < rect.bottom - 8; y += 6) {
          for (let x = rect.left + 8; x < rect.right - 8; x += 6) {
            canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'mouse' }));
            if (canvas.dataset.cursor === 'grab') return JSON.stringify({ x, y });
          }
        }
        return JSON.stringify({ error: 'no band hit' });
      })()`;
      // 拖拽一次不生效时（窗口刚被置前 / 鼠标事件被吞）再试一次，避免把环境问题当功能问题
      for (let attempt = 1; attempt <= 2 && !eqChanged; attempt += 1) {
        const point = attempt === 1 ? hit : await cdp.json(hitBand);
        if (typeof point.x !== 'number') break;
        const dy = attempt === 1 ? 95 : 55;
        await cdp.evaluate(`window.__micstudioGo('advanced'); true`);
        await wait(700);
        eqBefore = await cdp.json(readEq);
        await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
        await wait(500);
        await cdp.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
        await wait(300);
        await cdp.mouse('mouseMoved', point.x, point.y, { buttons: 0 });
        await wait(100);
        await cdp.mouse('mousePressed', point.x, point.y, { buttons: 1 });
        await wait(150);
        await cdp.mouse('mouseMoved', point.x, point.y - dy / 2, { buttons: 1 });
        await wait(200);
        await cdp.mouse('mouseMoved', point.x, point.y - dy, { buttons: 1 });
        await wait(350);
        await cdp.mouse('mouseReleased', point.x, point.y - dy, { buttons: 0 });
        await wait(900);
        await cdp.shot('05-custom-dragged.png');
        await cdp.evaluate(`window.__micstudioGo('advanced'); true`);
        await wait(800);
        eqAfter = await cdp.json(readEq);
        eqChanged = eqBefore.some((band, index) => {
          const after = eqAfter[index];
          return after && (band.gain !== after.gain || band.freq !== after.freq);
        });
        await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
        await wait(600);
      }
    }
    check(
      '自定义音色下拖拽曲线真的改了均衡器段值',
      eqChanged,
      eqBefore && eqAfter
        ? eqBefore.map((band, index) => (band.gain !== eqAfter[index]?.gain || band.freq !== eqAfter[index]?.freq ? `#${index + 1} ${band.freq}Hz/${band.gain}dB → ${eqAfter[index]?.freq}Hz/${eqAfter[index]?.gain}dB` : null)).filter(Boolean).join(' ; ') || '无变化'
        : 'no drag',
    );

    // ---- 10. 自定义场景 -----------------------------------------------------
    // 2026-11-22 起场景参数会「自动保存」：本探针前面改过噪声门/压缩器，那些改动已经记进
    // 当前场景名下，所以先点场景「复位」把它清回出厂预设，再验证"自定义 = 中性处理 + 自定义曲线"
    // 2026-11-25 起复位会先弹应用内确认框，必须点掉确认才会真的复位
    await cdp.evaluate(`document.querySelector('.scene-btn[data-scene="custom"]')?.click(); true`);
    await wait(900);
    await cdp.evaluate(`document.querySelector('.scene-reset')?.click(); true`);
    await wait(400);
    await cdp.evaluate(`document.querySelector('.confirm .btn--primary')?.click(); true`);
    await wait(1500);
    const customScene = await cdp.json(CONSOLE_SNAPSHOT);
    await cdp.shot('06-custom-scene.png');
    check(
      '「自定义」场景存在且应用中性处理 + 自定义曲线（场景复位后回到出厂值）',
      customScene.scenes.find((item) => item.id === 'custom')?.active === true &&
        customScene.macros.denoise?.value === '-91 dB' &&
        customScene.macros.evenness?.value === '-60 dB' &&
        customScene.tones.find((item) => item.id === 'custom')?.active === true,
      `scene=${customScene.scenes.find((item) => item.active)?.id} denoise=${customScene.macros.denoise?.value} evenness=${customScene.macros.evenness?.value}`,
    );

    // ---- 11. 收尾：把参数恢复成参数表默认值（等同设置页「恢复默认」） ------
    await cdp.evaluate(`window.__micstudioGo('settings'); true`);
    await wait(900);
    const resetInfo = await cdp.json(`(async () => {
      const button = document.querySelector('.modal-body .btn--danger');
      if (!button) return JSON.stringify({ error: 'no reset button' });
      const first = button.textContent.trim();
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const armed = button.textContent.trim();
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return JSON.stringify({ first, armed, done: button.textContent.trim() });
    })()`);
    results.measurements.reset = resetInfo;
    await wait(12_000);
    const resetState = await cdp.json(`(() => JSON.stringify({
      syncReady: !!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready'),
      notice: document.querySelector('.console-notice')?.hidden ? null : document.querySelector('.console-notice')?.textContent?.trim() ?? null,
    }))()`);
    check(
      '收尾「恢复默认」写入完成且链路仍 ready（测试遗留值已还原）',
      !resetInfo.error && resetState.syncReady && resetState.notice === null,
      `${resetInfo.first ?? ''} → ${resetInfo.armed ?? ''} → ${resetInfo.done ?? ''}；syncReady=${resetState.syncReady} notice=${resetState.notice}`,
    );

    results.finishedAt = new Date().toISOString();
    results.summary = {
      total: results.checks.length,
      passed: results.checks.filter((item) => item.ok).length,
      failed: results.checks.filter((item) => !item.ok).length,
    };
    writeFileSync(path.join(shotDir, 'result.json'), JSON.stringify(results, null, 2));
    log(`RESULT ${JSON.stringify(results.summary)}`);
    for (const item of results.checks.filter((entry) => !entry.ok)) log(`FAILED: ${item.name} — ${item.detail}`);
    if (results.summary.failed > 0) process.exitCode = 1;
  } catch (error) {
    results.error = String(error?.stack ?? error);
    writeFileSync(path.join(shotDir, 'result.json'), JSON.stringify(results, null, 2));
    log(`ERROR ${error?.message ?? error}`);
    process.exitCode = 1;
  } finally {
    try {
      spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // 已经退出
    }
  }
}

await main();
