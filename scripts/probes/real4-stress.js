// 第四轮真机联调 · 写 Flash 压测与轮询恢复：连接 → 20 次连续写（坑 27 复测）→ 统计/轮询恢复 → 自检连跑两次（坑 26 竞态）。
//   electron.exe . --screenshot=artifacts\real4\stress.png --route=device --exec-file=scripts\probes\real4-stress.js --no-sandbox
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
  const openDrawer = () => window.__micstudioGo('device');
  const closeDrawer = () => document.querySelector('.modal-close')?.click();

  const out = { samples: [], writes: [] };
  openDrawer();
  await wait(300);
  document.querySelector('.segmented .seg-btn[data-value="native"]')?.click();
  await wait(200);
  document.querySelector('.device-actions .btn')?.click();
  await wait(1600);
  const target = Array.from(document.querySelectorAll('.device-row')).find((row) => (row.textContent ?? '').includes('0A67'));
  if (!target) return JSON.stringify({ error: '设备列表里没有 0A67' });
  target.querySelector('.btn')?.click();
  await wait(5200);
  out.afterConnect = { ...pill(), stats: stats() };

  closeDrawer();
  await wait(500);
  out.beforeStress = { ...pill(), stats: null };

  const range = document.querySelector('[data-macro="denoise"] input[type="range"]');
  if (!range) return JSON.stringify({ ...out, error: '找不到降噪强度滑杆' });
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    range.value = String(index % 2 === 0 ? 55 : 45);
    range.dispatchEvent(new Event('input', { bubbles: true }));
    const updateMs = Number((performance.now() - started).toFixed(2));
    await wait(380);
    out.writes.push({ index, value: range.value, updateMs, ...pill() });
  }
  await wait(5000);
  out.afterStressPills = pill();

  // 重新打开抽屉取统计：timeouts / retries 是坑 27 的判据
  openDrawer();
  await wait(800);
  out.afterStress = { ...pill(), stats: stats() };
  out.diagTail = Array.from(document.querySelectorAll('.diag-log-row')).map((node) => clean(node)).slice(-14);

  // 轮询恢复：抽屉开着时读两次统计，间隔 2 s
  const beforeIdle = stats();
  await wait(2000);
  const afterIdle = stats();
  out.polling = { beforeIdle, afterIdle, framesOutDelta: afterIdle.out - beforeIdle.out, framesInDelta: afterIdle.in - beforeIdle.in };

  // 自检连跑两次：第一次 sync() 与在途轮询竞争（坑 26）
  const selfCheck = async () => {
    document.querySelector('.diag-selfcheck')?.click();
    await wait(6200);
    return Array.from(document.querySelectorAll('.diag-selfcheck-steps > *')).map((node) => clean(node));
  };
  out.selfCheck1 = await selfCheck();
  out.selfCheck1Stats = stats();
  out.selfCheck2 = await selfCheck();
  out.selfCheck2Stats = stats();
  closeDrawer();
  await wait(500);

  // 自检之后立刻点场景，确认不会把 sync 的收尾帧认领错
  document.querySelector('.scene-btn[data-scene="meeting"]')?.click();
  await wait(4500);
  out.afterScene = { ...pill(), notice: document.querySelector('.console-notice')?.hidden ? null : clean(document.querySelector('.console-notice')) };
  openDrawer();
  await wait(900);
  out.final = { ...pill(), stats: stats(), activeScene: Array.from(document.querySelectorAll('.scene-btn')).filter((node) => node.getAttribute('aria-pressed') === 'true').map((node) => node.dataset.scene) };
  return JSON.stringify(out);
})()
