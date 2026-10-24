// 诊断卡取证（J2/J3/J6）：连接虚拟设备 → 注入两条 CRC 错回执 → 展开诊断卡读统计与日志。
//   electron.exe . --screenshot=artifacts/v1.1.0-diag-crc.png --exec-file=scripts/probes/device-diag-open.js --no-sandbox
// 注意：不展开诊断卡的那张（J6 默认折叠）用 device-diag-closed.js。
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

  // 注入（J3）：参数协议读应答（Func 0x12 = 18，电平轮询走这条）前两条把 CRC 清零
  const injected = await fetch('http://127.0.0.1:8766/control/faults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ faults: [{ on: { mode: 'app', func: 18 }, action: 'crcError', times: 2 }] }),
  })
    .then((res) => res.json())
    .catch((error) => ({ error: String(error) }));
  await wait(400);

  // 一次写操作（J2）：回工作台拖一个快速旋钮 → store → Transport.write → 帧 + ACK 进日志。
  // 放在注入之后：诊断环形缓冲只留最近 200 条，50 Hz 轮询会把更早的条目录挤出去。
  go('console');
  await wait(250);
  const slider = document.querySelector('.macro-range') ?? document.querySelector('input[type="range"]');
  if (slider) {
    slider.value = String(Math.min(Number(slider.max), Number(slider.value) + 10));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await wait(250);

  go('device');
  await wait(250);
  const details = document.querySelector('.diag-details');
  if (details) details.open = true;
  await wait(300);

  // J4：点一次复制，拿到导出文本的前几行（剪贴板不可用时走只读 textarea 回落）
  document.querySelector('.diag-copy')?.click();
  await wait(400);
  const fallback = document.querySelector('.diag-fallback-text');
  const copied = fallback ? fallback.value : null;
  const copyStatus = document.querySelector('.diag-status')?.textContent ?? null;

  // 截图对准"标红"的那两条（R8-2）；统计数字在返回的 JSON 里
  const firstError = document.querySelector('.diag-log-row.is-error');
  if (firstError) firstError.scrollIntoView({ block: 'center' });
  await wait(400);

  const stats = {};
  for (const node of document.querySelectorAll('[data-stat]')) {
    stats[node.dataset.stat] = node.textContent;
  }
  const rows = Array.from(document.querySelectorAll('.diag-log-row')).map((node) => ({
    text: node.textContent,
    error: node.classList.contains('is-error'),
  }));
  const writes = rows.filter((row) => row.text.includes('写 ')).slice(-2);
  const errors = rows.filter((row) => row.error).slice(-3);
  return JSON.stringify({
    attached,
    injected,
    stats,
    writes,
    errors,
    logRows: rows.length,
    copyStatus,
    copyText: copied === null ? null : copied.split('\n').slice(0, 6).join(' | '),
  });
})()
