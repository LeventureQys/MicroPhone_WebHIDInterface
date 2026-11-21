// 「连上之后不再向设备要电平」的现场取证（2026-11-07，R-29）。
//
// 前置：先起虚拟下位机（`pnpm run vdevice`，桥 127.0.0.1:8765 + 侧车），再：
//   electron.exe . --no-sandbox --route=device --screenshot=artifacts/level-poll-idle.png \
//     --exec-file=scripts/probes/level-poll-idle.js
//
// 期望：[probe] 的输出里 `poll` 变成「关（电平走音频输入，不再发请求）」、`frames` 三次采样不再增长、
// 4 s（> inboundWatchdogMs）后 `model` 仍不是「—」——关轮询没有把正常连接判成掉线。
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (selector) => document.querySelector(selector)?.textContent ?? null;
  // 诊断卡的帧计数：每收发一帧 +1，轮询开着时 1.5 s 会涨几十条
  const frames = () => Number(text('.diag-count') ?? '0');

  const connect = document.querySelector('.device-actions .btn');
  if (!connect) return JSON.stringify({ error: 'no connect button' });
  connect.click();
  await wait(1500);

  const open = document.querySelector('.device-row .btn');
  if (!open) return JSON.stringify({ error: 'no device row', list: text('.device-list') });
  open.click();
  await wait(2500); // link.attach（全量回读）+ 音频电平接管

  const sample = {
    poll: text('[data-diag="poll"]'),
    audio: text('[data-diag="audio"]'),
    model: text('[data-diag="model"]'),
    frames1: frames(),
  };
  await wait(1500);
  sample.frames2 = frames();
  await wait(3000); // 超过 inboundWatchdogMs（2 s）：关掉轮询后不能自己判掉线
  sample.frames3 = frames();
  sample.pollLater = text('[data-diag="poll"]');
  sample.modelLater = text('[data-diag="model"]');
  sample.error = text('.device-error') ?? null;

  // 展开诊断卡并滚到它，让截图里能直接看到「设备轮询」这一行
  const details = document.querySelector('details.diag-details');
  if (details) {
    details.open = true;
    details.scrollIntoView({ block: 'center' });
  }
  await wait(400);
  return JSON.stringify(sample);
})()
