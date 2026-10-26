// 真机入站原始字节取证：一次成功请求之后，后续请求到底收到了什么。
//   electron.exe . --screenshot=artifacts\real\raw-inbound.png --route=device --exec-file=scripts\probes\real-hid-raw-inbound.js --no-sandbox
// 只读。
(async () => {
  const OUT_ID = 0x51;
  const PAYLOAD = 63;
  const hex = (value, digits) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
  const hexBytes = (bytes, limit) => Array.from(bytes.slice(0, limit), (byte) => hex(byte, 2)).join(' ');

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
  const addrBytes = (addrs) => Uint8Array.from(addrs.flatMap((addr) => [(addr >>> 8) & 0xff, addr & 0xff]));
  const watch28 = [0x2024, 0x2025, 0x2026, 0x2023, 0x205a, 0x2057, 0x2059, 0x204a, 0x2051, 0x2058, 0x2022, 0x2001, 0x2000,
    0x2027, 0x2028, 0x2029, 0x202a, 0x202b, 0x2040, 0x2045, 0x205b, 0x205c, 0x205d, 0x205e, 0x205f, 0x1000, 0x1007, 0x000b];

  const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ error: '设备不在列' });
  if (!device.opened) await device.open();

  let events = [];
  const onReport = (event) => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    events.push({ at: performance.now(), id: event.reportId, bytes });
  };
  device.addEventListener('inputreport', onReport);

  const probe = async (label, waitMs) => {
    events = [];
    const frame = encodeFrame(0x12, addrBytes(watch28));
    const t0 = performance.now();
    for (const report of splitFrame(frame)) await device.sendReport(OUT_ID, report);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return {
      label,
      sentHex: `${hexBytes(frame, 8)} … (${frame.length} B, pad ${Math.ceil(frame.length / PAYLOAD) * PAYLOAD - frame.length})`,
      reports: events.length,
      sample: events.slice(0, 6).map((event) => ({
        dt: Math.round(event.at - t0),
        id: `0x${hex(event.id, 2)}`,
        len: event.bytes.length,
        head: hexBytes(event.bytes, 12),
      })),
      tails: events.length > 6 ? events.slice(-2).map((event) => ({ dt: Math.round(event.at - t0), head: hexBytes(event.bytes, 12) })) : [],
    };
  };

  const out = { steps: [] };
  out.steps.push(await probe('① 干净读 62 B（第一发）', 500));
  out.steps.push(await probe('② 立刻再发一次', 500));
  out.steps.push(await probe('③ 再发一次', 500));
  await new Promise((resolve) => setTimeout(resolve, 3000));
  out.steps.push(await probe('④ 静置 3 s 后再发', 800));
  await new Promise((resolve) => setTimeout(resolve, 3000));
  out.steps.push(await probe('⑤ 再静置 3 s 后', 800));

  device.removeEventListener('inputreport', onReport);
  await device.close();
  return JSON.stringify(out);
})()
