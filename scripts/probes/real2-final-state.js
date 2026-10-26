// 第二轮真机联调 · 终检：设备信息区 / 配置区 / 预设区全量读一遍，列出非 0 项（交付态快照）。
//   electron.exe . --screenshot=artifacts\real2\final-state.png --route=device --exec-file=scripts\probes\real2-final-state.js --no-sandbox
(async () => {
  const OUT_ID = 0x51;
  const PAYLOAD = 63;
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
    for (let offset = 0; offset < bytes.length; offset += PAYLOAD) {
      const report = new Uint8Array(PAYLOAD);
      report.set(bytes.subarray(offset, Math.min(offset + PAYLOAD, bytes.length)));
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

  const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ error: '设备不在列（VID 0A67 / PID 0010）' });
  if (!device.opened) await device.open();

  let events = [];
  let mark = 0;
  device.addEventListener('inputreport', (event) => {
    events.push({ at: Math.round(performance.now() - mark), bytes: new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength) });
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function readRegion(start, count) {
    events = [];
    mark = performance.now();
    const frame = encodeFrame(0x13, Uint8Array.from([(start >>> 8) & 0xff, start & 0xff, (count >>> 8) & 0xff, count & 0xff]));
    for (const report of splitFrame(frame)) await device.sendReport(OUT_ID, report);
    const started = performance.now();
    let seen = 0;
    let lastAt = performance.now();
    while (performance.now() - started < 1800) {
      await sleep(8);
      if (events.length !== seen) {
        seen = events.length;
        lastAt = performance.now();
      } else if (events.length > 0 && performance.now() - lastAt >= 100) {
        break;
      }
    }
    const merged = new Uint8Array(events.reduce((sum, item) => sum + item.bytes.length, 0));
    let cursor = 0;
    for (const item of events) {
      merged.set(item.bytes, cursor);
      cursor += item.bytes.length;
    }
    const values = {};
    let acks = [];
    for (const item of decodeStream(merged)) {
      if (item.func === 0x02) acks.push(`0x${hex((item.data[0] << 8) | item.data[1], 4)}`);
      if (item.func !== 0x13) continue;
      const base = (item.data[0] << 8) | item.data[1];
      const total = (item.data[2] << 8) | item.data[3];
      for (let index = 0; index < total; index += 1) {
        const at = 4 + index * 2;
        if (at + 1 >= item.data.length) break;
        values[base + index] = (item.data[at] << 8) | item.data[at + 1];
      }
    }
    return { values, acks, inboundReports: events.length };
  }

  const info = await readRegion(0x0000, 0x3e);
  await sleep(120);
  const config = await readRegion(0x1000, 0x0e);
  await sleep(120);
  const preset = await readRegion(0x2000, 0x72);
  await sleep(120);
  // 固件接受但参数表里不存在的 0x2072..0x2075 也读一下（越界边界的实证）
  const beyond = await readRegion(0x2072, 0x04);

  const nonZero = (values) =>
    Object.entries(values)
      .filter(([, value]) => value !== 0)
      .map(([addr, value]) => `0x${hex(Number(addr), 4)}=${value}`);

  const out = {
    info: { words: Object.keys(info.values).length, nonZero: nonZero(info.values), acks: info.acks, reports: info.inboundReports },
    config: { words: Object.keys(config.values).length, nonZero: nonZero(config.values), acks: config.acks },
    preset: { words: Object.keys(preset.values).length, nonZero: nonZero(preset.values), acks: preset.acks },
    beyondTable: { words: Object.keys(beyond.values).length, values: beyond.values, acks: beyond.acks },
  };

  device.removeEventListener('inputreport', () => undefined);
  await device.close();
  return JSON.stringify(out);
})()
