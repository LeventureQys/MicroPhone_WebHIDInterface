// 第六轮真机联调 · 场景与业务控件：四个一键场景逐个点，再用「降噪强度 / 声音平稳 / 音色风格」
// 三个业务控件各改一次，最后断开连接，由 real6-read.py 回读核对。
//   electron.exe . --screenshot=artifacts\real6\scenes.png --route=console --exec-file=scripts\probes\real6-scenes.js --no-sandbox
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  const pill = () => ({ source: clean(document.querySelector('#source-pill')), sync: clean(document.querySelector('#sync-pill')) });
  const notice = () => (document.querySelector('.console-notice')?.hidden ? null : clean(document.querySelector('.console-notice')));
  const activeScene = () => clean(document.querySelector('.scene-btn[aria-pressed="true"]')) ?? null;
  const activeTone = () => clean(document.querySelector('.tone-chip[aria-pressed="true"]')) ?? null;
  const macroValue = (name) => Number(document.querySelector(`[data-macro="${name}"] input[type="range"]`)?.value ?? NaN);

  const out = { scenes: [], controls: null };
  window.__micstudioGo('device');
  await wait(300);
  document.querySelector('.segmented .seg-btn[data-value="native"]')?.click();
  await wait(200);
  document.querySelector('.device-actions .btn')?.click();
  await wait(1600);
  const target = Array.from(document.querySelectorAll('.device-row')).find((row) => (row.textContent ?? '').includes('0A67'));
  if (!target) return JSON.stringify({ ...out, error: '设备列表里没有 0A67' });
  target.querySelector('.btn')?.click();
  await wait(5600);
  document.querySelector('.modal-close')?.click();
  await wait(500);
  out.connected = { ...pill(), notice: notice() };

  for (const scene of ['meeting', 'podcast', 'sing', 'quiet']) {
    document.querySelector(`.scene-btn[data-scene="${scene}"]`)?.click();
    await wait(1600);
    out.scenes.push({
      scene,
      ...pill(),
      notice: notice(),
      activeScene: activeScene(),
      activeTone: activeTone(),
      denoise: macroValue('denoise'),
      evenness: macroValue('evenness'),
    });
    await wait(300);
  }

  // 业务控件：降噪强度 80 / 声音平稳 40 / 音色 bright
  const denoise = document.querySelector('[data-macro="denoise"] input[type="range"]');
  const evenness = document.querySelector('[data-macro="evenness"] input[type="range"]');
  denoise.value = '80';
  denoise.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(900);
  evenness.value = '40';
  evenness.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(900);
  document.querySelector('.tone-chip[data-tone="bright"]')?.click();
  await wait(1600);
  out.controls = {
    ...pill(),
    notice: notice(),
    activeScene: activeScene(),
    activeTone: activeTone(),
    denoise: macroValue('denoise'),
    evenness: macroValue('evenness'),
  };

  // 断开，让裸 HID 回读
  window.__micstudioGo('device');
  await wait(600);
  const row = Array.from(document.querySelectorAll('.device-row')).find((item) => (item.textContent ?? '').includes('0A67'));
  row?.querySelector('.btn')?.click();
  await wait(1500);
  out.afterDisconnect = pill();
  return JSON.stringify(out);
})()
