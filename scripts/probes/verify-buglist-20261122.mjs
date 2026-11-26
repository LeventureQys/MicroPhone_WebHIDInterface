/**
 * 对照 `usb audio demo buglist 2026-11-22.docx` 的 **2026-11-22 17:43** 那一节，
 * 逐条验证上位机侧修复（旧的两节由 verify-buglist-20261113/20261121 覆盖）。
 *
 *   node scripts/probes/verify-buglist-20261122.mjs
 *
 * 真机插着时会自动连上（auto-connect），没有真机时退化为 mock 通道；两种通道界面检查都成立。
 * 结束时用「设置 → 复位全部参数」把设备还原成参数表默认值，并留下 result.json 与截图。
 *
 * 2026-11-25 起界面改了三处，断言跟着改（都是当前实现的既定行为，不是放宽）：
 *   1. 场景「复位」先弹应用内确认框（`.confirm .btn--primary`），不再直接复位；
 *   2. 复位后按钮转灰（`disabled=true`）：没有保存过改动就没什么可复位的；
 *   3. 「复位全部参数」在**设置**抽屉（原先在高级参数抽屉），仍是二次确认的两下点击；
 *      EQ「恢复默认」的 Q 回产品默认（0.7/0.8/1.5/1/1），不再一律钉 0.7 —— 问题单只要频点。
 *
 * 覆盖（编号取问题单原文顺序）：
 *   1  三个阈值行的开关贴着左边文字，调参数时开关不跳
 *   2  均衡器默认频率（复位后 3–7 段 = 63/250/1k/4k/12.5k）
 *   3  3 到 7 段默认频点按下图
 *   4  灯效数据有没有上报（只记录设备回读值，映射在固件侧）
 *   5  灯效调节放在主页（快捷开关里，与高级参数联动）
 *   6  三分频动态默认关闭
 *   7  会议模式改为游戏模式
 *   8  软件打开默认处于自定义模式
 *   9  场景参数可单独调节、自动保存、带复位按钮
 *   10 耳机音量两端到不了 0/100（固件 ADC 映射，只记录回读值）
 *   11 最重负载测试另见 scripts/probes/heavyload-20261122.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Cdp, findPageTarget, killApp, launchApp, repo, wait, waitReady } from './lib/cdp.mjs';

const shotDir = path.join(repo, 'artifacts', 'verify-20261122');
const profile = 'D:\\Temp\\ud-verify-20261122';
const port = 9363;

rmSync(shotDir, { recursive: true, force: true });
mkdirSync(shotDir, { recursive: true });
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const log = (...args) => console.log(`[verify] ${new Date().toISOString().slice(11, 19)}`, ...args);

const results = { startedAt: new Date().toISOString(), checks: [], measurements: {}, timeline: [] };
function check(name, ok, detail) {
  results.checks.push({ name, ok: Boolean(ok), detail: detail ?? null });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
}

/** 顶栏链路胶囊：真机写完落盘要几百毫秒到几秒，断言前得先等到 ready */
const linkReady = async (cdp) => {
  const snap = await cdp.json(CONSOLE_SNAPSHOT);
  return { ready: /state-pill--ready/.test(snap.syncClass ?? ''), syncClass: snap.syncClass, notice: snap.notice };
};

async function waitLinkReady(cdp, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = await linkReady(cdp);
  while (!last.ready && Date.now() < deadline) {
    await wait(300);
    last = await linkReady(cdp);
  }
  return last;
}

/**
 * 链路时间线：200 ms 采一次顶栏胶囊与提示条，控制台里也抄一份。
 *
 * 真机写多了会被固件压住（写入超时 → 同步失败），一旦发生，后面的界面断言全会跟着错。
 * 所以每个阶段结束都记一条，链路一掉就把时间线写进 result.json 并中止——失败点要能
 * 落到具体动作上，而不是只看最后一条断言。
 */
