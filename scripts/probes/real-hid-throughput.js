// 真机 IN 通道定量：空闲推送节奏、干净帧的往返延迟与可持续速率、sync 连发时第二条请求的下场。
//   electron.exe . --screenshot=artifacts\real\throughput.png --route=device --exec-file=scripts\probes\real-hid-throughput.js --no-sandbox
// 只读：不写任何寄存器。
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
  const cleanRead = (addrs) => encodeFrame(0x12, addrBytes(addrs));
  const infoAddrs = [];
  const push = (start, count) => {
    for (let index = 0; index < count; index += 1) infoAddrs.push(start + index);
  };
  push(0x0000, 3);
  push(0x0003, 3);
  push(0x000b, 4);
  push(0x000f, 1);
  push(0x0016, 1);
  push(0x0017, 1);
  push(0x001e, 32);
  infoAddrs.push(0x1007);
  const watch28 = [0x2024, 0x2025, 0x2026, 0x2023, 0x205a, 0x2057, 0x2059, 0x204a, 0x2051, 0x2058, 0x2022, 0x2001, 0x2000,
    0x2027, 0x2028, 0x2029, 0x202a, 0x202b, 0x2040, 0x2045, 0x205b, 0x205c, 0x205d, 0x205e, 0x205f, 0x1000, 0x1007, 0x000b];

  const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ error: '设备不在列' });
  if (!device.opened) await device.open();

  let events = [];
  const onReport = (event) => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    events.push({ at: performance.now(), bytes });
  };
  device.addEventListener('inputreport', onReport);

  const sendFrame = async (frame) => {
    for (const report of splitFrame(frame)) await device.sendReport(OUT_ID, report);
  };
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

  const out = {};

  // A. 空闲 2 s：设备自主推送的节奏
  events = [];
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const idleFrames = decodeAll();
  const gaps = [];
  for (let index = 1; index < events.length; index += 1) gaps.push(Math.round(events[index].at - events[index - 1].at));
  out.idle = {
    windowMs: 2000,
    reports: events.length,
    frames: idleFrames.map((item) => `0x${hex(item.func, 2)}`),
    gapsMs: gaps,
    meanGapMs: gaps.length === 0 ? null : Math.round(gaps.reduce((sum, value) => sum + value, 0) / gaps.length),
  };

  // B. 干净帧连发 10 次：每次等回包后立刻发下一条，量可持续速率
  const latencies = [];
  for (let index = 0; index < 10; index += 1) {
    events = [];
    const started = performance.now();
    await sendFrame(cleanRead(watch28));
    let replied = false;
    while (performance.now() - started < 500) {
      if (decodeAll().some((item) => item.func === 0x12)) {
        replied = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    latencies.push({ ok: replied, ms: Math.round(performance.now() - started), reports: events.length });
  }
  out.cleanRoundTrips = latencies;

  // C. 复刻 sync：两条请求背靠背，观察第二条的命运（窗口拉到 2.5 s）
  events = [];
  const t0 = performance.now();
  await sendFrame(encodeFrame(0x13, new Uint8Array([0x20, 0x00, 0x00, 0x72])));
  while (performance.now() - t0 < 500) {
    if (decodeAll().some((item) => item.func === 0x13)) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const replyAt = events.length > 0 ? Math.round(events[0].at - t0) : null;
  await sendFrame(encodeFrame(0x12, addrBytes(infoAddrs)));
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const frames = decodeAll();
  out.syncMimic = {
    seqReplyAtMs: replyAt,
    totalReports: events.length,
    sequence: frames.map((item) => {
      if (item.func === 0x02) return `ACK ${hex((item.data[0] << 8) | item.data[1], 4)}`;
      if (item.func === 0x12) return `RAND_READ ${item.data.length}B`;
      if (item.func === 0x13) return `SEQ_READ ${item.data.length}B`;
      if (item.func === 0x10) return 'PUSH 2057';
      return `0x${hex(item.func, 2)}`;
    }),
    randReadAnswered: frames.some((item) => item.func === 0x12),
  };

  device.removeEventListener('inputreport', onReport);
  await device.close();
  return JSON.stringify(out);
})()
