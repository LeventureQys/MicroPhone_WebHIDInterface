// 干净 ACK 语义：每次写前静置 3 s（避开固件的闭锁态），用整帧 62 B 测「不可写地址」的回执码。
//   electron.exe . --screenshot=artifacts\real\ack-clean.png --route=device --exec-file=scripts\probes\real-hid-ack-clean.js --no-sandbox
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
  const wordBytes = (pairs) => Uint8Array.from(pairs.flatMap(([addr, raw]) => [(addr >>> 8) & 0xff, addr & 0xff, (raw >>> 8) & 0xff, raw & 0xff]));
  const addrBytes = (addrs) => Uint8Array.from(addrs.flatMap((addr) => [(addr >>> 8) & 0xff, addr & 0xff]));
  const cleanWrite = (addr, raw) => encodeFrame(0x10, wordBytes(Array.from({ length: 14 }, () => [addr, raw])));
  const watch = [0x1000, 0x2000, 0x2001, 0x2024, 0x2025, 0x2026, 0x2023, 0x205a, 0x2057, 0x204a, 0x2051, 0x2058, 0x2059,
    0x2022, 0x2027, 0x2028, 0x202b, 0x2040, 0x2045, 0x205b, 0x205c, 0x205d, 0x205e, 0x205f, 0x1007, 0x000b, 0x0016, 0x0017];

  const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ error: '设备不在列' });
  if (!device.opened) await device.open();

  let events = [];
  const onReport = (event) => {
    events.push(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
  };
  device.addEventListener('inputreport', onReport);
  const decodeAll = () => {
    let acc = new Uint8Array(0);
    for (const bytes of events) {
      const merged = new Uint8Array(acc.length + bytes.length);
      merged.set(acc, 0);
      merged.set(bytes, acc.length);
      acc = merged;
    }
    return decodeStream(acc);
  };
  const exchange = async (frame, waitMs) => {
    events = [];
    for (const report of splitFrame(frame)) await device.sendReport(OUT_ID, report);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const frames = decodeAll();
    const values = {};
    for (const item of frames) {
      if (item.func !== 0x12) continue;
      for (let offset = 0; offset < item.data.length; offset += 4) {
        values[`0x${hex((item.data[offset] << 8) | item.data[offset + 1], 4)}`] = (item.data[offset + 2] << 8) | item.data[offset + 3];
      }
    }
    return {
      acks: frames.filter((item) => item.func === 0x02).map((item) => `0x${hex((item.data[0] << 8) | item.data[1], 4)}`),
      reply: Object.keys(values).length > 0,
      values,
    };
  };

  const out = { cases: [] };
  const cases = [
    { label: '写心跳 0x1000 = 1（寄存器表标「不参与读写」）', addr: 0x1000 },
    { label: '写非法地址 0x9000 = 1', addr: 0x9000 },
    { label: '写只读 0x2023 gain.Mic = 0（写回原值 0）', addr: 0x2023, raw: 0 },
    { label: '写只读 0x205a gain.Hp = 0（写回原值 0）', addr: 0x205a, raw: 0 },
  ];
  for (const item of cases) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const result = await exchange(cleanWrite(item.addr, item.raw ?? 1), 1200);
    out.cases.push({ label: item.label, sent: Array.from(cleanWrite(item.addr, item.raw ?? 1).slice(0, 8), (byte) => hex(byte, 2)).join(' '), acks: result.acks });
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));
  const read = await exchange(encodeFrame(0x12, addrBytes(watch)), 800);
  out.final = { reply: read.reply, acks: read.acks, values: read.values };

  device.removeEventListener('inputreport', onReport);
  await device.close();
  return JSON.stringify(out);
})()
