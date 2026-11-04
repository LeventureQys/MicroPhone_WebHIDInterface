// 第五轮 · 设备句柄身份探针：连续两次 getDevices()，看同一台设备的原生 HIDDevice 是否是同一个对象，
// 并尝试带超时 open + Modbus/SigmaBus 探测当前模式。
//   electron.exe . --screenshot=artifacts\real5\identity.png --route=device --exec-file=scripts\probes\real5-identity.js --no-sandbox
(async () => {
  const hex = (value, digits) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const race = (promise, ms, label) =>
    Promise.race([
      promise.then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: String(error) })),
      sleep(ms).then(() => ({ timeout: label })),
    ]);
  const out = {};
  const first = await race(navigator.hid.getDevices(), 12000, 'getDevices#1');
  if (first.timeout) return JSON.stringify({ ...out, error: 'getDevices#1 timeout' });
  const second = await race(navigator.hid.getDevices(), 12000, 'getDevices#2');
  if (second.timeout) return JSON.stringify({ ...out, error: 'getDevices#2 timeout' });
  const a = first.value.find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  const b = second.value.find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!a || !b) return JSON.stringify({ ...out, error: '0A67 not found', a: Boolean(a), b: Boolean(b) });
  out.identity = {
    sameObject: a === b,
    keys: Object.keys(a),
    ownKeys: Object.getOwnPropertyNames(a),
    deviceId: a.deviceId ?? null,
    opened: a.opened,
    productName: a.productName,
  };
  out.open = await race(a.open(), 5000, 'open');
  if (out.open.timeout) return JSON.stringify(out);
  out.openedAfter = a.opened;

  let inbound = new Uint8Array(0);
  const onReport = (event) => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const merged = new Uint8Array(inbound.length + bytes.length);
    merged.set(inbound, 0);
    merged.set(bytes, inbound.length);
    inbound = merged;
  };
  a.addEventListener('inputreport', onReport);
  function crc16(bytes) {
    let crc = 0xffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    return crc & 0xffff;
  }
  function sigmaCrc(bytes) {
    let sum = 0;
    for (const byte of bytes) sum += byte;
    return ((~sum & 0xffff) + 1) & 0xffff;
  }
  async function modbusRead() {
    const frame = Uint8Array.from([0x00, 0x13, 0x00, 0x0a, 0x20, 0x00, 0x00, 0x01, 0x00, 0x00]);
    const crc = crc16(frame.subarray(0, 8));
    frame[8] = crc & 0xff; frame[9] = crc >>> 8;
    const report = new Uint8Array(63); report.set(frame);
    inbound = new Uint8Array(0);
    for (const r of [report]) await a.sendReport(0x51, r);
    await sleep(700);
    return inbound;
  }
  async function sigmaRead() {
    const payload = Uint8Array.from([0x00, 0x00, 0x0b, 0x00]);
    const len = 7 + payload.length;
    const frame = new Uint8Array(len);
    frame[0] = 0xc4; frame[1] = len & 0xff; frame[2] = (len >> 8) & 0xff; frame[3] = 0; frame[4] = 0x06;
    frame.set(payload, 5);
    const crc = sigmaCrc(frame.subarray(0, len - 2));
    frame[len - 2] = crc & 0xff; frame[len - 1] = crc >> 8;
    const report = new Uint8Array(63); report.set(frame);
    inbound = new Uint8Array(0);
    await a.sendReport(0x51, report);
    await sleep(900);
    return inbound;
  }
  const modbus = await modbusRead();
  out.modbus = Array.from(modbus, (byte) => hex(byte, 2)).join(' ').slice(0, 120);
  out.mode = modbus.length > 0 ? 'app?' : 'unknown';
  if (modbus.length === 0) {
    const sigma = await sigmaRead();
    out.sigma = Array.from(sigma, (byte) => hex(byte, 2)).join(' ').slice(0, 160);
    out.mode = sigma.length > 0 ? 'bootloader?' : 'unknown';
  }
  a.removeEventListener('inputreport', onReport);
  try { await a.close(); } catch { /* ignore */ }
  return JSON.stringify(out);
})()
