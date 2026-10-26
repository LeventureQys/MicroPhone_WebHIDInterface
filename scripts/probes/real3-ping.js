// 最小连通性检查：设备是否还接受 OUT 报告、是否还回 DevInfo（判断是否要拔插复位）。
//   electron.exe . --screenshot=artifacts\real3\ping.png --route=device --exec-file=scripts\probes\real3-ping.js --no-sandbox
(async () => {
  const hex = (value, digits) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const race = (promise, ms, label) =>
    Promise.race([promise.then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: String(error) })), sleep(ms).then(() => ({ timeout: label }))]);

  const out = {};
  out.getDevices = await race(navigator.hid.getDevices(), 12000, 'getDevices');
  if (out.getDevices.timeout) return JSON.stringify(out);
  const list = out.getDevices.value ?? [];
  out.devices = list.map((device) => ({ vid: hex(device.vendorId, 4), pid: hex(device.productId, 4), opened: device.opened, name: device.productName }));
  const device = list.find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ ...out, error: '目标设备不在列' });

  out.open = await race(device.open(), 4000, 'open');
  if (out.open.timeout || out.open.ok === false) return JSON.stringify({ ...out, error: 'open 失败/超时' });

  let inbound = new Uint8Array(0);
  device.addEventListener('inputreport', (event) => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const merged = new Uint8Array(inbound.length + bytes.length);
    merged.set(inbound, 0);
    merged.set(bytes, inbound.length);
    inbound = merged;
  });

  function sigmaCrc(bytes) {
    let sum = 0;
    for (const byte of bytes) sum += byte;
    return ((~sum & 0xffff) + 1) & 0xffff;
  }
  // 旧 SigmaBus 连续读 DevInfo：C4 | Len | Addr | Cmd 0x06 | addr(LE) num(LE) | CRC
  const payload = Uint8Array.from([0x00, 0x00, 0x0b, 0x00]);
  const length = 7 + payload.length;
  const frame = new Uint8Array(length);
  frame[0] = 0xc4;
  frame[1] = length & 0xff;
  frame[2] = (length >> 8) & 0xff;
  frame[3] = 0;
  frame[4] = 0x06;
  frame.set(payload, 5);
  const crc = sigmaCrc(frame.subarray(0, length - 2));
  frame[length - 2] = crc & 0xff;
  frame[length - 1] = (crc >> 8) & 0xff;

  const report = new Uint8Array(63);
  report.set(frame);
  out.send = await race(device.sendReport(0x51, report), 1500, 'sendReport');
  if (out.send.timeout) {
    try {
      await device.close();
    } catch {
      /* ignore */
    }
    return JSON.stringify({ ...out, error: 'sendReport 超时：设备 OUT 端点不接收，需要拔插复位' });
  }

  await sleep(1200);
  out.inbound = Array.from(inbound, (byte) => hex(byte, 2)).join(' ');
  out.replied = inbound.length > 0;

  try {
    await device.close();
  } catch {
    /* ignore */
  }
  return JSON.stringify(out);
})()

