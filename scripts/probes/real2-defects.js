// 第二轮真机联调 · 缺陷定位：把异常路径的原始入站报文抓出来（UnitID 失配 / 超容量 / 未知功能码 / 地址边界）。
//   electron.exe . --screenshot=artifacts\real2\defects.png --route=device --exec-file=scripts\probes\real2-defects.js --no-sandbox
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
    const idleMs = options.idleMs ?? 80;
    const maxMs = options.maxMs ?? 1500;
    const keepRaw = options.keepRaw ?? 0;
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
    const values = {};
    for (const item of decoded.frames) {
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
      inboundReports: events.length,
      inboundBytes: merged.length,
      firstAtMs: events.length > 0 ? events[0].at : null,
      acks,
      funcs: decoded.frames.map((item) => `0x${hex(item.func, 2)}:${item.len}`),
      values,
      pushes: decoded.frames.filter((item) => item.func === 0x10).map((item) => bytesHex(item.data)),
      issues: decoded.issues,
      raw: events.slice(0, keepRaw).map((item) => `${item.at}ms ${bytesHex(item.bytes.slice(0, 16))}${item.bytes.length > 16 ? '…' : ''}`),
    };
  }

  const out = { probes: [] };

  // D1 UnitID 失配：一次请求后的入站风暴 + 是否自愈
  const d1 = await exchange(frameBytes(0x12, addrList([0x2024]), 0x01), { maxMs: 900, keepRaw: 8 });
  await sleep(200);
  const d1Recover = await exchange(frameBytes(0x12, addrList([0x2024])), { maxMs: 900, keepRaw: 3 });
  out.probes.push({ id: 'D1-unitid-mismatch', label: 'UnitID=0x01 的 0x12 读（一次请求）', ...d1, recoverAfter200ms: { inboundReports: d1Recover.inboundReports, acks: d1Recover.acks, dataFrames: d1Recover.funcs, values: d1Recover.values } });
  await sleep(400);

  // D1b UnitID 失配后立刻再来一条合法请求（不等 200 ms）
  const d1b = await exchange(frameBytes(0x12, addrList([0x2024]), 0x02), { maxMs: 600, keepRaw: 4 });
  const d1bValid = await exchange(frameBytes(0x12, addrList([0x2024])), { maxMs: 900, keepRaw: 3 });
  out.probes.push({ id: 'D1b-unitid-then-valid', label: 'UnitID=0x02 后立刻发合法请求', ...d1b, immediateValid: { inboundReports: d1bValid.inboundReports, acks: d1bValid.acks, funcs: d1bValid.funcs, values: d1bValid.values } });
  await sleep(600);

  // D2 超容量 127 地址读：抓原始报文
  const many = Array.from({ length: 114 }, (_, index) => 0x2000 + index).concat(Array.from({ length: 13 }, () => 0x2000));
  const d2 = await exchange(frameBytes(0x12, addrList(many)), { maxMs: 1500, keepRaw: 10 });
  out.probes.push({ id: 'D2-read-127', label: '0x12 读 127 地址（超 126 上限）', requestBytes: frameBytes(0x12, addrList(many)).length, ...d2 });
  await sleep(400);

  // D3 未知功能码：是否静默、之后是否自愈
  const d3 = await exchange(frameBytes(0x20, Uint8Array.from([0x20, 0x24])), { maxMs: 700, keepRaw: 4 });
  const d3Valid = await exchange(frameBytes(0x12, addrList([0x2024])), { maxMs: 900, keepRaw: 2 });
  out.probes.push({ id: 'D3-unknown-func', label: '功能码 0x20（未知）', ...d3, nextValid: { inboundReports: d3Valid.inboundReports, acks: d3Valid.acks, funcs: d3Valid.funcs, values: d3Valid.values } });
  await sleep(400);

  // D4 地址边界：写入被接受的范围（0x2071 有效，0x2072 起待定），逐个写 0x1111 再回读
  const boundaryAddrs = [0x2070, 0x2071, 0x2072, 0x2073, 0x2074, 0x2075, 0x2076, 0x2080, 0x2100, 0x2fff];
  const boundary = [];
  for (const addr of boundaryAddrs) {
    const write = await exchange(frameBytes(0x10, pairs([[addr, 0x1111]])), { maxMs: 700 });
    await sleep(50);
    const read = await exchange(frameBytes(0x12, addrList([addr])), { maxMs: 700 });
    boundary.push({
      addr: `0x${hex(addr, 4)}`,
      writeAck: write.acks,
      readAck: read.acks,
      readBack: read.values[`0x${hex(addr, 4)}`] ?? null,
      readFrameBytes: read.funcs,
    });
    await sleep(50);
  }
  out.probes.push({ id: 'D4-write-boundary', label: '写入边界：写 0x1111 后回读（每行一次独立请求）', rows: boundary });

  // 还原：把 0x2070 / 0x2071 写回 0（其余不可恢复项按实测值记录）
  for (const addr of [0x2070, 0x2071]) {
    await exchange(frameBytes(0x10, pairs([[addr, 0]])), { maxMs: 700 });
    await sleep(80);
  }

  // D5 读边界：读 0x003E / 0x100E / 0x2072 是否被拒
  const readBoundary = [];
  for (const addr of [0x003d, 0x003e, 0x003f, 0x100d, 0x100e, 0x2071, 0x2072, 0x3000, 0x9000]) {
    const read = await exchange(frameBytes(0x12, addrList([addr])), { maxMs: 700 });
    readBoundary.push({
      addr: `0x${hex(addr, 4)}`,
      acks: read.acks,
      funcs: read.funcs,
      value: read.values[`0x${hex(addr, 4)}`] ?? null,
    });
    await sleep(50);
  }
  out.probes.push({ id: 'D5-read-boundary', label: '读边界：单地址读（0x12）', rows: readBoundary });

  // D6 权限：写只读 0x000B = 7，回读确认是否真的落值
  const d6write = await exchange(frameBytes(0x10, pairs([[0x000b, 7]])), { maxMs: 700 });
  await sleep(60);
  const d6read = await exchange(frameBytes(0x12, addrList([0x000b])), { maxMs: 700 });
  out.probes.push({
    id: 'D6-readonly-write',
    label: '写只读 0x000B（Firmware Rev X）= 7',
    writeAck: d6write.acks,
    push: d6write.pushes,
    readBack: d6read.values['0x000B'] ?? null,
  });
  await sleep(80);
  const d6restore = await exchange(frameBytes(0x10, pairs([[0x000b, 0]])), { maxMs: 700 });
  out.probes.push({ id: 'D6b-readonly-restore', label: '0x000B 写回 0', writeAck: d6restore.acks });

  // D7 空闲推送：3 s 不说话，看设备是否主动上报（电平 0x2057 等）
  events = [];
  mark = performance.now();
  await sleep(3000);
  const idleDecoded = decodeStream(
    (() => {
      const merged = new Uint8Array(events.reduce((sum, item) => sum + item.bytes.length, 0));
      let cursor = 0;
      for (const item of events) {
        merged.set(item.bytes, cursor);
        cursor += item.bytes.length;
      }
      return merged;
    })(),
  );
  out.probes.push({
    id: 'D7-idle-push',
    label: '静默 3 s 的主动上报',
    inboundReports: events.length,
    frames: idleDecoded.frames.map((item) => ({ func: `0x${hex(item.func, 2)}`, dataHex: bytesHex(item.data) })),
    firstAtMs: events.length > 0 ? events[0].at : null,
    lastAtMs: events.length > 0 ? events[events.length - 1].at : null,
  });

  device.removeEventListener('inputreport', onReport);
  await device.close();
  return JSON.stringify(out);
})()
