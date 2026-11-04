// 第四轮真机联调 · 报告 ID 与主动上报：读一次参数并记录回包走哪个 report ID，再静置 4 s 看设备是否主动推。
//   electron.exe . --screenshot=artifacts\real4\reports.png --route=device --exec-file=scripts\probes\real4-reports.js --no-sandbox
(async () => {
  const hex = (value, digits) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
  const bytesHex = (bytes) => Array.from(bytes, (byte) => hex(byte, 2)).join(' ');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function crc16(bytes) {
    let crc = 0xffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    return crc & 0xffff;
  }
  function encodeModbus(func, data) {
    const len = data.length + 6;
    const frame = new Uint8Array(len);
    frame[0] = 0;
    frame[1] = func & 0xff;
    frame[2] = (len >>> 8) & 0xff;
    frame[3] = len & 0xff;
    frame.set(data, 4);
    const crc = crc16(frame.subarray(0, len - 2));
    frame[len - 2] = crc & 0xff;
    frame[len - 1] = (crc >>> 8) & 0xff;
    return frame;
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

  const out = { idle: [], afterRead: [] };
  let phase = 'idle';
  const onReport = (event) => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const entry = { reportId: `0x${hex(event.reportId, 2)}`, hex: bytesHex(bytes) };
    if (phase === 'idle') out.idle.push(entry);
    else out.afterRead.push(entry);
  };
  device.addEventListener('inputreport', onReport);

  await sleep(4000);

  phase = 'read';
  for (const report of splitReports(encodeModbus(0x13, Uint8Array.from([0x20, 0x24, 0x00, 0x01])))) {
    await device.sendReport(0x51, report);
  }
  await sleep(1500);

  phase = 'read50';
  for (const report of splitReports(encodeModbus(0x13, Uint8Array.from([0x20, 0x25, 0x00, 0x01])))) {
    await device.sendReport(0x50, report);
  }
  await sleep(1200);

  device.removeEventListener('inputreport', onReport);
  await device.close().catch(() => undefined);
  return JSON.stringify(out);
})()
