// 第三轮真机联调 · 补充观测：0x2023（MIC 音量，参数表标"只读"）写入行为 + 0x2057 电平在真实声音下的表现。
//   electron.exe . --screenshot=artifacts\real4\misc.png --route=device --exec-file=scripts\probes\real4-misc.js --no-sandbox
(async () => {
  const out = {};
  try {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const hx = (value, digits = 2) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
    function crc16(bytes) {
      let crc = 0xffff;
      for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
      }
      return crc & 0xffff;
    }
    function frame(func, data) {
      const len = data.length + 6;
      const bytes = new Uint8Array(len);
      bytes[1] = func;
      bytes[2] = (len >>> 8) & 0xff;
      bytes[3] = len & 0xff;
      bytes.set(data, 4);
      const crc = crc16(bytes.subarray(0, len - 2));
      bytes[len - 2] = crc & 0xff;
      bytes[len - 1] = (crc >>> 8) & 0xff;
      return bytes;
    }
    const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
    if (!device) return JSON.stringify({ error: '目标设备不在列' });
    await device.open();
    let inbox = [];
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
    const decode = (buffer) => {
      const frames = [];
      let offset = 0;
      while (offset < buffer.length) {
        while (offset + 1 < buffer.length && buffer[offset] === 0 && buffer[offset + 1] === 0) offset += 1;
        if (buffer.length - offset < 4) break;
        const len = (buffer[offset + 2] << 8) | buffer[offset + 3];
        if (len < 6 || len > 512 || len > buffer.length - offset) {
          offset += 1;
          continue;
        }
        let crc = 0xffff;
        for (let index = offset; index < offset + len - 2; index += 1) {
          crc ^= buffer[index];
          for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
        }
        if (crc === ((buffer[offset + len - 2] | (buffer[offset + len - 1] << 8)) >>> 0)) {
          frames.push({ func: buffer[offset + 1], data: buffer.slice(offset + 4, offset + len - 2) });
          offset += len;
          continue;
        }
        offset += 1;
      }
      return frames;
    };
    const exchange = async (bytes, waitMs = 260) => {
      pull();
      for (let offset = 0; offset < bytes.length; offset += 63) {
        const report = new Uint8Array(63);
        report.set(bytes.subarray(offset, Math.min(offset + 63, bytes.length)));
        await device.sendReport(0x51, report);
        await sleep(2);
      }
      await sleep(waitMs);
      return decode(pull());
    };
    const read = async (addr) => {
      const frames = await exchange(frame(0x13, Uint8Array.from([(addr >> 8) & 0xff, addr & 0xff, 0, 1])));
      const seq = frames.find((item) => item.func === 0x13);
      return seq ? (seq.data[4] << 8) | seq.data[5] : null;
    };
    const write = async (addr, value) => {
      const frames = await exchange(frame(0x10, Uint8Array.from([(addr >> 8) & 0xff, addr & 0xff, (value >> 8) & 0xff, value & 0xff])));
      const ack = frames.find((item) => item.func === 0x02);
      return ack ? (ack.data[0] << 8) | ack.data[1] : null;
    };

    // --- 0x2023 写入行为：读 → 写 0 → 读 → 写 50 → 读 → 写 100 → 读
    const gain = { start: await read(0x2023) };
    gain.ackWrite0 = await write(0x2023, 0);
    gain.after0 = await read(0x2023);
    gain.ackWrite50 = await write(0x2023, 50);
    gain.after50 = await read(0x2023);
    gain.ackWrite100 = await write(0x2023, 100);
    gain.after100 = await read(0x2023);
    out.micGain = gain;

    // --- 静音状态（0x2022）
    out.mute = await read(0x2022);

    // --- 0x2057 电平采样 6 s，每 100 ms 一次
    const levels = [];
    const startAt = performance.now();
    while (performance.now() - startAt < 6000) {
      levels.push(await read(0x2057));
      await sleep(80);
    }
    out.levels = { n: levels.length, min: Math.min(...levels), max: Math.max(...levels), distinct: [...new Set(levels)].slice(0, 8) };

    device.removeEventListener('inputreport', onReport);
    try {
      await device.close();
    } catch {
      /* ignore */
    }
    return JSON.stringify(out);
  } catch (error) {
    return JSON.stringify({ ...out, fatal: String(error), stack: error && error.stack });
  }
})()
