// 第二轮真机联调 · 取证：设备抽屉里把「诊断自检」三步留在视口内（截图用）。
//   electron.exe . --screenshot=artifacts\real2\app-link-pass.png --route=device --exec-file=scripts\probes\real2-app-check-shot.js --no-sandbox
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (selector) => document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  const steps = () =>
    Array.from(document.querySelectorAll('.diag-selfcheck-steps > *')).map((node) => node.textContent?.replace(/\s+/g, ' ').trim());

  document.querySelector('.segmented .seg-btn[data-value="native"]')?.click();
  await wait(200);
  document.querySelector('.device-actions .btn')?.click();
  await wait(1500);

  const rows = Array.from(document.querySelectorAll('.device-row'));
  const target = rows.find((row) => (row.textContent ?? '').includes('0A67'));
  if (!target) return JSON.stringify({ error: '设备列表里没有 0A67' });
  target.querySelector('.btn')?.click();
  await wait(4500);

  document.querySelector('.diag-selfcheck')?.click();
  await wait(6000);
  const result = steps();

  // 截图取证：清空日志（帧日志已在 artifacts 里），展开诊断区并滚到自检结果
  const details = document.querySelector('.diag-details');
  if (details) details.open = true;
  document.querySelector('.diag-clear')?.click();
  await wait(250);
  const body = document.querySelector('.modal-body');
  if (body) body.scrollTop = body.scrollHeight;
  document.querySelector('.diag-selfcheck-steps')?.scrollIntoView({ block: 'center' });
  await wait(400);

  return JSON.stringify({
    sourcePill: text('#source-pill'),
    syncPill: text('#sync-pill'),
    selfCheck: result,
    stats: Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((node) => [node.dataset.stat, node.textContent])),
    deviceFields: Object.fromEntries(
      Array.from(document.querySelectorAll('[data-diag]')).map((node) => [node.dataset.diag, node.textContent]),
    ),
  });
})()
