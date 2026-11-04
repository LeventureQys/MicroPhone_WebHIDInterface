// 第四轮真机联调 · 参数协议符合性：全量读、有效区间、只读/范围/未知地址、拒绝路径、电平、信息区、配置区。
// 所有写操作都先读原值，测完写回原点，避免把设备参数留在测试态。
//   electron.exe . --screenshot=artifacts\real4\proto.png --route=device --exec-file=scripts\probes\real4-proto.js --no-sandbox
(async () => {
  const OUT_ID = 0x51;
  const hex = (value, digits) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
  const bytesHex = (bytes) => Array.from(bytes, (byte) => hex(byte, 2)).join(' ');
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
    frame[0] = unit & 0xff;
    frame[1] = func & 0xff;
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
    const issues = [];
    let offset = 0;
    while (offset < buffer.length) {
      while (offset + 1 < buffer.length && buffer[offset] === 0 && buffer[offset + 1] === 0) offset += 1;
      if (buffer.length - offset < 4) break;
      const len = (buffer[offset + 2] << 8) | buffer[offset + 3];
      if (len < 6 || len > 1024) {
        issues.push({ reason: `bad Len ${len}`, offset });
        offset += 1;
        continue;
      }
      if (len > buffer.length - offset) break;
      const expected = crc16(buffer.subarray(offset, offset + len - 2));
      const received = buffer[offset + len - 2] | (buffer[offset + len - 1] << 8);
      if (expected !== received) {
        issues.push({ reason: 'crc', offset });
        offset += 1;
        continue;
      }
      frames.push({ unit: buffer[offset], func: buffer[offset + 1], len, data: buffer.slice(offset + 4, offset + len - 2) });
      offset += len;
    }
    return { frames, issues, rest: buffer.slice(offset) };
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
  function summarize(frame) {
    const base = { unit: hex(frame.unit, 2), func: `0x${hex(frame.func, 2)}`, frameBytes: frame.len, dataBytes: frame.data.length };
    if (frame.func === 0x02) return { ...base, ack: `0x${hex((frame.data[0] << 8) | frame.data[1], 4)}` };
    if (frame.func === 0x13) {
      const start = (frame.data[0] << 8) | frame.data[1];
      const count = (frame.data[2] << 8) | frame.data[3];
      return { ...base, start: `0x${hex(start, 4)}`, count, first: Array.from(frame.data.slice(4, 12), (b) => hex(b, 2)).join(' ') };
    }
    if (frame.func === 0x12) {
      const entries = [];
      for (let at = 0; at + 3 < frame.data.length; at += 4) {
        entries.push(`0x${hex((frame.data[at] << 8) | frame.data[at + 1], 4)}=${(frame.data[at + 2] << 8) | frame.data[at + 3]}`);
      }
      return { ...base, entries };
    }
    return base;
  }

  const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ error: '设备不在列' });
  if (device.opened) await device.close().catch(() => undefined);
  await device.open();

  let inbound = new Uint8Array(0);
  let reportIds = {};
  const onReport = (event) => {
    reportIds[`0x${hex(event.reportId, 2)}`] = (reportIds[`0x${hex(event.reportId, 2)}`] ?? 0) + 1;
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const merged = new Uint8Array(inbound.length + bytes.length);
    merged.set(inbound, 0);
    merged.set(bytes, inbound.length);
    inbound = merged;
  };
  device.addEventListener('inputreport', onReport);

  async function transact(frame, opts = {}) {
    const waitMs = opts.waitMs ?? 900;
    const settleMs = opts.settleMs ?? 250;
    inbound = new Uint8Array(0);
    const sentAt = performance.now();
    for (const report of splitReports(frame)) await device.sendReport(OUT_ID, report);
    const sendMs = performance.now() - sentAt;
    let firstAt = null;
    const deadline = performance.now() + waitMs;
    while (performance.now() < deadline) {
      const decoded = decodeStream(inbound);
      if (decoded.frames.length > 0) {
        if (firstAt === null) firstAt = performance.now();
        if (performance.now() - firstAt >= settleMs) break;
      }
      await sleep(6);
    }
    const decoded = decodeStream(inbound);
    return {
      requestHex: bytesHex(frame),
      sendMs: Number(sendMs.toFixed(2)),
      firstReplyMs: firstAt === null ? null : Number((firstAt - sentAt).toFixed(2)),
      rawBytes: inbound.length,
      frames: decoded.frames.map(summarize),
      frameCount: decoded.frames.length,
      issues: decoded.issues,
      partial: bytesHex(decoded.rest),
    };
  }

  const readSeq = (start, count, opts) => transact(encodeFrame(0, 0x13, Uint8Array.from([(start >> 8) & 0xff, start & 0xff, (count >> 8) & 0xff, count & 0xff])), opts);
  const readRand = (addrs, opts) =>
    transact(encodeFrame(0, 0x12, Uint8Array.from(addrs.flatMap((addr) => [(addr >> 8) & 0xff, addr & 0xff]))), opts);
  const writeOne = (addr, value, opts) => transact(encodeFrame(0, 0x10, Uint8Array.from([(addr >> 8) & 0xff, addr & 0xff, (value >> 8) & 0xff, value & 0xff])), opts);
  const valuesOf = (result) => {
    const frame = result.frames.find((item) => item.func === '0x13');
    if (!frame) return null;
    return frame;
  };
  // 全量读：把 0x13 应答的 2 B 值解出来（summarize 只给了前 8 字节，这里重解一次）
  async function readFull(start, count) {
    inbound = new Uint8Array(0);
    for (const report of splitReports(encodeFrame(0, 0x13, Uint8Array.from([(start >> 8) & 0xff, start & 0xff, (count >> 8) & 0xff, count & 0xff])))) {
      await device.sendReport(OUT_ID, report);
    }
    const sentAt = performance.now();
    let reply = null;
    while (performance.now() - sentAt < 1500) {
      const decoded = decodeStream(inbound);
      reply = decoded.frames.find((item) => item.func === 0x13);
      if (reply) break;
      await sleep(6);
    }
    if (!reply) return { ok: false, ms: Number((performance.now() - sentAt).toFixed(2)) };
    const values = {};
    const total = (reply.data[2] << 8) | reply.data[3];
    for (let index = 0; index < total; index += 1) {
      const at = 4 + index * 2;
      if (at + 1 >= reply.data.length) break;
      values[`0x${hex(((reply.data[0] << 8) | reply.data[1]) + index, 4)}`] = (reply.data[at] << 8) | reply.data[at + 1];
    }
    return { ok: true, ms: Number((performance.now() - sentAt).toFixed(2)), frameBytes: reply.len, count: total, values };
  }

  const out = { steps: [] };
  const record = (name, value) => out.steps.push({ name, ...value });

  // 1) 全量读取与有效区间
  for (const [label, start, count] of [
    ['seqRead 0x2000 x114', 0x2000, 114],
    ['seqRead 0x2000 x118', 0x2000, 118],
    ['seqRead 0x2000 x120', 0x2000, 120],
    ['seqRead 0x2000 x130', 0x2000, 130],
  ]) {
    const result = await readFull(start, count);
    record(label, { ok: result.ok, ms: result.ms, frameBytes: result.frameBytes, count: result.count, tail: result.values ? Object.fromEntries(Object.entries(result.values).slice(-6)) : null });
    await sleep(150);
  }

  const preset114 = await readFull(0x2000, 114);
  out.preset = preset114.values ?? null;

  // 2) 0x2072..0x2075 是否存在
  record('randRead 0x2072..0x2075', (await readRand([0x2072, 0x2073, 0x2074, 0x2075])).frames);

  // 3) 信息区 / 配置区
  const info = await readFull(0x0000, 62);
  record('deviceInfo 0x0000 x62', {
    ok: info.ok,
    frameBytes: info.frameBytes,
    nonZero: info.values ? Object.entries(info.values).filter(([, value]) => value !== 0) : null,
  });
  const config = await readFull(0x1000, 14);
  record('config 0x1000 x14', { ok: config.ok, values: config.values });
  await sleep(150);

  // 4) 只读 / 范围 / 未知地址写（测完恢复原值）
  const orig = preset114.values ?? {};
  const restore = async (addr, value) => {
    const result = await writeOne(addr, value, { waitMs: 3200, settleMs: 800 });
    return result.frames;
  };
  for (const [label, addr, raw] of [
    ['write readOnly 0x2023 = 55', 0x2023, 55],
    ['write range 0x2025 = 5 (域 0..3)', 0x2025, 5],
    ['write range 0x2025 = 999', 0x2025, 999],
    ['write unknown 0x3000 = 1', 0x3000, 1],
  ]) {
    const original = orig[`0x${hex(addr, 4)}`] ?? 0;
    const write = await writeOne(addr, raw, { waitMs: 3200, settleMs: 900 });
    await sleep(1200);
    const back = await readFull(addr, 1);
    record(label, {
      originalRaw: original,
      ack: write.frames.filter((item) => item.func === '0x02').map((item) => item.ack),
      replyFrames: write.frameCount,
      readBack: back.values ? Object.values(back.values)[0] : null,
    });
    if (original !== (back.values ? Object.values(back.values)[0] : null)) {
      const restored = await restore(addr, original);
      const after = await readFull(addr, 1);
      record(`restore 0x${hex(addr, 4)} = ${original}`, { ack: restored.filter((item) => item.func === '0x02').map((item) => item.ack), readBack: after.values ? Object.values(after.values)[0] : null });
      await sleep(900);
    }
  }

  // 5) 拒绝路径：UnitID / 长度 / CRC / 未知功能码
  const unitFrame = encodeFrame(0, 0x13, Uint8Array.from([0x20, 0x00, 0x00, 0x01]));
  unitFrame[0] = 0x01;
  unitFrame[unitFrame.length - 2] = crc16(unitFrame.subarray(0, unitFrame.length - 2)) & 0xff;
  unitFrame[unitFrame.length - 1] = crc16(unitFrame.subarray(0, unitFrame.length - 2)) >>> 8;
  const unitResult = await transact(unitFrame, { waitMs: 1600, settleMs: 1400 });
  record('reject unitId=0x01 (bad unit)', { frames: unitResult.frameCount, acks: unitResult.frames.filter((item) => item.func === '0x02').map((item) => item.ack), rawBytes: unitResult.rawBytes });

  const lenFrame = Uint8Array.from([0x00, 0x13, 0x00, 0x04, 0x00, 0x00]);
  const lenCrc = crc16(lenFrame.subarray(0, 4));
  lenFrame[4] = lenCrc & 0xff;
  lenFrame[5] = lenCrc >>> 8;
  const lenResult = await transact(lenFrame, { waitMs: 1600, settleMs: 900 });
  record('reject Len=4', { frames: lenResult.frameCount, acks: lenResult.frames.filter((item) => item.func === '0x02').map((item) => item.ack) });

  const badCrc = encodeFrame(0, 0x13, Uint8Array.from([0x20, 0x00, 0x00, 0x01]));
  badCrc[badCrc.length - 1] ^= 0xff;
  const crcResult = await transact(badCrc, { waitMs: 1600, settleMs: 900 });
  record('reject bad CRC', { frames: crcResult.frameCount, acks: crcResult.frames.filter((item) => item.func === '0x02').map((item) => item.ack) });

  const unknownFunc = await transact(encodeFrame(0, 0x20, Uint8Array.from([0x00, 0x01])), { waitMs: 1600, settleMs: 900 });
  record('reject unknown func 0x20', { frames: unknownFunc.frameCount, acks: unknownFunc.frames.filter((item) => item.func === '0x02').map((item) => item.ack), rawBytes: unknownFunc.rawBytes });

  // 6) 电平：连续读 10 次 0x2057，并统计主动上报
  const levels = [];
  const beforeReports = { ...reportIds };
  for (let index = 0; index < 10; index += 1) {
    const result = await readRand([0x2057], { waitMs: 700, settleMs: 60 });
    const entry = result.frames.find((item) => item.func === '0x12');
    levels.push(entry?.entries?.[0] ?? null);
    await sleep(80);
  }
  await sleep(1200);
  const idleReports = {};
  for (const [id, count] of Object.entries(reportIds)) idleReports[id] = count - (beforeReports[id] ?? 0);
  record('level 0x2057 x10', { levels, unsolicitedReportIds: idleReports });

  // 7) 连续写（0x11）支持：把 noisegate attack/release 原值写回
  const seqWriteData = Uint8Array.from([0x20, 0x5d, 0x00, 0x02, 0x00, 0x05, 0x00, 0x05]);
  const seqWrite = await transact(encodeFrame(0, 0x11, seqWriteData), { waitMs: 3200, settleMs: 900 });
  record('seqWrite 0x205D..0x205E (原值)', { ack: seqWrite.frames.filter((item) => item.func === '0x02').map((item) => item.ack) });

  // 8) 写后全量回读，确认参数仍是测试前的值（除场景写入）
  const finalPreset = await readFull(0x2000, 114);
  out.finalPreset = finalPreset.values ?? null;
  out.reportIdCounts = reportIds;

  device.removeEventListener('inputreport', onReport);
  await device.close().catch(() => undefined);
  return JSON.stringify(out);
})()
