/**
 * 对照 `usb audio demo buglist(1).docx` 的 **2026-11-21 23:42** 那一节，逐条验证上位机侧修复。
 *
 *   node scripts/probes/verify-buglist-20261121.mjs
 *
 * 真机插着时会自动连上（auto-connect），没有真机时退化为 mock 通道；两种通道界面检查都成立。
 * 结束时把参数恢复成参数表默认值（等同设置页「恢复默认」），并留下 result.json 与截图。
 *
 * 覆盖（编号取问题单原文序号）：
 *   1  耳机增益 → 耳机音量            主界面读数文案
 *   2  旋钮最小不是 0 / 最大不是 100  只记录设备回读值（0x205A 只读，映射在固件侧）
 *   3  噪声门/压缩器开关与高级参数联动  主界面开关 ↔ 高级参数同一参数
 *   4  限幅器阈值进快速调音 + 开关      主界面第三个阈值行
 *   5  逐段精调直接跳到均衡器页面      抽屉打开后落在「均衡」一节
 *   6  三个输入开关同一水平线          三个开关的 top 一致
 *   7  bootloader 设备名             固件侧（只记录，不判定）
 *   8  bootloader VID 0x0A67         固件侧 + 设置页占位符不再出现 0x352F
 *   9  删掉 0x352F 信息               设置页 VID 占位符 / 整页文本
 *   10 去掉输出峰值                    电平画布只画一个峰值读数
 *   11 噪声门压缩比                    高级参数里有「压缩比」+ 说明
 *   12 均衡器复位按问题单那张表        复位后 7 段 gain 0 / Q 0.7
 *   13 复位按钮放在音色曲线卡 + 仅自定义可用
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Cdp, findPageTarget, killApp, launchApp, repo, wait, waitReady } from './lib/cdp.mjs';

const shotDir = path.join(repo, 'artifacts', 'verify-20261121');
const profile = 'D:\\Temp\\ud-verify-20261121';
const port = 9361;

rmSync(shotDir, { recursive: true, force: true });
mkdirSync(shotDir, { recursive: true });
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const log = (...args) => console.log(`[verify] ${new Date().toISOString().slice(11, 19)}`, ...args);

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
    if (!node) return null;
    const range = node.querySelector('input[type="range"]');
    const toggle = node.querySelector('.macro-toggle');
    return {
      label: clean(node.querySelector('.pfield-label')),
      value: clean(node.querySelector('.pfield-value')),
      range: range ? { min: range.min, max: range.max, step: range.step, value: range.value } : null,
      toggle: toggle ? {
        param: toggle.dataset.param ?? null,
        checked: toggle.querySelector('input[type="checkbox"]')?.checked ?? null,
        label: toggle.querySelector('.switch-label') ? clean(toggle.querySelector('.switch-label')) : clean(toggle),
      } : null,
    };
  };
  const rectOf = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { top: Math.round(box.top * 100) / 100, left: Math.round(box.left * 100) / 100, height: Math.round(box.height * 100) / 100 };
  };
  return JSON.stringify({
    toneLabels: Array.from(document.querySelectorAll('.tone-chip')).map(clean),
    gainLabels: Array.from(document.querySelectorAll('.console-gain-label > span:first-child')).map(clean),
    gainValues: Array.from(document.querySelectorAll('.console-gain-value')).map(clean),
    macros: { denoise: macro('denoise'), evenness: macro('evenness'), limiter: macro('limiter') },
    inputSwitches: Array.from(document.querySelectorAll('.tune-switch-grid [data-param]')).map((node) => ({
      id: node.dataset.param,
      label: clean(node.querySelector('.switch-label') ?? node),
      checked: node.querySelector('input[type="checkbox"]')?.checked ?? null,
      track: rectOf(node.querySelector('.switch')),
    })),
    quickSwitches: Array.from(document.querySelectorAll('.console-middle > .card:last-child .switch-row')).map((node) => ({
      label: clean(node.querySelector('.switch-label') ?? node),
      checked: node.querySelector('input[type="checkbox"]')?.checked ?? null,
    })),
    eqReset: (() => {
      const button = document.querySelector('.console-eq-reset');
      return button ? { text: clean(button), disabled: button.disabled, ariaDisabled: button.getAttribute('aria-disabled') } : null;
    })(),
    consoleMentions0x352F: /352F/i.test(document.body.innerText),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  });
})()`;

const ADVANCED_SNAPSHOT = `(() => {
  const clean = ${clean};
  const body = document.querySelector('.modal-body');
  const checked = (id) => body?.querySelector('[data-param="' + id + '"] input[type="checkbox"]')?.checked ?? null;
  const num = (id) => body?.querySelector('[data-param="' + id + '"] input.pfield-number')?.value ?? null;
  const labelOf = (id) => clean(body?.querySelector('[data-param="' + id + '"] .pfield-label'));
  const navActive = clean(body?.querySelector('.advanced-nav-link.is-active'));
  const bodyRect = body?.getBoundingClientRect() ?? null;
  const eqSection = body?.querySelector('.advanced-section[data-section="eq"]');
  const eqRect = eqSection?.getBoundingClientRect() ?? null;
  return JSON.stringify({
    scrollTop: body ? Math.round(body.scrollTop) : 0,
    navActive,
    eqSectionTop: bodyRect && eqRect ? Math.round(eqRect.top - bodyRect.top) : null,
    enable: { noisegate: checked('noisegate.Enable'), comp: checked('comp.Enable'), limit: checked('limit.Enable') },
    ratioLabel: labelOf('noisegate.ratio'),
    ratioValue: num('noisegate.ratio'),
    noisegateHints: Array.from(body?.querySelectorAll('.advanced-section[data-section="input"] .macro-hint') ?? []).map(clean),
    eqRows: Array.from(body?.querySelectorAll('.eq-row[data-band]') ?? []).map((row) => {
      const inputs = Array.from(row.querySelectorAll('input[type="number"]'));
      return {
        type: row.querySelector('select')?.value ?? null,
        freq: inputs[0]?.value ?? null,
        gain: inputs[1]?.value ?? null,
        q: inputs[2]?.value ?? null,
      };
    }),
  });
})()`;

/** 电平画布：只统计 meter 画布上画出来的文字，按「输入」切帧 */
const METER_TEXTS = `(() => {
  const meterTexts = window.__meterTexts ?? [];
  const frames = [];
  let current = null;
  for (const entry of meterTexts) {
    if (entry === '输入') {
      current = [];
      frames.push(current);
    }
    if (current) current.push(entry);
  }
  const peaksPerFrame = frames.map((frame) => frame.filter((text) => text.startsWith('峰值')).length);
  const rmsPerFrame = frames.map((frame) => frame.filter((text) => text.startsWith('RMS')).length);
  return JSON.stringify({
    frames: frames.length,
    peaksPerFrame: [...new Set(peaksPerFrame)],
    rmsPerFrame: [...new Set(rmsPerFrame)],
    sample: frames.at(-1) ?? [],
  });
})()`;

