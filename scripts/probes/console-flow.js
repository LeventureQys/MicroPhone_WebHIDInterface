// 一屏工作台回归：场景 → 快速调音 → 音色 → 开关 → 高级参数抽屉 → 设置复位
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const q = (selector) => document.querySelector(selector);
  const qa = (selector) => Array.from(document.querySelectorAll(selector));
  const openAdvanced = async () => {
    q('#advanced-btn')?.click();
    await sleep(260);
  };
  const closeModal = async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await sleep(220);
  };
  const numberValue = (param) =>
    q(`.modal [data-param="${param}"] .pfield-number`)?.value ?? null;
  const eqGains = () =>
    qa('.modal .eq-row:not(.eq-row--head)').map(
      (row) => row.querySelectorAll('.eq-input')[1]?.value ?? null,
    );

  // 1) 一键场景
  q('.scene-btn[data-scene="meeting"]')?.click();
  await sleep(220);
  const sceneActive = q('.scene-btn.is-active')?.dataset.scene ?? null;

  await openAdvanced();
  const scenePatch = {
    threshold: numberValue('noisegate.threshold_db'),
    comp: numberValue('comp.Threshold'),
    encOn: q('.modal .switch-row input')?.checked ?? null,
    limit: numberValue('limit.Threshold'),
    gains: eqGains(),
    sections: qa('.advanced-section').length,
    eqRows: qa('.modal .eq-row:not(.eq-row--head)').length,
  };
  await closeModal();
  const modalClosed = !q('.modal');

  // 2) 降噪强度改一次，场景高亮应消失
  const macro = q('[data-macro="denoise"] .macro-range');
  macro.value = '60';
  macro.dispatchEvent(new Event('input'));
  await sleep(200);
  const sceneAfterTweak = q('.scene-btn.is-active')?.dataset.scene ?? null;

  // 3) 音色风格
  q('.tone-chip[data-tone="warm"]')?.click();
  await sleep(200);
  const toneActive = q('.tone-chip.is-active')?.dataset.tone ?? null;
  await openAdvanced();
  const warmGains = eqGains();
  const thresholdAfterTweak = numberValue('noisegate.threshold_db');
  await closeModal();

  // 4) 快捷开关
  const encSwitch = qa('.switch-grid .switch-item')[0]?.querySelector('input');
  encSwitch?.click();
  q('.segmented--compact .seg-btn[data-value="2"]')?.click();
  await sleep(160);
  const encState = {
    on: qa('.switch-grid .switch-item')[0]?.querySelector('input')?.checked ?? null,
    level: q('.segmented--compact .seg-btn.is-active')?.dataset.value ?? null,
  };

  const limitSwitch = qa('.switch-grid .switch-item')[1]?.querySelector('input');
  limitSwitch?.click();
  await sleep(160);
  await openAdvanced();
  const limitAfterOff = numberValue('limit.Threshold');
  await closeModal();
  limitSwitch?.click();
  await sleep(120);

  // 5) 设置抽屉与两次确认复位
  q('#settings-btn')?.click();
  await sleep(260);
  const settingsModal = !!q('.modal .panel-grid');
  const reset = q('.modal .btn--ghost');
  reset?.click();
  await sleep(60);
  const resetArmed = reset?.textContent ?? null;
  reset?.click();
  await sleep(200);
  const resetDone = reset?.textContent ?? null;
  await closeModal();

  // 6) 设备抽屉
  q('#connect-btn')?.click();
  await sleep(260);
  const deviceModal = !!q('.modal .device-layout');
  await closeModal();

  // 7) 复位后场景与音色都不再高亮
  const sceneAfterReset = q('.scene-btn.is-active')?.dataset.scene ?? null;
  const toneAfterReset = q('.tone-chip.is-active')?.dataset.tone ?? null;

  return JSON.stringify({
    sceneActive,
    scenePatch,
    modalClosed,
    sceneAfterTweak,
    thresholdAfterTweak,
    toneActive,
    warmGains,
    encState,
    limitAfterOff,
    settingsModal,
    resetArmed,
    resetDone,
    deviceModal,
    sceneAfterReset,
    toneAfterReset,
  });
})();
