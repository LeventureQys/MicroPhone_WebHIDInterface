// 第四轮真机联调 · 应用级全流程：连接 → 同步 → 高级参数只读核对 → 场景写入 → 开关/档位 → 连续写压测（坑 27 复测）。
//   electron.exe . --screenshot=artifacts\real4\app-flow.png --route=device --exec-file=scripts\probes\real4-app-flow.js --no-sandbox
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  const pill = () => ({ source: clean(document.querySelector('#source-pill')), sync: clean(document.querySelector('#sync-pill')) });
  const stat = (name) => clean(document.querySelector(`[data-stat="${name}"]`));
  const stats = () => ({
    out: stat('out'),
    in: stat('in'),
    crc: stat('crc'),
    timeout: stat('timeout'),
    retry: stat('retry'),
    dropped: stat('dropped'),
    queue: stat('queue'),
  });
  const notice = () => (document.querySelector('.console-notice')?.hidden ? null : clean(document.querySelector('.console-notice')));

  const out = { stages: [] };
  const stage = (name, extra = {}) => out.stages.push({ name, at: new Date().toISOString().slice(11, 23), ...pill(), stats: stats(), notice: notice(), ...extra });

  window.__micstudioGo('device');
  await wait(300);
  document.querySelector('.segmented .seg-btn[data-value="native"]')?.click();
  await wait(200);
  document.querySelector('.device-actions .btn')?.click();
  await wait(1600);
  const target = Array.from(document.querySelectorAll('.device-row')).find((row) => (row.textContent ?? '').includes('0A67'));
  if (!target) return JSON.stringify({ ...out, error: '设备列表里没有 0A67' });
  out.deviceRowText = clean(target);
  target.querySelector('.btn')?.click();
  await wait(5200);
  stage('已连接（等待参数同步）', {
    gainValues: Array.from(document.querySelectorAll('.console-gain-value')).map((node) => clean(node)),
    deviceName: clean(document.querySelector('.console-device-name')),
    deviceState: clean(document.querySelector('.console-device-state')),
  });

  // 高级参数抽屉：只读项核对 + 42 项是否齐
  document.querySelector('.modal-close')?.click();
  await wait(300);
  document.querySelector('.console-link')?.click();
  await wait(700);
  const fields = Array.from(document.querySelectorAll('[data-param]'));
  out.advanced = {
    count: fields.length,
    ids: fields.map((node) => node.dataset.param),
    readonly: fields
      .filter((node) => node.querySelector('.pfield-badge'))
      .map((node) => ({ id: node.dataset.param, controls: node.querySelectorAll('input,button,select').length, text: clean(node) })),
    encLevelText: clean(document.querySelector('[data-param="enc.Level"] .pfield-value')),
    gateThresholdText: clean(document.querySelector('[data-param="noisegate.threshold_db"] .pfield-value')),
    compThresholdText: clean(document.querySelector('[data-param="comp.Threshold"] .pfield-value')),
    limitEnableText: clean(document.querySelector('[data-param="limit.Enable"]')),
  };
  stage('高级参数已展开');

  document.querySelector('.modal-close')?.click();
  await wait(400);

  // 一键场景
  document.querySelector('.scene-btn[data-scene="podcast"]')?.click();
  await wait(4200);
  stage('点击「播客」场景后', {
    activeScene: Array.from(document.querySelectorAll('.scene-btn')).filter((node) => node.getAttribute('aria-pressed') === 'true').map((node) => node.dataset.scene),
    activeTone: Array.from(document.querySelectorAll('.tone-chip')).filter((node) => node.getAttribute('aria-pressed') === 'true').map((node) => node.dataset.tone),
    gainValues: Array.from(document.querySelectorAll('.console-gain-value')).map((node) => clean(node)),
  });

  // 环境降噪开关 + 档位
  const encSwitch = document.querySelector('.switch-item input[type="checkbox"]');
  if (encSwitch) {
    encSwitch.click();
    await wait(1600);
  }
  stage('切换环境降噪开关', { encSwitchChecked: encSwitch?.checked ?? null });
  document.querySelector('.switch-item .seg-btn[data-value="3"]')?.click();
  await wait(1600);
  stage('切到降噪档位 3', { activeLevel: clean(document.querySelector('.switch-item .seg-btn.is-active')) });

  // 连续写压测：快速拖「降噪强度」16 次，观察是否被写 Flash 卡死/误判断连
  const range = document.querySelector('[data-macro="denoise"] input[type="range"]');
  out.stress = { writes: 0, samples: [] };
  if (range) {
    for (let index = 0; index < 16; index += 1) {
      range.value = String(index % 2 === 0 ? 55 : 45);
      range.dispatchEvent(new Event('input', { bubbles: true }));
      out.stress.writes += 1;
      await wait(520);
      if (index % 4 === 3) out.stress.samples.push({ index, ...pill(), stats: stats() });
    }
  }
  await wait(2500);
  stage('连续写 16 次后');
  out.stress.final = stats();
  out.stress.pills = pill();

  // 静置 6 s 看轮询是否恢复、设备是否掉线
  const before = Number(stat('out') ?? 0);
  await wait(6000);
  stage('静置 6 s 后', { framesOutDelta: Number(stat('out') ?? 0) - before });

  out.runtimeErrors = out.runtimeErrors ?? [];
  return JSON.stringify(out);
})()
