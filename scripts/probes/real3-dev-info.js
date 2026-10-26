// Bootloader 侧读 DevInfo（旧 SigmaBus 参数连续读 0x06）：判断信息帧 0x01 是"空白"还是"字节序反了"。
//   electron.exe . --screenshot=artifacts\real3\dev-info.png --route=device --exec-file=scripts\probes\real3-dev-info.js --no-sandbox
(async () => {
  const OUT_ID = 0x51;
  const hex = (value, digits) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
  const bytesHex = (bytes) => Array.from(bytes, (byte) => hex(byte, 2)).join(' ');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function sigmaCrc(bytes) {
    let sum = 0;
    for (const byte of bytes) sum += byte;
    return ((~sum & 0xffff) + 1) & 0xffff;
  }
  function encodeSigma(cmd, data) {
    const length = 7 + data.length;
    const frame = new Uint8Array(length);
    frame[0] = 0xc4;
    frame[1] = length & 0xff;
    frame[2] = (length >> 8) & 0xff;
    frame[3] = 0;
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
      frames.push({ cmd: frame[4] & 0x7f, data: frame.slice(5, length - 2), raw: frame.slice() });
      pos += length;
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

  const out = {};
  const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ error: '设备不在列' });
  try {
    if (!device.opened) await device.open();
  } catch (error) {
    return JSON.stringify({ ...out, error: `打不开设备：${String(error)}` });
  }
  out.opened = true;

  let inbound = new Uint8Array(0);
  device.addEventListener('inputreport', (event) => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const merged = new Uint8Array(inbound.length + bytes.length);
    merged.set(inbound, 0);
    merged.set(bytes, inbound.length);
    inbound = merged;
  });

  async function readDevInfo(addr, count) {
    // 旧 SigmaBus 数据段小端：addrLo addrHi numLo numHi
    const payload = Uint8Array.from([addr & 0xff, (addr >> 8) & 0xff, count & 0xff, (count >> 8) & 0xff]);
    const frame = encodeSigma(0x06, payload);
    inbound = new Uint8Array(0);
    for (const report of splitReports(frame)) await device.sendReport(OUT_ID, report);
    const started = performance.now();
    while (performance.now() - started < 1200) {
      const frames = decodeSigma(inbound);
      const reply = frames.find((item) => item.cmd === 0x06 && item.data.length >= 4);
      if (reply) return reply;
      await sleep(8);
    }
    return null;
  }

  for (const [label, addr, count] of [
    ['devInfoAll', 0x0000, 0x000b],
    ['model3', 0x0000, 0x0003],
    ['name8', 0x0003, 0x0008],
  ]) {
    const reply = await readDevInfo(addr, count);
    if (reply === null) {
      out[label] = { error: 'no reply (不是 Bootloader 或帧不匹配)' };
      continue;
    }
    const data = reply.data;
    const words = [];
    for (let at = 4; at + 1 < data.length; at += 2) words.push(data[at] | (data[at + 1] << 8));
    const lowFirst = words.map((word) => String.fromCharCode(word & 0xff, (word >> 8) & 0xff)).join('');
    const highFirst = words.map((word) => String.fromCharCode((word >> 8) & 0xff, word & 0xff)).join('');
    out[label] = {
      rawHex: bytesHex(data),
      words: words.map((word) => `0x${hex(word, 4)}`),
      asciiLowFirst: JSON.stringify(lowFirst),
      asciiHighFirst: JSON.stringify(highFirst),
    };
    await sleep(120);
  }

  try {
    await device.close();
  } catch {
    /* ignore */
  }
  return JSON.stringify(out);
})()
