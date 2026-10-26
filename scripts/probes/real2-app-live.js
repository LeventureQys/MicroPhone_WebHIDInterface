// 第二轮真机联调 · 取证：一屏工作台在真机连接态下的样子（连接保持不断开）。
//   electron.exe . --screenshot=artifacts\real2\app-console-live.png --route=console --exec-file=scripts\probes\real2-app-live.js --no-sandbox
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

  window.__micstudioGo('device');
  await wait(300);
  document.querySelector('.segmented .seg-btn[data-value="native"]')?.click();
  await wait(200);
  document.querySelector('.device-actions .btn')?.click();
  await wait(1500);
  const target = Array.from(document.querySelectorAll('.device-row')).find((row) => (row.textContent ?? '').includes('0A67'));
  if (!target) return JSON.stringify({ error: '设备列表里没有 0A67' });
  target.querySelector('.btn')?.click();
  await wait(4000);
  document.querySelector('.modal-close')?.click();
  await wait(400);

  document.querySelector('.scene-btn[data-scene="podcast"]')?.click();
  await wait(1200);

  return JSON.stringify({
    sourcePill: clean(document.querySelector('#source-pill')),
    syncPill: clean(document.querySelector('#sync-pill')),
    activeScene: Array.from(document.querySelectorAll('.scene-btn'))
      .filter((node) => node.getAttribute('aria-pressed') === 'true')
      .map((node) => node.dataset.scene),
    activeTone: Array.from(document.querySelectorAll('.tone-chip'))
      .filter((node) => node.getAttribute('aria-pressed') === 'true')
      .map((node) => node.dataset.tone),
    notice: clean(document.querySelector('.console-notice')),
    gain: clean(document.querySelector('.console-gain input')),
  });
})()
