// 第二轮真机联调 · 写容量边界：0x11 多字写 / 0x10 多组写最多能收多少，超限是回错还是静默。
//   electron.exe . --screenshot=artifacts\real2\write-capacity.png --route=device --exec-file=scripts\probes\real2-write-capacity.js --no-sandbox
// 顺带把预设区 0x2000..0x2071 写回 0（设备接入时就是全 0）。
(async () => {
  const OUT_ID = 0x51;
  const PAYLOAD = 63;
  const hex = (value, digits) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
  const bytesHex = (bytes) => Array.from(bytes, (byte) => hex(byte, 2)).join(' ');

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
    events.push({ at: Math.round(performance.now() - mark), bytes: new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength) });
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function exchange(frame, options = {}) {
    events = [];
    mark = performance.now();
    for (const report of splitFrame(frame)) await device.sendReport(OUT_ID, report);
    const started = performance.now();
    let seen = 0;
    let lastAt = performance.now();
    const idleMs = options.idleMs ?? 90;
    const maxMs = options.maxMs ?? 1600;
    while (performance.now() - started < maxMs) {
      await sleep(8);
      if (events.length !== seen) {
        seen = events.length;
        lastAt = performance.now();
      } else if (events.length > 0 && performance.now() - lastAt >= idleMs) {
        break;
      }
    }
    const merged = new Uint8Array(events.reduce((sum, item) => sum + item.bytes.length, 0));
    let cursor = 0;
    for (const item of events) {
      merged.set(item.bytes, cursor);
      cursor += item.bytes.length;
    }
    const frames = decodeStream(merged);
    return {
      acks: frames.filter((item) => item.func === 0x02).map((item) => `0x${hex((item.data[0] << 8) | item.data[1], 4)}`),
      pushes: frames.filter((item) => item.func === 0x10).map((item) => bytesHex(item.data)),
      inboundReports: events.length,
      frames: frames.length,
      firstAtMs: events.length > 0 ? events[0].at : null,
    };
  }

  const out = { seqWrite: [], randWrite: [], cleanup: null, final: null };

  // A) 0x11 连续写：从 0x2000 起写 N 个 0，看哪一档开始没有回执
  for (const count of [2, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 114]) {
    const data = new Uint8Array(4 + count * 2);
    data[0] = 0x20;
    data[1] = 0x00;
    data[2] = (count >>> 8) & 0xff;
    data[3] = count & 0xff;
    const frame = encodeFrame(0x11, data);
    const result = await exchange(frame, { idleMs: 120, maxMs: 1800 });
    out.seqWrite.push({
      words: count,
      frameBytes: frame.length,
      reports: Math.ceil(frame.length / PAYLOAD),
      acks: result.acks,
      inboundReports: result.inboundReports,
      answered: result.frames > 0,
    });
    await sleep(150);
  }

  // B) 0x10 随机写：同一段地址写 N 组（addr,val）
  for (const count of [1, 4, 8, 12, 14, 16, 20, 24, 30]) {
    const list = Array.from({ length: count }, (_, index) => [0x2027 + index, 0]);
    const frame = encodeFrame(0x10, pairs(list));
    const result = await exchange(frame, { idleMs: 120, maxMs: 1800 });
    out.randWrite.push({
      pairs: count,
      frameBytes: frame.length,
      reports: Math.ceil(frame.length / PAYLOAD),
      acks: result.acks,
      inboundReports: result.inboundReports,
      answered: result.frames > 0,
    });
    await sleep(150);
  }

  // C) 用已知可应答的块大小把整段预设清 0（优先 32 词一帧）
  const chunks = [];
  for (let start = 0x2000; start <= 0x2071; ) {
    const count = Math.min(32, 0x2072 - start);
    const data = new Uint8Array(4 + count * 2);
    data[0] = (start >>> 8) & 0xff;
    data[1] = start & 0xff;
    data[2] = (count >>> 8) & 0xff;
    data[3] = count & 0xff;
    const result = await exchange(encodeFrame(0x11, data), { idleMs: 120, maxMs: 1800 });
    chunks.push({ start: `0x${hex(start, 4)}`, words: count, acks: result.acks });
    start += count;
    await sleep(150);
  }
  out.cleanup = chunks;

  // D) 终检
  await sleep(250);
  const finalRead = await exchange(encodeFrame(0x13, Uint8Array.from([0x20, 0x00, 0x00, 0x72])), { maxMs: 2200 });
  const values = {};
  const merged = new Uint8Array(events.reduce((sum, item) => sum + item.bytes.length, 0));
  let cursor = 0;
  for (const item of events) {
    merged.set(item.bytes, cursor);
    cursor += item.bytes.length;
  }
  for (const frame of decodeStream(merged)) {
    if (frame.func !== 0x13) continue;
    const start = (frame.data[0] << 8) | frame.data[1];
    const count = (frame.data[2] << 8) | frame.data[3];
    for (let index = 0; index < count; index += 1) {
      const at = 4 + index * 2;
      if (at + 1 >= frame.data.length) break;
      values[start + index] = (frame.data[at] << 8) | frame.data[at + 1];
    }
  }
  out.final = {
    words: Object.keys(values).length,
    nonZero: Object.entries(values)
      .filter(([, value]) => value !== 0)
      .map(([addr, value]) => `0x${hex(Number(addr), 4)}=${value}`),
    acks: finalRead.acks,
    inboundReports: finalRead.inboundReports,
  };

  device.removeEventListener('inputreport', () => undefined);
  await device.close();
  return JSON.stringify(out);
})()
