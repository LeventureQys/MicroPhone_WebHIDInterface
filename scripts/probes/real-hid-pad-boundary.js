// 真机写入生效边界：把 0x2026（EQ 模式）写成 1，用不同补位长度，看哪种帧才真正落值。
//   electron.exe . --screenshot=artifacts\real\pad-boundary.png --route=device --exec-file=scripts\probes\real-hid-pad-boundary.js --no-sandbox
(async () => {
  const OUT_ID = 0x51;
  const PAYLOAD = 63;
  const TARGET = 0x2026;
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
  const wordBytes = (pairs) => Uint8Array.from(pairs.flatMap(([addr, raw]) => [(addr >>> 8) & 0xff, addr & 0xff, (raw >>> 8) & 0xff, raw & 0xff]));
  const addrBytes = (addrs) => Uint8Array.from(addrs.flatMap((addr) => [(addr >>> 8) & 0xff, addr & 0xff]));
  const repeatedWrite = (addr, raw, count) => encodeFrame(0x10, wordBytes(Array.from({ length: count }, () => [addr, raw])));
  const cleanWatch = [TARGET, 0x2024, 0x2025, 0x2001, 0x2000, 0x2057, 0x205a, 0x2023, 0x204a, 0x2051, 0x2058, 0x2059, 0x2022,
    0x2027, 0x2028, 0x2029, 0x202a, 0x202b, 0x2040, 0x2045, 0x205b, 0x205c, 0x205d, 0x205e, 0x205f, 0x1000, 0x1007, 0x2022];
  const readWatch = () => encodeFrame(0x12, addrBytes(cleanWatch));

  const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ error: '设备不在列' });
  if (!device.opened) await device.open();

  let buffer = new Uint8Array(0);
  let marks = [];
  let t0 = 0;
  const onReport = (event) => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    marks.push(Math.round(performance.now() - t0));
    const merged = new Uint8Array(buffer.length + bytes.length);
    merged.set(buffer, 0);
    merged.set(bytes, buffer.length);
    buffer = merged;
  };
  device.addEventListener('inputreport', onReport);

  const exchange = async (frame, waitMs) => {
    buffer = new Uint8Array(0);
    marks = [];
    t0 = performance.now();
    for (const report of splitFrame(frame)) await device.sendReport(OUT_ID, report);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const frames = decodeStream(buffer);
    const acks = frames.filter((item) => item.func === 0x02).map((item) => (item.data[0] << 8) | item.data[1]);
    const values = {};
    for (const item of frames) {
      if (item.func !== 0x12) continue;
      for (let offset = 0; offset < item.data.length; offset += 4) {
        values[`0x${hex((item.data[offset] << 8) | item.data[offset + 1], 4)}`] = (item.data[offset + 2] << 8) | item.data[offset + 3];
      }
    }
    return {
      okAck: acks.includes(0),
      ackCount: acks.length,
      ackCodes: [...new Set(acks.map((code) => `0x${hex(code, 4)}`))],
      ackSpan: marks.length > 1 ? marks[marks.length - 1] : null,
      reply: Object.keys(values).length > 0,
      value: values[`0x${hex(TARGET, 4)}`] ?? null,
    };
  };

  const rows = [];
  for (const count of [1, 2, 4, 8, 11, 12, 13, 14]) {
    const frame = repeatedWrite(TARGET, 1, count);
    const write = await exchange(frame, 1300);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const read = await exchange(readWatch(), 800);
    rows.push({
      pairs: count,
      frameBytes: frame.length,
      padding: Math.ceil(frame.length / PAYLOAD) * PAYLOAD - frame.length,
      okAck: write.okAck,
      ackCount: write.ackCount,
      ackCodes: write.ackCodes,
      ackSpanMs: write.ackSpan,
      readBack: read.value,
    });
    // 回到 0 再测下一个长度：写入 0 用 14 对（干净帧）
    await exchange(repeatedWrite(TARGET, 0, 14), 1200);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const finalRead = await exchange(readWatch(), 800);
  device.removeEventListener('inputreport', onReport);
  await device.close();
  return JSON.stringify({ rows, final: { reply: finalRead.reply, ackCount: finalRead.ackCount, value: finalRead.value } });
})()
