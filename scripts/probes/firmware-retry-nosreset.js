// P0 验收：statusFail 失败后**不做任何 reset**，直接点界面上的「立即重试」→ 必须成功。
//   electron.exe . --screenshot=artifacts/v1.1.0-fw-retry-nosreset.png --exec-file=scripts/probes/firmware-retry-nosreset.js --no-sandbox
// 关键点：设备此时停在 bootloader，只答 SigmaBus。EnterDfu（参数协议）注定超时，
// 重试要靠信息帧探测确认"已经在升级模式"才进 writing —— 本探针把这两段都记下来。
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
  const diagLines = () =>
    Array.from(document.querySelectorAll('.diag-log-row'))
      .map((node) => node.textContent)
      .filter((line) => line.includes('EnterDfu') || line.includes('DFU') || line.includes('超时'));

  const result = { stage: 'boot', first: null, retry: null, wired: null };

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

  // 第一段：第 5 块回 0x04 → statusFail
  const failed = await until(() => (document.querySelector('.fw-error')?.hidden === false ? true : null), 60000);
  result.first = {
    verdict: failed === true ? 'failed' : null,
    block: text('.fw-block'),
    error: text('.fw-error-title'),
    confirmedStillOn: document.querySelector('.fw-confirm input[type="checkbox"]')?.checked ?? null,
  };
  result.stage = 'failed';

  // **刻意不 reset**：不碰 /control/reset，也不碰故障表；直接点界面按钮
  const retry = await until(() => {
    const button = document.querySelector('.fw-retry');
    return button !== null && button.hidden === false ? button : null;
  }, 5000);
  if (retry === null) return JSON.stringify({ ...result, error: 'retry button missing' });
  // 重试开始的时间点：只认这之后的新帧，才分得清"重试的时序"和上一轮的尾巴
  const t0 = Date.now();
  retry.click();
  result.stage = 'retried';

  // 抓到"进入 → 探测 → 首块"这几帧就停，别等轮询把环形缓冲刷满
  const interesting = (entries) =>
    entries
      .filter(
        (entry) =>
          typeof entry.hex === 'string' &&
          (entry.hex.startsWith('00 10 00 0A') || entry.hex.startsWith('C4 5A') || entry.hex.startsWith('C4 0A')),
      )
      .map((entry) => `${entry.dir === 'in' ? '主机→设备' : '设备→主机'} ${entry.hex.slice(0, 26)}`);

  // 块序号采样：重试这一轮应当一路向前（restarts 应为 0，不是整轮重来）
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

  const wireDeadline = Date.now() + 30000;
  while (Date.now() < wireDeadline) {
    const log = await fetch('http://127.0.0.1:8766/control/log')
      .then((res) => res.json())
      .catch(() => null);
    if (Array.isArray(log)) {
      const fresh = interesting(log.filter((entry) => entry.at >= t0));
      if (fresh.length >= 4) {
        result.retryWire = fresh.slice(0, 10);
        break;
      }
    }
    await wait(120);
  }

  const done = await until(() => (document.querySelector('.fw-result')?.hidden === false ? true : null), 150000);
  clearInterval(sampler);
  result.retryBlockTrace = trace;
  await wait(400);
  result.retry = {
    verdict: done === true ? 'done' : null,
    phase: text('.fw-phase'),
    percent: text('.fw-percent'),
    block: text('.fw-block'),
    done: text('.fw-done'),
    error: document.querySelector('.fw-error')?.hidden === false ? text('.fw-error-title') : null,
  };
  result.stage = 'final';

  // 主机侧诊断：切到设备页展开诊断卡，抓 EnterDfu 超时与信息帧那几行
  go('device');
  await until(() => document.querySelector('.diag-details'), 5000);
  const details = document.querySelector('.diag-details');
  if (details) details.open = true;
  await wait(300);
  result.hostDiag = diagLines().slice(-10);

  // 设备侧：重试后到底是"信息帧先到"还是"EnterDfu 成功"
  const deviceLog = await fetch('http://127.0.0.1:8766/control/log')
    .then((res) => res.json())
    .catch(() => null);
  if (Array.isArray(deviceLog)) {
    const interesting = deviceLog.filter(
      (entry) =>
        typeof entry.hex === 'string' &&
        (entry.hex.startsWith('00 10 00 0A') || entry.hex.startsWith('C4 5A') || entry.hex.startsWith('C4 0A')),
    );
    result.wired = {
      enterDfuFrames: interesting.filter((entry) => entry.hex.startsWith('00 10 00 0A')).length,
      infoFrames: interesting.filter((entry) => entry.hex.startsWith('C4 5A')).length,
      statusFrames: interesting.filter((entry) => entry.hex.startsWith('C4 0A')).length,
      tail: interesting.slice(-6).map((entry) => `${entry.dir} ${entry.hex.slice(0, 26)}`),
    };
  }
  go('firmware');
  await wait(400);
  return JSON.stringify(result);
})()
