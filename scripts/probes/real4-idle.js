// 第四轮真机联调 · 空闲稳定性与重连：连接后静置 60 s（看门狗/心跳），再关闭并重新打开设备。
//   electron.exe . --screenshot=artifacts\real4\idle.png --route=device --exec-file=scripts\probes\real4-idle.js --no-sandbox
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  const stat = (name) => clean(document.querySelector(`[data-stat="${name}"]`));
  const stats = () => ({
    out: Number(stat('out') ?? NaN),
    in: Number(stat('in') ?? NaN),
    crc: Number(stat('crc') ?? NaN),
    timeout: Number(stat('timeout') ?? NaN),
    retry: Number(stat('retry') ?? NaN),
    dropped: Number(stat('dropped') ?? NaN),
    queue: Number(stat('queue') ?? NaN),
  });
  const pill = () => ({ source: clean(document.querySelector('#source-pill')), sync: clean(document.querySelector('#sync-pill')) });

  const out = { checks: [] };
  window.__micstudioGo('device');
  await wait(300);
  document.querySelector('.segmented .seg-btn[data-value="native"]')?.click();
  await wait(200);
  document.querySelector('.device-actions .btn')?.click();
  await wait(1600);
  const row = () => Array.from(document.querySelectorAll('.device-row')).find((item) => (item.textContent ?? '').includes('0A67'));
  if (!row()) return JSON.stringify({ error: '设备列表里没有 0A67' });
  row().querySelector('.btn')?.click();
  await wait(5200);
  out.connected = { ...pill(), stats: stats() };

  const started = Date.now();
  for (let index = 0; index < 6; index += 1) {
    await wait(10000);
    out.checks.push({ atSec: Math.round((Date.now() - started) / 1000), ...pill(), stats: stats() });
  }
  out.idleTail = Array.from(document.querySelectorAll('.diag-log-row')).map((node) => clean(node)).slice(-8);

  // 关闭 → 重新打开（等价于重连，不需要物理拔插）
  row()?.querySelector('.btn')?.click();
  await wait(1500);
  out.afterClose = { ...pill(), stats: stats() };
  row()?.querySelector('.btn')?.click();
  await wait(5200);
  out.afterReopen = { ...pill(), stats: stats(), rowText: clean(document.querySelector('.device-row')) };
  document.querySelector('.diag-selfcheck')?.click();
  await wait(6200);
  out.selfCheck = Array.from(document.querySelectorAll('.diag-selfcheck-steps > *')).map((node) => clean(node));
  out.final = { ...pill(), stats: stats() };
  return JSON.stringify(out);
})()
