// 第二轮真机联调 · 异常语义与容量：错误码映射（协议 §6）+ 单帧容量（评审 P0-2）。
//   electron.exe . --screenshot=artifacts\real2\errors.png --route=device --exec-file=scripts\probes\real2-errors.js --no-sandbox
// 判据：每条请求恰好 1 条回执；错误码按 §6 建议映射（0x0001 UnitID / 0x0002 长度 / 0x0003 CRC / 0x0004 只读 / 0x0005 越界）。
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
  function frameBytes(func, data, unitId = 0x00) {
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
      const expected = crc16(buffer.subarray(offset, offset + len - 2));
      const received = buffer[offset + len - 2] | (buffer[offset + len - 1] << 8);
      if (expected !== received) {
        issues.push(`crc@${offset}`);
        offset += 1;
        continue;
      }
      frames.push({ unitId: buffer[offset], func: buffer[offset + 1], len, data: buffer.slice(offset + 4, offset + len - 2) });
      offset += len;
    }
    return { frames, issues };
  }
  const addrList = (addrs) => Uint8Array.from(addrs.flatMap((addr) => [(addr >>> 8) & 0xff, addr & 0xff]));
  const pairs = (list) => Uint8Array.from(list.flatMap(([addr, raw]) => [(addr >>> 8) & 0xff, addr & 0xff, (raw >>> 8) & 0xff, raw & 0xff]));

  const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ error: '设备不在列（VID 0A67 / PID 0010）' });
  if (!device.opened) await device.open();

  let events = [];
  let mark = 0;
  const onReport = (event) => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    events.push({ at: Math.round(performance.now() - mark), bytes });
  };
  device.addEventListener('inputreport', onReport);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function exchange(frames, options = {}) {
    const idleMs = options.idleMs ?? 70;
    const maxMs = options.maxMs ?? 1500;
    const list = Array.isArray(frames) ? frames : [frames];
    events = [];
    mark = performance.now();
    for (const frame of list) for (const report of splitFrame(frame)) await device.sendReport(OUT_ID, report);
    const started = performance.now();
    let seen = 0;
    let lastAt = performance.now();
    while (performance.now() - started < maxMs) {
      await sleep(8);
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
    const decoded = decodeStream(merged);
    const acks = decoded.frames.filter((item) => item.func === 0x02).map((item) => `0x${hex((item.data[0] << 8) | item.data[1], 4)}`);
    const dataFrames = decoded.frames.filter((item) => item.func === 0x12 || item.func === 0x13);
    const values = {};
    for (const item of dataFrames) {
      if (item.func === 0x12) {
        for (let at = 0; at + 3 < item.data.length; at += 4) {
          values[`0x${hex((item.data[at] << 8) | item.data[at + 1], 4)}`] = (item.data[at + 2] << 8) | item.data[at + 3];
        }
      } else {
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
      inboundReports: events.length,
      inboundBytes: merged.length,
      firstAtMs: events.length > 0 ? events[0].at : null,
      acks,
      dataFrames: dataFrames.length,
      dataBytes: dataFrames.map((item) => item.data.length),
      values,
      pushes: decoded.frames.filter((item) => item.func === 0x10).map((item) => bytesHex(item.data)),
      issues: decoded.issues,
    };
  }

  const out = { cases: [], capacity: [] };

  async function probeCase(item) {
    const frame = item.frame;
    const result = await exchange(frame, { maxMs: item.maxMs ?? 1200 });
    out.cases.push({
      id: item.id,
      label: item.label,
      sentHex: bytesHex(frame),
      sentBytes: frame.length,
      expect: item.expect,
      inboundReports: result.inboundReports,
      acks: result.acks,
      dataFrames: result.dataFrames,
      dataBytes: result.dataBytes,
      pushes: result.pushes,
      firstAtMs: result.firstAtMs,
      verdict:
        item.expectAck === undefined
          ? null
          : result.acks.length === 1 && result.acks[0] === item.expectAck
            ? 'match'
            : `got [${result.acks.join(',') || '无 ACK'}]`,
    });
    await sleep(60);
    return result;
  }

  // 0) 读当前值，后面写只读/超范围时回写原值，避免留下副作用
  const baseline = await exchange(frameBytes(0x12, addrList([0x2023, 0x205a, 0x2025, 0x2024, 0x2026, 0x1007, 0x000b])), { maxMs: 900 });
  const base = baseline.values;
  out.baseline = base;
  await sleep(120);

  // 1) 只读 / 不可写
  await probeCase({
    id: 'E1-readonly-micGain',
    label: `0x10 写只读 0x2023 gain.Mic = 原值 ${base['0x2023'] ?? 0}`,
    frame: frameBytes(0x10, pairs([[0x2023, base['0x2023'] ?? 0]])),
    expectAck: '0x0004',
  });
  await probeCase({
    id: 'E2-readonly-hpGain',
    label: `0x10 写只读 0x205A gain.Hp = 原值 ${base['0x205a'] ?? 0}`,
    frame: frameBytes(0x10, pairs([[0x205a, base['0x205a'] ?? 0]])),
    expectAck: '0x0004',
  });
  await probeCase({
    id: 'E3-readonly-fwRev',
    label: '0x10 写只读 0x000B（Firmware Rev X）= 0',
    frame: frameBytes(0x10, pairs([[0x000b, 0]])),
    expectAck: '0x0004',
  });
  await probeCase({
    id: 'E4-none-heartbeat',
    label: '0x10 写「不参与读写」0x1000（心跳）= 700（寄存器表原值）',
    frame: frameBytes(0x10, pairs([[0x1000, 0x02bc]])),
    expectAck: '0x0004',
  });

  // 2) 参数值超范围 / 地址越界
  await probeCase({
    id: 'E5-range-encLevel',
    label: '0x10 写 0x2025 encLevel = 5（有效域 0..3）',
    frame: frameBytes(0x10, pairs([[0x2025, 5]])),
    expectAck: '0x0005',
  });
  await probeCase({
    id: 'E6-unmapped-write',
    label: '0x10 写未映射 0x9000 = 1',
    frame: frameBytes(0x10, pairs([[0x9000, 1]])),
    expectAck: '0x0005',
  });
  await probeCase({
    id: 'E7-unmapped-read',
    label: '0x12 读未映射 0x9000',
    frame: frameBytes(0x12, addrList([0x9000])),
    expectAck: '0x0005',
  });
  await probeCase({
    id: 'E8-beyond-preset-write',
    label: '0x10 写 0x2072（预设区止于 0x2071）= 0',
    frame: frameBytes(0x10, pairs([[0x2072, 0]])),
    expectAck: '0x0005',
  });
  await probeCase({
    id: 'E9-beyond-preset-read',
    label: '0x12 读 0x2072',
    frame: frameBytes(0x12, addrList([0x2072])),
    expectAck: '0x0005',
  });
  await probeCase({
    id: 'E10-mixed-valid-invalid-read',
    label: '0x12 读 0x2024 + 0x9000（应整条拒绝，不回半帧）',
    frame: frameBytes(0x12, addrList([0x2024, 0x9000])),
    expectAck: '0x0005',
  });

  // 3) 帧层错误：CRC / UnitID / Len / 未知功能码
  const badCrc = frameBytes(0x12, addrList([0x2024]));
  badCrc[badCrc.length - 1] ^= 0xff;
  await probeCase({ id: 'E11-bad-crc', label: '0x12 读 0x2024，CRC 高位取反', frame: badCrc, expectAck: '0x0003' });
  await probeCase({
    id: 'E12-unitid-1',
    label: '0x12 读 0x2024，UnitID = 0x01',
    frame: frameBytes(0x12, addrList([0x2024]), 0x01),
    expectAck: '0x0001',
  });
  await probeCase({
    id: 'E13-unitid-ff',
    label: '0x12 读 0x2024，UnitID = 0xFF',
    frame: frameBytes(0x12, addrList([0x2024]), 0xff),
    expectAck: '0x0001',
  });
  await probeCase({
    id: 'E14-len-0x10-odd',
    label: '0x10 数据段 3 B（DataLen % 4 != 0）',
    frame: frameBytes(0x10, Uint8Array.from([0x20, 0x24, 0x00])),
    expectAck: '0x0002',
  });
  await probeCase({
    id: 'E15-len-0x13-not4',
    label: '0x13 数据段 3 B（DataLen != 4）',
    frame: frameBytes(0x13, Uint8Array.from([0x20, 0x00, 0x00])),
    expectAck: '0x0002',
  });
  await probeCase({
    id: 'E16-unknown-func',
    label: '未知功能码 0x20',
    frame: frameBytes(0x20, Uint8Array.from([0x20, 0x24])),
    expectAck: '0x0002',
  });

  // 4) 容量：0x12 126 地址 / 127 地址；0x13 114 词 / 跨区 / 251 词
  const capacity = [];
  const valid126 = Array.from({ length: 114 }, (_, index) => 0x2000 + index).concat(Array.from({ length: 12 }, (_, index) => 0x2000 + index));
  const cap126 = await exchange(frameBytes(0x12, addrList(valid126)), { maxMs: 1600 });
  capacity.push({
    id: 'C1-0x12-126-addr',
    label: '0x12 随机读 126 地址（响应 510 B）',
    requestBytes: frameBytes(0x12, addrList(valid126)).length,
    inboundReports: cap126.inboundReports,
    dataFrames: cap126.dataFrames,
    dataBytes: cap126.dataBytes,
    acks: cap126.acks,
    firstAtMs: cap126.firstAtMs,
  });
  await sleep(80);
  const cap127 = await exchange(frameBytes(0x12, addrList(valid126.concat([0x2000]))), { maxMs: 1600 });
  capacity.push({
    id: 'C2-0x12-127-addr',
    label: '0x12 随机读 127 地址（超协议上限 126，期望 0x0002）',
    requestBytes: frameBytes(0x12, addrList(valid126.concat([0x2000]))).length,
    inboundReports: cap127.inboundReports,
    dataFrames: cap127.dataFrames,
    dataBytes: cap127.dataBytes,
    acks: cap127.acks,
    firstAtMs: cap127.firstAtMs,
  });
  await sleep(80);
  const cap114 = await exchange(frameBytes(0x13, Uint8Array.from([0x20, 0x00, 0x00, 0x72])), { maxMs: 1600 });
  capacity.push({
    id: 'C3-0x13-114-words',
    label: '0x13 连续读 0x2000..0x2071（114 词，响应 238 B / 4 报文）',
    inboundReports: cap114.inboundReports,
    dataFrames: cap114.dataFrames,
    dataBytes: cap114.dataBytes,
    acks: cap114.acks,
    firstAtMs: cap114.firstAtMs,
  });
  await sleep(80);
  const crossRegion = await exchange(frameBytes(0x13, Uint8Array.from([0x20, 0x70, 0x00, 0x04])), { maxMs: 1200 });
  capacity.push({
    id: 'C4-0x13-cross-end',
    label: '0x13 从 0x2070 连读 4（越过 0x2071，期望 0x0005）',
    inboundReports: crossRegion.inboundReports,
    dataFrames: crossRegion.dataFrames,
    acks: crossRegion.acks,
  });
  await sleep(80);
  const bigSeq = await exchange(frameBytes(0x13, Uint8Array.from([0x20, 0x00, 0x00, 0xfb])), { maxMs: 1600 });
  capacity.push({
    id: 'C5-0x13-251-words',
    label: '0x13 连续读 251 词（协议上限；本机必然跨区，期望 0x0002 或 0x0005）',
    inboundReports: bigSeq.inboundReports,
    dataFrames: bigSeq.dataFrames,
    acks: bigSeq.acks,
  });
  await sleep(80);
  const seqCross = await exchange(frameBytes(0x11, Uint8Array.from([0x20, 0x70, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])), { maxMs: 1200 });
  capacity.push({
    id: 'C6-0x11-cross-end',
    label: '0x11 从 0x2070 连写 4 个 0（越过 0x2071，期望 0x0005）',
    inboundReports: seqCross.inboundReports,
    dataFrames: seqCross.dataFrames,
    acks: seqCross.acks,
  });
  out.capacity = capacity;

  // 5) 还原：0x2025 写回原值（若 E5 被接受）
  await sleep(120);
  const restore = await exchange(frameBytes(0x10, pairs([[0x2025, base['0x2025'] ?? 0]])), { maxMs: 900 });
  out.restore = { ack: restore.acks, sent: bytesHex(frameBytes(0x10, pairs([[0x2025, base['0x2025'] ?? 0]]))) };
  await sleep(120);
  const verify = await exchange(frameBytes(0x12, addrList([0x2023, 0x205a, 0x2025, 0x2024, 0x2026, 0x1000, 0x1007])), { maxMs: 900 });
  out.after = verify.values;

  device.removeEventListener('inputreport', onReport);
  await device.close();
  return JSON.stringify(out);
})()
