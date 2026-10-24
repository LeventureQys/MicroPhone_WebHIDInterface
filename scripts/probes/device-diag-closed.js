// J6 取证：诊断卡默认折叠（R8-1/R8-4），不新增路由。
//   electron.exe . --screenshot=artifacts/v1.1.0-diag-collapsed.png --exec-file=scripts/probes/device-diag-closed.js --no-sandbox
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (fn, timeoutMs = 20000, step = 100) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = fn();
      if (value) return value;
      await wait(step);
    }
    return null;
  };
  const text = (selector) => document.querySelector(selector)?.textContent ?? null;
  const go = (panel) => window.__micstudioGo && window.__micstudioGo(panel);

  go('device');
  await wait(300);
  const connect = await until(() => document.querySelector('.device-actions .btn'), 15000);
  connect.click();
  const openRow = await until(() => document.querySelector('.device-row .btn'), 25000);
  openRow.click();
  await until(() => {
    const value = text('[data-diag="model"]');
    return value !== null && value !== '—' ? value : null;
  }, 25000);
  await wait(1200);

  const details = document.querySelector('.diag-details');
  if (details) details.scrollIntoView({ block: 'center' });
  await wait(400);
  return JSON.stringify({
    panel: 'device',
    diagCollapsed: details ? details.open === false : null,
    logRowsInDom: document.querySelectorAll('.diag-log-row').length,
    stats: {
      out: text('[data-stat="out"]'),
      in: text('[data-stat="in"]'),
    },
    selfCheckDisabled: document.querySelector('.diag-selfcheck')?.disabled ?? null,
  });
})()
