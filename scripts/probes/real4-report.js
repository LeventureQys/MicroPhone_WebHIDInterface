// 第三轮真机联调 · 「写后 0x10 上报」取证：设备在主机写参数之后，会额外推一条 0x10 帧。
//   electron.exe . --screenshot=artifacts\real4\report.png --route=device --exec-file=scripts\probes\real4-report.js --no-sandbox
//
// 协议 §四 规定 0x10 是双向复用（设备→主机为参数上报，主机不回 ACK、不按功能码配对）。
// 本探针要回答三件事：① 哪些写操作会触发上报；② 上报带几个 (Addr,Val)、内容是不是刚写的值；
// ③ 上报与 ACK 的先后顺序（上位机不能靠功能码配对，但要知道会不会抢在 ACK 前面）。
(async () => {
  const out = { cases: [], notes: [] };
  try {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const hx = (value, digits = 2) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
    const hex = (bytes) => Array.from(bytes, (byte) => hx(byte)).join(' ');

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
      frame[1] = func;
      frame[2] = (len >>> 8) & 0xff;
      frame[3] = len & 0xff;
      frame.set(data, 4);
      const crc = crc16(frame.subarray(0, len - 2));
      frame[len - 2] = crc & 0xff;
      frame[len - 1] = (crc >>> 8) & 0xff;
      return frame;
    }
    function decode(buffer) {
      const frames = [];
      let offset = 0;
      while (offset < buffer.length) {
        while (offset + 1 < buffer.length && buffer[offset] === 0 && buffer[offset + 1] === 0) offset += 1;
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

    const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
    if (!device) return JSON.stringify({ ...out, error: '目标设备不在列' });
    await device.open();

    let inbox = [];
    let receivedAt = new Map();
    const onReport = (event) => {
      inbox.push(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
    };
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

    async function watch(label, frame, waitMs = 900) {
      pull();
      const sentAt = performance.now();
      for (let offset = 0; offset < frame.length; offset += 63) {
        const report = new Uint8Array(63);
        report.set(frame.subarray(offset, Math.min(offset + 63, frame.length)));
        await device.sendReport(0x51, report);
        await sleep(2);
      }
      const timeline = [];
      let buffer = new Uint8Array(0);
      let seen = 0;
      while (performance.now() - sentAt < waitMs) {
        const batch = pull();
        if (batch.length > 0) {
          const next = new Uint8Array(buffer.length + batch.length);
          next.set(buffer, 0);
          next.set(batch, buffer.length);
          buffer = next;
          const frames = decode(buffer);
          if (frames.length > seen) {
            for (let index = seen; index < frames.length; index += 1) {
              const item = frames[index];
              const pairs = [];
              if (item.func === 0x10 || item.func === 0x12) {
                for (let at = 0; at + 3 < item.data.length; at += 4) {
                  pairs.push(`0x${hx((item.data[at] << 8) | item.data[at + 1], 4)}=${(item.data[at + 2] << 8) | item.data[at + 3]}`);
                }
              }
              timeline.push({
                atMs: Math.round(performance.now() - sentAt),
                func: `0x${hx(item.func)}`,
                bytes: item.data.length,
                pairs: pairs.length ? pairs : undefined,
                data: decimalSafe(item.data),
              });
            }
            seen = frames.length;
          }
        }
        await sleep(4);
      }
      out.cases.push({ label, sent: hex(frame), timeline });
    }
    function decimalSafe(data) {
      return Array.from(data, (byte) => hx(byte)).join('');
    }

    const readOne = async (addr) => {
      const reply = [];
      inbox = [];
      const frame = encodeFrame(0x13, Uint8Array.from([(addr >> 8) & 0xff, addr & 0xff, 0x00, 0x01]));
      for (let offset = 0; offset < frame.length; offset += 63) {
        const report = new Uint8Array(63);
        report.set(frame.subarray(offset, Math.min(offset + 63, frame.length)));
        await device.sendReport(0x51, report);
      }
      await sleep(220);
      const frames = decode(pull());
      const seq = frames.find((item) => item.func === 0x13);
      void reply;
      return seq ? (seq.data[4] << 8) | seq.data[5] : null;
    };
    const write = (pairs) =>
      encodeFrame(0x10, Uint8Array.from(pairs.flatMap(([addr, value]) => [(addr >> 8) & 0xff, addr & 0xff, (value >> 8) & 0xff, value & 0xff])));

    const origin = { 0x2023: await readOne(0x2023), 0x2024: await readOne(0x2024), 0x2025: await readOne(0x2025), 0x2026: await readOne(0x2026) };
    out.origin = origin;
    const alt = (value, max) => (value + 1 > max ? Math.max(0, value - 1) : value + 1);

    // 1. 单写降噪开关
    await watch('单写 0x2024（降噪开关）', write([[0x2024, alt(origin[0x2024], 1)]]));
    // 2. 单写降噪强度
    await watch('单写 0x2025（降噪强度）', write([[0x2025, alt(origin[0x2025], 3)]]));
    // 3. 单写均衡器模式
    await watch('单写 0x2026（EQ 模式）', write([[0x2026, alt(origin[0x2026], 4)]]));
    // 4. 一条帧两个参数
    await watch('同帧写 0x2024+0x2025', write([[0x2024, origin[0x2024]], [0x2025, origin[0x2025]]]));
    // 5. 连续写 3 个值（0x11）
    await watch(
      '0x11 连续写 0x2024×3',
      encodeFrame(0x11, Uint8Array.from([0x20, 0x24, 0x00, 0x03, 0x00, origin[0x2024], 0x00, origin[0x2025], 0x00, origin[0x2026]])),
    );
    // 6. 写只读参数
    await watch('写只读 0x2023（MIC 音量）', write([[0x2023, 50]]));
    // 7. 写不相关参数（EQ band1 频率）
    const band1Freq = await readOne(0x2029);
    await watch('写 0x2029（Band-1 Freq，与降噪无关）', write([[0x2029, band1Freq]]));
    // 8. 空闲 3 s
    await watch('空闲（不发任何帧）', new Uint8Array(0), 3000);

    // 恢复
    await write([
      [0x2024, origin[0x2024]],
      [0x2025, origin[0x2025]],
      [0x2026, origin[0x2026]],
      [0x2023, origin[0x2023]],
    ]);
    out.restored = true;

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
