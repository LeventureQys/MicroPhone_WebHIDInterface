// 第二轮真机联调 · 上报语义与收尾：写→推的内容/时序，并把设备恢复到接入时的全 0 状态。
//   electron.exe . --screenshot=artifacts\real2\push-restore.png --route=device --exec-file=scripts\probes\real2-push-restore.js --no-sandbox
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
  const addrList = (addrs) => Uint8Array.from(addrs.flatMap((addr) => [(addr >>> 8) & 0xff, addr & 0xff]));
  const pairs = (list) => Uint8Array.from(list.flatMap(([addr, raw]) => [(addr >>> 8) & 0xff, addr & 0xff, (raw >>> 8) & 0xff, raw & 0xff]));

  const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ error: '设备不在列（VID 0A67 / PID 0010）' });
  if (!device.opened) await device.open();

  let events = [];
  let mark = 0;
  device.addEventListener('inputreport', (event) => {
    events.push({
      at: Math.round(performance.now() - mark),
      bytes: new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength),
    });
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function exchange(frames, options = {}) {
    const list = Array.isArray(frames) ? frames : [frames];
    events = [];
    mark = performance.now();
    for (const frame of list) for (const report of splitFrame(frame)) await device.sendReport(OUT_ID, report);
    // 收齐所有回执：允许两段（ACK + 紧随其后的上报帧）
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
    const framesOut = decodeStream(merged);
    const acks = framesOut.filter((item) => item.func === 0x02).map((item) => `0x${hex((item.data[0] << 8) | item.data[1], 4)}`);
    const values = {};
    for (const item of framesOut) {
      if (item.func === 0x13) {
        const start = (item.data[0] << 8) | item.data[1];
        const count = (item.data[2] << 8) | item.data[3];
        for (let index = 0; index < count; index += 1) {
          const at = 4 + index * 2;
          if (at + 1 >= item.data.length) break;
          values[start + index] = (item.data[at] << 8) | item.data[at + 1];
        }
      }
      if (item.func === 0x12) {
        for (let at = 0; at + 3 < item.data.length; at += 4) {
          values[(item.data[at] << 8) | item.data[at + 1]] = (item.data[at + 2] << 8) | item.data[at + 3];
        }
      }
    }
    return {
      acks,
      dataFrames: framesOut.filter((item) => item.func === 0x12 || item.func === 0x13).length,
      pushes: framesOut.filter((item) => item.func === 0x10).map((item) => ({ at: events[0].at, hex: bytesHex(item.data) })),
      pushCount: framesOut.filter((item) => item.func === 0x10).length,
      inboundReports: events.length,
      firstAtMs: events.length > 0 ? events[0].at : null,
      values,
    };
  }

  const out = {};

  // 0) 静默 1.5 s：确认空闲不再主动上报（V0.0.2 与 V0.0.1 的 167 ms 推送对比）
  events = [];
  mark = performance.now();
  await sleep(1500);
  out.idle = { inboundReports: events.length };

  // 1) 单参数写 → 看推的内容与延迟
  const write1 = await exchange(encodeFrame(0x10, pairs([[0x2022, 1]])), { idleMs: 120 });
  out.writeMuteOn = {
    acks: write1.acks,
    pushCount: write1.pushCount,
    pushes: write1.pushes.map((item) => item.hex),
    firstAtMs: write1.firstAtMs,
    inboundReports: write1.inboundReports,
  };
  await sleep(150);
  const restore1 = await exchange(encodeFrame(0x10, pairs([[0x2022, 0]])), { idleMs: 120 });
  out.writeMuteOff = { acks: restore1.acks, pushCount: restore1.pushCount, pushes: restore1.pushes.map((item) => item.hex) };

  // 2) 连续写多字段（0x11）→ 一帧 ACK + 一条合并上报
  await sleep(150);
  const write2 = await exchange(encodeFrame(0x11, Uint8Array.from([0x20, 0x24, 0x00, 0x03, 0x00, 0x01, 0x00, 0x02, 0x00, 0x01])), { idleMs: 120 });
  out.writeMerged = { acks: write2.acks, pushCount: write2.pushCount, pushes: write2.pushes.map((item) => item.hex) };
  await sleep(150);

  // 3) 收尾：预设区 0x2000..0x2071 全部写回 0（0x11 一帧 114 词）
  const zeros = new Uint8Array(4 + 114 * 2);
  zeros[0] = 0x20;
  zeros[1] = 0x00;
  zeros[2] = 0x00;
  zeros[3] = 0x72;
  const cleanup = await exchange(encodeFrame(0x11, zeros), { idleMs: 150, maxMs: 2500 });
  out.cleanupPreset = { acks: cleanup.acks, pushCount: cleanup.pushCount, inboundReports: cleanup.inboundReports };
  await sleep(200);

  // 4) 配置区被改过的 0x1000、边界外的 0x2072..0x2075 也写回 0
  for (const [addr, raw] of [[0x1000, 0], [0x2072, 0], [0x2073, 0], [0x2074, 0], [0x2075, 0]]) {
    const result = await exchange(encodeFrame(0x10, pairs([[addr, raw]])), { idleMs: 90 });
    out[`restore_${hex(addr, 4)}`] = result.acks;
    await sleep(120);
  }

  // 5) 终检：整个预设区 + 设备信息 + 配置区关键项
  await sleep(200);
  const finalPreset = await exchange(encodeFrame(0x13, Uint8Array.from([0x20, 0x00, 0x00, 0x72])), { maxMs: 2000 });
  const nonZero = Object.entries(finalPreset.values)
    .filter(([, value]) => value !== 0)
    .map(([addr, value]) => `0x${hex(Number(addr), 4)}=${value}`);
  out.finalPreset = {
    words: Object.keys(finalPreset.values).length,
    nonZero,
    inboundReports: finalPreset.inboundReports,
    acks: finalPreset.acks,
  };
  const finalInfo = await exchange(encodeFrame(0x12, addrList([0x000b, 0x1000, 0x1007, 0x2072, 0x2073, 0x2074, 0x2075, 0x2022, 0x2024, 0x2025])), { maxMs: 900 });
  out.finalSample = Object.fromEntries(
    Object.entries(finalInfo.values).map(([addr, value]) => [`0x${hex(Number(addr), 4)}`, value]),
  );
  out.finalSampleAcks = finalInfo.acks;

  device.removeEventListener('inputreport', () => undefined);
  await device.close();
  return JSON.stringify(out);
})()
