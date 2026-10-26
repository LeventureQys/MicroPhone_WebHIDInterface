// 真机 DFU 首刷 / 救砖探针：按《DFU固件升级通讯协议说明_20261026》直连 HID 走完整流程。
//   electron.exe . --screenshot=artifacts\real3\dfu.png --route=device --exec-file=scripts\probes\real3-dfu-flash.js --no-sandbox --allow-file-access-from-files
// 流程：读版本（Modbus）→ 发进入 DFU 帧 → 等重新枚举 → 信息帧 → 645 块 → 0x05 → 等重启 → 回读版本。
// 任一状态异常立即停手并返回现场；设备会停在 Bootloader（可重跑本探针，跳过进入帧直接刷）。
(async () => {
  const OUT_ID = 0x51;
  const PAYLOAD = 63;
  const PKG_URL =
    'file:///D:/WorkShop/MicroPhone_WebHIDInterface/Document/Protocol/dfu_M001%20MCU%20V0.0.2_2026-10-26_Rev0.bin';
  const hex = (value, digits) => Number(value).toString(16).toUpperCase().padStart(digits, '0');
  const bytesHex = (bytes) => Array.from(bytes, (byte) => hex(byte, 2)).join(' ');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---- 帧层（与 device/dfu/frame.ts、device/proto/crc.ts 同构） ----
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
      frames.push({
        cmd: frame[4] & 0x7f,
        data: frame.slice(5, length - 2),
        raw: frame.slice(),
        status: frame[4] === 0x0b && frame[5] === 0x01 ? frame[7] : null,
        ack: frame[4] === 0x02 ? frame[5] | (frame[6] << 8) : null,
      });
      pos += length;
    }
    return { frames, rest: buffer.slice(pos) };
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
    for (let offset = 0; offset < frame.length; offset += PAYLOAD) {
      const report = new Uint8Array(PAYLOAD);
      report.set(frame.subarray(offset, Math.min(offset + PAYLOAD, frame.length)));
      reports.push(report);
    }
    return reports;
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

  // ---- 设备 ----
  const isTarget = (device) => device.vendorId === 0x0a67 && device.productId === 0x0010;
  async function listTargets() {
    const all = await navigator.hid.getDevices();
    return all.filter(isTarget);
  }
  async function openTarget(exclude = null) {
    const devices = await listTargets();
    const ordered = devices.filter((device) => device !== exclude).concat(devices.filter((device) => device === exclude));
    for (const candidate of ordered) {
      try {
        if (!candidate.opened) await candidate.open();
        if (candidate.opened) return candidate;
      } catch {
        /* 复位中的旧句柄：换下一个 */
      }
    }
    return null;
  }

  const out = { steps: [], error: null };
  const t0 = performance.now();
  const stamp = () => Math.round(performance.now() - t0);
  const log = (step, detail) => out.steps.push({ ms: stamp(), step, detail });

  // ---- 包解析（只取原始帧，不重编码，保证与厂商包逐字节一致） ----
  let pkg;
  try {
    const response = await fetch(PKG_URL);
    pkg = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    return JSON.stringify({ error: `读取固件包失败：${String(error)}` });
  }
  const headerLength = (pkg[2] << 8) | pkg[3];
  const enterFrame = pkg.slice(0, headerLength);
  const parsed = decodeSigma(pkg.subarray(headerLength));
  if (parsed.frames.length === 0) return JSON.stringify({ error: '固件包没有可解析的 SigmaBus 帧' });
  const infoFrame = parsed.frames.find((frame) => frame.cmd === 0x0b && frame.data[0] === 0x02);
  const blockFrames = parsed.frames.filter((frame) => frame.cmd === 0x0b && frame.data[0] === 0x03);
  if (!infoFrame || blockFrames.length === 0) return JSON.stringify({ error: '固件包里没有信息帧或代码块帧' });
  const info = infoFrame.data;

  // 厂商包每块 256 B → 整帧 265 B → 占 5 个 63 B 报文，超过设备 OUT 缓冲的 4 个槽位。
  // 这里按字节流重切成 128 B 一块（3 个报文），设备侧按 DataCount 累加，不关心分块边界；
  // Gamma 只看块内 i%4、累加和按 4 字节字连续累加，128 是 4 的倍数，所以字节流等价。
  const stream = new Uint8Array(blockFrames.reduce((sum, frame) => sum + frame.data.length - 2, 0));
  let cursor = 0;
  for (const frame of blockFrames) {
    stream.set(frame.data.subarray(2), cursor);
    cursor += frame.data.length - 2;
  }
  const CHUNK = 64;
  const REPORT_GAP_MS = 15;
  const POST_STATUS_MS = 25;
  const chunkFrames = [];
  for (let offset = 0; offset < stream.length; offset += CHUNK) {
    const size = Math.min(CHUNK, stream.length - offset);
    const payload = new Uint8Array(2 + size);
    payload[0] = 0x03;
    payload[1] = 0x00;
    payload.set(stream.subarray(offset, offset + size), 2);
    chunkFrames.push(encodeSigma(0x0b, payload));
  }
  out.chunking = {
    blocks: blockFrames.length,
    chunks: chunkFrames.length,
    chunkBytes: CHUNK,
    totalBytes: stream.length,
  };
  out.package = {
    bytes: pkg.length,
    headerHex: bytesHex(enterFrame),
    modelCode: String.fromCharCode(...info.subarray(2, 8)),
    version: `${info[72]}.${info[73]}.${info[74]}`,
    fwLength: info[75] | (info[76] << 8) | (info[77] << 16) | (info[78] << 24),
    fwChecksum: `0x${(info[79] | (info[80] << 8) | (info[81] << 16) | (info[82] << 24)).toString(16).toUpperCase()}`,
    blocks: blockFrames.length,
  };
  log('package', out.package);

  // ---- 连接与入站 ----
  let device = await openTarget(null);
  if (device === null) return JSON.stringify({ ...out, error: '设备不在列或打不开（VID 0A67 / PID 0010）' });
  let inbound = new Uint8Array(0);
  const onReport = (event) => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const merged = new Uint8Array(inbound.length + bytes.length);
    merged.set(inbound, 0);
    merged.set(bytes, inbound.length);
    inbound = merged;
  };
  device.addEventListener('inputreport', onReport);
  const detach = () => {
    try {
      device.removeEventListener('inputreport', onReport);
    } catch {
      /* 设备已释放 */
    }
    inbound = new Uint8Array(0);
  };

  async function sendFrame(frame, options = {}) {
    const timeoutMs = options.timeoutMs ?? 2000;
    const gapMs = options.gapMs ?? REPORT_GAP_MS;
    for (const report of splitReports(frame)) {
      const sent = await Promise.race([
        device
          .sendReport(OUT_ID, report)
          .then(() => ({ ok: true }))
          .catch((error) => ({ ok: false, error: String(error) })),
        sleep(timeoutMs).then(() => ({ timeout: true })),
      ]);
      if (sent.timeout === true) throw new Error(`sendReport 超时 ${timeoutMs} ms（设备 OUT 端点不接收）`);
      if (sent.ok === false) throw new Error(`sendReport 失败：${sent.error}`);
      if (gapMs > 0) await sleep(gapMs);
    }
  }
  async function waitFor(pick, timeoutMs) {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      const decoded = pick(inbound);
      const hit = decoded.frames.find((frame) => frame.status !== null || frame.ack !== null);
      if (hit) return hit;
      await sleep(4);
    }
    return null;
  }

  // ---- 0) 读当前版本（Modbus 0x13 读 0x0000..0x000E） ----
  async function readVersion(tag) {
    const request = Uint8Array.from([0x00, 0x13, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x0f]);
    const crc = crc16(request);
    const frame = new Uint8Array([...request, crc & 0xff, (crc >> 8) & 0xff]);
    inbound = new Uint8Array(0);
    try {
      await sendFrame(frame);
    } catch (error) {
      log(`${tag}:modbus-send-fail`, String(error));
      return null;
    }
    const started = performance.now();
    while (performance.now() - started < 800) {
      const frames = decodeModbus(inbound);
      const reply = frames.find((item) => item.func === 0x13 && item.data.length > 20);
      if (reply) {
        const words = [];
        for (let at = 4; at + 1 < reply.data.length; at += 2) words.push((reply.data[at] << 8) | reply.data[at + 1]);
        const version = `${words[11]}.${words[12]}.${words[13]}.${words[14]}`;
        log(`${tag}:modbus-version`, version);
        return version;
      }
      await sleep(8);
    }
    log(`${tag}:modbus-no-reply`, '');
    return null;
  }

  out.before = await readVersion('before');
  const staleDevice = device;

  // ---- 1) 进入 DFU（仅当还在 MainApp 应答 Modbus 时） ----
  let entered = false;
  if (out.before !== null) {
    inbound = new Uint8Array(0);
    await sendFrame(enterFrame);
    const ack = await waitFor((buffer) => {
      const frames = decodeModbus(buffer).map((item) => ({
        status: null,
        ack: item.func === 0x02 ? (item.data[0] << 8) | item.data[1] : null,
      }));
      return { frames };
    }, 900);
    out.enterAck = ack === null ? null : `0x${hex(ack.ack, 4)}`;
    log('enter', out.enterAck);
    entered = out.enterAck === '0x0000';
  } else {
    log('enter', '设备当前不应答 Modbus，按已在 Bootloader 处理');
  }
  detach();
  try {
    await device.close();
  } catch {
    /* 复位中，close 可能失败 */
  }
  device = null;

  // ---- 2) 等设备重新枚举（1–3 s，最长 10 s） ----
  {
    const started = performance.now();
    let found = null;
    while (performance.now() - started < 10000) {
      found = await openTarget(staleDevice);
      if (found !== null) break;
      await sleep(250);
    }
    if (found === null) return JSON.stringify({ ...out, error: '等不到设备重新枚举（10 s）' });
    device = found;
    device.addEventListener('inputreport', onReport);
    log('reenumerated', `${Math.round(performance.now() - started)} ms`);
  }

  // 连通性预检：读 Bootloader 的 DevInfo（旧 SigmaBus 0x06）。设备挂死时这里就会 sendReport 超时，
  // 比"发信息帧等 2.5 s"更快暴露问题。
  {
    const payload = Uint8Array.from([0x00, 0x00, 0x0b, 0x00]);
    let replied = false;
    try {
      await sendFrame(encodeSigma(0x06, payload), { timeoutMs: 1500, gapMs: 0 });
      const started = performance.now();
      while (performance.now() - started < 1200) {
        if (decodeSigma(inbound).frames.length > 0) {
          replied = true;
          break;
        }
        await sleep(8);
      }
    } catch (error) {
      return JSON.stringify({ ...out, error: `设备无响应：${String(error)}`, hint: '需要拔插复位后再试' });
    }
    inbound = new Uint8Array(0);
    out.precheck = replied;
    log('precheck', replied ? 'DevInfo 有应答' : 'DevInfo 无应答');
    if (!replied) return JSON.stringify({ ...out, error: 'Bootloader 不回应 DevInfo 读，设备可能挂死', hint: '需要拔插复位后再试' });
  }

  // ---- 3) 信息帧 ----
  async function exchangeStatus(frame, timeoutMs, tag) {
    inbound = new Uint8Array(0);
    try {
      await sendFrame(frame);
    } catch (error) {
      return { kind: 'send-fail', detail: String(error) };
    }
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      const frames = decodeSigma(inbound).frames;
      const status = frames.find((item) => item.status !== null);
      if (status) return { kind: 'status', value: status.status, ack: null, at: Math.round(performance.now() - started) };
      const ack = frames.find((item) => item.ack !== null);
      if (ack) return { kind: 'ack', value: ack.ack, at: Math.round(performance.now() - started) };
      await sleep(4);
    }
    return { kind: 'timeout' };
  }

  const infoResult = await exchangeStatus(infoFrame.raw, 2500, 'info');
  out.info = infoResult;
  log('info', infoResult);

  // 设备 Flash 信息区为空（Bootloader 侧读 DevInfo 全 0），非通配包会被 0x01 拒绝。
  // 这一步把**内存里**的信息帧型号改成通配 "000000" 并重封 SigmaCRC（不改厂商文件，写进 Flash 的代码块完全不变），
  // 走协议 §5.2 的"通用升级"分支。仅当 info 第一次被 0x01 拒绝时才触发。
  let sendInfo = infoFrame.raw;
  if (infoResult.kind === 'status' && infoResult.value === 0x01) {
    const patched = new Uint8Array(infoFrame.raw);
    const modelAt = 5 + 2; // C4 Len Addr Cmd DFU_CMD CHIP_ID 之后就是 ModelCode
    for (let i = 0; i < 6; i += 1) patched[modelAt + i] = '0'.charCodeAt(0);
    const crc = sigmaCrc(patched.subarray(0, patched.length - 2));
    patched[patched.length - 2] = crc & 0xff;
    patched[patched.length - 1] = (crc >> 8) & 0xff;
    sendInfo = patched;
    out.patchedModelCode = '000000';
    log('info-patch', '型号改为通配 000000（设备信息区为空）');
    const retry = await exchangeStatus(sendInfo, 2500, 'info-patched');
    out.infoPatched = retry;
    log('info-patched', retry);
    if (retry.kind !== 'status' || retry.value !== 0x03) {
      const hint =
        '通配包也被拒绝：设备可能不是 M001，或 Bootloader 与文档不一致，需固件方确认；拔插一次即回 App';
      return JSON.stringify({ ...out, error: `信息帧（通配）未被接受（${JSON.stringify(retry)}）`, hint });
    }
  } else if (infoResult.kind !== 'status' || infoResult.value !== 0x03) {
    // 0x01 = 型号不匹配（固件在写 EndFlag 之前就返回，拔插即可回到 App）
    const hint =
      infoResult.kind === 'status' && infoResult.value === 0x01
        ? '型号校验未过：设备 Flash 信息区里没有 JYM001，需固件先灌型号；拔插一次即回 App'
        : '信息帧无有效应答；设备若停在 Bootloader，拔插一次即回 App（EndFlag 未被改写）';
    return JSON.stringify({ ...out, error: `信息帧未被接受（status=${infoResult.value ?? '无'}）`, hint });
  }
  out.infoAccepted = true;

  // ---- 4) 逐块写入（整轮可重来：信息帧会把设备的 IapAddress/DataCount/校验和清零） ----
  const blockStart = performance.now();
  out.progress = [];
  out.rounds = [];
  const MAX_ROUNDS = 1;
  let ok = false;
  let maxLatency = 0;
  for (let round = 1; round <= MAX_ROUNDS && !ok; round += 1) {
    // 新一轮：信息帧重新开始（通配包已在上面验证过）
    if (round > 1) {
      const restart = await exchangeStatus(sendInfo, 3000, `info round ${round}`);
      log(`info round ${round}`, restart);
      if (restart.kind !== 'status' || restart.value !== 0x03) {
        out.error = `第 ${round} 轮信息帧失败：${JSON.stringify(restart)}`;
        break;
      }
    }
    const roundStart = performance.now();
    let roundError = null;
    for (let index = 0; index < chunkFrames.length; index += 1) {
      const frame = chunkFrames[index];
      const result = await exchangeStatus(frame, 4000, `chunk ${index + 1}`);
      if (result.kind === 'send-fail') {
        roundError = `块 ${index + 1}/${chunkFrames.length} 发送失败：${result.detail}`;
        out.channelDead = true;
        break;
      }
      if (result.kind !== 'status') {
        roundError = `块 ${index + 1}/${chunkFrames.length} ${result.kind}`;
        break;
      }
      if (typeof result.at === 'number' && result.at > maxLatency) maxLatency = result.at;
      await sleep(POST_STATUS_MS);
      if (result.value === 0x05) {
        log('block-final', `0x05 在块 ${index + 1}/${chunkFrames.length}（第 ${round} 轮）`);
        out.blockResult = 'success';
        ok = true;
        break;
      }
      if (result.value !== 0x03) {
        roundError = `块 ${index + 1}/${chunkFrames.length} 返回 status 0x${hex(result.value, 2)}`;
        break;
      }
      if (index === chunkFrames.length - 1) {
        roundError = '最后一块仍回 0x03（没有 0x05）';
        break;
      }
      if ((index + 1) % 100 === 0 || index === 0) {
        out.progress.push({
          round,
          block: index + 1,
          ms: Math.round(performance.now() - blockStart),
          maxLatency,
        });
      }
    }
    out.rounds.push({ round, ms: Math.round(performance.now() - roundStart), error: roundError });
    if (roundError !== null) {
      out.error = roundError;
      if (out.channelDead === true) break;
      await sleep(1200);
      continue;
    }
  }
  out.flashMs = Math.round(performance.now() - blockStart);
  log('flash', { result: out.blockResult ?? 'failed', ms: out.flashMs, rounds: out.rounds.length });
  if (!ok) return JSON.stringify(out);

  // ---- 5) 等重启并回读版本 ----
  detach();
  try {
    await device.close();
  } catch {
    /* 设备即将复位 */
  }
  device = null;
  await sleep(1500);
  {
    const started = performance.now();
    let found = null;
    while (performance.now() - started < 12000) {
      found = await openTarget(null);
      if (found !== null) break;
      await sleep(250);
    }
    if (found === null) {
      out.error = '升级后等不到设备重新枚举（12 s）';
      return JSON.stringify(out);
    }
    device = found;
    device.addEventListener('inputreport', onReport);
    log('reappeared', `${Math.round(performance.now() - started)} ms`);
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await sleep(900);
      out.after = await readVersion(`after#${attempt}`);
      if (out.after !== null) break;
    }
  }

  detach();
  try {
    await device.close();
  } catch {
    /* ignore */
  }
  return JSON.stringify(out);
})()
