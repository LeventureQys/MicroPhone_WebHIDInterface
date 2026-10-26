// 观察设备是否"只是忙"：每 1 s 发一次 DevInfo 读（旧 SigmaBus 0x06），共 15 次，记录哪次有回执。
//   electron.exe . --screenshot=artifacts\real3\wait.png --route=device --exec-file=scripts\probes\real3-wait.js --no-sandbox
(async () => {
  const hex = (value, digits) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const race = (promise, ms, label) =>
    Promise.race([
      promise.then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: String(error) })),
      sleep(ms).then(() => ({ timeout: label })),
    ]);

  const out = { attempts: [] };
  const list = await race(navigator.hid.getDevices(), 12000, 'getDevices');
  if (list.timeout) return JSON.stringify({ ...out, error: 'getDevices 超时' });
  const device = (list.value ?? []).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ ...out, error: '设备不在列' });
  const opened = await race(device.open(), 5000, 'open');
  if (opened.timeout) return JSON.stringify({ ...out, error: 'open 超时' });

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

  for (let attempt = 1; attempt <= 15; attempt += 1) {
    inbound = new Uint8Array(0);
    const sent = await race(device.sendReport(0x51, report), 1500, 'send');
    await sleep(900);
    out.attempts.push({
      attempt,
      sendTimeout: sent.timeout === true,
      sendError: sent.ok === false ? sent.error : undefined,
      inbound: inbound.length > 0 ? Array.from(inbound, (byte) => hex(byte, 2)).join(' ') : null,
    });
    if (inbound.length > 0) break;
  }

  try {
    await device.close();
  } catch {
    /* ignore */
  }
  return JSON.stringify(out);
})()
