// 第二轮真机联调 · 收尾：把预设区 / 配置区被本次联调改过的地址写回 0，并给出终态快照。
//   electron.exe . --screenshot=artifacts\real2\clean.png --route=device --exec-file=scripts\probes\real2-clean.js --no-sandbox
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
  const pairs = (list) => Uint8Array.from(list.flatMap(([addr, raw]) => [(addr >>> 8) & 0xff, addr & 0xff, (raw >>> 8) & 0xff, raw & 0xff]));

  const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ error: '设备不在列（VID 0A67 / PID 0010）' });
  if (!device.opened) await device.open();

  let events = [];
  let mark = 0;
  device.addEventListener('inputreport', (event) => {
    events.push(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function exchange(frame, maxMs = 1600) {
    events = [];
    const started = performance.now();
    for (const report of splitFrame(frame)) await device.sendReport(OUT_ID, report);
    let seen = 0;
    let lastAt = performance.now();
    while (performance.now() - started < maxMs) {
      await sleep(8);
      if (events.length !== seen) {
        seen = events.length;
        lastAt = performance.now();
      } else if (events.length > 0 && performance.now() - lastAt >= 100) {
        break;
      }
    }
    const merged = new Uint8Array(events.reduce((sum, item) => sum + item.length, 0));
    let cursor = 0;
    for (const item of events) {
      merged.set(item, cursor);
      cursor += item.length;
    }
    const frames = decodeStream(merged);
    return {
      acks: frames.filter((item) => item.func === 0x02).map((item) => `0x${hex((item.data[0] << 8) | item.data[1], 4)}`),
      values: (() => {
        const values = {};
        for (const item of frames) {
          if (item.func !== 0x13) continue;
          const start = (item.data[0] << 8) | item.data[1];
          const count = (item.data[2] << 8) | item.data[3];
          for (let index = 0; index < count; index += 1) {
            const at = 4 + index * 2;
            if (at + 1 >= item.data.length) break;
            values[start + index] = (item.data[at] << 8) | item.data[at + 1];
          }
        }
        return values;
      })(),
    };
  }

  const steps = [];
  // 1) 预设区 0x2000..0x2071 分 4 段写 0
  for (let start = 0x2000; start <= 0x2071; ) {
    const count = Math.min(32, 0x2072 - start);
    const data = new Uint8Array(4 + count * 2);
    data[0] = (start >>> 8) & 0xff;
    data[1] = start & 0xff;
    data[2] = (count >>> 8) & 0xff;
    data[3] = count & 0xff;
    const result = await exchange(encodeFrame(0x11, data));
    steps.push({ write: `0x${hex(start, 4)}+${count}`, acks: result.acks });
    start += count;
    await sleep(150);
  }
  // 2) 被改过的单点：配置区 0x1000、越界 0x2072..0x2075、只读 0x000B
  for (const addr of [0x1000, 0x000b, 0x2072, 0x2073, 0x2074, 0x2075]) {
    const result = await exchange(encodeFrame(0x10, pairs([[addr, 0]])));
    steps.push({ write: `0x${hex(addr, 4)}=0`, acks: result.acks });
    await sleep(150);
  }
  // 3) 终检
  const preset = await exchange(encodeFrame(0x13, Uint8Array.from([0x20, 0x00, 0x00, 0x72])), 2200);
  const info = await exchange(encodeFrame(0x13, Uint8Array.from([0x00, 0x00, 0x00, 0x3e])));
  const config = await exchange(encodeFrame(0x13, Uint8Array.from([0x10, 0x00, 0x00, 0x0e])));
  const beyond = await exchange(encodeFrame(0x12, Uint8Array.from([0x20, 0x72, 0x20, 0x73, 0x20, 0x74, 0x20, 0x75])));
  const nonZero = (values) =>
    Object.entries(values)
      .filter(([, value]) => value !== 0)
      .map(([addr, value]) => `0x${hex(Number(addr), 4)}=${value}`);

  device.removeEventListener('inputreport', () => undefined);
  await device.close();
  return JSON.stringify({
    steps,
    finalPreset: { words: Object.keys(preset.values).length, nonZero: nonZero(preset.values) },
    finalInfo: { words: Object.keys(info.values).length, nonZero: nonZero(info.values) },
    finalConfig: { words: Object.keys(config.values).length, nonZero: nonZero(config.values) },
    beyondTableAcks: beyond.acks,
    beyondTableWords: Object.keys(beyond.values).length,
  });
})()