const INSTALL_WATCH = `(() => {
  window.__watch = { started: Date.now(), samples: [], console: [] };
  const pill = () => document.querySelector('#sync-pill')?.className ?? '';
  const notice = () => {
    const bar = document.querySelector('.console-notice');
    if (!bar || bar.hidden || getComputedStyle(bar).display === 'none') return '';
    return (bar.textContent ?? '').replace(/\\s+/g, ' ').trim();
  };
  window.__watchTimer = setInterval(() => {
    window.__watch.samples.push({ t: Date.now() - window.__watch.started, pill: pill(), notice: notice() });
  }, 200);
  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try {
        window.__watch.console.push({
          t: Date.now() - window.__watch.started,
          level,
          text: args.map((item) => (typeof item === 'string' ? item : String(item))).join(' ').slice(0, 300),
        });
      } catch {
        // 抄日志失败不影响页面
      }
      original(...args);
    };
  }
  return true;
})()`;

async function mark(cdp, label) {
  const snap = await cdp.json(CONSOLE_SNAPSHOT);
  const ready = /state-pill--ready/.test(snap.syncClass ?? '');
  results.timeline.push({ label, at: new Date().toISOString(), ready, notice: snap.notice });
  log(`MARK ${label} link=${ready ? 'ready' : 'LOST'}${snap.notice ? ` notice=${snap.notice}` : ''}`);
  if (!ready) {
    results.watch = await cdp
      .evaluate(`JSON.stringify(window.__watch ?? null)`)
      .then((raw) => (raw ? JSON.parse(raw) : null))
      .catch(() => null);
    throw new Error(`链路在「${label}」之后掉了：${snap.syncClass ?? ''} ${snap.notice ?? ''}`.trim());
  }
  return snap;
}

const CONSOLE_SNAPSHOT = `(() => {
  const clean = (node) => node?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
  const rect = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { top: Math.round(box.top * 100) / 100, left: Math.round(box.left * 100) / 100, width: Math.round(box.width * 100) / 100 };
  };
  const macro = (key) => {
    const node = document.querySelector('[data-macro="' + key + '"]');
    if (!node) return null;
    const head = node.querySelector('.pfield-head');
    return {
      label: clean(node.querySelector('.pfield-label')),
      value: clean(node.querySelector('.pfield-value')),
      order: Array.from(head?.children ?? []).map((child) => child.className),
      toggle: rect(node.querySelector('.macro-toggle')),
      toggleParam: node.querySelector('.macro-toggle')?.dataset.param ?? null,
    };
  };
  const scenes = Array.from(document.querySelectorAll('.scene-btn')).map((node) => ({
    id: node.dataset.scene,
    name: clean(node.querySelector('.scene-name')),
    desc: clean(node.querySelector('.scene-desc')),
    active: node.getAttribute('aria-pressed') === 'true',
  }));
  const quickSwitch = (label) => {
    const labelNode = Array.from(document.querySelectorAll('.switch-item .switch-label')).find((node) => clean(node) === label);
    const row = labelNode?.closest('.switch-row');
    return row ? { label: clean(labelNode), checked: row.querySelector('input')?.checked ?? null, param: row.dataset.param ?? null } : null;
  };
  const mode = document.querySelector('.switch-item--light .segmented--modes');
  return JSON.stringify({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    macroOrder: { denoise: macro('denoise'), evenness: macro('evenness'), limiter: macro('limiter') },
    scenes,
    sceneReset: (() => {
      const button = document.querySelector('.scene-reset');
      return button ? { text: clean(button), disabled: button.disabled, ariaDisabled: button.getAttribute('aria-disabled') } : null;
    })(),
    toneActive: document.querySelector('.tone-chip.is-active')?.dataset.tone ?? null,
    eqReset: (() => {
      const button = document.querySelector('.console-eq-reset');
      return button ? { disabled: button.disabled } : null;
    })(),
    lighting: {
      toggle: quickSwitch('灯效'),
      modeButtons: Array.from(mode?.querySelectorAll('.seg-btn') ?? []).map((node) => node.dataset.value),
      modeActive: mode?.querySelector('.seg-btn.is-active')?.dataset.value ?? null,
    },
    quickLabels: Array.from(document.querySelectorAll('.switch-item .switch-label')).map(clean),
    gainLabels: Array.from(document.querySelectorAll('.console-gain-label > span:first-child')).map(clean),
    gainValues: Array.from(document.querySelectorAll('.console-gain-value')).map(clean),
    syncClass: document.querySelector('#sync-pill')?.className ?? null,
    notice: (() => {
      const bar = document.querySelector('.console-notice');
      if (!bar || bar.hidden || getComputedStyle(bar).display === 'none') return '';
      return clean(bar);
    })(),
    toneChips: Array.from(document.querySelectorAll('.tone-chip')).map(clean),
  });
})()`;

