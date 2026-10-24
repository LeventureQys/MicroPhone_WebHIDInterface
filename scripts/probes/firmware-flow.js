// 固件升级全流程取证：起虚拟下位机 + 本仓 `artifacts/vdevice` 上的 8799 静态服务后运行
//   electron.exe . --screenshot=artifacts/v1.1.0-fw-success.png --exec-file=scripts/probes/firmware-flow.js --no-sandbox
// 流程：连接虚拟设备 → 打开设备 → 打开固件抽屉 → 选包（fetch 8799/app.bin）→ 勾确认 → 开始 → 等终点
//       → 切到设备页读诊断日志 → 切回固件页 → 截图。返回的 JSON 会被主进程打到 stdout（[probe] 行）。
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

  const result = { stage: 'boot', preflight: null, final: null, logs: [] };

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
  result.stage = 'attached';

  const firmwareBtn = await until(() => document.querySelector('.fw-open'), 5000);
  firmwareBtn.click();
  const fileInput = await until(() => document.querySelector('input[type="file"]'), 5000);
  if (!fileInput) return JSON.stringify({ error: 'firmware panel missing' });

  const response = await fetch('http://127.0.0.1:8799/app.bin');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], 'app.bin', { type: 'application/octet-stream' }));
  fileInput.files = transfer.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));

  const preflight = await until(() => {
    if (document.querySelector('.fw-info')?.hidden === false) return 'ok';
    if (document.querySelector('.fw-error')?.hidden === false) return 'failed';
    return null;
  }, 25000);
  result.preflight = {
    verdict: preflight,
    model: text('[data-field="model"]'),
    version: text('[data-field="version"]'),
    length: text('[data-field="length"]'),
    blocks: text('[data-field="blocks"]'),
    checksum: text('[data-field="checksum"]'),
    error: text('.fw-error-title'),
    detail: text('.fw-error-detail'),
  };
  result.stage = 'preflight';
  if (preflight !== 'ok') {
    result.final = { phase: text('.fw-phase'), error: text('.fw-error-title'), detail: text('.fw-error-detail') };
    return JSON.stringify(result);
  }

  const confirm = document.querySelector('.fw-confirm input[type="checkbox"]');
  confirm.checked = true;
  confirm.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('.fw-start').click();
  result.stage = 'started';

  // 进度采样：块序号回退 = 整轮重来（round++），这是"重来而非补发"的界面侧证据
  const trace = { maxBlock: 0, restarts: 0, firstRestart: null, lastBlock: 0 };
  const sampler = setInterval(() => {
    const match = /(\d+)\/(\d+)/.exec(document.querySelector('.fw-block')?.textContent ?? '');
    if (!match) return;
    const index = Number(match[1]);
    if (index < trace.lastBlock) {
      trace.restarts += 1;
      if (trace.firstRestart === null) trace.firstRestart = { from: trace.lastBlock, to: index };
    }
    trace.lastBlock = index;
    if (index > trace.maxBlock) trace.maxBlock = index;
  }, 50);

  const final = await until(() => {
    if (document.querySelector('.fw-result')?.hidden === false) return 'done';
    if (document.querySelector('.fw-error')?.hidden === false && document.querySelector('.fw-progress')?.hidden === false) {
      return 'failed';
    }
    return null;
  }, 120000, 200);
  result.final = {
    verdict: final,
    phase: text('.fw-phase'),
    percent: text('.fw-percent'),
    block: text('.fw-block'),
    done: text('.fw-done'),
    error: text('.fw-error-title'),
    detail: text('.fw-error-detail'),
  };
  clearInterval(sampler);
  result.blockTrace = trace;
  result.stage = 'final';

  // 设备侧取证：趁收尾窗内的帧还在侧车环形缓冲里，抓一次控制面日志（信息帧数 = 轮数证据）
  const deviceLog = await fetch('http://127.0.0.1:8766/control/log')
    .then((res) => res.json())
    .catch(() => null);
  if (Array.isArray(deviceLog)) {
    const info = deviceLog.filter((entry) => typeof entry.hex === 'string' && entry.hex.startsWith('C4 5A'));
    const blocks = deviceLog.filter((entry) => typeof entry.hex === 'string' && entry.hex.startsWith('C4 09 01'));
    result.deviceLog = {
      entries: deviceLog.length,
      infoFrames: info.length,
      blockFrames: blocks.length,
      lastInfoAt: info.length > 0 ? info[info.length - 1].at : null,
    };
  }

  // 诊断日志：切到设备页展开诊断卡读日志，再切回固件页（控制器状态在 main，切面板不丢）
  go('device');
  await until(() => document.querySelector('.diag-details'), 5000);
  const details = document.querySelector('.diag-details');
  if (details) details.open = true;
  await wait(300);
  const allRows = Array.from(document.querySelectorAll('.diag-log-row')).map((node) => node.textContent);
  result.logCount = allRows.length;
  result.logSample = allRows.slice(-3);
  result.logEmpty = document.querySelector('.diag-log-empty') !== null;
  result.logs = allRows.filter((line) => line.includes('DFU') || line.includes('轮') || line.includes('EnterDfu')).slice(-14);
  result.stats = {
    crc: text('[data-stat="crc"]'),
    out: text('[data-stat="out"]'),
    timeouts: text('[data-stat="timeout"]'),
  };
  go('firmware');
  await wait(400);
  return JSON.stringify(result);
})()
