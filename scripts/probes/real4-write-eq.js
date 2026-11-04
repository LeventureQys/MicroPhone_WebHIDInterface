// 第四轮真机联调 · EQ/DRC 写入时延（是否只有部分参数触发落 Flash）+ 随机读容量边界 + 非法地址读稳定性。
//   electron.exe . --screenshot=artifacts\real4\write-eq.png --route=device --exec-file=scripts\probes\real4-write-eq.js --no-sandbox
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

  async function awaitFrames(predicate, timeoutMs, settleMs = 60) {
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
  async function write(addr, value) {
    inbound = new Uint8Array(0);
    for (const report of splitReports(encodeFrame(0x10, Uint8Array.from([(addr >> 8) & 0xff, addr & 0xff, (value >> 8) & 0xff, value & 0xff])))) {
      await device.sendReport(OUT_ID, report);
    }
    const result = await awaitFrames((frames) => frames.some((frame) => frame.func === 0x02), 5000, 60);
    return { ackMs: result.ms, acks: result.frames.filter((frame) => frame.func === 0x02).map((frame) => `0x${hex((frame.data[0] << 8) | frame.data[1], 4)}`), frames: result.frames.length };
  }
  async function readOne(addr) {
    inbound = new Uint8Array(0);
    for (const report of splitReports(encodeFrame(0x13, Uint8Array.from([(addr >> 8) & 0xff, addr & 0xff, 0x00, 0x01])))) {
      await device.sendReport(OUT_ID, report);
    }
    const result = await awaitFrames((frames) => frames.some((frame) => frame.func === 0x13 || frame.func === 0x02), 1500, 60);
    const reply = result.frames.find((frame) => frame.func === 0x13);
    const ack = result.frames.find((frame) => frame.func === 0x02);
    return reply ? { value: (reply.data[4] << 8) | reply.data[5], ms: result.ms } : { ack: ack ? `0x${hex((ack.data[0] << 8) | ack.data[1], 4)}` : null, ms: result.ms };
  }

  const out = {};
  const originals = {};
  for (const addr of [0x202A, 0x2063]) {
    originals[`0x${hex(addr, 4)}`] = await readOne(addr);
  }
  out.originals = originals;

  const timing = async (addr, a, b) => {
    const samples = [];
    for (let index = 0; index < 12; index += 1) {
      samples.push(await write(addr, index % 2 === 0 ? b : a));
      await sleep(380);
    }
    const times = samples.map((item) => item.ackMs).filter((value) => typeof value === 'number').sort((x, y) => x - y);
    return {
      samples: samples.map((item) => item.ackMs),
      min: times[0] ?? null,
      median: times[Math.floor(times.length / 2)] ?? null,
      max: times[times.length - 1] ?? null,
      timeouts: samples.filter((item) => item.ackMs === null).length,
      multiAck: samples.filter((item) => item.acks.length > 1).length,
    };
  };
  out.eqGainTiming = await timing(0x202A, 360, 350);
  out.drcPreGainTiming = await timing(0x2063, 0, 100);

  // 随机读容量：124 / 125 / 126
  out.capacity = {};
  for (const count of [124, 125, 126]) {
    inbound = new Uint8Array(0);
    const data = Uint8Array.from(Array.from({ length: count }, (_value, index) => 0x2000 + index).flatMap((addr) => [(addr >> 8) & 0xff, addr & 0xff]));
    for (const report of splitReports(encodeFrame(0x12, data))) await device.sendReport(OUT_ID, report);
    const result = await awaitFrames((frames) => frames.some((frame) => frame.func === 0x12 || frame.func === 0x02), 3000, 120);
    const reply = result.frames.find((frame) => frame.func === 0x12);
    const ack = result.frames.find((frame) => frame.func === 0x02);
    out.capacity[`rand ${count}`] = {
      ms: result.ms,
      frameBytes: reply?.len ?? null,
      entries: reply ? reply.data.length / 4 : null,
      ack: ack ? `0x${hex((ack.data[0] << 8) | ack.data[1], 4)}` : null,
      extraFrames: result.frames.length,
    };
    await sleep(250);
  }

  // 非法地址读 3 次，看值是否稳定（内存越界 vs 偶发）
  out.invalidReads = [];
  for (const addr of [0x3000, 0x4000, 0x2076]) {
    const samples = [];
    for (let index = 0; index < 3; index += 1) {
      samples.push(await readOne(addr));
      await sleep(150);
    }
    out.invalidReads.push({ addr: `0x${hex(addr, 4)}`, samples });
  }

  // 恢复
  out.restore = {};
  for (const [addr, value] of [
    [0x202A, 360],
    [0x2063, 0],
  ]) {
    out.restore[`0x${hex(addr, 4)}`] = { write: await write(addr, value), readBack: await readOne(addr) };
    await sleep(600);
  }

  device.removeEventListener('inputreport', onReport);
  await device.close().catch(() => undefined);
  return JSON.stringify(out);
})()
