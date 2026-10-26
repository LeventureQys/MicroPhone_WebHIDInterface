/**
 * 虚拟下位机侧车：订阅桥的 hid.outputReport → 按当前模式喂 ParamStack / DfuStack →
 * 用 device.setInput 注入回执，同时开一条控制面 HTTP（仅 127.0.0.1）供测试与人工
 * 读写寄存器、注入故障、驱动电平、查统计。
 *
 * 不回环、不 hid.open 设备：output 事件是无条件广播的，setInput 也不要求设备已打开
 * （2026-10-25 实测，见设计文档 §5.14.2）。
 *
 * 故障注入分两类，别混：`drop/delay/disconnect/powerLoss` 作用在"喂栈之前"，按报告拦；
 * 改回执的那几类（`dropAck/crcError/ackError/statusFail/sticky`）必须挂到**帧**上，等最后一条报告到齐、
 * 回执真正产出时由 handleReplies 消费 —— 265 B 的块帧跨 5 条报告，动作挂在单条报告上等于永远打不中。
 */

import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  LEVEL_ADDR,
  MODE_APP,
  MODE_BOOTLOADER,
  MAX_FRAME_BYTES,
  ParamStack,
  PAYLOAD_BYTES,
  REPORT_ID_IN,
  buildFrame,
  splitReports,
} from './device-stack.mjs';
import {
  CMD_ACK,
  CMD_DFU,
  DFU_CMD_BLOCK,
  DFU_CMD_INFO,
  DFU_CMD_STATUS,
  DFU_STATUS_FAIL,
  MAX_SIGMA_FRAME,
  SIGMA_START,
  DfuStack,
  buildSigmaFrame,
  sigmaCrc,
} from './dfu-stack.mjs';
import { REPLY_ACTIONS, FaultTable } from './faults.mjs';
import { LevelSource } from './level.mjs';

const TAG = '[vdevice]';
const CONTROL_HOST = '127.0.0.1';
const PROTOCOL = 'webhid-bridge.v1';
const WS_OPEN = 1;
const LOG_LIMIT = 200;
const BODY_LIMIT = 64 * 1024;
const RECONNECT_FIRST_MS = 500;
const RECONNECT_LATER_MS = 1000;
const RECONNECT_LIMIT = 20;
const SET_INPUT_RETRY = 1;

const MODEL_CODE = 'JYM001';
const FW_VERSION_ADDR = Object.freeze({ x: 0x000b, y: 0x000c, z: 0x000d });
const FIRMWARE_BUILD_ADDR = 0x000e;
/** 缺省延迟动作的毫秒数；规则里给了 ms 就以规则为准 */
const DEFAULT_FAULT_MS = 200;

const DEFAULTS = Object.freeze({
  bridge: 'ws://127.0.0.1:8765/ws',
  device: 'mic-m001',
  controlPort: 8766,
  level: 0,
});

/**
 * 桥的 hid.outputReport 带的是主机发出的 output report ID（0x51，63 B 载荷，2026-10-25 实测），
 * 不是 IN 报告号；短输出报告 0x50 本版本不用，收到即计入 ignoredReports。
 */
const REPORT_ID_OUT = 0x51;

/** 参数协议里主机 → 设备的四个功能码（ACK 0x02 只出现在回执里） */
const INBOUND_FUNCS = new Set([0x10, 0x11, 0x12, 0x13]);
/** 回执里可能出现的功能码，含 ACK 0x02（拆回执帧时用） */
const REPLY_FUNCS = new Set([0x02, 0x10, 0x11, 0x12, 0x13]);
const FRAME_TRAILER_BYTES = 2;

