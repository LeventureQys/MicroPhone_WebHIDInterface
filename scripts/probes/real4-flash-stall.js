// 第四轮真机联调 · 写后读延迟（落 Flash 是否在 ACK 之后才发生）：单写 12 次 + 连写 8 帧，每次写完立刻读一次电平。
//   electron.exe . --screenshot=artifacts\real4\flash-stall.png --route=device --exec-file=scripts\probes\real4-flash-stall.js --no-sandbox
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

  async function awaitOne(predicate, timeoutMs) {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      const frames = decodeStream(inbound);
      const hit = frames.find(predicate);
      if (hit) return { frame: hit, ms: Number((performance.now() - started).toFixed(2)) };
      await sleep(2);
    }
    return { frame: null, ms: null };
  }
  const send = async (func, data) => {
    for (const report of splitReports(encodeFrame(func, data))) await device.sendReport(OUT_ID, report);
  };
  async function write(addr, value) {
    inbound = new Uint8Array(0);
    await send(0x10, Uint8Array.from([(addr >> 8) & 0xff, addr & 0xff, (value >> 8) & 0xff, value & 0xff]));
    const result = await awaitOne((frame) => frame.func === 0x02, 5000);
    return { ackMs: result.ms, code: result.frame ? `0x${hex((result.frame.data[0] << 8) | result.frame.data[1], 4)}` : null };
  }
  async function readLevel() {
    inbound = new Uint8Array(0);
    await send(0x12, Uint8Array.from([0x20, 0x57]));
    const result = await awaitOne((frame) => frame.func === 0x12, 3000);
    return { ms: result.ms, value: result.frame ? (result.frame.data[2] << 8) | result.frame.data[3] : null };
  }

  const out = {};
  const original = await (async () => {
    inbound = new Uint8Array(0);
    await send(0x13, Uint8Array.from([0x20, 0x2a, 0x00, 0x01]));
    const result = await awaitOne((frame) => frame.func === 0x13, 1500);
    return result.frame ? (result.frame.data[4] << 8) | result.frame.data[5] : null;
  })();
  out.originalEqGain = original;

  // 单写 12 次，写完立即读
  const single = [];
  for (let index = 0; index < 12; index += 1) {
    const writeResult = await write(0x202a, index % 2 === 0 ? 360 : 350);
    const readStart = performance.now();
    const readResult = await readLevel();
    single.push({ writeAckMs: writeResult.ackMs, readAfterWriteMs: readResult.ms, readWallMs: Number((performance.now() - readStart).toFixed(2)) });
    await sleep(420);
  }
  out.singleWrite = single;

  // 连写 8 帧（模拟场景）后立即读
  const burst = [];
  for (let round = 0; round < 4; round += 1) {
    const start = performance.now();
    const targets = [0x202a, 0x202f, 0x2034, 0x2039, 0x203e, 0x2043, 0x2048, 0x204c];
    const acks = [];
    for (const [index, addr] of targets.entries()) {
      const value = addr === 0x204c ? 180 : 300 + index * 10 + round * 5;
      const result = await write(addr, value);
      acks.push(result.ackMs);
    }
    const writeWallMs = Number((performance.now() - start).toFixed(2));
    const readResult = await readLevel();
    burst.push({ writeWallMs, ackMs: acks, readAfterBurstMs: readResult.ms });
    await sleep(800);
  }
  out.burstWrite = burst;

  // 随机读容量复测：118 / 119 / 126
  out.capacity = {};
  for (const count of [118, 119, 126]) {
    inbound = new Uint8Array(0);
    const data = Uint8Array.from(Array.from({ length: count }, (_value, index) => 0x2000 + index).flatMap((addr) => [(addr >> 8) & 0xff, addr & 0xff]));
    await send(0x12, data);
    const result = await awaitOne((frame) => frame.func === 0x12 || frame.func === 0x02, 3000);
    out.capacity[`rand ${count}`] = {
      ms: result.ms,
      frameBytes: result.frame?.len ?? null,
      entries: result.frame && result.frame.func === 0x12 ? result.frame.data.length / 4 : null,
      ack: result.frame && result.frame.func === 0x02 ? `0x${hex((result.frame.data[0] << 8) | result.frame.data[1], 4)}` : null,
    };
    await sleep(250);
  }

  // 恢复 EQ band1 gain 到探测前（应恢复成 290，见 §联调报告）
  out.restore = await write(0x202a, 290);
  await sleep(500);
  inbound = new Uint8Array(0);
  await send(0x13, Uint8Array.from([0x20, 0x2a, 0x00, 0x01]));
  const restored = await awaitOne((frame) => frame.func === 0x13, 1500);
  out.restoreReadBack = restored.frame ? (restored.frame.data[4] << 8) | restored.frame.data[5] : null;

  device.removeEventListener('inputreport', onReport);
  await device.close().catch(() => undefined);
  return JSON.stringify(out);
})()
