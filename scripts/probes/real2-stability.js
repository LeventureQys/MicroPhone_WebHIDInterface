// 第二轮真机联调 · 稳定性：大帧（4 报文请求 / 9 报文响应）连发 10 轮，统计应答率与延迟。
//   electron.exe . --screenshot=artifacts\real2\stability.png --route=device --exec-file=scripts\probes\real2-stability.js --no-sandbox
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
  const addrList = (addrs) => Uint8Array.from(addrs.flatMap((addr) => [(addr >>> 8) & 0xff, addr & 0xff]));

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
    const idleMs = options.idleMs ?? 80;
    const maxMs = options.maxMs ?? 1500;
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
      answered: frames.length > 0,
      acks: frames.filter((item) => item.func === 0x02).map((item) => `0x${hex((item.data[0] << 8) | item.data[1], 4)}`),
      dataFrames: frames.filter((item) => item.func === 0x12 || item.func === 0x13).length,
      inboundReports: events.length,
      firstAtMs: events.length > 0 ? events[0].at : null,
    };
  }

  const out = { bigSeqWrite: [], bigSeqRead: [], bigRandRead: [] };
  const zeroWrite = (() => {
    const data = new Uint8Array(4 + 114 * 2);
    data[0] = 0x20;
    data[1] = 0x00;
    data[2] = 0x00;
    data[3] = 0x72;
    return encodeFrame(0x11, data);
  })();
  const seqRead = encodeFrame(0x13, Uint8Array.from([0x20, 0x00, 0x00, 0x72]));
  const randRead = encodeFrame(
    0x12,
    addrList(Array.from({ length: 114 }, (_, index) => 0x2000 + index).concat(Array.from({ length: 12 }, () => 0x2000))),
  );

  for (let round = 0; round < 10; round += 1) {
    const write = await exchange(zeroWrite, { idleMs: 110, maxMs: 1800 });
    out.bigSeqWrite.push({ round, ...write });
    await sleep(120);
  }
  for (let round = 0; round < 10; round += 1) {
    const read = await exchange(seqRead, { idleMs: 110, maxMs: 1800 });
    out.bigSeqRead.push({ round, ...read });
    await sleep(120);
  }
  for (let round = 0; round < 10; round += 1) {
    const read = await exchange(randRead, { idleMs: 110, maxMs: 1800 });
    out.bigRandRead.push({ round, ...read });
    await sleep(120);
  }

  const summarise = (rows) => ({
    attempts: rows.length,
    answered: rows.filter((row) => row.answered).length,
    missing: rows.filter((row) => !row.answered).map((row) => row.round),
  });
  out.summary = {
    bigSeqWrite: summarise(out.bigSeqWrite),
    bigSeqRead: summarise(out.bigSeqRead),
    bigRandRead: summarise(out.bigRandRead),
  };

  device.removeEventListener('inputreport', () => undefined);
  await device.close();
  return JSON.stringify(out);
})()
