// 第六轮真机联调 · 裸 HID 真值快照：信息区 / 配置区 / 预设区全量字 + 读容量 / 非法地址 /
// 写 ACK 时延 / 电平采样 / 空闲主动上报。只读为主，写入全部先读原值再恢复。
//   electron.exe . --screenshot=artifacts\real6\registers.png --route=device --exec-file=scripts\probes\real6-registers.js --no-sandbox
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const hx = (value, digits = 2) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
  const bytesHex = (bytes) => Array.from(bytes, (byte) => hx(byte)).join(' ');

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
  function splitReports(bytes) {
    const reports = [];
    for (let offset = 0; offset < bytes.length; offset += 63) {
      const report = new Uint8Array(63);
      report.set(bytes.subarray(offset, Math.min(offset + 63, bytes.length)));
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
      frames.push({ func: buffer[offset + 1], data: buffer.slice(offset + 4, offset + len - 2) });
      offset += len;
    }
    return { frames };
  }

  const out = { cases: [] };
  try {
  const hid = navigator.hid;
  const devices = await hid.getDevices();
  const device = devices.find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ error: '目标设备不在列（0A67/0010）' });
  await device.open();

  const inbox = [];
  let reportsSeen = 0;
  const inputIds = new Set();
  const onReport = (event) => {
    reportsSeen += 1;
    inputIds.add(hx(event.reportId));
    inbox.push(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
  };
  device.addEventListener('inputreport', onReport);

  function pull() {
    const batch = inbox.splice(0, inbox.length);
    const merged = new Uint8Array(batch.reduce((sum, item) => sum + item.length, 0));
    let cursor = 0;
    for (const item of batch) {
      merged.set(item, cursor);
      cursor += item.length;
    }
    return merged;
  }

  async function exchange(frame, { waitMs = 500, quietMs = 120 } = {}) {
    pull();
    const sentAt = performance.now();
    for (const report of splitReports(frame)) {
      await device.sendReport(0x51, report);
      await sleep(2);
    }
    let buffer = new Uint8Array(0);
    let firstAt = null;
    const append = () => {
      const batch = pull();
      if (batch.length === 0) return buffer;
      const next = new Uint8Array(buffer.length + batch.length);
      next.set(buffer, 0);
      next.set(batch, buffer.length);
      buffer = next;
      return buffer;
    };
    let lastCount = 0;
    while (performance.now() - sentAt < waitMs) {
      const decoded = decodeStream(append());
      if (decoded.frames.length > 0) {
        if (firstAt === null) firstAt = performance.now();
        lastCount = decoded.frames.length;
        await sleep(quietMs);
        if (decodeStream(append()).frames.length === lastCount) break;
      } else {
        await sleep(3);
      }
    }
    const decoded = decodeStream(append());
    return { ms: firstAt === null ? null : Math.round(firstAt - sentAt), frames: decoded.frames, bytes: buffer.length };
  }

  const ackOf = (reply) => {
    const frame = reply.frames.find((item) => item.func === 0x02);
    return frame && frame.data.length >= 2 ? (frame.data[0] << 8) | frame.data[1] : null;
  };
  const seqRead = async (start, count) => {
    const reply = await exchange(encodeFrame(0x13, Uint8Array.from([(start >> 8) & 0xff, start & 0xff, (count >> 8) & 0xff, count & 0xff])),
      { waitMs: count > 60 ? 900 : 500 });
    const frame = reply.frames.find((item) => item.func === 0x13);
    if (!frame) return { words: [], ack: ackOf(reply), frames: reply.frames.length };
    const words = [];
    const total = (frame.data[2] << 8) | frame.data[3];
    for (let index = 0; index < total; index += 1) words.push((frame.data[4 + index * 2] << 8) | frame.data[5 + index * 2]);
    return { words, len: frame.len, ms: reply.ms };
  };
  const randRead = async (addrs) => {
    const data = Uint8Array.from(addrs.flatMap((addr) => [(addr >> 8) & 0xff, addr & 0xff]));
    const reply = await exchange(encodeFrame(0x12, data), { waitMs: 900 });
    const frame = reply.frames.find((item) => item.func === 0x12);
    return { frame, ack: ackOf(reply), frames: reply.frames.length, bytes: reply.bytes, ms: reply.ms };
  };

  // 1) 三个区全量字
  const info = await seqRead(0x0000, 62);
  out.info = info.words;
  out.infoLen = info.len;
  const config = await seqRead(0x1000, 14);
  out.config = config.words;
  const preset114 = await seqRead(0x2000, 114);
  out.preset = preset114.words;
  out.presetLen = preset114.len;
  const preset118 = await seqRead(0x2000, 118);
  out.preset118 = preset118.words;
  out.preset118Len = preset118.len;

  // 2) 读容量边界
  out.capacity = {};
  for (const count of [119, 120, 126]) {
    const reply = await exchange(encodeFrame(0x13, Uint8Array.from([0x20, 0x00, 0x00, count])));
    const frame = reply.frames.find((item) => item.func === 0x13);
    out.capacity[`seq${count}`] = { frames: reply.frames.length, ack: ackOf(reply), dataWords: frame ? frame.data.length : null };
  }
  for (const count of [118, 119, 124, 125, 126, 127]) {
    const addrs = Array.from({ length: count }, (_, index) => 0x2000 + index);
    const reply = await randRead(addrs);
    const frame = reply.frame;
    const pairs = frame ? Math.floor(frame.data.length / 4) : 0;
    out.capacity[`rand${count}`] = { frames: reply.frames, ack: reply.ack, pairs, bytes: reply.bytes, ms: reply.ms };
  }

  // 3) 非法地址读（0x2076/0x3000/0x4000 各 3 次）
  out.illegal = {};
  for (const addr of [0x2076, 0x3000, 0x4000]) {
    const samples = [];
    for (let index = 0; index < 3; index += 1) {
      const reply = await exchange(encodeFrame(0x13, Uint8Array.from([(addr >> 8) & 0xff, addr & 0xff, 0x00, 0x01])));
      const frame = reply.frames.find((item) => item.func === 0x13);
      samples.push({
        ack: ackOf(reply),
        value: frame && frame.data.length >= 6 ? (frame.data[4] << 8) | frame.data[5] : null,
        raw: frame ? bytesHex(frame.data.subarray(0, 8)) : null,
        frames: reply.frames.length,
      });
      await sleep(120);
    }
    out.illegal[hx(addr, 4)] = samples;
  }

  // 4) 写 ACK 时延：0x205D（噪声门启动时间，5..500）写 5 次后恢复
  const originalD = (await seqRead(0x205d, 1)).words[0];
  out.writeLatency = { addr: '0x205D', original: originalD, samples: [] };
  for (let index = 0; index < 5; index += 1) {
    const value = 10 + index * 5;
    const reply = await exchange(encodeFrame(0x10, Uint8Array.from([0x20, 0x5d, (value >> 8) & 0xff, value & 0xff])));
    out.writeLatency.samples.push({ value, ack: ackOf(reply), ms: reply.ms, frames: reply.frames.length });
    await sleep(80);
  }
  const restore = await exchange(encodeFrame(0x10, Uint8Array.from([0x20, 0x5d, ((originalD ?? 0) >> 8) & 0xff, (originalD ?? 0) & 0xff])));
  out.writeLatency.restore = { value: originalD, ack: ackOf(restore), ms: restore.ms };

  // 5) 电平 0x2057 采样 20 次（50 ms）
  out.level = [];
  for (let index = 0; index < 20; index += 1) {
    out.level.push((await seqRead(0x2057, 1)).words[0] ?? null);
    await sleep(50);
  }

  // 6) 空闲 8 s 主动上报
  pull();
  const unsolicited = [];
  const startAt = performance.now();
  while (performance.now() - startAt < 8000) {
    const batch = pull();
    if (batch.length > 0) {
      for (const frame of decodeStream(batch)) unsolicited.push({ func: `0x${hx(frame.func)}`, len: frame.len });
    }
    await sleep(50);
  }
  out.unsolicited = unsolicited;
  out.inputReportIds = [...inputIds];
  out.reportsSeen = reportsSeen;

  device.removeEventListener('inputreport', onReport);
  try {
    await device.close();
  } catch {
    /* ignore */
  }
  return JSON.stringify(out);
  } catch (error) {
    return JSON.stringify({ fatal: String(error), stack: error && error.stack, partial: out });
  }
})()
