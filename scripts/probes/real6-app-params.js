// 第六轮真机联调 · 应用级参数快照：连接 → 同步 → 抓 42 项显示值 / 7 段 EQ 表 / 工作台摘要。
// 输出随后由 scripts/probes/real6-compare.mjs 与裸 HID 寄存器真值逐项对账。
//   electron.exe . --screenshot=artifacts\real6\app-params.png --route=device --exec-file=scripts\probes\real6-app-params.js --no-sandbox
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
  const notice = () => (document.querySelector('.console-notice')?.hidden ? null : clean(document.querySelector('.console-notice')));

  const out = { connected: false };
  window.__micstudioGo('device');
  await wait(300);
  document.querySelector('.segmented .seg-btn[data-value="native"]')?.click();
  await wait(200);
  document.querySelector('.device-actions .btn')?.click();
  await wait(1600);

  const target = Array.from(document.querySelectorAll('.device-row')).find((row) => (row.textContent ?? '').includes('0A67'));
  if (!target) return JSON.stringify({ ...out, error: '设备列表里没有 0A67' });
  out.deviceRows = Array.from(document.querySelectorAll('.device-row')).map((row) => clean(row));
  out.deviceRowText = clean(target);
  target.querySelector('.btn')?.click();
  await wait(5600);

  out.connected = true;
  out.pills = pill();
  out.notice = notice();
  out.stats = stats();
  out.diagFields = Object.fromEntries(
    Array.from(document.querySelectorAll('[data-diag]')).map((node) => [node.dataset.diag, clean(node)]),
  );
  out.console = {
    gainValues: Array.from(document.querySelectorAll('.console-gain-value')).map((node) => clean(node)),
    deviceName: clean(document.querySelector('.console-device-name')),
    deviceState: clean(document.querySelector('.console-device-state')),
    switchItems: Array.from(document.querySelectorAll('.switch-item')).map((node) => ({
      text: clean(node.querySelector('.switch-label') ?? node),
      checked: node.querySelector('input[type="checkbox"]')?.checked ?? null,
      active: clean(node.querySelector('.seg-btn.is-active')),
    })),
    macroValues: Array.from(document.querySelectorAll('.pfield-value--macro')).map((node) => clean(node)),
  };

  // 高级参数抽屉：40 个 data-param 控件 + EQ 7 段表
  document.querySelector('.console-link')?.click();
  await wait(900);
  out.params = Array.from(document.querySelectorAll('[data-param]')).map((node) => {
    const checkbox = node.querySelector('input[type="checkbox"]');
    const active = node.querySelector('.seg-btn.is-active');
    return {
      id: node.dataset.param,
      text: clean(node.querySelector('.pfield-readout strong') ?? node.querySelector('.pfield-value')),
      unit: clean(node.querySelector('.pfield-unit')),
      checked: checkbox ? checkbox.checked : null,
      seg: active ? active.dataset.value : null,
      readonly: !!node.querySelector('.pfield-badge'),
      controls: node.querySelectorAll('input,button,select').length,
    };
  });
  out.eqRows = Array.from(document.querySelectorAll('.eq-row[data-band]')).map((row) => {
    const inputs = Array.from(row.querySelectorAll('input[type="number"]'));
    return {
      band: Number(row.dataset.band),
      type: row.querySelector('select')?.value ?? null,
      freq: inputs[0]?.value ?? null,
      gain: inputs[1]?.value ?? null,
      q: inputs[2]?.value ?? null,
    };
  });
  out.sectionTitles = Array.from(document.querySelectorAll('.advanced-section-title')).map((node) => clean(node));

  document.querySelector('.modal-close')?.click();
  await wait(400);
  out.final = { ...pill(), notice: notice(), stats: stats() };
  return JSON.stringify(out);
})()
