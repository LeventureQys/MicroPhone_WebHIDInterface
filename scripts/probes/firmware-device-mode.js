// 固件升级抽屉的「设备模式」提示取证（规格 §3）：只读界面文本，不选包、不发帧。
//   electron.exe . --screenshot=artifacts\flash-spec\fw-device-mode.png --route=firmware --exec-file=scripts\probes\firmware-device-mode.js --no-sandbox
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  window.__micstudioGo?.('firmware');
  await wait(900);
  const row = document.querySelector('.fw-device-mode');
  const start = document.querySelector('.fw-start');
  return JSON.stringify({
    mode: row?.dataset.mode ?? null,
    visible: row ? !row.hidden : null,
    text: row?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    startDisabled: start?.disabled ?? null,
  });
})()
