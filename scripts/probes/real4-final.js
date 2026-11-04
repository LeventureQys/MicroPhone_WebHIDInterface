// 第四轮真机联调 · 收尾快照：读 118 词预设区 + 配置区 + 信息区，列出非零项，确认设备停在哪。
//   electron.exe . --screenshot=artifacts\real4\final.png --route=device --exec-file=scripts\probes\real4-final.js --no-sandbox
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

  async function read(start, count) {
    inbound = new Uint8Array(0);
    for (const report of splitReports(encodeFrame(0x13, Uint8Array.from([(start >> 8) & 0xff, start & 0xff, (count >> 8) & 0xff, count & 0xff])))) {
      await device.sendReport(OUT_ID, report);
    }
    const started = performance.now();
    while (performance.now() - started < 2000) {
      const reply = decodeStream(inbound).find((frame) => frame.func === 0x13);
      if (reply) {
        const values = {};
        const total = (reply.data[2] << 8) | reply.data[3];
        for (let index = 0; index < total; index += 1) {
          const at = 4 + index * 2;
          if (at + 1 >= reply.data.length) break;
          values[((reply.data[0] << 8) | reply.data[1]) + index] = (reply.data[at] << 8) | reply.data[at + 1];
        }
        return values;
      }
      await sleep(8);
    }
    return null;
  }

  const out = { productName: device.productName, vid: hex(device.vendorId, 4), pid: hex(device.productId, 4) };
  const preset = await read(0x2000, 118);
  out.presetRead = preset !== null;
  out.nonZeroPreset = preset
    ? Object.fromEntries(Object.entries(preset).filter(([, value]) => value !== 0).map(([addr, value]) => [`0x${hex(Number(addr), 4)}`, value]))
    : null;
  const config = await read(0x1000, 14);
  out.config = config ? Object.fromEntries(Object.entries(config).map(([addr, value]) => [`0x${hex(Number(addr), 4)}`, value])) : null;
  const info = await read(0x0000, 62);
  out.infoNonZero = info ? Object.entries(info).filter(([, value]) => value !== 0).map(([addr, value]) => `0x${hex(Number(addr), 4)}=${value}`) : null;
  const level = await read(0x2057, 1);
  out.level = level?.[0x2057] ?? null;
  device.removeEventListener('inputreport', onReport);
  await device.close().catch(() => undefined);
  return JSON.stringify(out);
})()