/** 解析 `--bridge/--device/--control-port/--level`；参数不合法直接抛（入口会打一行并退 1） */
export function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--bridge') {
      options.bridge = readValue(argv, (index += 1), flag);
    } else if (flag === '--device') {
      options.device = readValue(argv, (index += 1), flag);
    } else if (flag === '--control-port') {
      options.controlPort = Number(readValue(argv, (index += 1), flag));
    } else if (flag === '--level') {
      options.level = Number(readValue(argv, (index += 1), flag));
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!/^wss?:\/\/\S+$/.test(options.bridge)) {
    throw new Error(`--bridge must be a ws:// or wss:// URL, got ${options.bridge}`);
  }
  if (!Number.isInteger(options.controlPort) || options.controlPort <= 0 || options.controlPort > 0xffff) {
    throw new Error(`--control-port must be an integer in 1..65535, got ${options.controlPort}`);
  }
  if (!Number.isInteger(options.level) || options.level < 0 || options.level > 256) {
    throw new Error(`--level must be an integer in 0..256, got ${options.level}`);
  }
  return options;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

/** 桥对短包容忍（右侧补 0）；超过 63 B 无法补，返回 null 让调用方计数丢弃 */
export function padReportPayload(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > PAYLOAD_BYTES) return null;
  const payload = new Uint8Array(PAYLOAD_BYTES);
  payload.set(bytes);
  return payload;
}

function hexOf(bytes) {
  const parts = [];
  for (const byte of bytes) parts.push(byte.toString(16).toUpperCase().padStart(2, '0'));
  return parts.join(' ');
}