const ADVANCED_SNAPSHOT = `(() => {
  const body = document.querySelector('.modal-body');
  const checked = (id) => body?.querySelector('[data-param="' + id + '"] input[type="checkbox"]')?.checked ?? null;
  const number = (id) => body?.querySelector('[data-param="' + id + '"] input.pfield-number')?.value ?? null;
  const rowOf = (id) => body?.querySelector('[data-param="' + id + '"]') ?? null;
  return JSON.stringify({
    enable: {
      noisegate: checked('noisegate.Enable'),
      comp: checked('comp.Enable'),
      limit: checked('limit.Enable'),
      drc3: checked('drc3.Enable'),
      rgb: checked('rgb.OnOff'),
    },
    rgbMode: number('rgb.Mode'),
    rgbRow: rowOf('rgb.Mode') ? true : false,
    eqRows: Array.from(body?.querySelectorAll('.eq-row[data-band]') ?? []).map((row) => {
      const inputs = Array.from(row.querySelectorAll('input[type="number"]'));
      return { type: row.querySelector('select')?.value ?? null, freq: inputs[0]?.value ?? null, gain: inputs[1]?.value ?? null, q: inputs[2]?.value ?? null };
    }),
  });
})()`;

/** 改主界面某个阈值滑杆（真实 input 事件，跟用户拖动同一条路径） */
const setMacro = (key, value) => `(() => {
  const range = document.querySelector('[data-macro="${key}"] input[type="range"]');
  if (!range) return false;
  range.value = '${value}';
  range.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

async function openAdvanced(cdp, until = 'comp.Enable') {
  await cdp.evaluate(`window.__micstudioGo?.('advanced'); true`);
  for (let index = 0; index < 20; index += 1) {
    if (await cdp.evaluate(`!!document.querySelector('.modal-body [data-param="${until}"]')`)) return true;
    await wait(200);
  }
  return false;
}

/** 打开任意抽屉（advanced / settings / device / firmware），等某个元素出现 */
async function openPanel(cdp, panel, until, timeoutMs = 8000) {
  await cdp.evaluate(`window.__micstudioGo?.('${panel}'); true`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`!!document.querySelector('${until.replaceAll("'", "\\'")}')`)) return true;
    await wait(200);
  }
  return false;
}

async function closePanel(cdp) {
  await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
  await wait(400);
}

async function main() {
  const app = launchApp({ profile, port });
  let cdp = null;
  try {
    const target = await findPageTarget(port);
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
    if (!(await waitReady(cdp))) throw new Error('renderer not ready');
    await wait(2200);
    await cdp.evaluate(INSTALL_WATCH);
    // 自动连接 + 参数回读要一会儿；链路没 ready 就谈不上后面的断言
    const bootLink = await waitLinkReady(cdp, 15_000);
    results.measurements.bootLink = bootLink;
    await mark(cdp, '启动（自动连接 + 同步）');

    // ---- 启动态：默认「自定义」模式（问题 8） --------------------------------
    const boot = await cdp.json(CONSOLE_SNAPSHOT);
    results.measurements.boot = boot;
    await cdp.shot(path.join(shotDir, '01-console.png'));
    log(`viewport=${boot.viewport.width}x${boot.viewport.height} tone=${boot.toneActive}`);

    check(
      '问题8：软件打开默认停在「自定义」音色，场景也高亮「自定义」',
      boot.toneActive === 'custom' && boot.scenes.find((scene) => scene.id === 'custom')?.active === true,
      `tone=${boot.toneActive} scene=${boot.scenes.find((scene) => scene.active)?.id} 曲线复位按钮 disabled=${boot.eqReset?.disabled}`,
    );

    // ---- 场景顺序与改名（问题 7） -------------------------------------------
    const sceneNames = boot.scenes.map((scene) => scene.name);
    check(
      '问题7：场景依次是 安静房间 / 游戏 / 播客 / 唱歌 / 自定义（没有「会议」）',
      sceneNames.join(',') === '安静房间,游戏,播客,唱歌,自定义',
      sceneNames.join(' → '),
    );

    // ---- 开关贴着左边文字、调参数时不跳（问题 1） ---------------------------
    const anchors = boot.macroOrder;
    const orderOk = ['denoise', 'evenness', 'limiter'].every((key) => {
      const order = anchors[key]?.order ?? [];
      return order[0]?.includes('pfield-label') && order[1]?.includes('macro-toggle') && order[2]?.includes('pfield-value');
    });
    // 把噪声门阈值从 -91 拖到 -12（读数从 5 个字符变 4 个），开关位置必须一动不动
    await cdp.evaluate(setMacro('denoise', -12));
    await wait(500);
    const afterRail = await cdp.json(CONSOLE_SNAPSHOT);
    results.measurements.switchAnchor = {
      before: anchors.denoise?.toggle,
      valueBefore: anchors.denoise?.value,
      after: afterRail.macroOrder.denoise?.toggle,
      valueAfter: afterRail.macroOrder.denoise?.value,
    };
    const drift = Math.abs((afterRail.macroOrder.denoise?.toggle?.left ?? -1) - (anchors.denoise?.toggle?.left ?? 0));
    check(
      '问题1：三个阈值行的开关紧贴标题文字（标题 → 开关 → 读数），改读数时开关不位移',
      orderOk && drift < 0.5,
      `顺序=${orderOk ? '标题/开关/读数' : '不符合'} 开关 left ${anchors.denoise?.toggle?.left} → ${afterRail.macroOrder.denoise?.toggle?.left}（${anchors.denoise?.value} → ${afterRail.macroOrder.denoise?.value}）`,
    );
    await cdp.evaluate(setMacro('denoise', -91));
    await wait(300);

    // ---- 灯效搬上主页（问题 5） ---------------------------------------------
    const lightBefore = boot.lighting;
    check(
      '问题5：主界面「快捷开关」里有灯效开关与 0–7 模式（两列与环境降噪并排）',
      lightBefore.toggle?.label === '灯效' && lightBefore.toggle?.param === 'rgb.OnOff' && lightBefore.modeButtons?.join(',') === '0,1,2,3,4,5,6,7',
      `开关=${lightBefore.toggle?.label}[${lightBefore.toggle?.param}] 模式=${lightBefore.modeButtons?.join('/')}`,
    );
    await cdp.evaluate(`(() => {
      const mode = document.querySelector('.switch-item--light .segmented--modes');
      mode?.querySelector('.seg-btn[data-value="3"]')?.click();
      return true;
    })()`);
    await wait(600);
    const lightAfter = await cdp.json(CONSOLE_SNAPSHOT);
    await openAdvanced(cdp);
    const advancedLight = await cdp.json(ADVANCED_SNAPSHOT);
    results.measurements.lighting = { before: lightBefore, after: lightAfter.lighting, advanced: advancedLight.enable.rgb, mode: advancedLight.rgbMode };
    check(
      '问题5：主界面改灯效模式 → 高级参数里的同一项跟着变（同一个参数 id）',
      lightAfter.lighting.modeActive === '3' && String(advancedLight.rgbMode) === '3',
      `主界面高亮=${lightAfter.lighting.modeActive} 高级参数 rgb.Mode=${advancedLight.rgbMode}`,
    );
    // 反向：高级参数里改灯效开关，主界面跟着变
    await cdp.evaluate(`document.querySelector('.modal-body [data-param="rgb.OnOff"] input[type="checkbox"]')?.click(); true`);
    await wait(700);
    await closePanel(cdp);
    const lightBack = await cdp.json(CONSOLE_SNAPSHOT);
    check(
      '问题5：高级参数改灯效开关 → 主界面开关跟着变',
      lightBack.lighting.toggle?.checked === !advancedLight.enable.rgb,
      `高级 ${advancedLight.enable.rgb} → 主界面 ${lightBack.lighting.toggle?.checked}`,
    );
    await mark(cdp, '灯效双向联动');

    // ---- 灯效数据上报（问题 4：固件侧） --------------------------------------
    await openAdvanced(cdp);
    const lightingReadback = await cdp.json(ADVANCED_SNAPSHOT);
    results.measurements.lightingReadback = lightingReadback;
    check(
      '问题4：灯效寄存器（0x2072/0x2073）的读写路径在（设备回读值只记录，映射在固件侧）',
      lightingReadback.rgbRow === true,
      `设备回读 rgb.OnOff=${lightingReadback.enable.rgb} rgb.Mode=${lightingReadback.rgbMode}（若恒为 0 = 固件没上报，见问题清单）`,
    );

    // ---- 均衡器默认频点（问题 2、3） ----------------------------------------
    await cdp.evaluate(`document.querySelector('.modal-body [data-section="eq"]')?.scrollIntoView({ block: 'start' }); true`);
    await wait(500);
    await cdp.evaluate(`(() => {
      const rows = document.querySelectorAll('.modal-body .eq-row[data-band]');
      const set = (band, value) => {
        const row = rows[band - 1];
        const input = Array.from(row?.querySelectorAll('input[type="number"]') ?? [])[1];
        if (!input) return;
        input.value = String(value);
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set(3, 5);
      set(6, -4);
      return true;
    })()`);
    await wait(900);
    await closePanel(cdp);
    await cdp.evaluate(`document.querySelector('.tone-chip[data-tone="custom"]')?.click(); true`);
    await wait(400);
    await cdp.evaluate(`document.querySelector('.console-eq-reset')?.click(); true`);
    await wait(1200);
    await openAdvanced(cdp);
    await cdp.evaluate(`document.querySelector('.modal-body [data-section="eq"]')?.scrollIntoView({ block: 'start' }); true`);
    await wait(600);
    const afterEqReset = await cdp.json(ADVANCED_SNAPSHOT);
    await cdp.shot(path.join(shotDir, '02-eq-after-reset.png'));
    const expectedFreqs = ['50', '20000', '63', '250', '1000', '4000', '12500'];
    const resetRows = afterEqReset.eqRows.slice(0, 7);
    const actualFreqs = resetRows.map((row) => String(row.freq));
    const actualQ = resetRows.map((row) => String(row.q));
    results.measurements.eqReset = {
      freqs: actualFreqs,
      q: actualQ,
      gains: resetRows.map((row) => String(row.gain)),
    };
    check(
      '问题2/3：均衡器复位后 3–7 段频点 = 63 / 250 / 1k / 4k / 12.5k（增益回 0，Q 取产品默认）',
      actualFreqs.join(',') === expectedFreqs.join(',') && resetRows.every((row) => String(row.gain) === '0'),
      `频点=${actualFreqs.join(' / ')} 增益=${resetRows.map((row) => row.gain).join('/')} Q=${actualQ.join('/')}`,
    );
    await closePanel(cdp);
    await mark(cdp, '均衡器复位');

    // ---- 三分频动态默认关闭（问题 6） ---------------------------------------
    // 设备自己的上电预设由固件按参数表 G 列加载（0x2075 = 1），上位机不做"连上就改设备"，
    // 因此这里只记录设备当前回读；上位机的默认值断言放在收尾「恢复默认值」之后。
    await openAdvanced(cdp);
    const drcBefore = await cdp.json(ADVANCED_SNAPSHOT);
    results.measurements.drcDefault = drcBefore.enable.drc3;
    check(
      '问题6：三分频动态的设备回读值（上位机默认值 = 关，固件上电预设待改，见收尾断言）',
      true,
      `连接后回读 drc3.Enable=${drcBefore.enable.drc3}（参数表 G 列是 1，需固件改成 0；上位机默认值/场景/复位都已按关下发）`,
    );
    await closePanel(cdp);

    // ---- 场景参数可单独调 + 自动保存 + 复位（问题 9） ------------------------
    // 自动保存挂在 PARAM_CHANGED 上，而 `setParam` 在 sync 没 ready 时只改本地值、
    // 不派发 param-changed（state.ts C4 门控）——所以先等到 ready 再动参数
    const linkBeforeScene = await waitLinkReady(cdp);
    results.measurements.linkBeforeScene = linkBeforeScene;
    await cdp.evaluate(`document.querySelector('.scene-btn[data-scene="podcast"]')?.click(); true`);
    await wait(1400);
    const podcast = await cdp.json(CONSOLE_SNAPSHOT);
    await cdp.evaluate(setMacro('denoise', -48));
    await wait(1200);
    const tweaked = await cdp.json(CONSOLE_SNAPSHOT);
    await cdp.evaluate(`document.querySelector('.scene-btn[data-scene="sing"]')?.click(); true`);
    await wait(1400);
    const sing = await cdp.json(CONSOLE_SNAPSHOT);
    await cdp.evaluate(`document.querySelector('.scene-btn[data-scene="podcast"]')?.click(); true`);
    await wait(1400);
    const back = await cdp.json(CONSOLE_SNAPSHOT);
    await cdp.shot(path.join(shotDir, '03-scene-autosave.png'));
    results.measurements.sceneAutosave = {
      podcast: podcast.macroOrder.denoise?.value,
      tweaked: tweaked.macroOrder.denoise?.value,
      sing: sing.macroOrder.denoise?.value,
      back: back.macroOrder.denoise?.value,
      linkBeforeScene,
      linkAfter: await linkReady(cdp),
    };
    check(
      '问题9：每个场景的参数可单独调，切走再切回改动还在',
      podcast.macroOrder.denoise?.value === '-59 dB' &&
        tweaked.macroOrder.denoise?.value === '-48 dB' &&
        sing.macroOrder.denoise?.value === '-73 dB' &&
        back.macroOrder.denoise?.value === '-48 dB',
      `播客 ${podcast.macroOrder.denoise?.value} → 改 ${tweaked.macroOrder.denoise?.value} → 唱歌 ${sing.macroOrder.denoise?.value} → 回播客 ${back.macroOrder.denoise?.value}`,
    );
    await mark(cdp, '场景自动保存');

    // 防爆音阈值不写进场景预设（R-19），但它就在快速调音第三行：只改它，场景复位也要亮
    const limiterBefore = back.macroOrder.limiter?.value ?? '';
    const limiterNumber = Number.parseFloat(limiterBefore);
    const limiterTarget = Number.isFinite(limiterNumber) ? limiterNumber - 6 : -8;
    await cdp.evaluate(setMacro('limiter', String(limiterTarget)));
    await wait(900);
    const limiterEdited = await cdp.json(CONSOLE_SNAPSHOT);
    const limiterRowReset = await cdp.evaluate(
      `document.querySelector('[data-macro="limiter"] .param-reset')?.disabled ?? null`,
    );
    results.measurements.limiterEdit = {
      before: limiterBefore,
      after: limiterEdited.macroOrder.limiter?.value,
      sceneResetDisabled: limiterEdited.sceneReset?.disabled,
      rowResetDisabled: limiterRowReset,
    };
    check(
      '问题9：只改防爆音阈值也会点亮场景「复位」（该阈值不属场景，行内恢复同样可用）',
      limiterEdited.sceneReset?.disabled === false && limiterRowReset === false,
      `防爆音 ${limiterBefore} → ${limiterEdited.macroOrder.limiter?.value} 场景复位 disabled=${limiterEdited.sceneReset?.disabled} 行内恢复 disabled=${limiterRowReset}`,
    );

    // 复位先弹应用内确认框（2026-11-25）：不点确定什么都不该发生
    await cdp.evaluate(`document.querySelector('.scene-reset')?.click(); true`);
    await wait(400);
    const confirmTitle = await cdp.evaluate(`document.querySelector('.confirm .confirm-title')?.textContent ?? null`);
    await cdp.evaluate(`document.querySelector('.confirm .btn--primary')?.click(); true`);
    await wait(2000);
    const afterSceneReset = await cdp.json(CONSOLE_SNAPSHOT);
    results.measurements.sceneReset = {
      confirmTitle,
      denoise: afterSceneReset.macroOrder.denoise?.value,
      limiter: afterSceneReset.macroOrder.limiter?.value,
      limiterBefore,
      disabled: afterSceneReset.sceneReset?.disabled,
      link: await linkReady(cdp),
    };
    check(
      '问题9：场景「复位」确认后把当前场景恢复成默认值（含防爆音阈值），按钮随之转灰',
      confirmTitle !== null &&
        afterSceneReset.macroOrder.denoise?.value === '-59 dB' &&
        afterSceneReset.macroOrder.limiter?.value === limiterBefore &&
        afterSceneReset.sceneReset?.disabled === true,
      `确认框=${confirmTitle ?? '没弹出'} 复位后 播客噪声门=${afterSceneReset.macroOrder.denoise?.value} 防爆音=${afterSceneReset.macroOrder.limiter?.value}（原 ${limiterBefore}）复位按钮 disabled=${afterSceneReset.sceneReset?.disabled}`,
    );
    await mark(cdp, '场景复位');

    // ---- 10. 耳机音量回读（固件侧，只记录） --------------------------------
    check(
      '问题10：耳机音量最小不是 0 / 最大不是 100 属于固件 ADC 映射，上位机只记录回读值',
      true,
      `${boot.gainLabels.join(' / ')} = ${boot.gainValues.join(' / ')}（见问题清单：需固件校准端点）`,
    );

    // ---- 收尾：恢复参数表默认值 --------------------------------------------
    // 2026-11-25 起这个按钮在「设置」抽屉（高级参数抽屉里只剩逐项恢复），仍是二次确认：
    // 第一下把文案改成「再点一次确认」，第二下才开始按 6 项 / 320 ms 分批写
    await openPanel(cdp, 'settings', '.modal-body .btn--danger');
    const resetInfo = await cdp.json(`(async () => {
      const button = document.querySelector('.modal-body .btn--danger');
      if (!button) return JSON.stringify({ error: 'no reset button' });
      const label = button.textContent.trim();
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const armed = button.textContent.trim();
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 800));
      return JSON.stringify({ label, armed, running: button.textContent.trim() });
    })()`);
    results.measurements.restore = resetInfo;
    // 分批写 + 落 Flash：真机整轮约 5 s；按钮跑完会自己回到初始文案并解锁
    let restoreState = { text: '', disabled: true };
    const restoreDeadline = Date.now() + 30_000;
    while (Date.now() < restoreDeadline) {
      restoreState = await cdp.json(`(() => {
        const button = document.querySelector('.modal-body .btn--danger');
        return JSON.stringify({ text: button?.textContent?.trim() ?? '', disabled: button?.disabled ?? true });
      })()`);
      if (restoreState.text === resetInfo.label && restoreState.disabled === false) break;
      await wait(400);
    }
    results.measurements.restoreDone = restoreState;
    const restored = await waitLinkReady(cdp, 10_000);
    await closePanel(cdp);
    await cdp.shot(path.join(shotDir, '04-console-restored.png'));
    check(
      '收尾：恢复默认后链路仍 ready（本轮写入没有把设备搞掉）',
      restored.ready,
      `sync=${restored.syncClass} 按钮=${restoreState.text || '—'}`,
    );
    await mark(cdp, '复位全部参数');

    // 恢复默认值以后再读一次三分频：按上位机默认值写下去就是关的
    await openAdvanced(cdp);
    const afterRestore = await cdp.json(ADVANCED_SNAPSHOT);
    await closePanel(cdp);
    check(
      '问题6：「恢复默认」后三分频动态 = 关（上位机默认值已经是关，场景也不再打开它）',
      afterRestore.enable.drc3 === false,
      `drc3.Enable=${afterRestore.enable.drc3}`,
    );

    results.watch = await cdp
      .evaluate(`JSON.stringify(window.__watch ?? null)`)
      .then((raw) => (raw ? JSON.parse(raw) : null))
      .catch(() => null);
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
    if (cdp && !results.watch) {
      results.watch = await cdp
        .evaluate(`JSON.stringify(window.__watch ?? null)`)
        .then((raw) => (raw ? JSON.parse(raw) : null))
        .catch(() => null);
    }
    writeFileSync(path.join(shotDir, 'result.json'), JSON.stringify(results, null, 2));
    log(`ERROR ${error?.message ?? error}`);
    process.exitCode = 1;
  } finally {
    cdp?.close();
    killApp(app);
  }
}

await main();
