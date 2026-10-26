// 第二轮真机联调 · 应用级写链路：拉真实通道 → 打开设备 → 关抽屉点「播客」场景 → 用原始 HID 读回验证落值。
//   electron.exe . --screenshot=artifacts\real2\app-write.png --route=console --exec-file=scripts\probes\real2-app-write.js --no-sandbox
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  const hex = (value, digits) => Number(value).toString(16).toUpperCase().padStart(digits, '0');

  function crc16(bytes) {
    let crc = 0xffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    return crc & 0xffff;
  }
  function encodeFrame(func, data) {
    const len = data.length + 6;
    const frame = new Uint8Array(len);
    frame[0] = 0;
    frame[1] = func;
    frame[2] = (len >>> 8) & 0xff;
    frame[3] = len & 0xff;
    frame.set(data, 4);
    const crc = crc16(frame.subarray(0, len - 2));
    frame[len - 2] = crc & 0xff;
    frame[len - 1] = (crc >>> 8) & 0xff;
    return frame;
  }
  function splitFrame(bytes) {
    const reports = [];
    for (let offset = 0; offset < bytes.length; offset += 63) {
      const report = new Uint8Array(63);
      report.set(bytes.subarray(offset, Math.min(offset + 63, bytes.length)));
      reports.push(report);
    }
    return reports;
  }
  function decodeStream(buffer) {
    const frames = [];
    let offset = 0;
    while (offset < buffer.length) {
      while (offset + 1 < buffer.length && buffer[offset] === 0x00 && buffer[offset + 1] === 0x00) offset += 1;
      if (buffer.length - offset < 4) break;
      const len = (buffer[offset + 2] << 8) | buffer[offset + 3];
      if (len < 6 || len > 512) {
        offset += 1;
        continue;
      }
      if (len > buffer.length - offset) break;
      const expected = crc16(buffer.subarray(offset, offset + len - 2));
      const received = buffer[offset + len - 2] | (buffer[offset + len - 1] << 8);
      if (expected !== received) {
        offset += 1;
        continue;
      }
      frames.push({ func: buffer[offset + 1], len, data: buffer.slice(offset + 4, offset + len - 2) });
      offset += len;
    }
    return frames;
  }

  const out = { steps: [] };
  const snapshot = () => ({
    sourcePill: clean(document.querySelector('#source-pill')),
    syncPill: clean(document.querySelector('#sync-pill')),
    sceneActive: Array.from(document.querySelectorAll('.scene-btn'))
      .filter((node) => node.getAttribute('aria-pressed') === 'true')
      .map((node) => node.dataset.scene),
    toneActive: Array.from(document.querySelectorAll('.tone-chip'))
      .filter((node) => node.getAttribute('aria-pressed') === 'true')
      .map((node) => node.dataset.tone),
    notice: clean(document.querySelector('.console-notice')),
  });

  // 1) 设备抽屉：切真实通道 → 连接 → 打开 0A67
  window.__micstudioGo('device');
  await wait(300);
  document.querySelector('.segmented .seg-btn[data-value="native"]')?.click();
  await wait(200);
  document.querySelector('.device-actions .btn')?.click();
  await wait(1500);
  const target = Array.from(document.querySelectorAll('.device-row')).find((row) => (row.textContent ?? '').includes('0A67'));
  if (!target) return JSON.stringify({ ...out, error: '设备列表里没有 0A67' });
  target.querySelector('.btn')?.click();
  await wait(4000);
  out.steps.push({ step: '打开设备', ...snapshot() });

  // 2) 关抽屉 → 点「播客」场景（5 个协议字段 + 7 段 EQ）
  document.querySelector('.modal-close')?.click();
  await wait(400);
  const sceneButton = document.querySelector('.scene-btn[data-scene="podcast"]');
  if (!sceneButton) return JSON.stringify({ ...out, error: '找不到播客场景按钮' });
  sceneButton.click();
  await wait(1500);
  out.steps.push({ step: '点击播客场景（等写入 + 设备上报）', ...snapshot() });

  // 3) 重开设备抽屉，取诊断日志与统计
  window.__micstudioGo('device');
  await wait(600);
  const rows = Array.from(document.querySelectorAll('.diag-log-row')).map((node) => clean(node));
  out.diagTail = rows.slice(-36);
  out.stats = Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((node) => [node.dataset.stat, clean(node)]));
  out.diagCount = clean(document.querySelector('.diag-count'));

  // 4) 从 UI 关闭设备，改用原始 HID 读回设备侧真值
  const row = Array.from(document.querySelectorAll('.device-row')).find((item) => (item.textContent ?? '').includes('0A67'));
  row?.querySelector('.btn')?.click();
  await wait(1000);

  const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ ...out, error: '关闭后设备不在列' });
  if (!device.opened) await device.open();
  let events = [];
  device.addEventListener('inputreport', (event) => {
    events.push(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
  });
  const readRegisters = async (start, count) => {
    events = [];
    const frame = encodeFrame(0x13, Uint8Array.from([(start >>> 8) & 0xff, start & 0xff, (count >>> 8) & 0xff, count & 0xff]));
    for (const report of splitFrame(frame)) await device.sendReport(0x51, report);
    await wait(500);
    const merged = new Uint8Array(events.reduce((sum, item) => sum + item.length, 0));
    let cursor = 0;
    for (const item of events) {
      merged.set(item, cursor);
      cursor += item.length;
    }
    const values = {};
    for (const item of decodeStream(merged)) {
      if (item.func !== 0x13) continue;
      const offset = (item.data[0] << 8) | item.data[1];
      const total = (item.data[2] << 8) | item.data[3];
      for (let index = 0; index < total; index += 1) {
        const at = 4 + index * 2;
        if (at + 1 >= item.data.length) break;
        values[offset + index] = (item.data[at] << 8) | item.data[at + 1];
      }
    }
    return values;
  };

  const presetA = await readRegisters(0x2000, 44);
  const presetB = await readRegisters(0x204a, 24);
  device.removeEventListener('inputreport', () => undefined);
  await device.close();

  const pick = (values) => {
    const result = {};
    for (const [addr, label] of [
      [0x2022, 'mute'],
      [0x2024, 'encOnOff'],
      [0x2025, 'encLevel'],
      [0x2026, 'eqMode'],
      [0x2051, 'limitEnable'],
      [0x205b, 'gateThresholdRaw'],
      [0x204c, 'compThresholdRaw'],
      [0x2027, 'band1Enable'],
      [0x2028, 'band1Type'],
      [0x2029, 'band1Freq'],
      [0x202a, 'band1GainRaw'],
      [0x204a, 'compEnable'],
    ]) {
      result[label] = values[addr] ?? null;
    }
    return result;
  };
  out.deviceRegisters = pick({ ...presetB, ...presetA });
  out.devicePresetSnapshot = Object.fromEntries(
    Object.entries({ ...presetA, ...presetB }).map(([addr, value]) => [`0x${hex(Number(addr), 4)}`, value]),
  );

  return JSON.stringify(out);
})()