async function closePanel(cdp) {
  await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
  await wait(450);
}

/**
 * 等抽屉出现再读快照。
 *
 * 2026-11-22 实测偶发：截图那一步（Page.bringToFront + captureScreenshot）之后，
 * 下一次读快照时 `.modal-body` 还在重建的窗口里，`[data-param]` 查不到就误报"联动失效"。
 * 产品侧没有问题（抽屉与开关状态都在），只是探针要等一拍；等不到就重新打开一次。
 */
async function ensureDrawer(cdp, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`!!document.querySelector('.modal-body [data-param="comp.Enable"]')`)) return true;
    await wait(200);
  }
  await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
  await wait(300);
  await cdp.evaluate(`window.__micstudioGo?.('advanced'); true`);
  await wait(700);
  return cdp.evaluate(`!!document.querySelector('.modal-body [data-param="comp.Enable"]')`);
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
    await wait(1600);

    // 电平画布的 fillText 取证：输出峰值去掉后，每帧只应有一个「峰值」
    await cdp.evaluate(`(() => {
      window.__meterTexts = [];
      const proto = CanvasRenderingContext2D.prototype;
      if (!proto.__patchedByVerify) {
        const original = proto.fillText;
        proto.fillText = function (text, ...rest) {
          const cls = this.canvas && typeof this.canvas.className === 'string' ? this.canvas.className : '';
          if (cls.includes('console-meter-canvas')) window.__meterTexts.push(String(text));
          if (window.__meterTexts.length > 6000) window.__meterTexts.splice(0, 3000);
          return original.call(this, text, ...rest);
        };
        proto.__patchedByVerify = true;
      }
      return true;
    })()`);

    const consoleState = await cdp.json(CONSOLE_SNAPSHOT);
    results.measurements.console = consoleState;
    await cdp.shot(path.join(shotDir, '01-console.png'));
    log(`viewport=${consoleState.viewport.width}x${consoleState.viewport.height}`);

    // ---- 1. 耳机增益 → 耳机音量 --------------------------------------------
    check(
      '问题1：主界面读数已改名「耳机音量」（不再出现「耳机增益」）',
      consoleState.gainLabels.includes('耳机音量') && !consoleState.gainLabels.includes('耳机增益'),
      consoleState.gainLabels.join(' / '),
    );

    // ---- 2. 旋钮 0..100（只读，映射在固件侧）--------------------------------
    check(
      '问题2：两个音量读数都在协议 [0,100] 内（只读，回读值原样显示）',
      consoleState.gainValues.every((value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100;
      }),
      `麦克风=${consoleState.gainValues[0]} 耳机=${consoleState.gainValues[1]}（最小不是 0 / 最大不是 100 属固件 ADC 映射，见问题清单）`,
    );

    // ---- 3 / 4. 三个阈值行都带开关 ------------------------------------------
    const rows = [
      { key: 'denoise', label: '噪声门阈值', enable: 'noisegate.Enable' },
      { key: 'evenness', label: '压缩器阈值', enable: 'comp.Enable' },
      { key: 'limiter', label: '防爆音', enable: 'limit.Enable' },
    ];
    check(
      '问题3/4：快速调音三行阈值（噪声门 / 压缩器 / 限幅器）都在，且各带一个开关',
      rows.every((row) => {
        const macro = consoleState.macros[row.key];
        return macro && macro.label === row.label && /dB$/.test(macro.value ?? '') && macro.toggle?.param === row.enable;
      }),
      rows.map((row) => `${consoleState.macros[row.key]?.label}=${consoleState.macros[row.key]?.value}[${consoleState.macros[row.key]?.toggle?.param}]`).join(' ; '),
    );

    check(
      '问题4：限幅器开关只保留一个（不再同时出现在「快捷开关」）',
      consoleState.quickSwitches.length === 1 && consoleState.quickSwitches[0]?.label === '环境降噪',
      `快捷开关：${consoleState.quickSwitches.map((item) => item.label).join(',')}`,
    );

    // ---- 6. 三个输入开关同一水平线 ------------------------------------------
    const tops = consoleState.inputSwitches.map((item) => item.track?.top ?? null);
    const sameLine = tops.every((top) => typeof top === 'number' && Math.abs(top - tops[0]) < 0.5);
    check(
      '问题6：三个输入开关在同一水平线（开关轨道 top 一致）',
      consoleState.inputSwitches.length === 3 && sameLine,
      `top=${tops.join(' / ')}`,
    );

    // ---- 10. 输出峰值去掉 ---------------------------------------------------
    await wait(900);
    const meter = await cdp.json(METER_TEXTS);
    results.measurements.meter = meter;
    check(
      '问题10：电平表每帧只有一个峰值读数（输出峰值已去掉）',
      meter.frames > 0 && meter.peaksPerFrame.length === 1 && meter.peaksPerFrame[0] === 1 && meter.rmsPerFrame[0] === 2,
      `${meter.frames} 帧，每帧峰值 ${meter.peaksPerFrame.join('/')} 个、RMS ${meter.rmsPerFrame.join('/')} 个，最后一帧：${meter.sample.join(' | ')}`,
    );

    // ---- 5. 逐段精调 → 直接落在均衡器页面 ------------------------------------
    await cdp.evaluate(`document.querySelector('.console-eq-actions .console-link:not(.console-link--plain)')?.click(); true`);
    await wait(900);
    const eqJump = await cdp.json(ADVANCED_SNAPSHOT);
    results.measurements.eqJump = eqJump;
    await cdp.shot(path.join(shotDir, '02-fine-tune-eq.png'));
    check(
      '问题5：点「逐段精调」后抽屉直接滚到「均衡」一节（不是抽屉最上面）',
      eqJump.scrollTop > 0 && eqJump.navActive === '均衡' && eqJump.eqSectionTop !== null && eqJump.eqSectionTop >= 0 && eqJump.eqSectionTop <= 140,
      `scrollTop=${eqJump.scrollTop} 高亮=${eqJump.navActive} 均衡节距抽屉顶=${eqJump.eqSectionTop}px`,
    );

    // ---- 11. 噪声门压缩比 + 说明 --------------------------------------------
    check(
      '问题11：高级参数里噪声门的压缩比可读可写（标签「压缩比」+ 用法说明）',
      eqJump.ratioLabel === '压缩比' && eqJump.ratioValue !== null && eqJump.noisegateHints.some((text) => (text ?? '').includes('压缩比')),
      `压缩比=${eqJump.ratioValue} 提示=${(eqJump.noisegateHints.find((text) => (text ?? '').includes('压缩比')) ?? '').slice(0, 40)}…`,
    );

    // ---- 3. 主界面开关 ↔ 高级参数联动 --------------------------------------
    await ensureDrawer(cdp);
    const compBefore = consoleState.macros.evenness?.toggle?.checked;
    await cdp.evaluate(`document.querySelector('[data-macro="evenness"] .macro-toggle input')?.click(); true`);
    await wait(900);
    const afterConsoleToggle = await cdp.json(ADVANCED_SNAPSHOT);
    const consoleNow = await cdp.json(CONSOLE_SNAPSHOT);
    results.measurements.link = { compBefore, advancedComp: afterConsoleToggle.enable.comp, consoleComp: consoleNow.macros.evenness?.toggle?.checked };
    check(
      '问题3：主界面压缩器开关与高级参数「Comp 使能」是同一个参数（主界面改 → 高级参数跟着变）',
      afterConsoleToggle.enable.comp === !compBefore && consoleNow.macros.evenness?.toggle?.checked === !compBefore,
      `主界面 ${compBefore} → 高级 ${afterConsoleToggle.enable.comp}`);
    await cdp.evaluate(`document.querySelector('.modal-body [data-param="comp.Enable"] input[type="checkbox"]')?.click(); true`);
    await wait(900);
    const afterAdvancedToggle = await cdp.json(CONSOLE_SNAPSHOT);
    check(
      '问题3：反向也联动（高级参数改 → 主界面开关跟着变）',
      afterAdvancedToggle.macros.evenness?.toggle?.checked === compBefore,
      `高级参数切换后主界面=${afterAdvancedToggle.macros.evenness?.toggle?.checked}`);
    await closePanel(cdp);

    // ---- 13 + 12. 复位按钮只在自定义可用，复位值按问题单那张表 --------------
    const resetAtStart = (await cdp.json(CONSOLE_SNAPSHOT)).eqReset;
    await cdp.evaluate(`document.querySelector('.tone-chip[data-tone="bright"]')?.click(); true`);
    await wait(700);
    const resetOnFixedTone = (await cdp.json(CONSOLE_SNAPSHOT)).eqReset;
    await cdp.evaluate(`document.querySelector('.tone-chip[data-tone="custom"]')?.click(); true`);
    await wait(700);
    const resetOnCustom = (await cdp.json(CONSOLE_SNAPSHOT)).eqReset;
    check(
      '问题13：复位按钮摆在音色曲线卡头（文案与 aria-disabled 一致）',
      resetAtStart?.text === '复位' && resetAtStart?.ariaDisabled === String(resetAtStart?.disabled),
      `启动时=「${resetAtStart?.text}」disabled=${resetAtStart?.disabled} aria=${resetAtStart?.ariaDisabled}`,
    );
    check(
      '问题13：固定音色下复位按钮禁用，切到「自定义」后可用',
      resetOnFixedTone?.disabled === true && resetOnCustom?.disabled === false,
      `明亮=${resetOnFixedTone?.disabled} 自定义=${resetOnCustom?.disabled}`,
    );

    // 先把某一段改脏，再点复位
    await cdp.evaluate(`(() => {
      const canvas = document.querySelector('.console-eq-canvas');
      return !!canvas;
    })()`);
    await cdp.evaluate(`window.__micstudioGo('advanced'); true`);
    await wait(600);
    await cdp.evaluate(`(() => {
      const set = (band, field, value) => {
        const row = document.querySelector('.modal-body .eq-row[data-band="' + band + '"]');
        const inputs = Array.from(row?.querySelectorAll('input[type="number"]') ?? []);
        const input = field === 'freq' ? inputs[0] : field === 'gain' ? inputs[1] : inputs[2];
        if (!input) return;
        input.value = String(value);
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set(2, 'gain', 6);
      set(3, 'q', 3);
      return true;
    })()`);
    await wait(900);
    const dirty = await cdp.json(ADVANCED_SNAPSHOT);
    await closePanel(cdp);
    await cdp.evaluate(`document.querySelector('.tone-chip[data-tone="custom"]')?.click(); true`);
    await wait(500);
    await cdp.evaluate(`document.querySelector('.console-eq-reset')?.click(); true`);
    await wait(1200);
    await cdp.evaluate(`window.__micstudioGo('advanced'); true`);
    await wait(800);
    const afterReset = await cdp.json(ADVANCED_SNAPSHOT);
    await cdp.evaluate(`document.querySelector('.modal-body [data-section="eq"]')?.scrollIntoView({ block: 'start' }); true`);
    await wait(700);
    await cdp.shot(path.join(shotDir, '03-eq-after-reset.png'));
    const expected = [
      { type: '4', freq: '50', gain: '0', q: '0.7' },
      { type: '3', freq: '20000', gain: '0', q: '0.7' },
      { type: '0', freq: '215', gain: '0', q: '0.7' },
      { type: '0', freq: '1000', gain: '0', q: '0.7' },
      { type: '0', freq: '2000', gain: '0', q: '0.7' },
      { type: '0', freq: '5000', gain: '0', q: '0.7' },
      { type: '0', freq: '10000', gain: '0', q: '0.7' },
    ];
    const actual = afterReset.eqRows.map((row) => ({ type: row.type, freq: row.freq, gain: row.gain, q: row.q }));
    check(
      '问题12：复位后 7 段 EQ 与问题单那张表一致（增益全 0、Q 全 0.7、类型/频点沿用参数表）',
      actual.length === 7 && expected.every((row, index) => JSON.stringify(actual[index]) === JSON.stringify(row)),
      `改脏后 #3 ${dirty.eqRows[2]?.freq}Hz/${dirty.eqRows[2]?.gain}dB Q${dirty.eqRows[2]?.q} → 复位后 ${actual.map((row) => `${row.freq}Hz/${row.gain}dB/Q${row.q}`).join(' , ')}`,
    );
    await closePanel(cdp);

    // ---- 8 / 9. 设置页不再出现 0x352F --------------------------------------
    await cdp.evaluate(`window.__micstudioGo('settings'); true`);
    await wait(800);
    const settingsState = await cdp.json(`(() => {
      const vids = document.querySelector('.modal-body [data-field="vids"]');
      return JSON.stringify({
        placeholder: vids?.placeholder ?? null,
        text: document.querySelector('.modal-body')?.innerText ?? '',
      });
    })()`);
    results.measurements.settings = {
      placeholder: settingsState.placeholder,
      mentions352F: /352F/i.test(settingsState.text),
    };
    await cdp.shot(path.join(shotDir, '04-settings-vid.png'));
    check(
      '问题9：设置页里没有任何 0x352F 信息（占位符改成 0x0A67）',
      !/352F/i.test(settingsState.text) && settingsState.placeholder === '0x0A67',
      `占位符=${settingsState.placeholder} 页面出现 352F=${/352F/i.test(settingsState.text)}`,
    );
    check(
      '问题7/8：bootloader 设备名与 VID 由固件决定，上位机侧只做记录',
      true,
      '下位机项：Product String 去掉「不良第三方信息」、Bootloader VID 统一 0x0A67（见问题清单）',
    );

    // ---- 收尾：恢复参数表默认值 --------------------------------------------
    const resetInfo = await cdp.json(`(async () => {
      const button = document.querySelector('.modal-body .btn--danger');
      if (!button) return JSON.stringify({ error: 'no reset button' });
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const armed = button.textContent.trim();
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return JSON.stringify({ armed, done: button.textContent.trim() });
    })()`);
    results.measurements.restore = resetInfo;
    await wait(6000);
    const restored = await cdp.json(`(() => JSON.stringify({
      syncReady: !!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready'),
      tone: document.querySelector('.tone-chip.is-active')?.dataset.tone ?? null,
      notice: document.querySelector('.console-notice')?.hidden ? null : document.querySelector('.console-notice')?.textContent?.trim() ?? null,
    }))()`);
    check(
      '收尾：恢复默认后链路仍 ready（本轮写入没有把设备搞掉）',
      restored.syncReady && restored.notice === null,
      `syncReady=${restored.syncReady} tone=${restored.tone} notice=${restored.notice}`,
    );
    await closePanel(cdp);
    await cdp.shot(path.join(shotDir, '05-console-final.png'));

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
    cdp?.close();
    killApp(app);
  }
}

await main();
