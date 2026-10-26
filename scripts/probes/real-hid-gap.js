// 真机请求间隔阈值：两次干净读之间留不同静默，量设备的可用最小间隔与自愈时间。
//   electron.exe . --screenshot=artifacts\real\gap-threshold.png --route=device --exec-file=scripts\probes\real-hid-gap.js --no-sandbox
// 只读。
(async () => {
  const OUT_ID = 0x51;
  const PAYLOAD = 63;
  const hex = (value, digits) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
  const hexBytes = (bytes, limit) => Array.from(bytes.slice(0, limit), (byte) => hex(byte, 2)).join(' ');

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
    const out = [];
    for (let offset = 0; offset < bytes.length; offset += PAYLOAD) {
      const report = new Uint8Array(PAYLOAD);
      report.set(bytes.subarray(offset, Math.min(offset + PAYLOAD, bytes.length)));
      out.push(report);
    }
    return out;
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
      frames.push({ func: buffer[offset + 1], data: buffer.slice(offset + 4, offset + len - 2) });
      offset += len;
    }
    return frames;
  }
  const addrBytes = (addrs) => Uint8Array.from(addrs.flatMap((addr) => [(addr >>> 8) & 0xff, addr & 0xff]));
  const watch = [0x2024, 0x2025, 0x2026, 0x2023, 0x205a, 0x2057, 0x2059, 0x204a, 0x2051, 0x2058, 0x2022, 0x2001, 0x2000,
    0x2027, 0x2028, 0x2029, 0x202a, 0x202b, 0x2040, 0x2045, 0x205b, 0x205c, 0x205d, 0x205e, 0x205f, 0x1000, 0x1007, 0x000b];
  const requestFrame = encodeFrame(0x12, addrBytes(watch));

  const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ error: '设备不在列' });
  if (!device.opened) await device.open();

  let events = [];
  const onReport = (event) => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    events.push({ at: performance.now(), bytes });
  };
  device.addEventListener('inputreport', onReport);

  const decodeAll = () => {
    let acc = new Uint8Array(0);
    for (const event of events) {
      const merged = new Uint8Array(acc.length + event.bytes.length);
      merged.set(acc, 0);
      merged.set(event.bytes, acc.length);
      acc = merged;
    }
    return decodeStream(acc);
  };

  const send = async () => {
    for (const report of splitFrame(requestFrame)) await device.sendReport(OUT_ID, report);
  };

  const attempt = async (timeoutMs) => {
    events = [];
    const t0 = performance.now();
    await send();
    while (performance.now() - t0 < timeoutMs) {
      const frames = decodeAll();
      const reply = frames.find((item) => item.func === 0x12);
      if (reply) return { ok: true, ms: Math.round(performance.now() - t0), reports: events.length };
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const frames = decodeAll();
    const acks = frames.filter((item) => item.func === 0x02);
    return {
      ok: false,
      ms: Math.round(performance.now() - t0),
      reports: events.length,
      ackFrames: acks.length,
      ackCodes: [...new Set(acks.map((item) => hex((item.data[0] << 8) | item.data[1], 4)))],
      sample: events.slice(0, 3).map((event) => hexBytes(event.bytes, 8)),
    };
  };

  const rows = [];
  for (const gapMs of [0, 20, 50, 100, 200, 400, 800, 1500]) {
    // 每轮先静置 3 s，把设备拉回健康态
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const first = await attempt(600);
    await new Promise((resolve) => setTimeout(resolve, gapMs));
    const second = await attempt(800);
    rows.push({ gapMs, first, second });
  }

  device.removeEventListener('inputreport', onReport);
  await device.close();
  return JSON.stringify({ rows });
})()
