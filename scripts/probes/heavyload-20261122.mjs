/**
 * 最重负载测试（2026-11-22 问题单第 11 条）：
 * 「打开环境降噪，打开 USB 录音和放音，打开所有效果器，并且不断的调节参数。」
 *
 *   node scripts/probes/heavyload-20261122.mjs [--seconds=180]
 *
 * 做法：
 *   1. 连接设备（真机自动连接；没有设备时退化为 mock，结论只对界面与链路有效）；
 *   2. 打开环境降噪 + 全部效果器（噪声门 / 压缩器 / 限幅器 / 三分频动态 / 灯效 / 监听）；
 *   3. 录音：电平条走设备音频输入（`getUserMedia`，就是 USB 录音通路），顺带把
 *      音频输入端点打到 USB 输出做回放（`AudioContext.setSinkId`，不支持时退回默认输出）；
 *   4. 循环调节参数：三个阈值滑杆、三个输入开关、色音曲线、灯效模式、场景切换，
 *      约每 250 ms 一次，等价于"手一直不停地在拨"；
 *   5. 全程量主线程卡顿（rAF 间隔）、链路是否掉线、有没有超时/重试/CRC 错。
 *
 * 结束时把参数恢复成参数表默认值，结果写 `artifacts/heavyload-20261122/result.json`。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Cdp, findPageTarget, killApp, launchApp, repo, wait, waitReady } from './lib/cdp.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const seconds = Math.max(20, Number(arg('seconds', '180')) || 180);
const shotDir = path.join(repo, 'artifacts', 'heavyload-20261122');
const profile = 'D:\\Temp\\ud-heavyload-20261122';
const port = 9365;

rmSync(shotDir, { recursive: true, force: true });
mkdirSync(shotDir, { recursive: true });
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const log = (...args) => console.log(`[load] ${new Date().toISOString().slice(11, 19)}`, ...args);
const results = { startedAt: new Date().toISOString(), seconds, checks: [], measurements: {} };
function check(name, ok, detail) {
  results.checks.push({ name, ok: Boolean(ok), detail: detail ?? null });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
}

/** 装好：全部效果器打开 + 回放 + 卡顿采样 + 参数锤子 */
const SETUP = `(() => {
  const click = (node) => { if (node) { node.click(); return true; } return false; };
  const setChecked = (node, value) => {
    if (!node) return false;
    if (node.checked !== value) node.click();
    return true;
  };
  const checked = (selector) => document.querySelector(selector)?.checked ?? null;

  // 全部效果器打开；监听打开、麦克风不静音、电平信号不静音
  const state = {
    noisegate: checked('[data-param="noisegate.Enable"] input'),
    comp: checked('[data-param="comp.Enable"] input'),
    limit: checked('[data-param="limit.Enable"] input'),
    enc: checked('[data-param="enc.OnOff"] input'),
    monitor: checked('[data-param="hp.OnOff"] input'),
    mute: checked('[data-param="mic.mute"] input'),
    sigMute: checked('[data-param="mic.sigMute"] input'),
    rgb: checked('[data-param="rgb.OnOff"] input'),
  };
  setChecked(document.querySelector('[data-param="noisegate.Enable"] input'), true);
  setChecked(document.querySelector('[data-param="comp.Enable"] input'), true);
  setChecked(document.querySelector('[data-param="limit.Enable"] input'), true);
  setChecked(document.querySelector('[data-param="enc.OnOff"] input'), true);
  setChecked(document.querySelector('[data-param="hp.OnOff"] input'), true);
  setChecked(document.querySelector('[data-param="mic.mute"] input'), false);
  setChecked(document.querySelector('[data-param="mic.sigMute"] input'), false);
  setChecked(document.querySelector('[data-param="rgb.OnOff"] input'), true);
  window.__loadStateBefore = state;

  // USB 放音：440 Hz 正弦打到 USB 输出（拿不到设备输出端点时退回默认输出）
  window.__loadAudio = { playback: 'none', sink: null };
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440;
    gain.gain.value = 0.02;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    window.__loadAudio.ctx = ctx;
    window.__loadAudio.playback = 'started';
    ctx.resume?.();
    navigator.mediaDevices?.enumerateDevices?.().then((devices) => {
      const outputs = devices.filter((item) => item.kind === 'audiooutput');
      const usb = outputs.find((item) => /USB Audio|M001|JYM/i.test(item.label ?? ''));
      if (usb && ctx.setSinkId) {
        ctx.setSinkId(usb.deviceId).then(() => {
          window.__loadAudio.sink = usb.label;
        }).catch(() => {
          window.__loadAudio.sink = 'default(failed)';
        });
      } else {
        window.__loadAudio.sink = 'default';
      }
    }).catch(() => { window.__loadAudio.sink = 'default'; });
  } catch (error) {
    window.__loadAudio.error = String(error);
  }

  // 主线程卡顿：rAF 间隔
  window.__loadLag = { samples: 0, max: 0, slow50: 0, slow120: 0, last: performance.now() };
  const tickLag = () => {
    const now = performance.now();
    const delta = now - window.__loadLag.last;
    window.__loadLag.last = now;
    window.__loadLag.samples += 1;
    if (delta > window.__loadLag.max) window.__loadLag.max = delta;
    if (delta > 50) window.__loadLag.slow50 += 1;
    if (delta > 120) window.__loadLag.slow120 += 1;
    requestAnimationFrame(tickLag);
  };
  requestAnimationFrame(tickLag);

  // 参数锤子：每 250 ms 拨一次，四个动作轮转
  window.__loadHammer = { actions: 0, slider: 0, tone: 0, switch: 0, lighting: 0, scene: 0 };
  const setRange = (key, value) => {
    const range = document.querySelector('[data-macro="' + key + '"] input[type="range"]');
    if (!range) return false;
    range.value = String(value);
    range.dispatchEvent(new Event('input', { bubbles: true }));
    window.__loadHammer.actions += 1;
    window.__loadHammer.slider += 1;
    return true;
  };
  const flip = (selector) => {
    const input = document.querySelector(selector);
    if (!input) return false;
    input.click();
    window.__loadHammer.actions += 1;
    window.__loadHammer.switch += 1;
    return true;
  };
  let step = 0;
  window.__loadTimer = setInterval(() => {
    step += 1;
    const phase = step % 4;
    if (phase === 0) {
      setRange('denoise', -91 + (step % 7) * 9);
    } else if (phase === 1) {
      setRange('evenness', -60 + (step % 5) * 6);
    } else if (phase === 2) {
      setRange('limiter', -30 + (step % 4) * 5);
    } else {
      const tones = ['flat', 'vocal', 'warm', 'bright', 'custom'];
      document.querySelector('.tone-chip[data-tone="' + tones[step % tones.length] + '"]')?.click();
      window.__loadHammer.actions += 1;
      window.__loadHammer.tone += 1;
    }
    if (step % 8 === 3) {
      document.querySelector('.switch-item--light .segmented--modes .seg-btn[data-value="' + (step % 8) + '"]')?.click();
      window.__loadHammer.lighting += 1;
    }
    if (step % 12 === 5) {
      flip('[data-param="mic.sigMute"] input');
      flip('[data-param="hp.OnOff"] input');
    }
    if (step % 40 === 7) {
      const scenes = ['quiet', 'game', 'podcast', 'sing', 'custom'];
      document.querySelector('.scene-btn[data-scene="' + scenes[step % scenes.length] + '"]')?.click();
      window.__loadHammer.scene += 1;
      // 场景会按预设改开关：切完立刻把"全部效果器"重新打开，负载更重
      setChecked(document.querySelector('[data-param="noisegate.Enable"] input'), true);
      setChecked(document.querySelector('[data-param="comp.Enable"] input'), true);
      setChecked(document.querySelector('[data-param="limit.Enable"] input'), true);
      setChecked(document.querySelector('[data-param="enc.OnOff"] input'), true);
    }
  }, 250);

  // 场景预设里三分频是关的：这里单独打开，保证"所有效果器"都跑到
  window.__micstudioGo?.('advanced');
  return JSON.stringify({ ok: true, initial: state });
})()`;

