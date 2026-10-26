// 真机应用级联调：设备抽屉 → 真实设备通道 → 连接 → 打开 0x0A67 设备 → 全量回读 → 诊断自检。
//   electron.exe . --screenshot=artifacts\real\app-link.png --route=device --exec-file=scripts\probes\real-app-link.js --no-sandbox
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (selector) => document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  const snapshot = () => {
    const fields = {};
    for (const node of document.querySelectorAll('[data-diag]')) fields[node.dataset.diag] = node.textContent;
    const stats = {};
    for (const node of document.querySelectorAll('[data-stat]')) stats[node.dataset.stat] = node.textContent;
    return {
      sourcePill: text('#source-pill'),
      syncPill: text('#sync-pill'),
      syncClass: document.querySelector('#sync-pill')?.className ?? null,
      notice: text('.console-notice'),
      error: text('.device-error:not([hidden]) .device-error-detail'),
      fields,
      stats,
      log: Array.from(document.querySelectorAll('.diag-log-row')).slice(-6).map((node) => node.textContent),
      selfCheck: Array.from(document.querySelectorAll('.diag-selfcheck-steps > *')).map((node) => node.textContent),
    };
  };

  const out = { steps: [] };

  document.querySelector('.segmented .seg-btn[data-value="native"]')?.click();
  await wait(200);
  document.querySelector('.device-actions .btn')?.click();
  await wait(1500);
  out.steps.push({ step: '连接真实通道', ...snapshot() });

  const rows = Array.from(document.querySelectorAll('.device-row'));
  const target = rows.find((row) => (row.textContent ?? '').includes('0A67'));
  if (!target) return JSON.stringify({ ...out, error: '设备列表里没有 0A67' });

  target.querySelector('.btn')?.click();
  await wait(5000);
  out.steps.push({ step: '打开设备并全量回读', ...snapshot() });

  document.querySelector('.diag-selfcheck')?.click();
  await wait(7000);
  out.steps.push({ step: '诊断自检', ...snapshot() });

  const openedBadge = Array.from(document.querySelectorAll('.device-row'))
    .filter((row) => (row.textContent ?? '').includes('0A67'))
    .map((row) => row.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  out.targetRows = openedBadge;

  // 取证用：把诊断卡展开并滚到视口中央，截图里能直接读到失败链路
  const details = document.querySelector('.diag-details');
  if (details) details.open = true;
  document.querySelector('.diag-log')?.scrollIntoView({ block: 'center' });
  return JSON.stringify(out);
})()
