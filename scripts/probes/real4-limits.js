// 第四轮真机联调 · 写 Flash 时延与协议边界：20 次写 ACK 时延、容量上限、非法地址读、收尾恢复原始值。
//   electron.exe . --screenshot=artifacts\real4\limits.png --route=device --exec-file=scripts\probes\real4-limits.js --no-sandbox
(async () => {
  const OUT_ID = 0x51;
  const hex = (value, digits) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function crc16(bytes) {
    let crc = 0xffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    return crc & 0xffff;
  }
  function encodeFrame(unit, func, data) {
    const len = data.length + 6;
    const frame = new Uint8Array(len);
    frame[0] = unit;
    frame[1] = func;
    frame[2] = (len >>> 8) & 0xff;
    frame[3] = len & 0xff;
    frame.set(data, 4);
    const crc = crc16(frame.subarray(0, len - 2));
    frame[len - 2] = crc & 0xff;
    frame[len - 1] = (crc >>> 8) & 0xff;
    return frame;
  }
  function decodeStream(buffer) {
    const frames = [];
    let offset = 0;
    while (offset < buffer.length) {
      while (offset + 1 < buffer.length && buffer[offset] === 0 && buffer[offset + 1] === 0) offset += 1;
      if (buffer.length - offset < 4) break;
      const len = (buffer[offset + 2] << 8) | buffer[offset + 3];
      if (len < 6 || len > 1024) {
        offset += 1;
        continue;
      }
      if (len > buffer.length - offset) break;
      if (crc16(buffer.subarray(offset, offset + len - 2)) !== (buffer[offset + len - 2] | (buffer[offset + len - 1] << 8))) {
        offset += 1;
        continue;
      }
      frames.push({ func: buffer[offset + 1], len, data: buffer.slice(offset + 4, offset + len - 2) });
      offset += len;
    }
    return frames;
  }
  function splitReports(frame) {
    const reports = [];
    for (let offset = 0; offset < frame.length; offset += 63) {
      const report = new Uint8Array(63);
      report.set(frame.subarray(offset, Math.min(offset + 63, frame.length)));
      reports.push(report);
    }
    return reports;
  }

  const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ error: '设备不在列' });
  if (device.opened) await device.close().catch(() => undefined);
  await device.open();

  let inbound = new Uint8Array(0);
  const onReport = (event) => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const merged = new Uint8Array(inbound.length + bytes.length);
    merged.set(inbound, 0);
    merged.set(bytes, inbound.length);
    inbound = merged;
  };
  device.addEventListener('inputreport', onReport);

  async function waitFor(predicate, timeoutMs, settleMs = 0) {
    const started = performance.now();
    let hitAt = null;
    while (performance.now() - started < timeoutMs) {
      const frames = decodeStream(inbound);
      if (predicate(frames)) {
        if (hitAt === null) hitAt = performance.now();
        if (performance.now() - hitAt >= settleMs) break;
      }
      await sleep(4);
    }
    return { frames: decodeStream(inbound), ms: hitAt === null ? null : Number((hitAt - started).toFixed(2)) };
  }

  async function write(addr, value, timeoutMs = 5000) {
    inbound = new Uint8Array(0);
    for (const report of splitReports(encodeFrame(0, 0x10, Uint8Array.from([(addr >> 8) & 0xff, addr & 0xff, (value >> 8) & 0xff, value & 0xff])))) {
      await device.sendReport(OUT_ID, report);
    }
    const result = await waitFor((frames) => frames.some((frame) => frame.func === 0x02), timeoutMs, 60);
    const acks = result.frames.filter((frame) => frame.func === 0x02).map((frame) => `0x${hex((frame.data[0] << 8) | frame.data[1], 4)}`);
    return { ackMs: result.ms, acks, frames: result.frames.length };
  }
  async function readSeq(start, count, timeoutMs = 1500) {
    inbound = new Uint8Array(0);
    for (const report of splitReports(encodeFrame(0, 0x13, Uint8Array.from([(start >> 8) & 0xff, start & 0xff, (count >> 8) & 0xff, count & 0xff])))) {
      await device.sendReport(OUT_ID, report);
    }
    const result = await waitFor((frames) => frames.some((frame) => frame.func === 0x13 || frame.func === 0x02), timeoutMs, 80);
    const reply = result.frames.find((frame) => frame.func === 0x13);
    const ack = result.frames.find((frame) => frame.func === 0x02);
    return {
      ms: result.ms,
      frameBytes: reply?.len ?? null,
      count: reply ? (reply.data[2] << 8) | reply.data[3] : null,
      firstValues: reply ? Array.from(reply.data.slice(4, 14), (b) => hex(b, 2)).join(' ') : null,
      ack: ack ? `0x${hex((ack.data[0] << 8) | ack.data[1], 4)}` : null,
      extraFrames: result.frames.length,
    };
  }

  const out = {};

  // 1) 原始值
  const original = {};
  for (const addr of [0x2025, 0x205D, 0x205E]) {
    const reply = await readSeq(addr, 1, 1200);
    original[`0x${hex(addr, 4)}`] = reply.firstValues;
  }
  out.original = original;

  // 2) 20 次写 ACK 时延（0x2025 在 1/2 之间交替，确保每次都是真改值）
  const timings = [];
  for (let index = 0; index < 20; index += 1) {
    const result = await write(0x2025, index % 2 === 0 ? 2 : 1);
    timings.push(result);
    await sleep(420);
  }
  const ackTimes = timings.map((item) => item.ackMs).filter((value) => typeof value === 'number');
  const sorted = [...ackTimes].sort((a, b) => a - b);
  out.writeTiming = {
    samples: timings.map((item) => ({ ackMs: item.ackMs, acks: item.acks, frames: item.frames })),
    min: sorted[0] ?? null,
    median: sorted[Math.floor(sorted.length / 2)] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    timeouts: timings.filter((item) => item.ackMs === null).length,
    multiAck: timings.filter((item) => item.acks.length > 1).length,
  };

  // 3) 非法地址读（0x2076 越界、0x3000、0x4000）
  out.invalidReads = {};
  for (const addr of [0x2076, 0x2077, 0x3000, 0x4000]) {
    out.invalidReads[`0x${hex(addr, 4)}`] = await readSeq(addr, 1, 1200);
    await sleep(120);
  }

  // 4) 容量上限：连续读 119/120/126，再随机读 126/127 个地址
  out.capacity = {};
  for (const count of [119, 120, 126]) {
    out.capacity[`seq ${count}`] = await readSeq(0x2000, count, 3000);
    await sleep(150);
  }
  const addrList = (n) => Array.from({ length: n }, (_value, index) => 0x2000 + index);
  for (const count of [126, 127]) {
    inbound = new Uint8Array(0);
    const data = Uint8Array.from(addrList(count).flatMap((addr) => [(addr >> 8) & 0xff, addr & 0xff]));
    for (const report of splitReports(encodeFrame(0, 0x12, data))) await device.sendReport(OUT_ID, report);
    const result = await waitFor((frames) => frames.some((frame) => frame.func === 0x12 || frame.func === 0x02), 3000, 120);
    const reply = result.frames.find((frame) => frame.func === 0x12);
    const ack = result.frames.find((frame) => frame.func === 0x02);
    out.capacity[`rand ${count}`] = {
      ms: result.ms,
      frameBytes: reply?.len ?? null,
      entries: reply ? reply.data.length / 4 : null,
      ack: ack ? `0x${hex((ack.data[0] << 8) | ack.data[1], 4)}` : null,
      extraFrames: result.frames.length,
    };
    await sleep(150);
  }

  // 5) 恢复：0x2025 / 0x205D / 0x205E 写回探测前的值（0x205D/E 之前被写成 5，本次恢复为 0）
  out.restore = {};
  for (const [addr, raw] of [
    [0x2025, 1],
    [0x205D, 0],
    [0x205E, 0],
  ]) {
    const result = await write(addr, raw);
    const back = await readSeq(addr, 1, 1500);
    out.restore[`0x${hex(addr, 4)}`] = { wrote: raw, acks: result.acks, readBack: back.firstValues };
    await sleep(700);
  }

  // 6) 写完之后设备仍可正常读
  out.healthAfter = await readSeq(0x2057, 1, 1500);

  device.removeEventListener('inputreport', onReport);
  await device.close().catch(() => undefined);
  return JSON.stringify(out);
})()