const ENABLE_DRC3 = `(() => {
  const body = document.querySelector('.modal-body');
  const input = body?.querySelector('[data-param="drc3.Enable"] input[type="checkbox"]');
  if (!input) return JSON.stringify({ ok: false });
  if (!input.checked) input.click();
  return JSON.stringify({ ok: true, checked: input.checked });
})()`;

const STATUS = `(() => {
  const pill = document.querySelector('#sync-pill');
  const notice = document.querySelector('.console-notice');
  return JSON.stringify({
    sync: pill?.className ?? null,
    ready: /state-pill--ready/.test(pill?.className ?? ''),
    noticeVisible: notice ? !notice.hidden && notice.style.display !== 'none' : false,
    noticeText: notice?.textContent?.trim() ?? null,
    lag: window.__loadLag ?? null,
    hammer: window.__loadHammer ?? null,
    audio: { playback: window.__loadAudio?.playback ?? null, sink: window.__loadAudio?.sink ?? null, error: window.__loadAudio?.error ?? null },
    checked: {
      noisegate: document.querySelector('[data-param="noisegate.Enable"] input')?.checked ?? null,
      comp: document.querySelector('[data-param="comp.Enable"] input')?.checked ?? null,
      limit: document.querySelector('[data-param="limit.Enable"] input')?.checked ?? null,
      enc: document.querySelector('[data-param="enc.OnOff"] input')?.checked ?? null,
      monitor: document.querySelector('[data-param="hp.OnOff"] input')?.checked ?? null,
      rgb: document.querySelector('[data-param="rgb.OnOff"] input')?.checked ?? null,
    },
    gain: Array.from(document.querySelectorAll('.console-gain-value')).map((node) => node.textContent?.trim() ?? null),
    meterTexts: (window.__meterTexts ?? []).slice(-4),
  });
})()`;