function decodeBase64(text) {
  const buffer = Buffer.from(text, 'base64');
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function concatBytes(left, right) {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error(`body exceeds ${BODY_LIMIT} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('body must be JSON'));
      }
    });
    req.on('error', (error) => reject(error));
  });
}

/**
 * 从一条已发出的报告解出帧长；0 表示这段字节不是帧起点（多为报告尾部补 0x00）。
 * 参数协议 LEN 是大端、整帧字节数；SigmaBus LEN 是小端、整帧字节数。
 */
function frameLengthAt(bytes, replyMode) {
  if (bytes.length < 4) return 0;
  if (replyMode === MODE_BOOTLOADER) {
    if (bytes[0] !== SIGMA_START) return 0;
    const length = bytes[1] | (bytes[2] << 8);
    return length >= 9 && length <= MAX_SIGMA_FRAME ? length : 0;
  }
  if (bytes[0] !== 0x00) return 0;
  if (!REPLY_FUNCS.has(bytes[1])) return 0;
  const length = (bytes[2] << 8) | bytes[3];
  return length >= 6 && length <= MAX_FRAME_BYTES ? length : 0;
}

/**
 * 把栈交给侧车的报告还原成完整帧。
 * 栈按 63 B 切包时会右侧补 0x00，帧边界只能靠 LEN 自己找回来；
 * 回执动作（crcError/ackError/sticky）必须作用在帧上，不能作用在报告上。
 */
function sliceFrames(reports, replyMode) {
  const frames = [];
  let pending = new Uint8Array(0);
  for (const report of reports) {
    pending = concatBytes(pending, report);
    for (;;) {
      const length = frameLengthAt(pending, replyMode);
      if (length === 0) {
        pending = new Uint8Array(0);
        break;
      }
      if (pending.length < length) break;
      frames.push(Uint8Array.from(pending.subarray(0, length)));
      pending = pending.subarray(length);
    }
  }
  return frames;
}

/** 帧长不变、只把末两字节清零：保证测的是"CRC 错"这条路径而不是"截断帧" */
function corruptCrc(frame) {
  const out = Uint8Array.from(frame);
  out[out.length - 2] = 0x00;
  out[out.length - 1] = 0x00;
  return out;
}

/** DFU 状态帧的 STATUS 字节偏移：C4 | LEN_L LEN_H | ADDR | CMD | DFU_CMD | CHIP_ID | STATUS | CRC_L CRC_H */
const STATUS_OFFSET = 7;
const STATUS_FRAME_BYTES = 10;

/**
 * 把设备本来要回的状态帧改成 `0x04 UPGRADE_FAIL` 并重算 SigmaCRC（R6-7 / 验收 A30）。
 *
 * 只动 `CMD 0x0B` + `DFU_CMD 0x01` 的状态帧：ACK 帧（`CMD 0x02`）的语义是"整帧丢弃、指针没前进"，
 * 拿它伪装成 0x04 会让上位机走错分支（歧义态整轮重来 vs 立即失败可重试）。
 */
function forceStatusFail(frame) {
  if (frame.length < STATUS_FRAME_BYTES) return frame;
  if ((frame[4] & 0x7f) !== CMD_DFU) return frame;
  if (frame[5] !== DFU_CMD_STATUS) return frame;
  const out = Uint8Array.from(frame);
  out[STATUS_OFFSET] = DFU_STATUS_FAIL;
  const crc = sigmaCrc(out.subarray(0, out.length - 2));
  out[out.length - 2] = crc & 0xff;
  out[out.length - 1] = (crc >> 8) & 0xff;
  return out;
}

function buildErrorAck(replyMode, code) {
  // 参数协议错误码 16 位大端；SigmaBus 数据小端（设计文档 §12 R-4）
  if (replyMode === MODE_BOOTLOADER) return buildSigmaFrame(CMD_ACK, [code & 0xff, (code >> 8) & 0xff]);
  return buildFrame(0x02, [(code >> 8) & 0xff, code & 0xff]);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${TAG} ${describeError(error)}`);
    process.exit(1);
    return;
  }

  const verbose = process.env.MICSTUDIO_VDEVICE_LOG === '1';
  const telemetry = {
    ignoredReports: 0,
    droppedReports: 0,
    setInputFailures: 0,
    lastRoundTripMs: 0,
    blockedFrames: 0,
    droppedAcks: 0,
  };
  const entries = [];
  const queue = [];
  const pending = new Map();
  let socket = null;
  let nextRequestId = 1;
  let pumping = false;
  let inboundAt = 0;
  let reconnectAttempts = 0;
  let reconnectDelayMs = RECONNECT_FIRST_MS;
  let reconnectTimer = null;
  let wsConnected = false;
  let httpListening = false;
  let announced = false;
  let stopping = false;

  let mode = MODE_APP;
  let levelSource = new LevelSource({ pattern: 'step', value: options.level });
  let faults = new FaultTable([]);
  let paramStack;
  let dfuStack;
  /** powerLoss 之后所有入站帧都不喂，直到 POST /control/mode */
  let powerLost = false;
  /** disconnect 故障的时间窗右端（ms） */
  let disconnectUntil = 0;
  /** 已判定要丢弃的帧还剩多少字节没到（多报告帧靠它整帧吞掉） */
  let swallow = 0;
  /**
   * 本帧回执要套用的动作。265 B 的块帧跨 5 条报告，回执是在最后一条报告到达时才产出的，
   * 所以这个标记必须活到回执产出为止（在 handleReplies 里消费），不能跟着单条报告的 feed 清掉。
   */
  let activeReplyFault = null;
  /** delay 命中的多报告帧：把剩余报告收齐，到点整帧喂栈（否则后半帧会被当成噪声丢掉） */
  let pendingDelayedFrame = null;
  /** sticky 用：上一条回执的完整帧字节 */
  let lastReplyFrame = null;
  let versionSynthetic = false;

  function record(dir, bytes) {
    const entry = { at: Date.now(), dir, hex: hexOf(bytes) };
    entries.push(entry);
    if (entries.length > LOG_LIMIT) entries.shift();
    if (verbose) console.log(`${TAG} ${dir} ${entry.hex}`);
  }

  function createParamStack() {
    const next = new ParamStack({ onReplies: (reports) => handleReplies(reports, MODE_APP) });
    next.writeRegister(LEVEL_ADDR, levelSource.value(Date.now()));
    return next;
  }

  function createDfuStack() {
    // allowBootld 必须保持 false：R6-9 的边界靠设备侧默认拒绝守住
    return new DfuStack({
      modelCode: MODEL_CODE,
      allowBootld: false,
      onReplies: (reports) => handleReplies(reports, MODE_BOOTLOADER),
    });
  }

  function resetStacks() {
    paramStack = createParamStack();
    dfuStack = createDfuStack();
  }

  resetStacks();

  function handleReplies(reports, replyMode) {
    const startedAt = inboundAt || Date.now();
    let frames = sliceFrames(reports, replyMode);
    // 谁产出回执，谁身上挂着的动作才算兑现（帧起点处挂上，见 routeReport）
    const fault = activeReplyFault;
    activeReplyFault = null;
    if (fault && fault.action === 'dropAck') {
      telemetry.droppedAcks += 1;
      return;
    }
    if (fault && REPLY_ACTIONS.includes(fault.action)) {
      if (fault.action === 'crcError') frames = frames.map(corruptCrc);
      else if (fault.action === 'ackError') frames = frames.map(() => buildErrorAck(replyMode, fault.code ?? 0));
      else if (fault.action === 'statusFail') frames = frames.map(forceStatusFail);
      else if (fault.action === 'sticky') frames = frames.map((frame) => stickyWith(lastReplyFrame, frame));
    }
    if (frames.length === 0) return;
    for (const frame of frames) {
      for (const report of splitReports(frame)) {
        record('out', report);
        queue.push({ report, startedAt });
      }
    }
    lastReplyFrame = frames[frames.length - 1];
    void pump();
  }

  /** 上一条回执的尾部 + 本条回执，再切 63 B；k = min(前一条长度, 63 - 本条长度) */
  function stickyWith(previous, frame) {
    if (!previous) return frame;
    const take = Math.min(previous.length, Math.max(0, PAYLOAD_BYTES - frame.length));
    if (take <= 0) return frame;
    const merged = new Uint8Array(take + frame.length);
    merged.set(previous.subarray(previous.length - take), 0);
    merged.set(frame, take);
    return merged;
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0 && !stopping) {
        const item = queue.shift();
        await deliver(item);
      }
    } catch (error) {
      console.error(`${TAG} reply pump failed: ${describeError(error)}`);
    } finally {
      pumping = false;
    }
  }

  async function deliver(item) {
    const data = Buffer.from(item.report).toString('base64');
    for (let attempt = 0; attempt <= SET_INPUT_RETRY; attempt += 1) {
      try {
        await request('device.setInput', { deviceId: options.device, reportId: REPORT_ID_IN, data });
        telemetry.lastRoundTripMs = Date.now() - item.startedAt;
        return;
      } catch (error) {
        if (attempt === SET_INPUT_RETRY) {
          telemetry.setInputFailures += 1;
          console.error(`${TAG} device.setInput failed for ${options.device}: ${describeError(error)}`);
        }
      }
    }
  }

  function request(op, params) {
    return new Promise((resolve, reject) => {
      const ws = socket;
      if (!ws || ws.readyState !== WS_OPEN) {
        reject(new Error('bridge socket is not open'));
        return;
      }
      const id = nextRequestId;
      nextRequestId += 1;
      pending.set(id, { resolve, reject });
      try {
        ws.send(JSON.stringify({ id, type: 'request', op, params }));
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  function rejectPending(error) {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter.reject(error);
    }
  }

  function handleMessage(raw) {
    if (typeof raw !== 'string') return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === 'response') {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.ok) {
        waiter.resolve(message.result ?? {});
      } else {
        const name = message.error?.name ?? 'Error';
        const text = message.error?.message ?? 'request failed';
        waiter.reject(new Error(`${name}: ${text}`));
      }
      return;
    }
    if (message.type === 'event' && message.op === 'hid.outputReport') {
      handleOutputReport(message.params ?? {});
    }
  }

  function handleOutputReport(params) {
    if (params.deviceId !== options.device) return;
    if (Number(params.reportId) !== REPORT_ID_OUT) {
      telemetry.ignoredReports += 1;
      return;
    }
    const payload = padReportPayload(decodeBase64(String(params.data ?? '')));
    if (!payload) {
      telemetry.droppedReports += 1;
      return;
    }
    record('in', payload);
    inboundAt = Date.now();
    try {
      routeReport(payload);
    } catch (error) {
      console.error(`${TAG} feed failed: ${describeError(error)}`);
    } finally {
      inboundAt = 0;
    }
  }

  /** 帧起点判定：只认主机 → 设备方向，用来数"这一帧算不算 framesIn" */
  function isFrameStart(payload) {
    if (mode === MODE_BOOTLOADER) return payload[0] === SIGMA_START;
    return payload[0] === 0x00 && INBOUND_FUNCS.has(payload[1]);
  }

  /**
   * 解出这条报告的帧上下文（供故障规则匹配）；返回 null 表示这条报告不是帧起点。
   * 265 B 的块帧跨 5 条报告，后续几条在 drop 时靠 swallow 吞掉，不需要再匹配。
   */
  function inspectInbound(payload) {
    if (mode === MODE_BOOTLOADER) {
      if (payload[0] !== SIGMA_START) return null;
      const length = payload[1] | (payload[2] << 8);
      if (length < 9 || length > MAX_SIGMA_FRAME) return null;
      const cmd = payload[4] & 0x7f;
      const dfuCmd = cmd === CMD_DFU ? payload[5] : undefined;
      const phase = dfuCmd === DFU_CMD_INFO ? 'info' : dfuCmd === DFU_CMD_BLOCK ? 'block' : 'any';
      return { length, context: { mode, func: undefined, dfuCmd, phase } };
    }
    const func = payload[1];
    const length = (payload[2] << 8) | payload[3];
    if (payload[0] !== 0x00 || !INBOUND_FUNCS.has(func) || length < 6 || length > MAX_FRAME_BYTES) return null;
    return { length, context: { mode, func, dfuCmd: undefined, phase: undefined } };
  }

  function countBlockedFrame(payload) {
    if (isFrameStart(payload)) telemetry.blockedFrames += 1;
  }

  /** 入站帧的统一入口：先过故障表，再按当前模式喂栈 */
  function routeReport(payload) {
    if (powerLost) {
      countBlockedFrame(payload);
      return;
    }
    if (Date.now() < disconnectUntil) {
      countBlockedFrame(payload);
      return;
    }
    if (pendingDelayedFrame !== null) {
      const pending = pendingDelayedFrame;
      const take = Math.min(PAYLOAD_BYTES, pending.missing);
      pending.bytes = concatBytes(pending.bytes, payload.subarray(0, take));
      pending.missing -= take;
      if (pending.missing === 0) {
        pendingDelayedFrame = null;
        pending.fire(pending.bytes);
      }
      return;
    }
    if (swallow > 0) {
      swallow = Math.max(0, swallow - PAYLOAD_BYTES);
      return;
    }
    const head = inspectInbound(payload);
    if (!head) {
      feedCurrent(payload);
      return;
    }
    // 新帧起点：上一帧该兑现的回执已经过去了，剩下的标记一定是配置错误留下的，先清掉
    activeReplyFault = null;
    const hit = faults.match(head.context);
    if (!hit) {
      feedCurrent(payload);
      return;
    }
    faults.consume(hit);
    if (hit.action === 'drop') {
      telemetry.blockedFrames += 1;
      swallow = Math.max(0, head.length - PAYLOAD_BYTES);
      return;
    }
    if (hit.action === 'delay') {
      const ms = hit.ms ?? DEFAULT_FAULT_MS;
      const frameBytes = Uint8Array.from(payload.subarray(0, Math.min(head.length, PAYLOAD_BYTES)));
      const missing = Math.max(0, head.length - PAYLOAD_BYTES);
      if (missing === 0) {
        paramStack.timers.setTimeout(() => {
          feedCurrent(frameBytes);
        }, ms);
        return;
      }
      pendingDelayedFrame = {
        bytes: frameBytes,
        missing,
        fire: (bytes) => {
          paramStack.timers.setTimeout(() => {
            feedCurrent(bytes);
          }, ms);
        },
      };
      return;
    }
    if (hit.action === 'disconnect') {
      telemetry.blockedFrames += 1;
      disconnectUntil = Date.now() + (hit.ms ?? DEFAULT_FAULT_MS);
      return;
    }
    if (hit.action === 'powerLoss') {
      telemetry.blockedFrames += 1;
      applyPowerLoss();
      return;
    }
    activeReplyFault = hit;
    feedCurrent(payload);
  }

  function feedCurrent(payload) {
    // 这里不复位 activeReplyFault：多报告帧的回执在最后一条报告才产出，
    // 交给 handleReplies 一次性消费，否则 dropAck/crcError/sticky 永远打不中块帧。
    if (mode === MODE_BOOTLOADER) {
      dfuStack.feed(payload);
      afterDfuFeed();
      return;
    }
    paramStack.writeRegister(LEVEL_ADDR, levelSource.value(Date.now()));
    paramStack.feed(payload);
    if (paramStack.takeDfuRequest()) enterBootloader();
  }

  /** §4.5-1：ACK 发出后切 bootloader，之后所有入站帧只喂 DfuStack */
  function enterBootloader() {
    mode = MODE_BOOTLOADER;
    paramStack.setMode(MODE_BOOTLOADER);
    paramStack.reset();
    dfuStack.reset();
    swallow = 0;
    activeReplyFault = null;
    pendingDelayedFrame = null;
  }

  /** §4.5-2：升级成功 → 回写版本寄存器并切回 app */
  function afterDfuFeed() {
    if (!dfuStack.completed()) return;
    const info = dfuStack.info();
    const version = info ? info.version : { x: 0, y: 0, z: 0 };
    versionSynthetic = version.x === 0 && version.y === 0 && version.z === 0;
    paramStack.writeRegister(FW_VERSION_ADDR.x, versionSynthetic ? 0 : version.x);
    paramStack.writeRegister(FW_VERSION_ADDR.y, versionSynthetic ? 0 : version.y);
    paramStack.writeRegister(FW_VERSION_ADDR.z, versionSynthetic ? 1 : version.z);
    paramStack.writeRegister(FIRMWARE_BUILD_ADDR, 0);
    mode = MODE_APP;
    paramStack.setMode(MODE_APP);
    dfuStack.reset();
    swallow = 0;
  }

  /** §4.5-3 / §5：断电后不喂任何栈，模式固定 bootloader 直到控制面改回来 */
  function applyPowerLoss() {
    powerLost = true;
    mode = MODE_BOOTLOADER;
    paramStack.setMode(MODE_BOOTLOADER);
    dfuStack.powerLoss();
    swallow = 0;
    activeReplyFault = null;
    pendingDelayedFrame = null;
  }

  function maybeAnnounce() {
    if (announced || !httpListening || !wsConnected) return;
    announced = true;
    console.log(
      `${TAG} sidecar ready device=${options.device} bridge=${options.bridge} control=http://${CONTROL_HOST}:${options.controlPort}`,
    );
  }

  function connect() {
    reconnectTimer = null;
    const ws = new WebSocket(options.bridge, PROTOCOL);
    socket = ws;
    ws.addEventListener('open', () => {
      wsConnected = true;
      reconnectAttempts = 0;
      reconnectDelayMs = RECONNECT_LATER_MS;
      maybeAnnounce();
    });
    ws.addEventListener('message', (event) => handleMessage(event.data));
    // 必须挂 error 监听：Node 的 WebSocket 在无监听时会把连接错误升级成未捕获异常，
    // 真正的原因与重连节奏统一由随后的 close 事件处理。
    ws.addEventListener('error', () => {});
    ws.addEventListener('close', () => {
      socket = null;
      wsConnected = false;
      rejectPending(new Error('bridge connection closed'));
      if (stopping) return;
      if (announced) {
        console.error(`${TAG} bridge disconnected, reconnecting in ${reconnectDelayMs} ms`);
      }
      reconnectAttempts += 1;
      if (reconnectAttempts > RECONNECT_LIMIT) {
        console.error(`${TAG} bridge unreachable`);
        process.exit(1);
        return;
      }
      reconnectTimer = setTimeout(connect, reconnectDelayMs);
    });
  }

  function statsPayload() {
    const paramStats = paramStack.stats();
    const dfuStats = dfuStack.stats();
    const info = paramStack.info();
    return {
      mode,
      framesIn: paramStats.framesIn + dfuStats.framesIn + telemetry.blockedFrames,
      framesOut: paramStats.framesOut + dfuStats.framesOut,
      byFunc: paramStats.byFunc,
      unknownFunc: paramStats.unknownFunc,
      rejectedReadOnly: paramStats.rejectedReadOnly,
      rejectedRange: paramStats.rejectedRange,
      dfuRequested: paramStack.dfuRequested(),
      dfuStatus: dfuStack.lastStatus(),
      blocks: dfuStack.flash().blocks,
      levelRaw: levelSource.value(Date.now()),
      firmwareVersion: [info.firmware.x, info.firmware.y, info.firmware.z],
      modelCode: info.modelCode,
      serial: info.serial,
      versionSynthetic,
      faultsFired: faults.fired(),
      lastRoundTripMs: telemetry.lastRoundTripMs,
      ignoredReports: telemetry.ignoredReports,
      droppedReports: telemetry.droppedReports,
      droppedAcks: telemetry.droppedAcks,
      setInputFailures: telemetry.setInputFailures,
      bridgeConnected: wsConnected,
    };
  }

  function setMode(target) {
    if (target !== MODE_APP && target !== MODE_BOOTLOADER) {
      throw new Error(`mode must be ${MODE_APP} or ${MODE_BOOTLOADER}, got ${JSON.stringify(target)}`);
    }
    mode = target;
    powerLost = false;
    disconnectUntil = 0;
    swallow = 0;
    activeReplyFault = null;
    pendingDelayedFrame = null;
    paramStack.setMode(target);
    paramStack.reset();
    dfuStack.reset();
    queue.length = 0;
    inboundAt = 0;
    return mode;
  }

  function resetAll() {
    levelSource = new LevelSource({ pattern: 'step', value: options.level });
    faults = new FaultTable([]);
    resetStacks();
    setMode(MODE_APP);
    versionSynthetic = false;
    telemetry.blockedFrames = 0;
    telemetry.droppedAcks = 0;
    lastReplyFrame = null;
  }

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      console.error(`${TAG} control request failed: ${describeError(error)}`);
      sendJson(res, 500, { ok: false, error: describeError(error) });
    });
  });

  const ROUTES = Object.freeze({
    '/control/stats': 'GET',
    '/control/log': 'GET',
    '/control/registers': 'POST',
    '/control/reset': 'POST',
    '/control/faults': 'POST',
    '/control/mode': 'POST',
    '/control/level': 'POST',
    '/control/report': 'POST',
  });

  async function handleHttp(req, res) {
    const url = new URL(req.url ?? '/', `http://${CONTROL_HOST}:${options.controlPort}`);
    const expected = ROUTES[url.pathname];
    if (!expected) {
      sendJson(res, 404, { ok: false, error: `no route for ${url.pathname}` });
      return;
    }
    if (req.method !== expected) {
      sendJson(res, 405, { ok: false, error: `${req.method} not allowed on ${url.pathname}` });
      return;
    }
    if (url.pathname === '/control/stats') {
      sendJson(res, 200, statsPayload());
      return;
    }
    if (url.pathname === '/control/log') {
      sendJson(res, 200, entries);
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: describeError(error) });
      return;
    }
    if (url.pathname === '/control/registers') {
      const values = body?.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        sendJson(res, 400, { ok: false, error: 'body must be {"values":{"0x2024":1}}' });
        return;
      }
      const writes = [];
      for (const [key, raw] of Object.entries(values)) {
        const addr = Number.parseInt(String(key), 16);
        if (!Number.isInteger(addr) || addr < 0 || addr > 0xffff) {
          sendJson(res, 400, { ok: false, error: `invalid register address ${key}` });
          return;
        }
        if (!Number.isInteger(raw) || raw < 0 || raw > 0xffff) {
          sendJson(res, 400, { ok: false, error: `value for ${key} must be an integer in 0..65535` });
          return;
        }
        writes.push([addr, raw]);
      }
      for (const [addr, raw] of writes) paramStack.writeRegister(addr, raw);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/control/faults') {
      let table;
      try {
        table = new FaultTable(body?.faults);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: describeError(error) });
        return;
      }
      faults = table;
      sendJson(res, 200, { ok: true, rules: faults.size() });
      return;
    }
    if (url.pathname === '/control/mode') {
      let applied;
      try {
        applied = setMode(body?.mode);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: describeError(error) });
        return;
      }
      sendJson(res, 200, { ok: true, mode: applied });
      return;
    }
    if (url.pathname === '/control/level') {
      let snapshot;
      try {
        snapshot = levelSource.set(body ?? {});
      } catch (error) {
        sendJson(res, 400, { ok: false, error: describeError(error) });
        return;
      }
      paramStack.writeRegister(LEVEL_ADDR, levelSource.value(Date.now()));
      sendJson(res, 200, { ok: true, level: snapshot });
      return;
    }
    if (url.pathname === '/control/report') {
      const pairs = Array.isArray(body?.pairs)
        ? body.pairs
        : body && body.addr !== undefined
          ? [{ addr: body.addr, raw: body.raw }]
          : null;
      if (!pairs || pairs.length === 0) {
        sendJson(res, 400, {
          ok: false,
          error: 'body must be {"addr":0x2057,"raw":200} or {"pairs":[{"addr":…,"raw":…}]}',
        });
        return;
      }
      for (const pair of pairs) {
        if (!Number.isInteger(pair?.addr) || pair.addr < 0 || pair.addr > 0xffff) {
          sendJson(res, 400, { ok: false, error: `invalid address ${JSON.stringify(pair?.addr)}` });
          return;
        }
        if (!Number.isInteger(pair?.raw) || pair.raw < 0 || pair.raw > 0xffff) {
          sendJson(res, 400, { ok: false, error: `invalid raw ${JSON.stringify(pair?.raw)}` });
          return;
        }
      }
      // 设备侧值先变再上报：与真机"值变了才推"一致；静默改值走 /control/registers
      for (const pair of pairs) paramStack.writeRegister(pair.addr, pair.raw);
      const pushed = paramStack.pushParams(pairs);
      sendJson(res, 200, { ok: true, pushed });
      return;
    }
    resetAll();
    sendJson(res, 200, { ok: true });
  }

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`${TAG} control port ${options.controlPort} is already in use`);
    } else {
      console.error(`${TAG} control server error: ${describeError(error)}`);
    }
    process.exit(1);
  });

  server.listen(options.controlPort, CONTROL_HOST, () => {
    httpListening = true;
    maybeAnnounce();
  });

  function shutdown(code) {
    if (stopping) return;
    stopping = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    rejectPending(new Error('sidecar stopping'));
    const ws = socket;
    socket = null;
    if (ws) {
      try {
        ws.close(1000, 'sidecar shutdown');
      } catch {
        // 已经关闭时 close 会抛，退出流程不因此中断
      }
    }
    server.closeAllConnections();
    server.close(() => process.exit(code));
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => shutdown(0));
  }

  connect();
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
