// 拔插后音频监听自愈的现场取证（2026-11-14，R-38）。
//
// 前置：先起虚拟下位机（`pnpm run vdevice`，桥 127.0.0.1:8765），再：
//   electron.exe . --no-sandbox --route=device --screenshot=artifacts/audio-heal.png \
//     --exec-file=scripts/probes/audio-heal.js
//
// 期望：[probe] 里 `audio` 从首采到 5 s 后（跨过 2 个自检周期）一直是
// 「音频输入：…」、`poll` 一直是「关」、`frames` 不再增长（重试/自检不发 HID 帧）。
// 中途派发一次 `devicechange`（模拟插拔时的设备表变化），状态不能被抖成「正在重新打开」。
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (selector) => document.querySelector(selector)?.textContent ?? null;
  const frames = () => Number(text('.diag-count') ?? '0');
  const diag = () => ({
    audio: text('[data-diag="audio"]'),
    poll: text('[data-diag="poll"]'),
    model: text('[data-diag="model"]'),
    frames: frames(),
  });

  const connect = document.querySelector('.device-actions .btn');
  if (!connect) return JSON.stringify({ error: 'no connect button' });
  connect.click();
  await wait(1500);

  const open = document.querySelector('.device-row .btn');
  if (!open) return JSON.stringify({ error: 'no device row', list: text('.device-list') });
  open.click();
  await wait(2500); // link.attach（全量回读）+ 音频电平接管

  const first = diag();
  // 模拟一次插拔时的音频设备表变化：watchDevices 必须已经挂上（否则这里没有任何反应是看不出来的，
  // 但至少能验证状态不会被抖坏、不会多开一路采集）
  navigator.mediaDevices?.dispatchEvent?.(new Event('devicechange'));
  await wait(1500);
  const afterEvent = diag();
  await wait(4000); // 跨过 2 个 2 s 自检周期
  const later = diag();

  // 展开诊断卡并滚到它，让截图里能直接看到「电平来源 / 设备轮询」两行
  const details = document.querySelector('details.diag-details');
  if (details) {
    details.open = true;
    details.scrollIntoView({ block: 'center' });
  }
  await wait(400);
  return JSON.stringify({ first, afterEvent, later, error: text('.device-error') ?? null });
})()