const DIAG = `(() => {
  const read = (key) => document.querySelector('[data-stat="' + key + '"]')?.textContent?.trim() ?? null;
  const field = (key) => document.querySelector('[data-diag="' + key + '"]')?.textContent?.trim() ?? null;
  return JSON.stringify({
    out: read('out'),
    in: read('in'),
    crc: read('crc'),
    timeout: read('timeout'),
    retry: read('retry'),
    dropped: read('dropped'),
    queue: read('queue'),
    audio: field('audio'),
    poll: field('poll'),
    firmware: field('firmware'),
  });
})()`;

async function main() {
  const app = launchApp({ profile, port });
  let cdp = null;
  try {
    const target = await findPageTarget(port);
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
    if (!(await waitReady(cdp))) throw new Error('renderer not ready');

    // 等自动连接（真机插着时）
    for (let index = 0; index < 40; index += 1) {
      const ready = await cdp.evaluate(`/state-pill--ready/.test(document.querySelector('#sync-pill')?.className ?? '')`);
      if (ready) break;
      await wait(500);
    }
    await wait(1200);

    // 电平画布取证：确认录音通路在出帧
    await cdp.evaluate(`(() => {
      window.__meterTexts = [];
      const proto = CanvasRenderingContext2D.prototype;
      if (!proto.__patchedByLoad) {
        const original = proto.fillText;
        proto.fillText = function (text, ...rest) {
          const cls = this.canvas && typeof this.canvas.className === 'string' ? this.canvas.className : '';
          if (cls.includes('console-meter-canvas')) {
            window.__meterTexts.push(String(text));
            if (window.__meterTexts.length > 400) window.__meterTexts.splice(0, 200);
          }
          return original.call(this, text, ...rest);
        };
        proto.__patchedByLoad = true;
      }
      return true;
    })()`);

    const setup = await cdp.evaluate(SETUP);
    log(`setup ${setup}`);
    await wait(700);
    const drc = await cdp.evaluate(ENABLE_DRC3);
    log(`drc3 ${drc}`);
    await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
    await wait(800);

    const before = JSON.parse(await cdp.evaluate(STATUS));
    results.measurements.before = before;
    await cdp.shot(path.join(shotDir, '01-before.png'));
    log(`start: sync=${before.sync} audio=${before.audio.playback}/${before.audio.sink}`);

    const startedAt = Date.now();
    const samples = [];
    let lastTick = 0;
    let midShot = false;
    while (Date.now() - startedAt < seconds * 1000) {
      await wait(2000);
      const status = JSON.parse(await cdp.evaluate(STATUS));
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      samples.push({ t: elapsed, ready: status.ready, sync: status.sync, lagMax: status.lag?.max ?? null, actions: status.hammer?.actions ?? 0 });
      if (elapsed !== lastTick) {
        lastTick = elapsed;
        if (elapsed % 20 === 0) log(`t+${elapsed}s ready=${status.ready} actions=${status.hammer?.actions} lagMax=${status.lag?.max?.toFixed?.(1) ?? status.lag?.max}`);
      }
      if (!midShot && elapsed >= Math.floor(seconds / 2)) {
        midShot = true;
        await cdp.shot(path.join(shotDir, '02-mid.png'));
      }
    }

    // 收尾：停锤子，读状态与诊断
    const finalStatus = JSON.parse(await cdp.evaluate(`(() => {
      clearInterval(window.__loadTimer);
      window.__loadTimer = null;
      return ${STATUS};
    })()`));
    results.measurements.final = finalStatus;
    results.measurements.samples = samples;
    await cdp.shot(path.join(shotDir, '03-after.png'));

    // 诊断卡（设备抽屉）：超时 / 重试 / CRC / 丢帧 / 电平来源
    await cdp.evaluate(`window.__micstudioGo?.('device'); true`);
    await wait(1500);
    const diag = JSON.parse(await cdp.evaluate(DIAG));
    results.measurements.diag = diag;
    await cdp.shot(path.join(shotDir, '04-diag.png'));
    log(`diag ${JSON.stringify(diag)}`);

    const timeouts = Number(diag.timeout ?? 0);
    const retries = Number(diag.retry ?? 0);
    const crc = Number(diag.crc ?? 0);
    const lag = finalStatus.lag ?? {};

    check(
      '负载期间链路始终 ready（没有掉线 / 同步失败）',
      samples.every((item) => item.ready) && finalStatus.ready,
      `${samples.length} 次采样，ready=${samples.filter((item) => item.ready).length}`,
    );
    check(
      '负载期间没有常驻错误提示（超时/断开提示条）',
      finalStatus.noticeVisible === false,
      `notice=${finalStatus.noticeText ?? '无'}`,
    );
    check(
      '所有效果器在负载结束时仍然打开（噪声门 / 压缩器 / 限幅器 / 环境降噪 / 灯效）',
      finalStatus.checked.noisegate === true &&
        finalStatus.checked.comp === true &&
        finalStatus.checked.limit === true &&
        finalStatus.checked.enc === true &&
        finalStatus.checked.rgb === true,
      JSON.stringify(finalStatus.checked),
    );
    check(
      'USB 录音在出帧（电平画布有 RMS/峰值文本）+ 回放已启动',
      finalStatus.audio.playback === 'started' && finalStatus.meterTexts.length > 0,
      `回放=${finalStatus.audio.playback} 输出=${finalStatus.audio.sink} 画布文本=${finalStatus.meterTexts.join('|')}`,
    );
    check(
      '参数一直在变（动作次数 > 每秒 1 次）',
      (finalStatus.hammer?.actions ?? 0) > seconds,
      `actions=${finalStatus.hammer?.actions} slider=${finalStatus.hammer?.slider} tone=${finalStatus.hammer?.tone} switch=${finalStatus.hammer?.switch} 灯效=${finalStatus.hammer?.lighting} 场景=${finalStatus.hammer?.scene}`,
    );
    check(
      '协议统计没有超时/CRC 错（重试可以为 0；真机落盘窗口内允许少量重试）',
      timeouts === 0 && crc === 0,
      `timeouts=${diag.timeout} retries=${diag.retry} crc=${diag.crc} dropped=${diag.dropped} out=${diag.out} in=${diag.in}`,
    );
    check(
      '主线程没有被卡死（最长 rAF 间隔 < 1.5 s）',
      (lag.max ?? 0) < 1500,
      `rAF 采样=${lag.samples} 最长=${Math.round(lag.max ?? 0)}ms >120ms 的次数=${lag.slow120}`,
    );
    check(
      '电平来源仍是设备音频输入（录音通路没有被负载打断）',
      (diag.audio ?? '').includes('音频输入'),
      `电平来源=${diag.audio} 设备轮询=${diag.poll}`,
    );

    results.finishedAt = new Date().toISOString();
    results.summary = {
      total: results.checks.length,
      passed: results.checks.filter((item) => item.ok).length,
      failed: results.checks.filter((item) => !item.ok).length,
      seconds,
      actions: finalStatus.hammer?.actions ?? 0,
    };
    writeFileSync(path.join(shotDir, 'result.json'), JSON.stringify(results, null, 2));
    log(`RESULT ${JSON.stringify(results.summary)}`);
    for (const item of results.checks.filter((entry) => !entry.ok)) log(`FAILED: ${item.name} — ${item.detail}`);
    if (results.summary.failed > 0) process.exitCode = 1;

    // 收尾：恢复默认值（与其它探针一致）
    await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
    await wait(400);
    await cdp.evaluate(`window.__micstudioGo?.('settings'); true`);
    await wait(800);
    await cdp.json(`(async () => {
      const button = document.querySelector('.modal-body .btn--danger');
      if (!button) return JSON.stringify({ error: 'no reset button' });
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 350));
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return JSON.stringify({ done: true });
    })()`);
    await wait(4000);
    await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
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
