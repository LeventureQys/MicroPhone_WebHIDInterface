// 升级中关窗拦截取证（R6-8）：流程同上，但在 writing 阶段停住 8 s，
// 由外部（PowerShell）对 Electron 主窗口发 WM_CLOSE；主进程必须拦下并回推 `dfu-close-blocked`。
//   electron.exe . --screenshot=artifacts/v1.1.0-fw-close-blocked.png --exec-file=scripts/probes/firmware-close-wait.js --no-sandbox
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
  if (!connect) return JSON.stringify({ error: 'connect button missing' });
  connect.click();
  const openRow = await until(() => document.querySelector('.device-row .btn'), 25000);
  if (!openRow) return JSON.stringify({ error: 'no device row' });
  openRow.click();
  const attached = await until(() => {
    const value = text('[data-diag="model"]');
    return value !== null && value !== '—' ? value : null;
  }, 25000);
  if (!attached) return JSON.stringify({ error: 'link not ready' });

  document.querySelector('.fw-open').click();
  const fileInput = await until(() => document.querySelector('input[type="file"]'), 5000);
  const response = await fetch('http://127.0.0.1:8799/app.bin');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], 'app.bin', { type: 'application/octet-stream' }));
  fileInput.files = transfer.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => document.querySelector('.fw-info')?.hidden === false, 25000);

  const confirm = document.querySelector('.fw-confirm input[type="checkbox"]');
  confirm.checked = true;
  confirm.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('.fw-start').click();

  const writing = await until(() => document.querySelector('.fw-progress')?.hidden === false, 20000);
  // 留出 8 s 给外部 WM_CLOSE 与主进程回推事件，截图落在"升级中 + 已提示不能关闭"
  await wait(8000);
  const notice = {
    visible: document.querySelector('.fw-error')?.hidden === false,
    title: text('.fw-error-title'),
    detail: text('.fw-error-detail'),
  };
  return JSON.stringify({
    stage: writing === null ? 'no-progress' : 'writing',
    notice,
    phase: text('.fw-phase'),
    percent: text('.fw-percent'),
    error: text('.fw-error-title'),
    detail: text('.fw-error-detail'),
    closeDisabled: document.querySelector('.fw-close')?.disabled ?? null,
  });
})()
