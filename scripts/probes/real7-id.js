// 第七轮（V0.0.6 全量测试）· 设备身份快读：型号 / 固件版本 / VID-PID / 产品名，用来判断
// 设备现在是 App 模式、Bootloader 还是"刷了一半"。
//   electron.exe . --screenshot=artifacts\real7\id.png --route=device --exec-file=scripts\probes\real7-id.js --no-sandbox
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const hx = (value, digits = 4) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
  const decodeAscii = (words) => {
    let text = '';
    for (const word of words) {
      const high = (word >> 8) & 0xff;
      const low = word & 0xff;
      if (high === 0 || high === 0xff) break;
      text += String.fromCharCode(high);
      if (low === 0 || low === 0xff) break;
      text += String.fromCharCode(low);
    }
    return text.replace(/\s+$/, '');
  };

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
    frame[0] = 0x00;
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
      while (offset + 1 < buffer.length && buffer[offset] === 0x00 && buffer[offset + 1] === 0x00) offset += 1;
      if (buffer.length - offset < 4) break;
      const len = (buffer[offset + 2] << 8) | buffer[offset + 3];
      if (len < 6 || len > 512) {
        offset += 1;
        continue;
      }
      if (len > buffer.length - offset) break;
      if (crc16(buffer.subarray(offset, offset + len - 2)) !== (buffer[offset + len - 2] | (buffer[offset + len - 1] << 8))) {
        offset += 1;
        continue;
      }
      frames.push({ func: buffer[offset + 1], data: buffer.slice(offset + 4, offset + len - 2) });
      offset += len;
    }
    return frames;
  }

  const devices = await navigator.hid.getDevices();
  const targets = devices.filter((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  const listing = devices.map((item) => ({
    product: item.productName,
    vid: hx(item.vendorId),
    pid: hx(item.productId),
    opened: item.opened,
    collections: (item.collections ?? []).map((c) => `${hx(c.usagePage, 4)}:${hx(c.usage, 2)}`),
  }));
  if (targets.length === 0) return JSON.stringify({ error: 'no 0A67/0010 device', listing });

  const device = targets[0];
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

  async function readSeq(start, count, timeoutMs = 1200) {
    pull();
    const frame = encodeFrame(0x13, Uint8Array.from([(start >> 8) & 0xff, start & 0xff, (count >> 8) & 0xff, count & 0xff]));
    const sentAt = performance.now();
    for (let offset = 0; offset < frame.length; offset += 63) {
      const report = new Uint8Array(63);
      report.set(frame.subarray(offset, Math.min(offset + 63, frame.length)));
      await device.sendReport(0x51, report);
      await sleep(2);
    }
    let buffer = new Uint8Array(0);
    let frames = [];
    while (performance.now() - sentAt < timeoutMs) {
      const batch = pull();
      if (batch.length > 0) {
        const next = new Uint8Array(buffer.length + batch.length);
        next.set(buffer, 0);
        next.set(batch, buffer.length);
        buffer = next;
        frames = decodeStream(buffer);
        if (frames.some((item) => item.func === 0x13)) break;
      }
      await sleep(4);
    }
    frames = decodeStream(buffer);
    const reply = frames.find((item) => item.func === 0x13);
    if (!reply) {
      return { words: [], ack: frames.find((item) => item.func === 0x02)?.data?.slice(0, 2) ?? null, frames: frames.length };
    }
    const total = (reply.data[2] << 8) | reply.data[3];
    const words = [];
    for (let index = 0; index < total; index += 1) words.push((reply.data[4 + index * 2] << 8) | reply.data[5 + index * 2]);
    return { words };
  }

  const info = await readSeq(0x0000, 62);
  device.removeEventListener('inputreport', onReport);
  try {
    await device.close();
  } catch {
    /* ignore */
  }

  const words = info.words;
  return JSON.stringify({
    listing,
    product: device.productName,
    modelCode: words.length >= 3 ? decodeAscii(words.slice(0, 3)) : null,
    deviceName: words.length >= 11 ? decodeAscii(words.slice(3, 11)) : null,
    firmware: words.length >= 15 ? `${words[11]}.${words[12]}.${words[13]}.${words[14]}` : null,
    fwType: words.length >= 16 ? words[15] : null,
    vid: words.length >= 23 ? hx(words[22]) : null,
    pid: words.length >= 24 ? hx(words[23]) : null,
    serial: words.length >= 62 ? decodeAscii(words.slice(30, 62)) : null,
    wordCount: words.length,
    ack: info.ack ?? null,
  });
})()
