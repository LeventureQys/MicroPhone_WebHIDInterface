// 端到端联调取证（G7）：连虚拟下位机 → 参数回读 → 改旋钮出写帧 → 设备静默后电平失效。
// 前置：先起 tools/vdevice/run.mjs（桥 8765 + 控制面 8766）。
//   electron.exe . --screenshot=artifacts\v1.1.0-e2e-silent.png --exec-file=scripts\probes\param-link.js --no-sandbox
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

  const stats = {};
  const steps = {};

  // 1) 设备抽屉 → 连接虚拟桥 → 打开设备（走 DeviceLink.attach）
  q('#connect-btn')?.click();
  await wait(320);
  q('.device-actions .btn')?.click();
  await wait(1600);
  steps.deviceRows = qa('.device-row').length;
  stats.beforeAttach = await control('/control/stats');

  qa('.device-row .btn')[0]?.click();
  await wait(2600);
  stats.afterAttach = await control('/control/stats');
  steps.deviceButtonLabel = textOf('.device-row .btn');
  steps.syncPill = textOf('#sync-pill .state-text');
  steps.sourcePill = textOf('#source-pill .state-text');

  // 2) 关掉抽屉，读界面上的参数值（回读覆盖后不再是默认值）
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await wait(260);
  steps.micGain = textOf('.console-gain-item .console-gain-value');
  steps.denoise = textOf('[data-macro="denoise"] .pfield-value');
  steps.encLevel = q('.segmented--compact .seg-btn.is-active')?.dataset.value ?? null;

  // 3) 改一个旋钮（环境降噪开关）→ 设备侧应收到写帧
  stats.beforeWrite = await control('/control/stats');
  qa('.switch-grid .switch-item')[0]?.querySelector('input')?.click();
  await wait(500);
  stats.afterWrite = await control('/control/stats');
  steps.encSwitch = qa('.switch-grid .switch-item')[0]?.querySelector('input')?.checked ?? null;

  // 4) 拉高电平，确认界面跟 0x2057 动（截图留证）
  await control('/control/level', { pattern: 'step', value: 200 });
  await wait(400);
  steps.levelRaw = (await control('/control/stats')).levelRaw;

  // 5) 设备静默（进 bootloader，不再应答参数帧）→ 1 s 后两栏应变 —
  await control('/control/mode', { mode: 'bootloader' });
  await wait(1500);
  steps.silentMode = (await control('/control/stats')).mode;

  return JSON.stringify({
    steps,
    byFunc: {
      beforeWrite: stats.beforeWrite.byFunc,
      afterWrite: stats.afterWrite.byFunc,
    },
    framesIn: {
      beforeAttach: stats.beforeAttach.framesIn,
      afterAttach: stats.afterAttach.framesIn,
    },
    modelCode: stats.afterAttach.modelCode,
    firmware: stats.afterAttach.firmwareVersion,
    levelRaw: stats.afterAttach.levelRaw,
    framesOut: stats.afterAttach.framesOut,
    rejectedReadOnly: stats.afterAttach.rejectedReadOnly,
  });
})();
