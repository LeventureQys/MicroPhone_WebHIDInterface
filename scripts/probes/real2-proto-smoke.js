// 第二轮真机联调 · 协议冒烟：按协议 §5 的示例帧（真实地址）逐条发、逐条收。
//   electron.exe . --screenshot=artifacts\real2\proto-smoke.png --route=device --exec-file=scripts\probes\real2-proto-smoke.js --no-sandbox
// 判据：每条请求恰好 1 条回执（数据帧或 ACK）；补位零不得产生额外 ACK（协议 §3-P0-1 / 评审 P0-1）。
(async () => {
  const OUT_ID = 0x51;
  const PAYLOAD = 63;
  const hex = (value, digits) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
  const bytesHex = (bytes) => Array.from(bytes, (byte) => hex(byte, 2)).join(' ');

  function crc16(bytes) {
    let crc = 0xffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    return crc & 0xffff;
  }
  function fromHex(text) {
    const clean = text.replace(/\s+/g, '');
    return Uint8Array.from(clean.match(/../g).map((pair) => parseInt(pair, 16)));
  }
  function encodeFrame(func, data, unitId = 0x00) {
    const len = data.length + 6;
    const frame = new Uint8Array(len);
    frame[0] = unitId;
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
    const reports = [];
    for (let offset = 0; offset < bytes.length; offset += PAYLOAD) {
      const report = new Uint8Array(PAYLOAD);
      report.set(bytes.subarray(offset, Math.min(offset + PAYLOAD, bytes.length)));
      reports.push(report);
    }
    return reports;
  }
  // 与 src/renderer/src/device/proto/frame.ts 的 decodeStream 完全同构
  function decodeStream(buffer) {
    const frames = [];
    const issues = [];
    let offset = 0;
    while (offset < buffer.length) {
      while (offset + 1 < buffer.length && buffer[offset] === 0x00 && buffer[offset + 1] === 0x00) offset += 1;
      if (buffer.length - offset < 4) break;
      const len = (buffer[offset + 2] << 8) | buffer[offset + 3];
      if (len < 6 || len > 512) {
        issues.push(`len@${offset}=${len}`);
        offset += 1;
        continue;
      }
      if (len > buffer.length - offset) break;
      const unitId = buffer[offset];
      const func = buffer[offset + 1];
      const expected = crc16(buffer.subarray(offset, offset + len - 2));
      const received = buffer[offset + len - 2] | (buffer[offset + len - 1] << 8);
      if (expected !== received) {
        issues.push(`crc@${offset}`);
        offset += 1;
        continue;
      }
      frames.push({ unitId, func, len, data: buffer.slice(offset + 4, offset + len - 2) });
      offset += len;
    }
    return { frames, issues };
  }
  const wordPairs = (pairs) =>
    Uint8Array.from(pairs.flatMap(([addr, raw]) => [(addr >>> 8) & 0xff, addr & 0xff, (raw >>> 8) & 0xff, raw & 0xff]));
  const addrList = (addrs) => Uint8Array.from(addrs.flatMap((addr) => [(addr >>> 8) & 0xff, addr & 0xff]));

  const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ error: '设备不在列（VID 0A67 / PID 0010）' });
  if (!device.opened) await device.open();

  let events = [];
  let mark = 0;
  const onReport = (event) => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    events.push({ id: event.reportId, at: Math.round(performance.now() - mark), bytes });
  };
  device.addEventListener('inputreport', onReport);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function exchange(frame, options = {}) {
    const idleMs = options.idleMs ?? 60;
    const maxMs = options.maxMs ?? 900;
    events = [];
    mark = performance.now();
    for (const report of splitFrame(frame)) await device.sendReport(OUT_ID, report);
    const started = performance.now();
    let seen = 0;
    let lastAt = performance.now();
    while (performance.now() - started < maxMs) {
      await sleep(10);
      if (events.length !== seen) {
        seen = events.length;
        lastAt = performance.now();
      } else if (events.length > 0 && performance.now() - lastAt >= idleMs) {
        break;
      }
    }
    const merged = new Uint8Array(events.reduce((sum, item) => sum + item.bytes.length, 0));
    let cursor = 0;
    for (const item of events) {
      merged.set(item.bytes, cursor);
      cursor += item.bytes.length;
    }
    const { frames, issues } = decodeStream(merged);
    const acks = [];
    const values = {};
    for (const item of frames) {
      if (item.func === 0x02) acks.push(`0x${hex((item.data[0] << 8) | item.data[1], 4)}`);
      if (item.func === 0x12) {
        for (let at = 0; at + 3 < item.data.length; at += 4) {
          values[`0x${hex((item.data[at] << 8) | item.data[at + 1], 4)}`] = (item.data[at + 2] << 8) | item.data[at + 3];
        }
      }
      if (item.func === 0x13) {
        const start = (item.data[0] << 8) | item.data[1];
        const count = (item.data[2] << 8) | item.data[3];
        for (let index = 0; index < count; index += 1) {
          const at = 4 + index * 2;
          if (at + 1 >= item.data.length) break;
          values[`0x${hex(start + index, 4)}`] = (item.data[at] << 8) | item.data[at + 1];
        }
      }
    }
    return {
      sentHex: bytesHex(frame),
      sentBytes: frame.length,
      sentReports: Math.ceil(frame.length / PAYLOAD),
      padding: Math.ceil(frame.length / PAYLOAD) * PAYLOAD - frame.length,
      inboundReports: events.length,
      inboundBytes: merged.length,
      firstAtMs: events.length > 0 ? events[0].at : null,
      reportIds: [...new Set(events.map((item) => `0x${hex(item.id, 2)}`))],
      frames: frames.map((item) => ({ func: `0x${hex(item.func, 2)}`, len: item.len, dataHex: bytesHex(item.data) })),
      acks,
      values,
      issues,
    };
  }

  const out = {
    device: {
      vendorId: `0x${hex(device.vendorId, 4)}`,
      productId: `0x${hex(device.productId, 4)}`,
      productName: device.productName,
      collections: (device.collections ?? []).map((item) => ({
        usagePage: `0x${hex(item.usagePage, 4)}`,
        usage: `0x${hex(item.usage, 4)}`,
      })),
    },
    tests: [],
  };

  // 0) 先把设备信息区读出来（62 词 = 124 B 数据 / 134 B 帧 / 3 个报文），顺带验证多包重组
  const infoRead = await exchange(encodeFrame(0x13, Uint8Array.from([0x00, 0x00, 0x00, 0x3e])), { maxMs: 1200 });
  out.tests.push({
    id: 'T0-info',
    label: '0x13 连续读 0x0000..0x003D（62 词，响应 134 B / 3 报文）',
    ...infoRead,
    firmware: ['0x000B', '0x000C', '0x000D', '0x000E'].map((key) => infoRead.values[key] ?? null),
    vid: infoRead.values['0x0016'] ?? null,
    pid: infoRead.values['0x0017'] ?? null,
    model: [0, 1, 2].map((index) => infoRead.values[`0x${hex(index, 4)}`] ?? null),
    name: Array.from({ length: 8 }, (_, index) => infoRead.values[`0x${hex(3 + index, 4)}`] ?? null),
  });

  // 1) 协议 §5 示例帧（评审 §3-b 换过真实地址；帧字节原样发送）
  const cases = [
    {
      id: 'T1-write-2024',
      label: '0x10 写 0x2024=1（协议示例帧）',
      frameHex: '00 10 00 0A 20 24 00 01 43 C0',
      expect: { acks: ['0x0000'], values: {} },
    },
    {
      id: 'T2-read-2024',
      label: '0x12 读 0x2024（应回 1）',
      frame: encodeFrame(0x12, addrList([0x2024])),
      expect: { acks: [], values: { '0x2024': 1 } },
    },
    {
      id: 'T3-seqwrite',
      label: '0x11 从 0x2024 连写 2 个（1,2；协议示例帧）',
      frameHex: '00 11 00 0E 20 24 00 02 00 01 00 02 B7 85',
      expect: { acks: ['0x0000'], values: {} },
    },
    {
      id: 'T4-seqread-2',
      label: '0x13 从 0x2024 连读 2（协议示例帧，应回 1,2）',
      frameHex: '00 13 00 0A 20 24 00 02 ' + bytesHex(encodeFrame(0x13, Uint8Array.from([0x20, 0x24, 0x00, 0x02])).slice(-2)),
      expect: { acks: [], values: { '0x2024': 1, '0x2025': 2 } },
    },
    {
      id: 'T5-randread-205B',
      label: '0x12 随机读 0x205B/0x205C（协议示例帧）',
      frameHex: '00 12 00 0A 20 5B 20 5C 89 E1',
      expect: { acks: [], values: { '0x205B': null, '0x205C': null } },
    },
    {
      id: 'T6-seqread-2000-2',
      label: '0x13 从 0x2000 连读 2（协议示例帧）',
      frameHex: '00 13 00 0A 20 00 00 02 70 CA',
      expect: { acks: [], values: { '0x2000': null, '0x2001': null } },
    },
    {
      id: 'T7-read-2057',
      label: '0x12 读 0x2057（电平；协议示例帧）',
      frameHex: '00 12 00 08 20 57 61 E4',
      expect: { acks: [], values: { '0x2057': null } },
    },
  ];
  for (const item of cases) {
    const frame = item.frameHex ? fromHex(item.frameHex) : item.frame;
    const result = await exchange(frame, { maxMs: 900 });
    const expectValues = item.expect.values;
    const valueOk = Object.keys(expectValues).every((key) =>
      expectValues[key] === null ? Object.prototype.hasOwnProperty.call(result.values, key) : result.values[key] === expectValues[key],
    );
    const ackOk =
      item.expect.acks.length === 0
        ? result.acks.length === 0
        : item.expect.acks.length === result.acks.length && item.expect.acks.every((code, index) => result.acks[index] === code);
    out.tests.push({
      id: item.id,
      label: item.label,
      ...result,
      expect: item.expect,
      verdict: { acksOk: ackOk, valuesOk: valueOk, singleReply: result.inboundReports === result.sentReports || result.frames.length === 1 ? true : null },
    });
    await sleep(120);
  }

  // 2) 还原：把 0x2024 / 0x2025 写回 0
  const restore = await exchange(encodeFrame(0x11, Uint8Array.from([0x20, 0x24, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00])), { maxMs: 900 });
  out.tests.push({ id: 'T8-restore', label: '0x11 还原 0x2024/0x2025 = 0,0', ...restore });
  await sleep(120);
  const verify = await exchange(encodeFrame(0x12, addrList([0x2024, 0x2025, 0x2022, 0x2026])), { maxMs: 900 });
  out.tests.push({ id: 'T9-verify', label: '0x12 复核 0x2024/0x2025/0x2022/0x2026', ...verify });

  device.removeEventListener('inputreport', onReport);
  await device.close();
  return JSON.stringify(out);
})()
