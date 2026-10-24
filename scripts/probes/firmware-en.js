// I8（英文字面）取证：切到 English 后走完整升级流程，截图落在英文固件抽屉上。
//   electron.exe . --screenshot=artifacts/v1.1.0-fw-success-en.png --exec-file=scripts/probes/firmware-en.js --no-sandbox
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

  // 切英文：设置页的语言分段 → store.setLang('en') → shell 重建顶栏与抽屉
  go('settings');
  const english = await until(
    () => Array.from(document.querySelectorAll('.seg-btn')).find((node) => node.textContent === 'English') ?? null,
    5000,
  );
  english.click();
  await wait(600);

  go('device');
  await wait(300);
  const firmwareBtn = await until(() => document.querySelector('.fw-open'), 5000);
  firmwareBtn.click();
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

  const final = await until(() => {
    if (document.querySelector('.fw-result')?.hidden === false) return 'done';
    if (document.querySelector('.fw-error')?.hidden === false && document.querySelector('.fw-progress')?.hidden === false) {
      return 'failed';
    }
    return null;
  }, 120000, 200);
  await wait(400);
  return JSON.stringify({
    lang: 'en',
    final,
    title: text('.modal-title'),
    subtitle: text('.modal-subtitle'),
    phase: text('.fw-phase'),
    block: text('.fw-block'),
    done: text('.fw-done'),
    warn: text('.fw-warn'),
    confirmLabel: text('.fw-confirm .switch-label'),
    startLabel: text('.fw-start'),
    closeLabel: text('.fw-close'),
  });
})()
