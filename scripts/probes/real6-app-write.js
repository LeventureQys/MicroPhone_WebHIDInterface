// 第六轮真机联调 · 逐项写入：连上真机后把 42 项参数各改一次（走真实 DOM 控件），
// 记录「改前/改后」，断开连接后由 real6-verify-writes.js 用裸 HID 回读核对。
//   electron.exe . --screenshot=artifacts\real6\app-write.png --route=device --exec-file=scripts\probes\real6-app-write.js --no-sandbox
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  const stat = (name) => Number(clean(document.querySelector(`[data-stat="${name}"]`)) ?? NaN);
  const stats = () => ({ out: stat('out'), in: stat('in'), crc: stat('crc'), timeout: stat('timeout'), retry: stat('retry') });
  const pill = () => ({ source: clean(document.querySelector('#source-pill')), sync: clean(document.querySelector('#sync-pill')) });
  const notice = () => (document.querySelector('.console-notice')?.hidden ? null : clean(document.querySelector('.console-notice')));

  const ADDR = {
    'gain.Mic': 0x2023, 'gain.Hp': 0x205a, 'mic.mute': 0x2022, 'mic.sigMute': 0x2058, 'hp.OnOff': 0x2059,
    'enc.OnOff': 0x2024, 'enc.Level': 0x2025, 'eq.mode': 0x2026,
    'comp.Enable': 0x204a, 'comp.MakeUpGain': 0x204b, 'comp.Threshold': 0x204c, 'comp.Attack': 0x204d,
    'comp.Release': 0x204e, 'comp.Rate': 0x204f, 'comp.KneeWidth': 0x2050,
    'limit.Enable': 0x2051, 'limit.Threshold': 0x2053, 'limit.Attack': 0x2054, 'limit.Release': 0x2055,
    'noisegate.threshold_db': 0x205b, 'noisegate.ratio': 0x205c, 'noisegate.attack_ms': 0x205d,
    'noisegate.release_ms': 0x205e, 'noisegate.knee_width_db': 0x205f, 'noisegate.hp_freq': 0x2060,
    'drc3.fc1': 0x2061, 'drc3.fc2': 0x2062,
    'drc3.low.preGain': 0x2063, 'drc3.low.threshold': 0x2064, 'drc3.low.attackTime': 0x2065,
    'drc3.low.releaseTime': 0x2066, 'drc3.low.ratio': 0x2067,
    'drc3.high.preGain': 0x2068, 'drc3.high.threshold': 0x2069, 'drc3.high.attackTime': 0x206a,
    'drc3.high.releaseTime': 0x206b, 'drc3.high.ratio': 0x206c,
    'drc3.mid.preGain': 0x206d, 'drc3.mid.threshold': 0x206e, 'drc3.mid.attackTime': 0x206f,
    'drc3.mid.releaseTime': 0x2070, 'drc3.mid.ratio': 0x2071,
  };

  const out = { writes: [], readOnly: [], errors: [] };
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
  out.connected = { ...pill(), stats: stats() };

  // 工作台里的环境降噪开关 + 档位（这两项在抽屉里没有 data-param）
  const encSwitch = document.querySelector('.switch-item input[type="checkbox"]');
  if (encSwitch) {
    const before = stats().out;
    encSwitch.click();
    await wait(700);
    out.writes.push({ id: 'enc.OnOff', addr: '0x2024', from: encSwitch.checked ? 0 : 1, to: encSwitch.checked ? 1 : 0, control: 'switch', framesOut: stats().out - before });
    await wait(200);
  }
  const encLevels = Array.from(document.querySelectorAll('.switch-item .seg-btn'));
  const currentLevel = encLevels.find((node) => node.classList.contains('is-active'))?.dataset.value;
  const nextLevel = encLevels.find((node) => node.dataset.value !== currentLevel);
  if (nextLevel) {
    const before = stats().out;
    nextLevel.click();
    await wait(700);
    out.writes.push({ id: 'enc.Level', addr: '0x2025', from: Number(currentLevel), to: Number(nextLevel.dataset.value), control: 'segmented', framesOut: stats().out - before });
    await wait(200);
  }

  // 抽屉里的 40 项
  document.querySelector('.console-link')?.click();
  await wait(900);
  const nodes = Array.from(document.querySelectorAll('[data-param]'));
  out.paramCount = nodes.length;

  for (const node of nodes) {
    const id = node.dataset.param;
    const addr = `0x${(ADDR[id] ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
    const checkbox = node.querySelector('input[type="checkbox"]');
    if (checkbox) {
      const before = stats().out;
      const from = checkbox.checked ? 1 : 0;
      checkbox.click();
      await wait(700);
      out.writes.push({ id, addr, from, to: checkbox.checked ? 1 : 0, control: 'switch', framesOut: stats().out - before });
      await wait(150);
      continue;
    }
    const activeBtn = node.querySelector('.seg-btn.is-active');
    if (activeBtn) {
      const buttons = Array.from(node.querySelectorAll('.seg-btn'));
      const next = buttons.find((btn) => btn !== activeBtn);
      const before = stats().out;
      next?.click();
      await wait(700);
      out.writes.push({ id, addr, from: Number(activeBtn.dataset.value), to: Number(next?.dataset.value), control: 'segmented', framesOut: stats().out - before });
      await wait(150);
      continue;
    }
    const number = node.querySelector('input[type="number"]');
    if (!number) {
      out.readOnly.push({ id, addr, text: clean(node), controls: node.querySelectorAll('input,button,select').length });
      continue;
    }
    const min = Number(number.min);
    const max = Number(number.max);
    const step = Number(number.step) || 1;
    const current = Number(number.value);
    // 取区间内与当前值差得最远的合法点，保证回读可区分
    let target = Math.abs(current - min) > Math.abs(max - current) ? min : max;
    if (target === current) target = Math.abs(current - max) < Math.abs(min - current) ? min : max;
    target = Number(target.toFixed(4));
    const before = stats().out;
    number.value = String(target);
    number.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(700);
    const after = Number(node.querySelector('input[type="number"]')?.value);
    out.writes.push({ id, addr, from: current, to: after, requested: target, control: 'number', framesOut: stats().out - before, step });
    await wait(150);
  }

  out.afterWrites = { ...pill(), notice: notice(), stats: stats() };
  out.writeCount = out.writes.length;

  // 断开连接，把设备让给裸 HID 回读探针
  document.querySelector('.modal-close')?.click();
  await wait(300);
  window.__micstudioGo('device');
  await wait(400);
  const row = Array.from(document.querySelectorAll('.device-row')).find((item) => (item.textContent ?? '').includes('0A67'));
  row?.querySelector('.btn')?.click();
  await wait(1500);
  out.afterDisconnect = { ...pill(), stats: stats() };
  return JSON.stringify(out);
})()
