// 第六轮真机联调 · 协议边角：0x10 设备→主机上报语义、拒绝路径 ACK 条数、未知功能码、
// 写后立即读时延。所有写先读原值、测完恢复。
//   electron.exe . --screenshot=artifacts\real6\proto-extras.png --route=device --exec-file=scripts\probes\real6-proto-extras.js --no-sandbox
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
    return frames;
  }

  const out = { echo: [], reject: {}, timing: {} };
  const devices = await navigator.hid.getDevices();
  const device = devices.find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ error: '目标设备不在列（0A67/0010）' });
  await device.open();

  const inbox = [];
  const onReport = (event) => inbox.push(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
  device.addEventListener('inputreport', onReport);
  const pull = () => {
    const batch = inbox.splice(0, inbox.length);
    const merged = new Uint8Array(batch.reduce((sum, item) => sum + item.length, 0));
    let cursor = 0;
    for (const item of batch) {
      merged.set(item, cursor);
      cursor += item.length;
    }
    return merged;
  };
  const send = async (frame) => {
    for (const report of splitReports(frame)) {
      await device.sendReport(0x51, report);
      await sleep(2);
    }
  };
  const collect = async (ms) => {
    const frames = [];
    const started = performance.now();
    while (performance.now() - started < ms) {
      const batch = pull();
      if (batch.length > 0) frames.push(...decodeStream(batch));
      await sleep(5);
    }
    return frames;
  };
  const exchangeFixed = async (frame, waitMs) => {
    pull();
    const sentAt = performance.now();
    await send(frame);
    await sleep(waitMs);
    const frames = decodeStream(pull());
    return { frames, ms: Math.round(performance.now() - sentAt) };
  };
  const ackOf = (frames) => {
    const frame = frames.find((item) => item.func === 0x02);
    return frame && frame.data.length >= 2 ? (frame.data[0] << 8) | frame.data[1] : null;
  };
  const readOne = async (addr) => {
    const reply = await exchangeFixed(encodeFrame(0x13, Uint8Array.from([(addr >> 8) & 0xff, addr & 0xff, 0x00, 0x01])), 160);
    const frame = reply.frames.find((item) => item.func === 0x13);
    return frame ? (frame.data[4] << 8) | frame.data[5] : null;
  };
  const writeOne = (addr, value) =>
    exchangeFixed(encodeFrame(0x10, Uint8Array.from([(addr >> 8) & 0xff, addr & 0xff, (value >> 8) & 0xff, value & 0xff])), 160);

  // 1) 0x10 上报语义：改 0x2024（ENC 开关），看有没有主动上报
  const encOrigin = await readOne(0x2024);
  pull();
  const encWrite = await exchangeFixed(encodeFrame(0x10, Uint8Array.from([0x20, 0x24, 0x00, encOrigin === 1 ? 0 : 1])), 60);
  const afterEnc = await collect(500);
  out.echo.push({
    label: '写 0x2024 后 500ms',
    ack: ackOf(encWrite.frames),
    immediate: encWrite.frames.map((item) => `0x${hx(item.func)}:${bytesHex(item.data)}`),
    followUp: afterEnc.map((item) => `0x${hx(item.func)}:${bytesHex(item.data)}`),
  });

  // 2) 写非回显参数 0x205B（阈值），看上报是否只针对 0x2024/0x2025
  const gateOrigin = await readOne(0x205b);
  pull();
  const gateWrite = await writeOne(0x205b, gateOrigin === 0 ? 1 : 0);
  const afterGate = await collect(500);
  out.echo.push({
    label: '写 0x205B 后 500ms',
    ack: ackOf(gateWrite.frames),
    immediate: gateWrite.frames.map((item) => `0x${hx(item.func)}:${bytesHex(item.data)}`),
    followUp: afterGate.map((item) => `0x${hx(item.func)}:${bytesHex(item.data)}`),
  });

  // 3) 写同值（把 0x2024 再写成当前值）——如果设备“只在变化时上报”，这里应无 0x10
  const encCurrent = encOrigin === 1 ? 0 : 1;
  pull();
  const sameWrite = await writeOne(0x2024, encCurrent);
  const afterSame = await collect(500);
  out.echo.push({
    label: '写 0x2024 同值（无变化）后 500ms',
    ack: ackOf(sameWrite.frames),
    immediate: sameWrite.frames.map((item) => `0x${hx(item.func)}:${bytesHex(item.data)}`),
    followUp: afterSame.map((item) => `0x${hx(item.func)}:${bytesHex(item.data)}`),
  });

  // 恢复 0x2024 / 0x205B
  await writeOne(0x2024, encOrigin);
  await writeOne(0x205b, gateOrigin);
  await sleep(300);

  // 4) 拒绝路径：UnitID 错 / 坏 CRC / Len 错，各数 2 s 内的 ACK 条数
  const countReject = async (label, frame) => {
    pull();
    await send(frame);
    const frames = await collect(2000);
    const acks = frames.filter((item) => item.func === 0x02);
    out.reject[label] = {
      total: frames.length,
      acks: acks.length,
      codes: acks.map((item) => `0x${hx((item.data[0] << 8) | item.data[1], 4)}`),
      others: frames.filter((item) => item.func !== 0x02).map((item) => `0x${hx(item.func)}`),
    };
    await sleep(1200);
  };
  await countReject('unitId', encodeFrame(0x13, Uint8Array.from([0x00, 0x0b, 0x00, 0x01]), 0x01));
  const badCrc = encodeFrame(0x13, Uint8Array.from([0x00, 0x0b, 0x00, 0x01]));
  badCrc[badCrc.length - 1] ^= 0xff;
  await countReject('badCrc', badCrc);
  await countReject('lenError', encodeFrame(0x13, Uint8Array.from([0x20, 0x00, 0x00])));
  await countReject('unknownFunc', encodeFrame(0x20, Uint8Array.from([0x00, 0x00])));

  // 5) 写后立即读时延
  const originD = await readOne(0x205d);
  out.timing.writeAfterRead = [];
  for (let index = 0; index < 6; index += 1) {
    const value = 60 + index * 10;
    const write = await exchangeFixed(encodeFrame(0x10, Uint8Array.from([0x20, 0x5d, 0x00, value])), 40);
    const writeAckAt = write.ms;
    const readStart = performance.now();
    const read = await exchangeFixed(encodeFrame(0x13, Uint8Array.from([0x20, 0x57, 0x00, 0x01])), 40);
    out.timing.writeAfterRead.push({
      value,
      writeAckAt,
      writeAck: ackOf(write.frames),
      readFrames: read.frames.length,
      readAt: Math.round(performance.now() - readStart),
    });
    await sleep(200);
  }
  await writeOne(0x205d, originD ?? 0);

  device.removeEventListener('inputreport', onReport);
  try {
    await device.close();
  } catch {
    /* ignore */
  }
  return JSON.stringify(out);
})()
