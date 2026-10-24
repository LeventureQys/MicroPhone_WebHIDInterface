// 回读覆盖取证（G3，R4-1）：先把设备侧寄存器改成非默认值，再连接，界面必须显示设备值。
// 前置：先起 tools/vdevice/run.mjs，并先把 0x205b/0x2025/0x2024/0x2023/0x205a 改成非默认值。
//   electron.exe . --screenshot=artifacts\v1.1.0-e2e-readback.png --exec-file=scripts\probes\param-readback.js --no-sandbox
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const q = (selector) => document.querySelector(selector);
  const qa = (selector) => Array.from(document.querySelectorAll(selector));
  const textOf = (selector) => q(selector)?.textContent ?? null;
  const control = async (path) => {
    const response = await fetch(`http://127.0.0.1:8766${path}`);
    return response.json();
  };

  q('#connect-btn')?.click();
  await wait(320);
  q('.device-actions .btn')?.click();
  await wait(1600);
  qa('.device-row .btn')[0]?.click();
  await wait(2400);

  const pills = {
    source: textOf('#source-pill .state-text'),
    sync: textOf('#sync-pill .state-text'),
  };
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await wait(260);

  const gains = qa('.console-gain-item').map((item) => ({
    label: item.querySelector('.console-gain-label')?.textContent ?? null,
    value: item.querySelector('.console-gain-value')?.textContent ?? null,
  }));

  await control('/control/stats');

  return JSON.stringify({
    pills,
    gains,
    denoiseStrength: textOf('[data-macro="denoise"] .pfield-value'),
    evenness: textOf('[data-macro="evenness"] .pfield-value'),
    encSwitch: qa('.switch-grid .switch-item')[0]?.querySelector('input')?.checked ?? null,
    encLevel: q('.segmented--compact .seg-btn.is-active')?.dataset.value ?? null,
    limitSwitch: qa('.switch-grid .switch-item')[1]?.querySelector('input')?.checked ?? null,
    deviceState: textOf('.console-device-state'),
  });
})();
