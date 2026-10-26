// 第二轮真机联调 · 帧边界与并发：补位长度扫描 + 零间隔连发 + 间隔阈值 + 吞吐。
//   electron.exe . --screenshot=artifacts\real2\timing.png --route=device --exec-file=scripts\probes\real2-timing.js --no-sandbox
// 判据（协议 §3-P0-1 / 评审 P0-1、F1、F2）：一请求一应答；补位不产生额外 ACK；零间隔连发不闭锁。
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
  function encodeFrame(func, data, unitId = 0x00) {
    const len = data.length + 6;
    const frame = new Uint8Array(len);
    frame[0] = unitId;
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
      frames.push({ unitId: buffer[offset], func: buffer[offset + 1], len, data: buffer.slice(offset + 4, offset + len - 2) });
      offset += len;
    }
    return frames;
  }
  const addrList = (addrs) => Uint8Array.from(addrs.flatMap((addr) => [(addr >>> 8) & 0xff, addr & 0xff]));
  const seqBytes = (start, count) => Uint8Array.from([(start >>> 8) & 0xff, start & 0xff, (count >>> 8) & 0xff, count & 0xff]);

  const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ error: '设备不在列（VID 0A67 / PID 0010）' });
  if (!device.opened) await device.open();

  let events = [];
  let mark = 0;
  const onReport = (event) => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    events.push({ at: Math.round(performance.now() - mark), bytes });
  };
  device.addEventListener('inputreport', onReport);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function run(frames, options = {}) {
    const idleMs = options.idleMs ?? 70;
    const maxMs = options.maxMs ?? 1500;
    events = [];
    mark = performance.now();
    for (const frame of frames) for (const report of splitFrame(frame)) await device.sendReport(OUT_ID, report);
    const sentAt = performance.now() - mark;
    const started = performance.now();
    let seen = 0;
    let lastAt = performance.now();
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
    return {
      sentFrames: frames.length,
      sentReports: frames.reduce((sum, frame) => sum + Math.ceil(frame.length / PAYLOAD), 0),
      sentAtMs: Math.round(sentAt),
      inboundReports: events.length,
      inboundBytes: merged.length,
      firstAtMs: events.length > 0 ? events[0].at : null,
      lastAtMs: events.length > 0 ? events[events.length - 1].at : null,
      frames: framesOut,
    };
  }

  const out = { device: { vendorId: `0x${hex(device.vendorId, 4)}`, productId: `0x${hex(device.productId, 4)}` }, sweeps: [] };

  // A) 补位长度扫描：0x12 读 N 个地址，请求帧 4+2N+2 字节，响应 4+4N+2 字节
  const padRows = [];
  for (const count of [1, 2, 4, 8, 16, 22, 26, 28, 29, 30]) {
    const addrs = Array.from({ length: count }, (_, index) => 0x2000 + index);
    const request = encodeFrame(0x12, addrList(addrs));
    const responseBytes = 4 + count * 4 + 2;
    const result = await run([request], { maxMs: 900 });
    await sleep(40);
    const dataFrames = result.frames.filter((item) => item.func === 0x12);
    const acks = result.frames.filter((item) => item.func === 0x02);
    padRows.push({
      addresses: count,
      requestBytes: request.length,
      padding: Math.ceil(request.length / PAYLOAD) * PAYLOAD - request.length,
      requestReports: Math.ceil(request.length / PAYLOAD),
      responseBytes,
      expectedResponseReports: Math.ceil(responseBytes / PAYLOAD),
      inboundReports: result.inboundReports,
      dataFrames: dataFrames.length,
      acks: acks.length,
      firstAtMs: result.firstAtMs,
      ok: dataFrames.length === 1 && acks.length === 0 && result.inboundReports === Math.ceil(responseBytes / PAYLOAD),
    });
  }
  out.sweeps.push({ id: 'A-padding', label: '补位长度 ↔ 回执报文数（每行一次独立请求）', rows: padRows });

  // B) 零间隔连发：20 条不同地址的 0x12 一次性灌入，看是否每条都有应答
  const burstAddresses = Array.from({ length: 20 }, (_, index) => 0x2000 + index);
  const burst = await run(
    burstAddresses.map((addr) => encodeFrame(0x12, addrList([addr]))),
    { idleMs: 150, maxMs: 3000 },
  );
  const answered = new Set();
  for (const frame of burst.frames) {
    if (frame.func !== 0x12 || frame.data.length < 4) continue;
    answered.add((frame.data[0] << 8) | frame.data[1]);
  }
  out.sweeps.push({
    id: 'B-burst',
    label: '零间隔连发 20 条 0x12（每条读 0x2000..0x2013 之一）',
    sentFrames: burst.sentFrames,
    sentReports: burst.sentReports,
    sentAtMs: burst.sentAtMs,
    inboundReports: burst.inboundReports,
    dataFrames: burst.frames.filter((item) => item.func === 0x12).length,
    acks: burst.frames.filter((item) => item.func === 0x02).length,
    answeredAddresses: answered.size,
    missing: burstAddresses.filter((addr) => !answered.has(addr)).map((addr) => `0x${hex(addr, 4)}`),
    firstAtMs: burst.firstAtMs,
    lastAtMs: burst.lastAtMs,
  });

  // C) 间隔阈值：两次独立请求之间的静默取 0 / 20 / 50 / 100 / 200 / 400 / 800 ms
  const gapRows = [];
  for (const gap of [0, 20, 50, 100, 200, 400, 800]) {
    const first = await run([encodeFrame(0x12, addrList([0x2024]))], { maxMs: 700 });
    await sleep(gap);
    const second = await run([encodeFrame(0x12, addrList([0x2057]))], { maxMs: 700 });
    gapRows.push({
      gapMs: gap,
      firstOk: first.frames.filter((item) => item.func === 0x12).length === 1,
      secondOk: second.frames.filter((item) => item.func === 0x12).length === 1,
      secondInbound: second.inboundReports,
      secondFirstAtMs: second.firstAtMs,
    });
    await sleep(120);
  }
  out.sweeps.push({ id: 'C-gap', label: '请求间隔 ↔ 第二条请求是否被应答（F2 复测）', rows: gapRows });

  // D) 吞吐：50 条 0x12 顺序（等应答再发）与 50 条流水（不等应答）
  const sequential = [];
  for (let index = 0; index < 20; index += 1) {
    const one = await run([encodeFrame(0x12, addrList([0x2024]))], { idleMs: 40, maxMs: 600 });
    sequential.push(one.firstAtMs);
  }
  out.sweeps.push({
    id: 'D-sequential',
    label: '20 次「发→等→再发」单地址读往返延迟（ms）',
    latencies: sequential,
    avgMs: Math.round(sequential.reduce((sum, value) => sum + (value ?? 0), 0) / sequential.length),
    maxMs: Math.max(...sequential.map((value) => value ?? 0)),
  });

  const pipelineStart = performance.now();
  const pipeline = await run(
    Array.from({ length: 50 }, () => encodeFrame(0x12, addrList([0x2024]))),
    { idleMs: 200, maxMs: 5000 },
  );
  const pipelineElapsed = Math.round(performance.now() - pipelineStart);
  out.sweeps.push({
    id: 'D-pipeline',
    label: '50 条 0x12 一次性流水（不等应答）',
    sentFrames: pipeline.sentFrames,
    sentReports: pipeline.sentReports,
    inboundReports: pipeline.inboundReports,
    dataFrames: pipeline.frames.filter((item) => item.func === 0x12).length,
    acks: pipeline.frames.filter((item) => item.func === 0x02).length,
    elapsedMs: pipelineElapsed,
    firstAtMs: pipeline.firstAtMs,
    lastAtMs: pipeline.lastAtMs,
  });

  device.removeEventListener('inputreport', onReport);
  await device.close();
  return JSON.stringify(out);
})()
