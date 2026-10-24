// 修复验收取证（A11 EQ 写帧 / A5+B5 断线看门狗）：
//   连虚拟下位机 → 点一个音色预设（改 7 段 gain）→ 设备侧应收到 EQ 写帧 → 让设备静默，看门狗把链路判掉。
// 前置：先起 tools/vdevice/run.mjs（桥 8765 + 控制面 8766）。
//   electron.exe . --screenshot=artifacts\v1.1.0-e2e-eq-watchdog.png --exec-file=scripts\probes\eq-write-watchdog.js --no-sandbox
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const q = (selector) => document.querySelector(selector);
  const qa = (selector) => Array.from(document.querySelectorAll(selector));
  const textOf = (selector) => q(selector)?.textContent ?? null;
  const control = async (path, body) => {
    const options =
      body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const response = await fetch(`http://127.0.0.1:8766${path}`, options);
    return response.json();
  };
  const writeFrames = (stats) => ({
    randWrite: stats.byFunc['16'] ?? 0,
    seqWrite: stats.byFunc['17'] ?? 0,
  });

  // 1) 连接虚拟桥 + 打开设备（DeviceLink.attach）
  q('#connect-btn')?.click();
  await wait(320);
  q('.device-actions .btn')?.click();
  await wait(1600);
  qa('.device-row .btn')[0]?.click();
  await wait(2400);
  const attached = await control('/control/stats');

  // 2) 关抽屉，点「温暖」音色 → 6~7 段 gain 变化 → 每段一条 0x10
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await wait(260);
  const beforeTone = await control('/control/stats');
  q('.tone-chip[data-tone="warm"]')?.click();
  await wait(420);
  const afterTone = await control('/control/stats');
  const log = await control('/control/log');
  // 只挑参数写帧：Func 0x10（随机写）/ 0x11（连续写），UnitID 恒 0
  const writeHex = log
    .filter((entry) => entry.dir === 'in' && /^00 1[01] /.test(entry.hex))
    .slice(-8)
    .map((entry) => entry.hex);

  // 3) 设备静默：看门狗应在 ~2.5 s 内把通道判成断开（顶栏 + 提示条 + 电平）
  await control('/control/mode', { mode: 'bootloader' });
  await wait(3200);
  const pills = {
    state: textOf('.state-pill .state-text'),
    source: textOf('#source-pill .state-text'),
    sync: textOf('#sync-pill .state-text'),
  };
  const notice = q('.console-notice');
  const afterSilence = await control('/control/stats');

  return JSON.stringify({
    attached: { framesIn: attached.framesIn, modelCode: attached.modelCode, mode: attached.mode },
    toneWrites: { before: writeFrames(beforeTone), after: writeFrames(afterTone) },
    writeHex,
    pills,
    notice: { hidden: notice?.hidden ?? null, text: notice?.textContent ?? null },
    silentMode: afterSilence.mode,
    tone: q('.tone-chip.is-active')?.dataset.tone ?? null,
  });
})();
