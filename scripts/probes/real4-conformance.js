// 第三轮真机联调 · Modbus 参数协议逐条一致性探针（不经 AppStore / ParamSession，直接发帧）。
//   electron.exe . --screenshot=artifacts\real4\conformance.png --route=device --exec-file=scripts\probes\real4-conformance.js --no-sandbox
//
// 目的：把《Modbus通讯协议说明_20261026》里可离线判定的条款逐条跑一遍 —
//   §二 帧结构 / Len / CRC / 多报文、§四 功能码 0x10–0x13、§五 数据段格式、
//   §六 异常码、§七 接收状态机（补位零、拒绝路径），外加 0x2057 电平与 0x10 主动上报两条现场观测。
//
// 所有写操作都「先读原值 → 写入 → 回读 → 恢复原值」；绝不碰 0x1008/0x1009/0x100A（复位/升级/恢复出厂）。
// 输出 { pass, fail, skipped, cases[] }，失败项带原始帧。
(async () => {
 const out = { cases: [], pass: 0, fail: 0, skipped: 0, notes: [] };
 try {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const hx = (value, digits = 2) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
  const bytesHex = (bytes) => Array.from(bytes, (byte) => hx(byte)).join(' ');

  function crc16(bytes) {
    let crc = 0xffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    return crc & 0xffff;
  }
  // 与 device/proto/frame.ts 完全一致：UnitID+Func+LenHi+LenLo+Data+CRCLo+CRCHi
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
  function splitReports(bytes) {
    const reports = [];
    for (let offset = 0; offset < bytes.length; offset += 63) {
      const report = new Uint8Array(63);
      report.set(bytes.subarray(offset, Math.min(offset + 63, bytes.length)));
      reports.push(report);
    }
    return reports;
  }
  // 与 device/proto/frame.ts 的 decodeStream 同算法（含补位零规则）
  function decodeStream(buffer) {
    const frames = [];
    const issues = [];
    let offset = 0;
    while (offset < buffer.length) {
      while (offset + 1 < buffer.length && buffer[offset] === 0x00 && buffer[offset + 1] === 0x00) offset += 1;
      if (buffer.length - offset < 4) break;
      const len = (buffer[offset + 2] << 8) | buffer[offset + 3];
      if (len < 6) {
        issues.push({ problem: 'length', offset, len });
        offset += 1;
        continue;
      }
      if (len > 512) {
        issues.push({ problem: 'capacity', offset, len });
        offset += 1;
        continue;
      }
      if (len > buffer.length - offset) break;
      const expected = crc16(buffer.subarray(offset, offset + len - 2));
      const received = buffer[offset + len - 2] | (buffer[offset + len - 1] << 8);
      if (expected !== received) {
        issues.push({ problem: 'crc', offset, len, expected, received });
        offset += 1;
        continue;
      }
      frames.push({ func: buffer[offset + 1], unitId: buffer[offset], len, data: buffer.slice(offset + 4, offset + len - 2) });
      offset += len;
    }
    return { frames, issues, rest: buffer.slice(offset) };
  }

  const hid = navigator.hid;
  const devices = await hid.getDevices();
  const device = devices.find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
  if (!device) return JSON.stringify({ ...out, error: '目标设备不在列（0A67/0010）' });
  out.product = device.productName;
  await device.open();
  out.opened = device.opened;

  const inbox = [];
  let reportsSeen = 0;
  let inputIds = new Set();
  const onReport = (event) => {
    reportsSeen += 1;
    inputIds.add(hx(event.reportId));
    inbox.push(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
  };
  device.addEventListener('inputreport', onReport);

  function pull() {
    const batch = inbox.splice(0, inbox.length);
    const merged = new Uint8Array(batch.reduce((sum, item) => sum + item.length, 0));
    let cursor = 0;
    for (const item of batch) {
      merged.set(item, cursor);
      cursor += item.length;
    }
    return merged;
  }

  // 发一帧，等到「首个完整应答」后再静默 quietMs 收尾，把多回的帧（ACK 连发）也计入
  async function exchange(frame, { waitMs = 320, quietMs = 150 } = {}) {
    pull();
    const sentAt = performance.now();
    for (const report of splitReports(frame)) {
      await device.sendReport(0x51, report);
      await sleep(2);
    }
    let buffer = new Uint8Array(0);
    let firstAt = null;
    const append = () => {
      const batch = pull();
      if (batch.length === 0) return buffer;
      const next = new Uint8Array(buffer.length + batch.length);
      next.set(buffer, 0);
      next.set(batch, buffer.length);
      buffer = next;
      return buffer;
    };
    let lastCount = 0;
    while (performance.now() - sentAt < waitMs) {
      const decoded = decodeStream(append());
      if (decoded.frames.length > 0) {
        if (firstAt === null) firstAt = performance.now();
        lastCount = decoded.frames.length;
        await sleep(quietMs);
        if (decodeStream(append()).frames.length === lastCount) break;
      } else {
        await sleep(3);
      }
    }
    const decoded = decodeStream(append());
    return {
      ms: firstAt === null ? null : Math.round(firstAt - sentAt),
      frames: decoded.frames,
      issues: decoded.issues,
      bytes: buffer.length,
      raw: bytesHex(buffer.subarray(0, Math.min(buffer.length, 320))),
    };
  }

  const ackOf = (reply) => {
    const frame = reply.frames.find((item) => item.func === 0x02);
    return frame && frame.data.length >= 2 ? (frame.data[0] << 8) | frame.data[1] : null;
  };
  const seqReadOf = (reply) => reply.frames.find((item) => item.func === 0x13) ?? null;
  const randReadOf = (reply) => reply.frames.find((item) => item.func === 0x12) ?? null;
  const seqWords = (frame) => {
    const values = [];
    const count = (frame.data[2] << 8) | frame.data[3];
    for (let index = 0; index < count; index += 1) values.push((frame.data[4 + index * 2] << 8) | frame.data[5 + index * 2]);
    return values;
  };
  const readSeq = async (start, count) => {
    const reply = await exchange(encodeFrame(0x13, Uint8Array.from([(start >> 8) & 0xff, start & 0xff, (count >> 8) & 0xff, count & 0xff])));
    const frame = seqReadOf(reply);
    return frame ? seqWords(frame) : [];
  };
  const readOne = async (addr) => (await readSeq(addr, 1))[0];
  const writeOne = (addr, value) =>
    exchange(encodeFrame(0x10, Uint8Array.from([(addr >> 8) & 0xff, addr & 0xff, (value >> 8) & 0xff, value & 0xff])));

  function record(name, clause, expect, reply, verdict, detail) {
    const entry = {
      name,
      clause,
      expect,
      replies: reply ? reply.frames.length : 0,
      funcs: reply ? reply.frames.map((item) => `0x${hx(item.func)}`) : [],
      ack: reply ? ackOf(reply) : null,
      ms: reply ? reply.ms : null,
      pass: verdict,
      detail,
    };
    if (reply && reply.raw) entry.raw = reply.raw;
    out.cases.push(entry);
    if (verdict === true) out.pass += 1;
    else if (verdict === false) out.fail += 1;
    else out.skipped += 1;
    return entry;
  }

  // ---------------------------------------------------------------- T01 连续读：帧结构 / Len / 回显
  {
    const reply = await exchange(encodeFrame(0x13, Uint8Array.from([0x00, 0x00, 0x00, 0x0f])));
    const frame = seqReadOf(reply);
    const ok =
      !!frame &&
      frame.len === frame.data.length + 6 &&
      frame.data.length === 4 + 15 * 2 &&
      ((frame.data[0] << 8) | frame.data[1]) === 0 &&
      ((frame.data[2] << 8) | frame.data[3]) === 15 &&
      reply.issues.length === 0;
    record('T01 0x13 连续读版本区 0x0000×15', '§二 帧结构 / §五 0x13', '回 0x13，Len=Data+6=40，回显 0x0000/15，CRC 正确', reply, ok,
      ok ? `Len=${frame.len}，回显一致` : `raw=${reply.raw}`);
  }

  // ---------------------------------------------------------------- T02 246 B 单帧跨 4 个 HID 报文
  {
    const reply = await exchange(encodeFrame(0x13, Uint8Array.from([0x20, 0x00, 0x00, 0x76])), { waitMs: 600 });
    const frame = seqReadOf(reply);
    const ok = !!frame && frame.data.length === 4 + 118 * 2 && reply.bytes > 200;
    record('T02 0x13 连续读 0x2000×118（246 B，跨报文）', '§二 多报文按字节流续传', '单帧 240 B 数据，跨 ≥3 个 HID 报文拼接完整', reply, ok,
      ok ? `${reply.bytes} B 拼成 1 帧` : `raw=${reply.raw}`);
  }

  // ---------------------------------------------------------------- T03 随机读乱序地址
  {
    const addrs = [0x2057, 0x000b, 0x2023, 0x205a];
    const reply = await exchange(encodeFrame(0x12, Uint8Array.from(addrs.flatMap((addr) => [(addr >> 8) & 0xff, addr & 0xff]))));
    const frame = randReadOf(reply);
    const pairs = [];
    if (frame) for (let at = 0; at + 3 < frame.data.length; at += 4) pairs.push([(frame.data[at] << 8) | frame.data[at + 1], (frame.data[at + 2] << 8) | frame.data[at + 3]]);
    const ok = !!frame && frame.data.length === addrs.length * 4 && pairs.length === addrs.length && pairs.every((pair, index) => pair[0] === addrs[index]);
    record('T03 0x12 随机读乱序 4 地址', '§五 0x12 回 (Addr,Val) 序列', '4 组 (Addr,Val)，Addr 按请求顺序回显', reply, ok,
      ok ? pairs.map((pair) => `0x${hx(pair[0], 4)}=${pair[1]}`).join(', ') : `raw=${reply.raw}`);
  }

  // ---------------------------------------------------------------- T04 单写 + 回读 + 恢复
  {
    const origin = await readOne(0x2025);
    const target = origin === 1 ? 2 : 1;
    const write = await writeOne(0x2025, target);
    const readBack = await readOne(0x2025);
    const restore = await writeOne(0x2025, origin);
    const ok = ackOf(write) === 0 && readBack === target && ackOf(restore) === 0;
    record('T04 0x10 随机写单字 0x2025 并回读', '§五 0x10（写成功回 ACK 0）', `ACK 0x0000，回读=${target}，恢复 ${origin}`, write, ok,
      `原值 ${origin} → 写 ${target} → 回读 ${readBack} → 恢复 ACK ${ackOf(restore)}`);
  }

  // ---------------------------------------------------------------- T05 连续写 3 字 + 回读 + 恢复
  {
    const start = 0x2024;
    const origin = await readSeq(start, 3);
    const limits = [1, 3, 4];
    const next = origin.map((value, index) => (value + 1 > limits[index] ? Math.max(0, value - 1) : value + 1));
    const writeData = Uint8Array.from([0x20, 0x24, 0x00, 0x03, ...next.flatMap((value) => [(value >> 8) & 0xff, value & 0xff])]);
    const write = await exchange(encodeFrame(0x11, writeData));
    const readBack = await readSeq(start, 3);
    const restoreData = Uint8Array.from([0x20, 0x24, 0x00, 0x03, ...origin.flatMap((value) => [(value >> 8) & 0xff, value & 0xff])]);
    const restore = await exchange(encodeFrame(0x11, restoreData));
    const ok = ackOf(write) === 0 && readBack.join(',') === next.join(',') && ackOf(restore) === 0;
    record('T05 0x11 连续写 0x2024×3 并回读', '§五 0x11（Num*2+4 == len）', `ACK 0x0000，回读=${next.join(',')}，恢复 ${origin.join(',')}`, write, ok,
      `原值 ${origin.join(',')} → 写 ${next.join(',')} → 回读 ${readBack.join(',')} → 恢复 ACK ${ackOf(restore)}`);
  }

  // ---------------------------------------------------------------- T06 写只读参数 → 0x0004
  {
    const origin = await readOne(0x2023);
    const reply = await writeOne(0x2023, origin === 50 ? 51 : 50);
    if (ackOf(reply) === 0) await writeOne(0x2023, origin); // 固件若误接受，恢复
    record('T06 0x10 写只读参数 0x2023（MIC 音量）', '§六 CP_ACK_READ_ONLY_ERR', 'ACK 0x0004', reply, ackOf(reply) === 4,
      `ack=${reply.frames.length ? `0x${hx(ackOf(reply) ?? 0xffff, 4)}` : '无应答'}，帧数 ${reply.frames.length}`);
  }
  await sleep(400);

  // ---------------------------------------------------------------- T07 地址越界 → 0x0005
  {
    const reply = await exchange(encodeFrame(0x13, Uint8Array.from([0x20, 0x80, 0x00, 0x01])));
    record('T07 0x13 读越界地址 0x2080（参数表止于 0x2071）', '§五 0x13 / §六 CP_ACK_DATA_ERR', 'ACK 0x0005', reply, ackOf(reply) === 5,
      `ack=${reply.frames.length ? `0x${hx(ackOf(reply) ?? 0xffff, 4)}` : '无应答'}，帧数 ${reply.frames.length}`);
  }
  await sleep(400);

  // ---------------------------------------------------------------- T08 CRC 错 → 0x0003
  {
    const bad = encodeFrame(0x13, Uint8Array.from([0x00, 0x0b, 0x00, 0x01]));
    bad[bad.length - 1] ^= 0xff;
    const reply = await exchange(bad);
    record('T08 故意错 CRC 的 0x13', '§六 CP_ACK_CHECKSUM_ERR', 'ACK 0x0003', reply, ackOf(reply) === 3, `ack=${ackOf(reply)}，帧数 ${reply.frames.length}`);
  }
  await sleep(400);

  // ---------------------------------------------------------------- T09 UnitID 错 → 0x0001（且只能一条）
  {
    const reply = await exchange(encodeFrame(0x13, Uint8Array.from([0x00, 0x0b, 0x00, 0x01]), 0x01));
    record('T09 UnitID=0x01 的 0x13', '§七 ADDR 失配 → CP_ACK_DEV_ADDR_ERR', 'ACK 0x0001，且只回 1 条', reply, ackOf(reply) === 1 && reply.frames.length === 1,
      `ack=${ackOf(reply)}，帧数 ${reply.frames.length}（${reply.frames.map((item) => `0x${hx(item.func)}`).join(',')}）`);
  }
  await sleep(1500); // 拒绝路径可能触发固件 1 s 断流

  // ---------------------------------------------------------------- T10 拒绝之后紧跟合法请求
  {
    const reply = await exchange(encodeFrame(0x13, Uint8Array.from([0x00, 0x0b, 0x00, 0x02])), { waitMs: 900 });
    const frame = seqReadOf(reply);
    const ok = !!frame && frame.data.length === 8;
    record('T10 拒绝路径之后紧跟一条合法 0x13', '§六「不得静默不回包」', '回 0x13 两字数据，不被残留 ACK 吞掉', reply, ok,
      ok ? '正常回数据帧' : `raw=${reply.raw}`);
  }

  // ---------------------------------------------------------------- T11–T15 长度类异常 → 0x0002
  {
    const reply = await exchange(encodeFrame(0x10, Uint8Array.from([0x20, 0x25, 0x00])));
    record('T11 0x10 数据段 3 B（len%4!=0）', '§五 0x10 / §六 CP_ACK_LEN_ERR', 'ACK 0x0002', reply, ackOf(reply) === 2, `ack=${ackOf(reply)}，帧数 ${reply.frames.length}`);
  }
  await sleep(400);
  {
    const reply = await exchange(encodeFrame(0x13, Uint8Array.from([0x20, 0x00, 0x00])));
    record('T12 0x13 数据段 3 B（len!=4）', '§五 0x13 / §六 CP_ACK_LEN_ERR', 'ACK 0x0002', reply, ackOf(reply) === 2, `ack=${ackOf(reply)}，帧数 ${reply.frames.length}`);
  }
  await sleep(400);
  {
    const reply = await exchange(encodeFrame(0x12, Uint8Array.from([0x20, 0x00, 0x00])));
    record('T13 0x12 数据段 3 B（len%2!=0）', '§五 0x12 / §六 CP_ACK_LEN_ERR', 'ACK 0x0002', reply, ackOf(reply) === 2, `ack=${ackOf(reply)}，帧数 ${reply.frames.length}`);
  }
  await sleep(400);
  {
    const reply = await exchange(encodeFrame(0x11, Uint8Array.from([0x20, 0x24, 0x00, 0x03, 0x00, 0x01, 0x00, 0x02])));
    record('T14 0x11 Num=3 但只给 2 个值', '§五 0x11（Num*2+4 == len）', 'ACK 0x0002', reply, ackOf(reply) === 2, `ack=${ackOf(reply)}，帧数 ${reply.frames.length}`);
  }
  await sleep(400);
  {
    const many = new Uint8Array(260 * 2);
    for (let index = 0; index < 260; index += 1) {
      many[index * 2] = 0x20;
      many[index * 2 + 1] = index & 0xff;
    }
    const reply = await exchange(encodeFrame(0x12, many), { waitMs: 700 });
    record('T15 0x12 请求 260 个地址（帧 526 B，超 512 B 缓存）', '§六 Len 超缓存 → CP_ACK_LEN_ERR', 'ACK 0x0002，且只回 1 条', reply, ackOf(reply) === 2 && reply.frames.length === 1,
      `ack=${ackOf(reply)}，帧数 ${reply.frames.length}`);
  }
  await sleep(1500);

  // ---------------------------------------------------------------- T16 值越界 → 0x0005 或明确拒绝
  {
    const origin = await readOne(0x2025);
    const reply = await writeOne(0x2025, 9);
    const kept = await readOne(0x2025);
    const accepted = ackOf(reply) === 0;
    if (accepted && kept === 9) await writeOne(0x2025, origin); // 越界值被接受：恢复现场
    record('T16 0x10 写越界值 0x2025=9（范围 0..3）', '§六 CP_ACK_DATA_ERR（参数值超范围）', 'ACK 0x0005 且寄存器保持原值', reply,
      ackOf(reply) === 5 && kept === origin, `ack=${ackOf(reply)}，回读 ${kept}（原 ${origin}）${accepted ? '，设备接受了越界值' : ''}`);
  }
  await sleep(400);

  // ---------------------------------------------------------------- T17 正常请求尾部补位零不应产生额外 ACK
  {
    const reply = await exchange(encodeFrame(0x13, Uint8Array.from([0x20, 0x00, 0x00, 0x1e])), { waitMs: 600 });
    const frame = seqReadOf(reply);
    const ok = !!frame && reply.frames.length === 1 && frame.data.length === 4 + 30 * 2;
    record('T17 正常请求尾部补位零（63 B + 7 B）', '§七 接收状态机 / 需求 C1 补位零', '1 条数据帧，0 条杂 ACK', reply, ok,
      ok ? '一请求一应答' : `帧数 ${reply.frames.length}：${reply.funcs.join(',')}`);
  }

  // ---------------------------------------------------------------- T18 空 0x10
  {
    const reply = await exchange(encodeFrame(0x10, new Uint8Array(0)));
    record('T18 0x10 数据段 0 B', '§五 0x10', 'ACK 0x0002/0x0005，不得静默、不得多条', reply,
      reply.frames.length === 1 && (ackOf(reply) === 2 || ackOf(reply) === 5), `ack=${ackOf(reply)}，帧数 ${reply.frames.length}`);
  }
  await sleep(400);

  // ---------------------------------------------------------------- T19 0x2057 电平连读
  {
    const levels = [];
    for (let index = 0; index < 12; index += 1) {
      levels.push(await readOne(0x2057));
      await sleep(250);
    }
    out.levels = levels;
    record('T19 0x2057 MIC 电平连读 12 次', '需求 §电平现场值', '读数随输入变化（至少不是恒定 0）', null,
      levels.every((value) => value === 0) ? false : true, `采样 ${levels.join(',')}`);
  }

  // ---------------------------------------------------------------- T20 空闲 6 s 是否有 0x10 主动上报
  {
    pull();
    const seen = [];
    const startAt = performance.now();
    while (performance.now() - startAt < 6000) {
      const batch = pull();
      if (batch.length > 0) {
        for (const frame of decodeStream(batch).frames) seen.push({ func: `0x${hx(frame.func)}`, len: frame.len });
      }
      await sleep(50);
    }
    out.unsolicited = seen;
    record('T20 空闲 6 s 监听 0x10 主动上报', '§四 0x10 双向复用（设备→主机上报）', '有上报，或至少不产生畸形帧', null, null,
      seen.length === 0 ? '6 s 内无任何上报帧' : `收到 ${seen.length} 帧：${JSON.stringify(seen.slice(0, 6))}`);
  }

  // ---------------------------------------------------------------- T21 设备信息区
  {
    const reply = await exchange(encodeFrame(0x13, Uint8Array.from([0x00, 0x00, 0x00, 0x3e])), { waitMs: 700 });
    const frame = seqReadOf(reply);
    const words = frame ? seqWords(frame) : [];
    const ascii = (from, count) =>
      String.fromCharCode(...words.slice(from, from + count).flatMap((word) => [(word >> 8) & 0xff, word & 0xff])).replace(/\x00+$/, '');
    out.info = words.length
      ? {
          model: ascii(0, 3),
          name: ascii(3, 8),
          firmware: `${words[11]}.${words[12]}.${words[13]}.${words[14]}`,
          vid: hx(words[0x16], 4),
          pid: hx(words[0x17], 4),
          sn: ascii(0x1e, 32),
          nonZero: words.filter((word) => word !== 0).length,
        }
      : null;
    record('T21 0x13 读设备信息 0x0000×62', 'M001 参数表「设备信息」/ 需求 A.4', '型号/名称/版本/VID/PID/SN 有内容', reply,
      !!frame && out.info.nonZero > 0,
      out.info ? `非零字 ${out.info.nonZero}/62；model="${out.info.model}" name="${out.info.name}" fw=${out.info.firmware} vid/pid=${out.info.vid}/${out.info.pid}` : '读失败');
  }

  // ---------------------------------------------------------------- T22 整段预设 + 区间上界
  {
    const reply = await exchange(encodeFrame(0x13, Uint8Array.from([0x20, 0x00, 0x00, 0x76])), { waitMs: 700 });
    const frame = seqReadOf(reply);
    const words = frame ? seqWords(frame) : [];
    const nonZero = words.map((word, index) => (word === 0 ? -1 : 0x2000 + index)).filter((addr) => addr >= 0);
    out.preset = { count: words.length, nonZero: nonZero.length, firstNonZero: nonZero.slice(0, 12).map((addr) => `0x${hx(addr, 4)}`) };
    record('T22 0x13 读整段预设 0x2000×118', '§五 地址有效范围（0x2000~0x2075）', '整段可读、帧完整', reply,
      !!frame && words.length === 118, `读到 ${words.length} 字，非零 ${nonZero.length}${nonZero.length ? `（首 ${out.preset.firstNonZero.join(',')}）` : '（全 0）'}`);
  }

  // ---------------------------------------------------------------- T23 参数表之外的 0x2072~0x2075
  {
    const reply = await exchange(encodeFrame(0x13, Uint8Array.from([0x20, 0x72, 0x00, 0x04])));
    record('T23 读 0x2072~0x2075（M001 参数表止于 0x2071）', '§五 地址范围 vs 参数表', '回 DATA_ERR 或明确应答，不得静默', reply, reply.frames.length >= 1,
      reply.frames.length ? `${reply.frames.map((item) => `0x${hx(item.func)}`).join(',')} ack=${ackOf(reply)}` : '无应答');
  }
  await sleep(400);

  // ---------------------------------------------------------------- T24 配置区默认值
  {
    const reply = await exchange(encodeFrame(0x13, Uint8Array.from([0x10, 0x00, 0x00, 0x02])));
    const frame = seqReadOf(reply);
    const words = frame ? seqWords(frame) : [];
    record('T24 0x13 读配置区 0x1000/0x1001', 'M001 参数表「设备配置」默认值（心跳 700 / 地址 0）', '心跳 700、设备地址 0', reply,
      !!frame && words[0] === 700 && words[1] === 0, `心跳=${words[0]} 地址=${words[1]}`);
  }

  out.inputReportIds = [...inputIds];
  out.reportsSeen = reportsSeen;
  device.removeEventListener('inputreport', onReport);
  try {
    await device.close();
  } catch {
    /* ignore */
  }
  out.ok = out.cases.every((item) => item.pass !== false);
  return JSON.stringify(out);
 } catch (error) {
   return JSON.stringify({ fatal: String(error), stack: error && error.stack, cases: out.cases, pass: out.pass, fail: out.fail });
 }
})()
