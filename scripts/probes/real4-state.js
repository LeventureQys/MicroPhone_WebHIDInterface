// 注意：本机 DSH 沙箱里 Electron 起不来（子进程建不了命名管道，platform_channel FATAL），
// 这个探针只在普通机器上可用；本机请用 `python tools/dfu/m001-dfu.py state`（同语义，见
// Document/Update/Alpha/v1.1.0/真机DFU刷写成功记录.md）。
//
// 现场状态探测：设备现在跑 App（Modbus 应答）还是停在 Bootloader（SigmaBus 应答）。
//   electron.exe . --screenshot=artifacts\real4\state.png --route=device --exec-file=scripts\probes\real4-state.js --no-sandbox
// 两种帧都只读、不改 Flash，可安全重复执行。
(async () => {
  const hex = (value, digits) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
  const bytesHex = (bytes) => Array.from(bytes, (byte) => hex(byte, 2)).join(' ');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function sigmaCrc(bytes) {
    let sum = 0;
    for (const byte of bytes) sum += byte;
    return ((~sum & 0xffff) + 1) & 0xffff;
  }
  function crc16(bytes) {
    let crc = 0xffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    return crc & 0xffff;
  }
  function encodeSigma(cmd, data) {
    const length = 7 + data.length;
    const frame = new Uint8Array(length);
    frame[0] = 0xc4;
    frame[1] = length & 0xff;
    frame[2] = (length >> 8) & 0xff;
    frame[3] = 0x00;
    frame[4] = cmd;
    frame.set(data, 5);
    const crc = sigmaCrc(frame.subarray(0, length - 2));
    frame[length - 2] = crc & 0xff;
    frame[length - 1] = (crc >> 8) & 0xff;
    return frame;
  }
  function decodeSigma(buffer) {
    const frames = [];
    let pos = 0;
    while (pos + 3 <= buffer.length) {
      if (buffer[pos] !== 0xc4) {
        pos += 1;
        continue;
      }
      const length = buffer[pos + 1] | (buffer[pos + 2] << 8);
      if (length < 9 || length > 1022 || length > buffer.length - pos) break;
      const frame = buffer.subarray(pos, pos + length);
      const received = frame[length - 2] | (frame[length - 1] << 8);
      if (sigmaCrc(frame.subarray(0, length - 2)) !== received) {
        pos += 1;
        continue;
      }
      frames.push({ cmd: frame[4] & 0x7f, data: frame.slice(5, length - 2) });
      pos += length;
    }
    return frames;
  }
  function decodeModbus(buffer) {
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
  function splitReports(frame) {
    const reports = [];
    for (let offset = 0; offset < frame.length; offset += 63) {
      const report = new Uint8Array(63);
      report.set(frame.subarray(offset, Math.min(offset + 63, frame.length)));
      reports.push(report);
    }
    return reports;
  }

  const out = { steps: [] };
  const list = await navigator.hid.getDevices();
  out.devices = list.map((device) => ({
    vid: hex(device.vendorId, 4),
    pid: hex(device.productId, 4),
    name: device.productName,
    opened: device.opened,
    collections: (device.collections ?? []).map((item) => `${hex(item.usagePage, 4)}/${hex(item.usage, 4)}`),
  }));

  const device = list.find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ ...out, error: '目标设备不在列（VID 0A67 / PID 0010）' });
  out.productName = device.productName;
  try {
    if (!device.opened) await device.open();
  } catch (error) {
    return JSON.stringify({ ...out, error: `open 失败：${String(error)}` });
  }
  out.opened = device.opened;

  let inbound = new Uint8Array(0);
  const onReport = (event) => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const merged = new Uint8Array(inbound.length + bytes.length);
    merged.set(inbound, 0);
    merged.set(bytes, inbound.length);
    inbound = merged;
  };
  device.addEventListener('inputreport', onReport);

  async function exchange(label, frame, decode, waitMs) {
    inbound = new Uint8Array(0);
    const sentAt = performance.now();
    try {
      for (const report of splitReports(frame)) {
        await device.sendReport(0x51, report);
        await sleep(3);
      }
    } catch (error) {
      out.steps.push({ label, sendError: String(error) });
      return [];
    }
    while (performance.now() - sentAt < waitMs) {
      if (decode(inbound).length > 0) break;
      await sleep(4);
    }
    const frames = decode(inbound);
    out.steps.push({
      label,
      request: bytesHex(frame),
      replied: frames.length > 0,
      raw: bytesHex(inbound),
      frames: frames.length,
    });
    return frames;
  }

  // A) MainApp：Modbus 连续读 0x0000..0x000E（版本区）
  const modbusReq = Uint8Array.from([0x00, 0x13, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x0f]);
  const modbusCrc = crc16(modbusReq);
  const modbusFrame = new Uint8Array([...modbusReq, modbusCrc & 0xff, (modbusCrc >> 8) & 0xff]);
  const modbusFrames = await exchange('modbus-version', modbusFrame, decodeModbus, 900);
  if (modbusFrames.length > 0) {
    const reply = modbusFrames.find((item) => item.func === 0x13 && item.data.length > 20);
    if (reply) {
      const words = [];
      for (let at = 4; at + 1 < reply.data.length; at += 2) words.push((reply.data[at] << 8) | reply.data[at + 1]);
      out.mode = 'MainApp';
      out.version = `${words[11]}.${words[12]}.${words[13]}.${words[14]}`;
      out.words = words.map((word) => hex(word, 4));
    }
  }

  // B) Bootloader：SigmaBus 连续读 DevInfo 0x0000..0x000A（机型区）
  await sleep(150);
  const devInfoPayload = Uint8Array.from([0x00, 0x00, 0x0b, 0x00]);
  const sigmaFrames = await exchange('sigmabus-devinfo', encodeSigma(0x06, devInfoPayload), decodeSigma, 1000);
  const devInfo = sigmaFrames.find((item) => item.cmd === 0x06 && item.data.length >= 4);
  if (devInfo) {
    out.mode = out.mode === 'MainApp' ? 'MainApp(+SigmaBus?)' : 'Bootloader';
    const words = [];
    for (let at = 4; at + 1 < devInfo.data.length; at += 2) words.push(devInfo.data[at] | (devInfo.data[at + 1] << 8));
    out.devInfoWords = words.map((word) => hex(word, 4));
    out.devInfoAscii = JSON.stringify(
      words.map((word) => String.fromCharCode((word >> 8) & 0xff, word & 0xff)).join(''),
    );
  }

  if (!out.mode) out.mode = 'unknown(无应答)';

  device.removeEventListener('inputreport', onReport);
  try {
    await device.close();
  } catch {
    /* ignore */
  }
  return JSON.stringify(out);
})()
