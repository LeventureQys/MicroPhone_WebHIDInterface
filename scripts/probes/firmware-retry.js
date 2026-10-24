// R6-7 重试用例：第 5 块回 0x04 → 界面「设备校验固件失败…可立即重试」→ 清故障 → 点「立即重试」→ 同包跑完。
//   electron.exe . --screenshot=artifacts/v1.1.0-fw-statusfail-retry.png --exec-file=scripts/probes/firmware-retry.js --no-sandbox
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (fn, timeoutMs = 30000, step = 100) => {
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
  const result = { stage: 'boot', first: null, reset: null, second: null };

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
  result.stage = 'started';

  // 第一段：第 5 块回 0x04 → statusFail 分支（不是歧义态，round 不增加）
  const failed = await until(
    () => (document.querySelector('.fw-error')?.hidden === false ? true : null),
    60000,
  );
  result.first = {
    verdict: failed === true ? 'failed' : null,
    phase: text('.fw-phase'),
    block: text('.fw-block'),
    error: text('.fw-error-title'),
    retryVisible: document.querySelector('.fw-retry')?.hidden === false,
    replugVisible: document.querySelector('.fw-replug')?.hidden === false,
  };
  result.stage = 'failed';

  // 清故障 + 设备回 App 模式，然后点「立即重试」（同一份包）
  result.reset = await fetch('http://127.0.0.1:8766/control/reset', { method: 'POST' })
    .then((res) => res.json())
    .catch((error) => ({ error: String(error) }));

  const retry = await until(() => {
    const button = document.querySelector('.fw-retry');
    return button !== null && button.hidden === false ? button : null;
  }, 5000);
  if (retry === null) return JSON.stringify({ ...result, error: 'retry button missing' });
  retry.click();
  result.stage = 'retried';

  const done = await until(
    () => (document.querySelector('.fw-result')?.hidden === false ? true : null),
    120000,
  );
  await wait(400);
  result.second = {
    verdict: done === true ? 'done' : null,
    phase: text('.fw-phase'),
    percent: text('.fw-percent'),
    block: text('.fw-block'),
    done: text('.fw-done'),
    error: document.querySelector('.fw-error')?.hidden === false ? text('.fw-error-title') : null,
  };
  result.stage = 'final';
  return JSON.stringify(result);
})()
