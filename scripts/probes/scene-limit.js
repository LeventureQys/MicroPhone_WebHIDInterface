// 收尾取证：点「一键场景」后防爆音开关必须跟着亮，且不再偷偷改限幅阈值。
//   electron.exe . --screenshot=artifacts\v1.1.0-scene-limit.png --exec-file=scripts\probes\scene-limit.js --no-sandbox
(() => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return (async () => {
    const limitSwitch = () => document.querySelectorAll('.switch-grid .switch-item')[1]?.querySelector('input');
    const readSwitch = () => limitSwitch()?.checked ?? null;

    const before = readSwitch();
    document.querySelector('.scene-btn[data-scene="meeting"]')?.click();
    await wait(240);
    const after = readSwitch();
    const sceneActive = document.querySelector('.scene-btn.is-active')?.dataset.scene ?? null;

    // 手动关掉开关后场景高亮应消失；最后再点一次场景，让截图停在"开关已亮"的状态
    limitSwitch()?.click();
    await wait(200);
    const afterManualOff = {
      switch: readSwitch(),
      sceneActive: document.querySelector('.scene-btn.is-active')?.dataset.scene ?? null,
    };
    document.querySelector('.scene-btn[data-scene="meeting"]')?.click();
    await wait(240);

    return JSON.stringify({ before, after, sceneActive, afterManualOff });
  })();
})();
