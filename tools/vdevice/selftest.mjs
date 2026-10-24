/**
 * 端到端自检（R7-3/R7-4/R10-3）：20 条用例跑在虚拟下位机（Python 桥 + Node 侧车）上。
 *
 * 界限：本脚本是**协议级**端到端，不是 UI 级。上位机行为（会话队列、超时重试、写合并、
 * 电平轮询、DFU 状态机、预检）在这里用最小 WS 客户端自己实现一遍，编码函数复用
 * `device-stack.mjs` / `dfu-stack.mjs` / `package.mjs`，**不 import `src/**`**：
 * 渲染进程是 TS、依赖 DOM 别名，直接拉进来既跑不动，也会把"设备侧 vs 上位机侧"
 * 的对拍关系搅混。UI 级取证由 Electron 截图与 `scripts/probes/` 负责（验收文档）。
 *
 * 每条用例前置 `POST /control/reset`，逐条 try/catch；环境不可用（Python 缺失、
 * 端口被别人的进程占用）以退出码 2 结束，绝不拿 skip 当通过。
 *
 * 用法：node tools/vdevice/selftest.mjs [--keep] [--port 8765] [--control-port 8766] [--timeout-ms 60000]
 * 退出码：0 全部通过；1 有用例失败；2 环境不可用。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  LEVEL_ADDR,
  PRESET_END,
  PRESET_START,
  REPORT_ID_IN,
  buildFrame,
  crc16,
  splitReports,
} from './device-stack.mjs';
import {
  APP_MAX_BYTES,
  BLOCK_BYTES,
  BOOT_MAX_BYTES,
  CMD_ACK,
  CMD_DFU,
  CMD_PARAM_WRITE,
  DFU_CMD_BLOCK,
  DFU_CMD_INFO,
  DFU_CMD_STATUS,
  DFU_STATUS_CODE_ERR,
  DFU_STATUS_CONTINUE,
  DFU_STATUS_FAIL,
  DFU_STATUS_INFO_ERR,
  DFU_STATUS_SUCCESS,
  MAX_SIGMA_FRAME,
  SIGMA_START,
  buildSigmaFrame,
  gammaDecrypt,
  sigmaCrc,
  sum32Words,
} from './dfu-stack.mjs';
import { buildPackage, overrideLength, syntheticImage, tamperByte } from './package.mjs';
import { REPO_ROOT, killChild, resolvePython, startVDevice, DEFAULT_PYTHON } from './run.mjs';

const TAG = '[selftest]';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts', 'vdevice');
const DEVICE_ID = 'mic-m001';
const PROTOCOL = 'webhid-bridge.v1';
/** 主机 → 设备的 OUT 报告号；IN 用 0x11（17） */
const REPORT_ID_OUT = 0x51;
const WS_OPEN = 1;
const DIAG_LIMIT = 500;

const FUNC_ACK = 0x02;
const FUNC_RAND_WRITE = 0x10;
const FUNC_SEQ_WRITE = 0x11;
const FUNC_RAND_READ = 0x12;
const FUNC_SEQ_READ = 0x13;
const PARAM_FUNCS = new Set([FUNC_ACK, FUNC_RAND_WRITE, FUNC_SEQ_WRITE, FUNC_RAND_READ, FUNC_SEQ_READ]);

const ACK_NO_ERR = 0x0000;
const ACK_DEV_ADDR_ERR = 0x0001;
const ACK_CHECKSUM_ERR = 0x0003;
const MAX_FRAME_BYTES = 512;
const WORD_MAX = 0xffff;

/**
 * 上位机侧的会话时序（设计 §5.4.4 TIMING 的镜像；本脚本不 import src/**）。
 * `writeThrottleMs` 120 与 R-22 一致：2 s 内的 flush 上限约 ceil(T/W)+1，
 * 而 T 是调用方逐条 await 的**墙钟**时长（实测常略超 2000 ms）。
 * W=100 时上限 21、相位不利就破 R3-6 的"≤20"；W=110 实测会顶到 20（余量 0）；W=120 留出余量。
 */
const TIMING = Object.freeze({
  requestTimeoutMs: 500,
  requestRetries: 2,
  writeThrottleMs: 120,
  pollIntervalMs: 20,
  pollTimeoutMs: 200,
  enterAttempts: 2,
  dfuProbeTimeoutMs: 1500,
  dfuProbeAttempts: 3,
  dfuBlockTimeoutMs: 1500,
  dfuRoundRestarts: 3,
});

/** 电平失效阈值：1 s 没有新采样即 inputValid === false（R5-3） */
const LEVEL_STALE_MS = 1000;
/** 回读设备信息的 46 个地址（R-13：型号码 3 + 设备名 3 词 + 固件 4 + 类型 1 + VI D/PID 各 1 + SN 32 + 通讯错误 1） */
const SYNC_INFO_ADDRS = Object.freeze([
  0x0000, 0x0001, 0x0002,
  0x0003, 0x0004, 0x0005,
  0x000b, 0x000c, 0x000d, 0x000e,
  0x000f, 0x0016, 0x0017,
  ...Array.from({ length: 32 }, (_, index) => 0x001e + index),
  0x1007,
]);
/**
 * 上位机本地的只读拦截表（`domain/params.ts` 里 Gain.Mic / Gain.Hp / 预设校验和只读）。
 * 只用于本脚本模拟"界面不会为只读字段发帧"，不代表设备侧权限（那是 T04 的另一半断言）。
 */
const READ_ONLY_ADDRS = new Set([PRESET_START, 0x2023, 0x205a]);

const MODEL_APP = 'JYM001';
const MODEL_WILDCARD = '000000';
const MODEL_BOOTLOADER = 'Bootld';

// ---------------------------------------------------------------- 字节工具

function hex2(value) {
  return (value & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

function hex4(value) {
  return (value & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

function hexBytes(bytes) {
  const parts = [];
  for (const byte of bytes) parts.push(hex2(byte));
  return parts.join(' ');
}

function concatBytes(left, right) {
  if (right.length === 0) return left;
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

function writeWord(target, offset, value) {
  target[offset] = (value >> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

function readWord(source, offset) {
  return (source[offset] << 8) | source[offset + 1];
}

function readU32(source, offset) {
  return (source[offset] | (source[offset + 1] << 8) | (source[offset + 2] << 16) | (source[offset + 3] << 24)) >>> 0;
}

function writeU32(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function encodeBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function decodeBase64(text) {
  const buffer = Buffer.from(text, 'base64');
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 用例里"等一会儿"的写法统一叫 sleep，读起来比 delay 更贴近时序断言 */
const sleep = delay;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时 ${timeoutMs} ms：${label}`);
    await delay(20);
  }
}

// ---------------------------------------------------------------- 编码（参数协议）

function encodeParamFrame(func, data) {
  return buildFrame(func, data);
}

function encodeRandWrite(pairs) {
  const data = new Uint8Array(pairs.length * 4);
  pairs.forEach((pair, index) => {
    writeWord(data, index * 4, pair.addr);
    writeWord(data, index * 4 + 2, pair.raw);
  });
  return data;
}

function encodeSeqWrite(start, values) {
  const data = new Uint8Array(4 + values.length * 2);
  writeWord(data, 0, start);
  writeWord(data, 2, values.length);
  values.forEach((raw, index) => writeWord(data, 4 + index * 2, raw));
  return data;
}

function encodeRandRead(addrs) {
  const data = new Uint8Array(addrs.length * 2);
  addrs.forEach((addr, index) => writeWord(data, index * 2, addr));
  return data;
}

function encodeSeqRead(start, count) {
  const data = new Uint8Array(4);
  writeWord(data, 0, start);
  writeWord(data, 2, count);
  return data;
}

/** 流式拆帧（设计 §5.4.2 的步骤 0–9）：补位零静默丢弃，坏字节只记 issue 并重同步 */
function decodeParamStream(buffer) {
  const frames = [];
  const issues = [];
  let offset = 0;
  while (offset < buffer.length) {
    while (offset + 1 < buffer.length && buffer[offset] === 0x00 && buffer[offset + 1] === 0x00) offset += 1;
    const available = buffer.length - offset;
    if (available < 4) break;
    const len = (buffer[offset + 2] << 8) | buffer[offset + 3];
    if (len < 6) {
      issues.push({ problem: 'length', offset, detail: `Len ${len} < 6` });
      offset += 1;
      continue;
    }
    if (len > MAX_FRAME_BYTES) {
      issues.push({ problem: 'capacity', offset, detail: `Len ${len} > ${MAX_FRAME_BYTES}` });
      offset += 1;
      continue;
    }
    if (len > available) break;
    const func = buffer[offset + 1];
    if (!PARAM_FUNCS.has(func)) {
      issues.push({ problem: 'func', offset, detail: `Func 0x${hex2(func)} 不是参数协议功能码` });
      offset += 1;
      continue;
    }
    const expected = crc16(buffer.subarray(offset, offset + len - 2));
    const received = buffer[offset + len - 2] | (buffer[offset + len - 1] << 8);
    if (expected !== received) {
      issues.push({ problem: 'crc', offset, detail: `CRC 0x${hex4(received)} != 计算值 0x${hex4(expected)}` });
      offset += 1;
      continue;
    }
    frames.push({ unitId: buffer[offset], func, data: buffer.slice(offset + 4, offset + len - 2) });
    offset += len;
  }
  return { frames, rest: buffer.slice(offset), issues };
}

function parseParamReply(frame) {
  if (frame.func === FUNC_ACK) {
    assert(frame.data.length === 2, `ACK 帧数据 ${frame.data.length} B，应为 2 B`);
    return { kind: 'ack', ack: readWord(frame.data, 0) };
  }
  if (frame.func === FUNC_SEQ_READ) {
    assert(frame.data.length >= 4, `0x13 应答数据 ${frame.data.length} B，应 ≥ 4 B`);
    const start = readWord(frame.data, 0);
    const count = readWord(frame.data, 2);
    assert(frame.data.length === 4 + count * 2, `0x13 应答 ${frame.data.length} B 与 count=${count} 不符`);
    const values = [];
    for (let index = 0; index < count; index += 1) values.push(readWord(frame.data, 4 + index * 2));
    return { kind: 'seq', start, values };
  }
  if (frame.func === FUNC_RAND_READ) {
    assert(frame.data.length > 0 && frame.data.length % 4 === 0, `0x12 应答 ${frame.data.length} B 不是 4 的倍数`);
    const entries = [];
    for (let offset = 0; offset < frame.data.length; offset += 4) {
      entries.push({ addr: readWord(frame.data, offset), raw: readWord(frame.data, offset + 2) });
    }
    return { kind: 'rand', entries };
  }
  throw new Error(`非应答帧 func 0x${hex2(frame.func)}`);
}

function describeParamFrame(frame) {
  if (frame.func === FUNC_ACK) {
    const code = readWord(frame.data, 0);
    return `ACK 0x${hex4(code)}${code === ACK_NO_ERR ? ' 成功' : ' 错误'}`;
  }
  if (frame.func === FUNC_SEQ_READ) return `读回 0x${hex4(readWord(frame.data, 0))} (${readWord(frame.data, 2)})`;
  if (frame.func === FUNC_RAND_READ) return `读回 ${frame.data.length / 4} 项`;
  return `入站帧 0x${hex2(frame.func)}`;
}

// ---------------------------------------------------------------- 编码（SigmaBus）

function encodeSigmaInfoFrame(info) {
  const payload = new Uint8Array(2 + 81);
  payload[0] = DFU_CMD_INFO;
  payload[1] = 0x00;
  writeAscii(payload, 2, info.modelCode, 6);
  writeAscii(payload, 8, info.modelName, 64);
  let offset = 2 + 6 + 64;
  payload[offset] = info.version.x;
  payload[offset + 1] = info.version.y;
  payload[offset + 2] = info.version.z;
  offset += 3;
  writeU32(payload, offset, info.length);
  writeU32(payload, offset + 4, info.checksum);
  return buildSigmaFrame(CMD_DFU, payload);
}

function encodeSigmaBlockFrame(block) {
  const payload = new Uint8Array(2 + block.length);
  payload[0] = DFU_CMD_BLOCK;
  payload[1] = 0x00;
  payload.set(block, 2);
  return buildSigmaFrame(CMD_DFU, payload);
}

function writeAscii(target, offset, text, width) {
  for (let index = 0; index < width; index += 1) {
    target[offset + index] = index < text.length ? text.charCodeAt(index) & 0x7f : 0x00;
  }
}

/**
 * SigmaBus 拆帧。报告尾部按 63 B 补的 0x00 不算 issue：一帧结束后剩下的全零只可能是填充，
 * 与参数协议那边"补位零静默丢弃"同一口径，否则每条 10 B 状态帧都会刷出 53 条 start 告警。
 */
function decodeSigmaStream(buffer) {
  const frames = [];
  const issues = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer[offset] !== SIGMA_START) {
      if (buffer.subarray(offset).every((byte) => byte === 0x00)) {
        offset = buffer.length;
        break;
      }
      issues.push({ problem: 'start', offset, detail: `期望 0x${hex2(SIGMA_START)}，实际 0x${hex2(buffer[offset])}` });
      offset += 1;
      continue;
    }
    if (buffer.length - offset < 3) break;
    const len = buffer[offset + 1] | (buffer[offset + 2] << 8);
    if (len < 9) {
      issues.push({ problem: 'length', offset, detail: `帧长 ${len} < 9` });
      offset += 1;
      continue;
    }
    if (len > MAX_SIGMA_FRAME) {
      issues.push({ problem: 'capacity', offset, detail: `帧长 ${len} > ${MAX_SIGMA_FRAME}` });
      offset += 1;
      continue;
    }
    if (len > buffer.length - offset) break;
    const expected = buffer[offset + len - 2] | (buffer[offset + len - 1] << 8);
    const actual = sigmaCrc(buffer.subarray(offset, offset + len - 2));
    if (actual !== expected) {
      issues.push({ problem: 'crc', offset, detail: `SigmaCRC 0x${hex4(expected)} != 计算值 0x${hex4(actual)}` });
      offset += 1;
      continue;
    }
    frames.push({
      addr: buffer[offset + 3],
      cmd: buffer[offset + 4] & 0x7f,
      data: buffer.slice(offset + 5, offset + len - 2),
    });
    offset += len;
  }
  return { frames, rest: buffer.slice(offset), issues };
}

function parseStatusFrame(frame) {
  if (frame.cmd !== CMD_DFU) return null;
  if (frame.data.length < 3 || frame.data[0] !== DFU_CMD_STATUS) return null;
  return { status: frame.data[2] };
}

function parseAckFrame(frame) {
  if (frame.cmd !== CMD_ACK) return null;
  if (frame.data.length < 2) return null;
  return { err: frame.data[0] | (frame.data[1] << 8) };
}

function describeSigmaFrame(frame) {
  const status = parseStatusFrame(frame);
  if (status !== null) return `DFU status 0x${hex2(status.status)}`;
  const ack = parseAckFrame(frame);
  if (ack !== null) return `SigmaBus ACK 0x${hex4(ack.err)}`;
  return `SigmaBus cmd 0x${hex2(frame.cmd)}`;
}

// ---------------------------------------------------------------- HTTP 工具

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { ok: response.ok, status: response.status, body };
}

async function getJson(url) {
  const result = await requestJson(url, { headers: { accept: 'application/json' } });
  if (!result.ok) throw new Error(`GET ${url} -> HTTP ${result.status}`);
  return result.body;
}

async function postJson(url, body) {
  const result = await requestJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!result.ok) throw new Error(`POST ${url} -> HTTP ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

// ---------------------------------------------------------------- WS 通道

/** 最小 WS 客户端：进出一律 63 B 报告，帧的拼接/拆解由两个流式解码器负责 */
class Channel {
  constructor(url, deviceId) {
    this.url = url;
    this.deviceId = deviceId;
    this.ws = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.decoder = 'param';
    this.paramRest = new Uint8Array(0);
    this.sigmaRest = new Uint8Array(0);
    this.paramHandler = null;
    this.sigmaHandler = null;
    this.reportListener = null;
    this.diag = [];
    this.crcErrors = 0;
    this.inFrames = 0;
    this.outFrames = 0;
  }

  static async connect(url, deviceId) {
    const channel = new Channel(url, deviceId);
    await channel.open();
    return channel;
  }

  async open() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, PROTOCOL);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('WebSocket 握手超时')), 5000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('message', (event) => this.handleMessage(event.data));
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket 连接失败：${this.url}`));
      });
      ws.addEventListener('close', () => {
        this.closed = true;
        for (const waiter of this.pending.values()) waiter.reject(new Error('桥连接已关闭'));
        this.pending.clear();
      });
    });
    await this.request('hid.open', { deviceId: this.deviceId });
  }

  request(op, params) {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WS_OPEN) {
        reject(new Error('桥连接未就绪'));
        return;
      }
      const id = this.nextId;
      this.nextId += 1;
      this.pending.set(id, { resolve, reject });
      try {
        ws.send(JSON.stringify({ id, type: 'request', op, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  handleMessage(raw) {
    if (typeof raw !== 'string') return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === 'response') {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result ?? {});
      else waiter.reject(new Error(`${message.error?.name ?? 'Error'}: ${message.error?.message ?? '请求失败'}`));
      return;
    }
    if (message.type === 'event' && message.op === 'hid.inputReport') this.handleInputReport(message.params ?? {});
  }

  handleInputReport(params) {
    if (params.deviceId !== this.deviceId) return;
    if (Number(params.reportId) !== REPORT_ID_IN) return;
    const bytes = decodeBase64(String(params.data ?? ''));
    if (this.decoder === 'param') this.handleParamBytes(bytes);
    else this.handleSigmaBytes(bytes);
  }

  handleParamBytes(bytes) {
    const result = decodeParamStream(concatBytes(this.paramRest, bytes));
    this.paramRest = result.rest;
    for (const issue of result.issues) {
      if (issue.problem === 'crc') this.crcErrors += 1;
      this.pushDiag('in', '', `参数帧解析告警（${issue.problem}）：${issue.detail}`, issue.problem === 'crc' ? 'error' : 'warn');
    }
    for (const frame of result.frames) {
      this.inFrames += 1;
      this.pushDiag('in', hexBytes(encodeParamFrame(frame.func, frame.data)), describeParamFrame(frame), 'info');
      if (this.paramHandler !== null) this.paramHandler(frame);
    }
    if (this.reportListener !== null) this.reportListener({ frames: result.frames, issues: result.issues });
  }

  handleSigmaBytes(bytes) {
    const result = decodeSigmaStream(concatBytes(this.sigmaRest, bytes));
    this.sigmaRest = result.rest;
    for (const issue of result.issues) {
      this.pushDiag('in', '', `SigmaBus 解析告警（${issue.problem}）：${issue.detail}`, 'warn');
    }
    for (const frame of result.frames) {
      this.inFrames += 1;
      this.pushDiag('in', hexBytes(buildSigmaFrame(frame.cmd, frame.data, frame.addr)), describeSigmaFrame(frame), 'info');
      if (this.sigmaHandler !== null) this.sigmaHandler(frame);
    }
    if (this.reportListener !== null) this.reportListener({ frames: result.frames, issues: result.issues });
  }

  pushDiag(dir, hex, summary, level) {
    this.diag.push({ at: Date.now(), dir, hex, summary, level });
    while (this.diag.length > DIAG_LIMIT) this.diag.shift();
  }

  setDecoder(mode) {
    this.decoder = mode;
    this.paramRest = new Uint8Array(0);
    this.sigmaRest = new Uint8Array(0);
  }

  setParamHandler(handler) {
    this.paramHandler = handler;
  }

  setSigmaHandler(handler) {
    this.sigmaHandler = handler;
  }

  async sendFrame(frame, summary) {
    this.pushDiag('out', hexBytes(frame), summary ?? '发帧', 'info');
    for (const report of splitReports(frame)) {
      await this.request('hid.sendReport', {
        deviceId: this.deviceId,
        reportId: REPORT_ID_OUT,
        data: encodeBase64(report),
      });
      this.outFrames += 1;
    }
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    this.closed = true;
    if (!ws) return;
    try {
      ws.close();
    } catch {
      // 已关闭
    }
  }
}

// ---------------------------------------------------------------- 上位机参数会话（最小实现）

function levelToDb(raw) {
  const normalized = Math.min(1, Math.max(0, raw / 256));
  return normalized * 96 - 96;
}

function isPresetAddr(addr) {
  return addr >= PRESET_START && addr <= PRESET_END;
}

/** 按 addr 升序把同批写分组：预设区内连续（+1）的相邻地址合成一组（设计 §6.4） */
function groupWrites(entries) {
  const groups = [];
  let current = null;
  for (const [addr, raw] of entries) {
    const mergeable = current !== null && isPresetAddr(current.last) && isPresetAddr(addr) && addr === current.last + 1;
    if (mergeable) {
      current.values.push(raw);
      current.last = addr;
      continue;
    }
    if (current !== null) groups.push({ start: current.start, values: current.values });
    current = { start: addr, last: addr, values: [raw] };
  }
  if (current !== null) groups.push({ start: current.start, values: current.values });
  return groups;
}

class ParamClient {
  constructor(channel) {
    this.channel = channel;
    this.phase = 'idle';
    this.stats = { outFrames: 0, inFrames: 0, crcErrors: 0, timeouts: 0, retries: 0, droppedPolls: 0 };
    this.errors = [];
    this.level = { raw: null, at: 0 };
    this.inflight = null;
    this.queue = [];
    this.pendingWrites = new Map();
    this.throttleTimer = null;
    this.polling = false;
    this.pollTimer = null;
    this.activate();
  }

  /** 一条通道上可能先后挂过 DFU 会话，因此每次使用前都把解码器与回执入口接管回来 */
  activate() {
    this.channel.setDecoder('param');
    this.channel.setSigmaHandler(null);
    this.channel.setParamHandler((frame) => this.handleFrame(frame));
  }

  readRandom(addrs) {
    if (this.phase === 'error') return Promise.reject(new Error('会话处于 error，读请求被拒绝'));
    this.activate();
    const frame = encodeParamFrame(FUNC_RAND_READ, encodeRandRead(addrs));
    return this.enqueue({ frame, expect: 'read', summary: `读 ${addrs.length} 项`, poll: false });
  }

  readSeq(start, count) {
    if (this.phase === 'error') return Promise.reject(new Error('会话处于 error，读请求被拒绝'));
    this.activate();
    const frame = encodeParamFrame(FUNC_SEQ_READ, encodeSeqRead(start, count));
    return this.enqueue({ frame, expect: 'read', summary: `读 0x${hex4(start)} (${count})`, poll: false });
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ ...task, resolve, reject });
      this.pump();
    });
  }

  /** 写：合并窗口内的同址覆盖，窗口到期才出帧（R3-6） */
  write(pairs) {
    if (this.phase === 'error') return;
    this.activate();
    for (const pair of pairs) this.pendingWrites.set(pair.addr, pair.raw);
    if (this.throttleTimer === null) {
      this.throttleTimer = setTimeout(() => this.flushWrites(), TIMING.writeThrottleMs);
    }
  }

  /** 界面口径的写：只读字段在本地就被拦掉，连帧都不发（R3-3） */
  writeFields(pairs) {
    const dropped = pairs.filter((pair) => READ_ONLY_ADDRS.has(pair.addr));
    const sent = pairs.filter((pair) => !READ_ONLY_ADDRS.has(pair.addr));
    if (sent.length > 0) this.write(sent);
    return { sent, dropped };
  }

  flushWrites() {
    this.throttleTimer = null;
    if (this.pendingWrites.size === 0) return;
    const entries = [...this.pendingWrites.entries()].sort((left, right) => left[0] - right[0]);
    this.pendingWrites.clear();
    for (const group of groupWrites(entries)) {
      const merge = group.values.length >= 2;
      const data = merge ? encodeSeqWrite(group.start, group.values) : encodeRandWrite([{ addr: group.start, raw: group.values[0] }]);
      const frame = encodeParamFrame(merge ? FUNC_SEQ_WRITE : FUNC_RAND_WRITE, data);
      const summary = merge
        ? `写 0x${hex4(group.start)}..0x${hex4(group.start + group.values.length - 1)}`
        : `写 0x${hex4(group.start)} = ${group.values[0]}`;
      this.queue.push({
        frame,
        expect: 'ack',
        summary,
        poll: false,
        resolve: () => undefined,
        reject: (error) => this.errors.push(error),
      });
    }
    this.pump();
  }

  pump() {
    if (this.phase === 'error') return;
    if (this.inflight !== null || this.queue.length === 0) return;
    const task = this.queue.shift();
    this.inflight = { task, attempts: 0, timer: null };
    this.sendAttempt();
  }

  sendAttempt() {
    const inflight = this.inflight;
    if (inflight === null) return;
    inflight.attempts += 1;
    const timeoutMs = inflight.task.poll ? TIMING.pollTimeoutMs : TIMING.requestTimeoutMs;
    inflight.timer = setTimeout(() => this.onTimeout(inflight), timeoutMs);
    this.stats.outFrames += 1;
    const summary = inflight.attempts > 1 ? `重发（第 ${inflight.attempts} 次）${inflight.task.summary}` : inflight.task.summary;
    this.channel.sendFrame(inflight.task.frame, summary).catch((error) => this.failFatal({ kind: 'disconnected', message: `通道错误：${error.message}` }));
  }

  onTimeout(inflight) {
    if (this.inflight !== inflight) return;
    inflight.timer = null;
    if (inflight.task.poll) {
      this.stats.droppedPolls += 1;
      this.inflight = null;
      this.pump();
      return;
    }
    this.stats.timeouts += 1;
    this.retryOrFail({ kind: 'timeout', message: `请求超时：${inflight.task.summary}` });
  }

  retryOrFail(error) {
    const inflight = this.inflight;
    if (inflight === null) return;
    if (inflight.attempts <= TIMING.requestRetries) {
      this.stats.retries += 1;
      if (inflight.timer !== null) clearTimeout(inflight.timer);
      inflight.timer = null;
      this.sendAttempt();
      return;
    }
    this.failFatal(error);
  }

  failFatal(error) {
    if (this.phase === 'error') return;
    const inflight = this.inflight;
    this.inflight = null;
    if (inflight !== null && inflight.timer !== null) clearTimeout(inflight.timer);
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.pendingWrites.clear();
    this.stopPolling();
    const dropped = this.queue;
    this.queue = [];
    this.errors.push(error);
    this.phase = 'error';
    if (inflight !== null) inflight.task.reject(error);
    for (const task of dropped) task.reject(error);
  }

  handleFrame(frame) {
    if (this.phase === 'error') return;
    const inflight = this.inflight;
    if (inflight === null) {
      this.channel.pushDiag('in', hexBytes(encodeParamFrame(frame.func, frame.data)), `unexpected 帧：当前没有在途请求`, 'warn');
      return;
    }
    if (frame.func === FUNC_ACK) {
      this.settleAck(frame);
      return;
    }
    if (inflight.task.expect === 'read' && (frame.func === FUNC_RAND_READ || frame.func === FUNC_SEQ_READ)) {
      this.settle(frame);
      return;
    }
    this.channel.pushDiag('in', hexBytes(encodeParamFrame(frame.func, frame.data)), 'unexpected 帧：与在途请求方向不符', 'warn');
  }

  settleAck(frame) {
    const code = readWord(frame.data, 0);
    if (code === ACK_NO_ERR) {
      this.settle(frame);
      return;
    }
    if (code === ACK_CHECKSUM_ERR || code === ACK_DEV_ADDR_ERR) {
      this.retryOrFail({ kind: code === ACK_CHECKSUM_ERR ? 'crc' : 'addr', ack: code, message: `设备返回 0x${hex4(code)}` });
      return;
    }
    const kind = code === 0x0002 ? 'len' : code === 0x0004 ? 'readOnly' : 'range';
    this.completeWithError({ kind, ack: code, message: `设备返回 0x${hex4(code)}` });
  }

  settle(frame) {
    const inflight = this.inflight;
    if (inflight === null) return;
    if (inflight.timer !== null) clearTimeout(inflight.timer);
    this.inflight = null;
    let reply;
    try {
      reply = parseParamReply(frame);
    } catch (error) {
      inflight.task.reject({ kind: 'len', message: error.message });
      this.pump();
      return;
    }
    inflight.task.resolve(reply);
    this.pump();
  }

  completeWithError(error) {
    const inflight = this.inflight;
    if (inflight === null) return;
    if (inflight.timer !== null) clearTimeout(inflight.timer);
    this.inflight = null;
    inflight.task.reject(error);
    if (inflight.task.expect === 'ack') this.errors.push(error);
    this.pump();
  }

  async sync() {
    this.activate();
    this.phase = 'syncing';
    const preset = await this.readSeq(PRESET_START, PRESET_END - PRESET_START + 1);
    const info = await this.readRandom(SYNC_INFO_ADDRS);
    const words = new Map(info.entries.map((entry) => [entry.addr, entry.raw]));
    const values = new Map();
    preset.values.forEach((raw, index) => values.set(preset.start + index, raw));
    this.phase = 'ready';
    if (this.polling) this.startPolling();
    return {
      preset: { start: preset.start, values },
      device: {
        modelCode: decodeAsciiWords(words, 0x0000, 3),
        firmware: {
          x: words.get(0x000b) ?? 0,
          y: words.get(0x000c) ?? 0,
          z: words.get(0x000d) ?? 0,
          build: words.get(0x000e) ?? 0,
        },
        vid: words.get(0x0016) ?? 0,
        pid: words.get(0x0017) ?? 0,
        serial: decodeAsciiWords(words, 0x001e, 32),
      },
    };
  }

  setPolling(enabled) {
    this.polling = enabled;
    if (!enabled) {
      this.stopPolling();
      return;
    }
    if (this.phase === 'ready') this.startPolling();
  }

  startPolling() {
    if (this.pollTimer !== null) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.pollTick();
    }, TIMING.pollIntervalMs);
  }

  stopPolling() {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  pollTick() {
    if (!this.polling || this.phase !== 'ready') return;
    if (this.inflight !== null || this.queue.length > 0 || this.pendingWrites.size > 0) {
      this.stats.droppedPolls += 1;
      this.startPolling();
      return;
    }
    const frame = encodeParamFrame(FUNC_RAND_READ, encodeRandRead([LEVEL_ADDR]));
    this.queue.push({
      frame,
      expect: 'read',
      summary: `读 0x${hex4(LEVEL_ADDR)}`,
      poll: true,
      resolve: (reply) => this.deliverLevel(reply),
      reject: () => undefined,
    });
    this.pump();
    this.startPolling();
  }

  deliverLevel(reply) {
    if (reply.kind !== 'rand') return;
    const entry = reply.entries.find((item) => item.addr === LEVEL_ADDR);
    if (!entry) return;
    this.level = { raw: entry.raw, at: Date.now() };
  }

  /** 电平状态：1 s 没有新采样就判失效（R5-3 的可观测面） */
  levelState() {
    const { raw, at } = this.level;
    if (raw === null) return { raw: null, db: null, valid: false, ageMs: null };
    const ageMs = Date.now() - at;
    return { raw, db: levelToDb(raw), valid: ageMs <= LEVEL_STALE_MS, ageMs };
  }

  dispose() {
    this.stopPolling();
    if (this.throttleTimer !== null) clearTimeout(this.throttleTimer);
    this.throttleTimer = null;
    const inflight = this.inflight;
    this.inflight = null;
    if (inflight !== null) {
      if (inflight.timer !== null) clearTimeout(inflight.timer);
      inflight.task.reject({ kind: 'disconnected', message: '会话已销毁' });
    }
    for (const task of this.queue.splice(0)) task.reject({ kind: 'disconnected', message: '会话已销毁' });
    this.pendingWrites.clear();
  }
}

function decodeAsciiWords(words, base, count) {
  let text = '';
  for (let index = 0; index < count; index += 1) {
    const word = words.get(base + index) ?? 0;
    const high = (word >> 8) & 0xff;
    const low = word & 0xff;
    if (high === 0) return text;
    text += String.fromCharCode(high);
    if (low === 0) return text;
    text += String.fromCharCode(low);
  }
  return text;
}

// ---------------------------------------------------------------- 升级包解析（预检）

function rejection(problem, message, detail) {
  return detail === undefined ? { problem, message } : { problem, message, detail };
}

/**
 * 结构解析：帧/信息帧位置/块长度与对齐。**不含**内容判定（型号、长度上界、校验和），
 * T14 要取证设备侧 FAIL 分支，必须只做结构解析就把包发出去。
 */
function parsePackageStructure(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return { ok: false, rejection: rejection('frame', '包为空', { size: 0 }) };
  }
  const decoded = decodeSigmaStream(new Uint8Array(bytes));
  const crcIssue = decoded.issues.find((issue) => issue.problem === 'crc');
  if (crcIssue) return { ok: false, rejection: rejection('crc', `偏移 ${crcIssue.offset} 的帧 SigmaCRC 错`, { offset: crcIssue.offset }) };
  if (decoded.issues.length > 0) {
    const first = decoded.issues[0];
    return { ok: false, rejection: rejection('frame', `偏移 ${first.offset}：${first.detail}`, { offset: first.offset }) };
  }
  if (decoded.rest.length > 0) {
    return { ok: false, rejection: rejection('frame', `包尾有 ${decoded.rest.length} B 无法成帧`, { rest: decoded.rest.length }) };
  }
  const frames = decoded.frames;
  if (frames.length === 0) return { ok: false, rejection: rejection('frame', '包内没有 SigmaBus 帧') };

  const enter = frames[0];
  const enterData = [0x08, 0x10, 0x01, 0x00];
  if (enter.cmd !== CMD_PARAM_WRITE || enter.data.length !== enterData.length || enterData.some((byte, index) => enter.data[index] !== byte)) {
    return { ok: false, rejection: rejection('frame', '首帧不是 EnterDfu（0x03 写 0x1008 = 1）') };
  }

  const infoIndexes = [];
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index].cmd === CMD_DFU && frames[index].data.length > 0 && frames[index].data[0] === DFU_CMD_INFO) {
      infoIndexes.push(index);
    }
  }
  if (infoIndexes.length === 0) return { ok: false, rejection: rejection('infoCount', '包内没有固件信息帧') };
  if (infoIndexes.length > 1) return { ok: false, rejection: rejection('infoCount', `包内有 ${infoIndexes.length} 个信息帧`, { count: infoIndexes.length }) };
  if (infoIndexes[0] !== 1) return { ok: false, rejection: rejection('frame', `信息帧在 index ${infoIndexes[0]}，应为 1`, { index: infoIndexes[0] }) };

  const infoFrame = frames[1];
  if (infoFrame.data.length !== 2 + 81) {
    return { ok: false, rejection: rejection('infoCount', `信息帧载荷 ${infoFrame.data.length - 2} B，应为 81 B`) };
  }

  const blocks = [];
  for (let index = 2; index < frames.length; index += 1) {
    const frame = frames[index];
    if (frame.cmd !== CMD_DFU || frame.data.length < 3 || frame.data[0] !== DFU_CMD_BLOCK) {
      return { ok: false, rejection: rejection('frame', `index ${index} 不是固件数据块`, { index }) };
    }
    blocks.push(frame.data.slice(2));
  }
  if (blocks.length === 0) return { ok: false, rejection: rejection('frame', '包内没有数据块') };

  for (let index = 0; index < blocks.length; index += 1) {
    const size = blocks[index].length;
    const isLast = index === blocks.length - 1;
    if (size > BLOCK_BYTES || (!isLast && size !== BLOCK_BYTES)) {
      return { ok: false, rejection: rejection('blockSize', `块 ${index} 为 ${size} B，应为 ${BLOCK_BYTES} B`, { index, size }) };
    }
  }
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index].length % 4 !== 0) {
      return { ok: false, rejection: rejection('notAligned', `块 ${index} 为 ${blocks[index].length} B，不是 4 的倍数`, { index }) };
    }
  }
  for (let index = 0; index < 6; index += 1) {
    const byte = infoFrame.data[2 + index];
    if (byte < 0x20 || byte > 0x7e) {
      return { ok: false, rejection: rejection('modelMissing', '信息帧的型号码不是可打印 ASCII') };
    }
  }

  const payload = infoFrame.data.subarray(2);
  const info = {
    modelCode: readAscii(payload, 0, 6),
    modelName: readAscii(payload, 6, 64),
    version: { x: payload[70], y: payload[71], z: payload[72] },
    length: readU32(payload, 73),
    checksum: readU32(payload, 77),
  };
  return { ok: true, info, blocks, total: blocks.reduce((sum, block) => sum + block.length, 0) };
}

function readAscii(bytes, offset, width) {
  let text = '';
  for (let index = 0; index < width; index += 1) text += String.fromCharCode(bytes[offset + index]);
  return text.replace(/\0+$/, '');
}

/** 内容判定：型号 → 长度上界 → 长度一致性 → 校验和（设计 §5.10 / R-5 的顺序） */
function verifyPackageContent(parsed, options) {
  const info = parsed.info;
  if (info.modelCode === MODEL_BOOTLOADER) {
    if (options.allowBootld !== true) {
      return rejection('modelMissing', '固件包是 Bootloader 镜像', { reason: 'bootld', imageModelCode: info.modelCode });
    }
  } else if (info.modelCode !== MODEL_WILDCARD) {
    const deviceModel = options.deviceModelCode ?? null;
    if (deviceModel === null) {
      return rejection('modelMissing', '拿不到当前设备的型号码', { reason: 'unknown-device', imageModelCode: info.modelCode });
    }
    if (deviceModel !== info.modelCode) {
      return rejection('modelMissing', `设备型号码 ${deviceModel} 与镜像型号码 ${info.modelCode} 不一致`, {
        reason: 'mismatch',
        imageModelCode: info.modelCode,
        deviceModelCode: deviceModel,
      });
    }
  }
  const limit = info.modelCode === MODEL_BOOTLOADER ? BOOT_MAX_BYTES : APP_MAX_BYTES;
  if (info.length > limit) {
    return rejection('limitExceeded', `长度 ${info.length} 超过上限 ${limit}`, { length: info.length, limit });
  }
  if (info.length !== parsed.total) {
    return rejection('lengthMismatch', `长度 ${info.length} 与块总长 ${parsed.total} 不一致`, {
      length: info.length,
      actual: parsed.total,
    });
  }
  const cipher = new Uint8Array(parsed.total);
  let offset = 0;
  for (const block of parsed.blocks) {
    cipher.set(block, offset);
    offset += block.length;
  }
  const plain = gammaDecrypt(cipher);
  const checksum = sum32Words(plain);
  if (checksum !== info.checksum) {
    return rejection('checksumMismatch', `校验和 0x${(info.checksum >>> 0).toString(16)} 与计算值 0x${(checksum >>> 0).toString(16)} 不符`, {
      expected: info.checksum,
      actual: checksum,
    });
  }
  return null;
}

// ---------------------------------------------------------------- 上位机 DFU 会话（最小实现）

class DfuRunner {
  constructor(channel) {
    this.channel = channel;
    this.phase = 'idle';
    this.error = null;
    this.round = 1;
    this.image = null;
    this.slot = null;
    this.sends = [];
    channel.setParamHandler((frame) => this.handleParamFrame(frame));
    channel.setSigmaHandler((frame) => this.handleSigmaFrame(frame));
  }

  load(bytes, options = {}) {
    this.phase = 'idle';
    this.error = null;
    this.round = 1;
    this.sends = [];
    this.image = null;
    const structural = parsePackageStructure(bytes);
    if (!structural.ok) {
      this.failPreflight(structural.rejection);
      return { ok: false, rejection: structural.rejection };
    }
    const rejectionResult = options.skipPreflight === true ? null : verifyPackageContent(structural, options);
    if (rejectionResult !== null) {
      this.failPreflight(rejectionResult);
      return { ok: false, rejection: rejectionResult };
    }
    this.image = structural;
    this.phase = 'ready';
    return { ok: true, info: structural.info, blocks: structural.blocks.length };
  }

  failPreflight(rejectionResult) {
    this.phase = 'failed';
    this.error = {
      kind: 'preflight',
      problem: rejectionResult.problem,
      detail: `${rejectionResult.problem}: ${rejectionResult.message}`,
    };
  }

  reportFailure(error) {
    this.error = error;
    this.settleSlot({ kind: 'aborted' });
    this.phase = 'failed';
  }

  snapshot() {
    return { phase: this.phase, round: this.round, error: this.error, sends: this.sends.slice() };
  }

  complete(verification) {
    if (this.phase !== 'settling' && this.phase !== 'verifying') return;
    if (verification !== undefined && verification.ok === false) {
      this.reportFailure({ kind: 'verify', round: this.round, detail: verification.detail });
      return;
    }
    this.phase = this.error === null ? 'done' : 'failed';
  }

  waitSlot(kind, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.slot === null || this.slot.timer !== timer) return;
        this.slot = null;
        resolve({ kind: 'timeout' });
      }, timeoutMs);
      this.slot = { kind, timer, resolve };
    });
  }

  settleSlot(result) {
    const slot = this.slot;
    if (slot === null) return;
    clearTimeout(slot.timer);
    this.slot = null;
    slot.resolve(result);
  }

  handleParamFrame(frame) {
    if (frame.func !== FUNC_ACK) return;
    if (this.slot !== null && this.slot.kind === 'ack') this.settleSlot({ kind: 'ack', code: readWord(frame.data, 0) });
  }

  handleSigmaFrame(frame) {
    const status = parseStatusFrame(frame);
    if (status !== null) {
      if (this.slot !== null && this.slot.kind === 'status') this.settleSlot({ kind: 'status', value: status.status });
      return;
    }
    const ack = parseAckFrame(frame);
    if (ack !== null && ack.err !== 0 && this.slot !== null && this.slot.kind === 'status') {
      this.settleSlot({ kind: 'ackError', err: ack.err });
    }
  }

  /** App 模式：写 0x1008=1 并等参数协议 ACK；ACK 只证明帧被处理，进没进 DFU 由信息帧探测判定 */
  async enterDfu() {
    this.channel.setDecoder('param');
    this.channel.setSigmaHandler(null);
    this.channel.setParamHandler((frame) => this.handleParamFrame(frame));
    const frame = encodeParamFrame(FUNC_RAND_WRITE, encodeRandWrite([{ addr: 0x1008, raw: 1 }]));
    for (let attempt = 1; attempt <= TIMING.enterAttempts; attempt += 1) {
      this.sends.push({ kind: 'enter', attempt });
      const pending = this.waitSlot('ack', TIMING.requestTimeoutMs);
      await this.channel.sendFrame(frame, `EnterDfu 0x1008=1（第 ${attempt} 次）`);
      const result = await pending;
      if (result.kind === 'ack' && result.code === ACK_NO_ERR) return true;
    }
    return false;
  }

  async run(options = {}) {
    const { skipEnter = false, quiesceMs = 0 } = options;
    if (this.image === null) throw new Error('DFU 会话没有已加载的镜像');
    this.phase = 'entering';
    if (!skipEnter) {
      const acked = await this.enterDfu();
      if (!acked) {
        this.reportFailure({ kind: 'enterTimeout', detail: `${TIMING.enterAttempts} 次 EnterDfu 都没有 ACK 0x0000` });
        return this.snapshot();
      }
    }
    for (;;) {
      const step = await this.playRound();
      if (step.kind === 'settled') {
        this.phase = 'settling';
        return this.snapshot();
      }
      if (step.kind === 'failed') {
        this.reportFailure(step.error);
        return this.snapshot();
      }
      this.round += 1;
      if (this.round > TIMING.dfuRoundRestarts) {
        this.reportFailure({ kind: 'restartExhausted', round: this.round - 1, detail: step.reason });
        return this.snapshot();
      }
      const waitMs = step.sentAt === undefined ? 0 : Math.max(0, step.sentAt + quiesceMs - Date.now());
      if (waitMs > 0) await delay(waitMs);
    }
  }

  async playRound() {
    this.phase = 'probing';
    const probe = await this.probeInfo();
    if (probe.kind !== 'ok') return probe;
    this.phase = 'writing';
    return this.writeBlocks();
  }

  async probeInfo() {
    this.channel.setDecoder('sigma');
    this.channel.setParamHandler(null);
    this.channel.setSigmaHandler((frame) => this.handleSigmaFrame(frame));
    const frame = encodeSigmaInfoFrame(this.image.info);
    for (let attempt = 1; attempt <= TIMING.dfuProbeAttempts; attempt += 1) {
      this.sends.push({ kind: 'info', round: this.round, attempt });
      const pending = this.waitSlot('status', TIMING.dfuProbeTimeoutMs);
      await this.channel.sendFrame(frame, `DFU info（第 ${this.round} 轮第 ${attempt} 次）`);
      const result = await pending;
      if (result.kind === 'timeout') continue;
      if (result.kind === 'ackError') return { kind: 'restart', reason: `info SigmaBus ACK 0x${hex4(result.err)}` };
      if (result.value === DFU_STATUS_CONTINUE) return { kind: 'ok' };
      if (result.value === DFU_STATUS_CODE_ERR) return { kind: 'restart', reason: 'info status 0x02' };
      if (result.value === DFU_STATUS_INFO_ERR) return { kind: 'failed', error: { kind: 'statusInfo', status: result.value, round: this.round } };
      if (result.value === DFU_STATUS_FAIL) return { kind: 'failed', error: { kind: 'statusFail', status: result.value, round: this.round } };
      return { kind: 'failed', error: { kind: 'statusCode', status: result.value, round: this.round } };
    }
    return { kind: 'failed', error: { kind: 'probeFailed', round: this.round } };
  }

  /** 逐块发、逐块等：绝不流水线（设备 OUT 槽只有 4 个，一块占 5 个） */
  async writeBlocks() {
    const blocks = this.image.blocks;
    for (let index = 0; index < blocks.length; index += 1) {
      const step = await this.sendBlock(index);
      if (step.kind === 'timeout' || step.kind === 'ackError' || step.kind === 'failed' || step.kind === 'restart') return step;
      if (step.kind === 'success') return { kind: 'settled', blockIndex: index };
      if (step.kind !== 'continue') return step;
    }
    return { kind: 'restart', reason: `${blocks.length} 块发完仍无终态` };
  }

  async sendBlock(index) {
    this.channel.setDecoder('sigma');
    this.channel.setParamHandler(null);
    this.channel.setSigmaHandler((frame) => this.handleSigmaFrame(frame));
    const blocks = this.image.blocks;
    const frame = encodeSigmaBlockFrame(blocks[index]);
    const sentAt = Date.now();
    this.sends.push({ kind: 'block', round: this.round, index: index + 1, sentAt });
    const pending = this.waitSlot('status', TIMING.dfuBlockTimeoutMs);
    await this.channel.sendFrame(frame, `DFU block ${index + 1}/${blocks.length}`);
    const result = await pending;
    if (result.kind === 'timeout') return { kind: 'timeout', sentAt, reason: `block ${index + 1} 超时` };
    if (result.kind === 'ackError') return { kind: 'ackError', sentAt, reason: `block ${index + 1} ACK 0x${hex4(result.err)}` };
    if (result.value === DFU_STATUS_SUCCESS) return { kind: 'success', sentAt };
    if (result.value === DFU_STATUS_CONTINUE) return { kind: 'continue', sentAt };
    if (result.value === DFU_STATUS_CODE_ERR) return { kind: 'restart', sentAt, reason: `block ${index + 1} status 0x02` };
    if (result.value === DFU_STATUS_INFO_ERR) return { kind: 'failed', sentAt, error: { kind: 'statusInfo', status: result.value, blockIndex: index } };
    if (result.value === DFU_STATUS_FAIL) return { kind: 'failed', sentAt, error: { kind: 'statusFail', status: result.value, blockIndex: index } };
    return { kind: 'failed', sentAt, error: { kind: 'statusCode', status: result.value, blockIndex: index } };
  }
}

// ---------------------------------------------------------------- 上下文与用例

function createContext(options) {
  const bridgeHttp = `http://127.0.0.1:${options.port}`;
  const controlHttp = `http://127.0.0.1:${options.controlPort}`;
  return {
    bridgeUrl: options.bridgeUrl,
    bridgeHttp,
    controlHttp,
    getJson,
    post: (route, body) => postJson(`${controlHttp}${route}`, body),
    stats: () => getJson(`${controlHttp}/control/stats`),
    async connect() {
      return Channel.connect(options.bridgeUrl, DEVICE_ID);
    },
  };
}

async function readFirmwareVersion(client) {
  const reply = await client.readRandom([0x000b, 0x000c, 0x000d, 0x000e]);
  const words = new Map(reply.entries.map((entry) => [entry.addr, entry.raw]));
  return { x: words.get(0x000b) ?? 0, y: words.get(0x000c) ?? 0, z: words.get(0x000d) ?? 0, build: words.get(0x000e) ?? 0 };
}

const CASES = [
  {
    id: 'T01',
    name: '设备发现（R7-1）',
    async run(ctx) {
      const body = await ctx.getJson(`${ctx.bridgeHttp}/api/devices`);
      const device = (body?.devices ?? []).find((item) => item.deviceId === DEVICE_ID);
      assert(device, `/api/devices 里没有 ${DEVICE_ID}`);
      const input = device.layout?.input?.[String(REPORT_ID_IN)];
      const output = device.layout?.output?.[String(REPORT_ID_OUT)];
      assert(input, 'layout 里没有 input 报告 0x11');
      assert(output, 'layout 里没有 output 报告 0x51');
      assert(input.byteLength === 63, `input 0x11 byteLength=${input.byteLength}，应为 63`);
      assert(output.byteLength === 63, `output 0x51 byteLength=${output.byteLength}，应为 63`);
      return {
        deviceId: device.deviceId,
        productName: device.productName,
        vendorId: device.vendorId,
        productId: device.productId,
        usesReportIds: device.usesReportIds,
        input: { reportId: REPORT_ID_IN, byteLength: input.byteLength },
        output: { reportId: REPORT_ID_OUT, byteLength: output.byteLength },
      };
    },
  },
  {
    id: 'T02',
    name: '随机读往返（R7-2）',
    async run(ctx) {
      const channel = await ctx.connect();
      const client = new ParamClient(channel);
      try {
        const reply = await client.readRandom([LEVEL_ADDR]);
        assert(reply.kind === 'rand', `应答类型 ${reply.kind}，应为 rand`);
        const stats = await ctx.stats();
        assert(stats.lastRoundTripMs <= 5, `端到端 ${stats.lastRoundTripMs} ms > 5 ms`);
        return {
          request: `0x12 读 0x${hex4(LEVEL_ADDR)}`,
          lastRoundTripMs: stats.lastRoundTripMs,
          entries: reply.entries,
        };
      } finally {
        client.dispose();
        channel.close();
      }
    },
  },
  {
    id: 'T03',
    name: '回读全量（R4-1）',
    async run(ctx) {
      const known = {
        0x2024: 1,
        0x2025: 3,
        0x204a: 1,
        0x204b: 123,
        0x2051: 1,
        0x2053: 500,
        0x205b: 30,
        0x2061: 200,
        0x2063: 100,
        0x2068: 200,
        0x206d: 300,
        0x2070: 20,
      };
      const values = {};
      for (const [addr, raw] of Object.entries(known)) values[`0x${hex4(Number(addr))}`] = raw;
      await ctx.post('/control/registers', { values });
      const channel = await ctx.connect();
      const client = new ParamClient(channel);
      try {
        const snapshot = await client.sync();
        const mismatched = [];
        for (const [addr, expected] of Object.entries(known)) {
          const actual = snapshot.preset.values.get(Number(addr));
          if (actual !== expected) mismatched.push({ addr: `0x${hex4(Number(addr))}`, expected, actual });
        }
        assert(mismatched.length === 0, `回读不一致：${JSON.stringify(mismatched)}`);
        return {
          asserted: Object.keys(known).length,
          presetStart: `0x${hex4(snapshot.preset.start)}`,
          presetWords: snapshot.preset.values.size,
          modelCode: snapshot.device.modelCode,
          serial: snapshot.device.serial,
        };
      } finally {
        client.dispose();
        channel.close();
      }
    },
  },
  {
    id: 'T04',
    name: '写参数 + 只读拦截（R3-1/R3-3）',
    async run(ctx) {
      const channel = await ctx.connect();
      const client = new ParamClient(channel);
      try {
        client.write([{ addr: 0x2025, raw: 2 }]);
        await sleep(TIMING.writeThrottleMs + 200);
        const readback = await client.readRandom([0x2025]);
        const landed = readback.entries.find((entry) => entry.addr === 0x2025)?.raw;
        assert(landed === 2, `0x2025 写入后回读为 ${landed}，应为 2`);

        const before = await ctx.stats();
        const filtered = client.writeFields([{ addr: 0x2023, raw: 50 }]);
        await sleep(TIMING.writeThrottleMs + 150);
        const after = await ctx.stats();
        assert(filtered.dropped.length === 1, '本地只读拦截没有拦下 0x2023');
        assert(after.framesIn === before.framesIn, `只读字段仍然出帧：framesIn ${before.framesIn} → ${after.framesIn}`);
        assert(
          after.rejectedReadOnly === before.rejectedReadOnly,
          `设备侧 rejectedReadOnly 变化 ${before.rejectedReadOnly} → ${after.rejectedReadOnly}`,
        );
        return {
          wrote: { '0x2025': 2, readback: landed },
          readonlyDropped: { '0x2023': 50 },
          framesIn: { before: before.framesIn, after: after.framesIn },
          rejectedReadOnly: after.rejectedReadOnly,
        };
      } finally {
        client.dispose();
        channel.close();
      }
    },
  },
  {
    id: 'T05',
    name: '超范围（R3-4）',
    async run(ctx) {
      const channel = await ctx.connect();
      const client = new ParamClient(channel);
      try {
        // 第一半：设备侧真的拒绝。0x2024（encOnOff）原始值域 0..1，写 2 被设备以 0x0005 拒绝
        client.write([{ addr: 0x2024, raw: 2 }]);
        const deviceError = await waitFor(
          () => client.errors.find((item) => item.kind === 'range') ?? null,
          3000,
          '等待设备侧超范围拒绝（0x0005）',
        );
        const unchanged = await client.readRandom([0x2024]);
        const rawAfterDevice = unchanged.entries.find((entry) => entry.addr === 0x2024)?.raw;
        assert(rawAfterDevice === 0, `设备拒绝后 0x2024=${rawAfterDevice}，应为 0`);

        // 第二半：ackError(5) 注入只改写回执，用来验证上位机的错误码映射；设备侧寄存器会先落地
        await ctx.post('/control/faults', {
          faults: [{ on: { mode: 'app', func: FUNC_RAND_WRITE }, action: 'ackError', code: 5, times: 1 }],
        });
        client.write([{ addr: 0x2024, raw: 1 }]);
        const injected = await waitFor(
          () => client.errors.find((item) => item.kind === 'range' && item.ack === 5) ?? null,
          3000,
          '等待注入的 0x0005 回执',
        );
        return {
          deviceSide: { ack: `0x${hex4(deviceError.ack ?? 0)}`, kind: deviceError.kind, register: rawAfterDevice },
          injectedAck: { code: `0x${hex4(injected.ack ?? 0)}`, kind: injected.kind },
          note: 'ackError 只改写回执，设备侧寄存器已落地；"设备值不变"由设备侧真实拒绝那一半取证',
        };
      } finally {
        client.dispose();
        channel.close();
      }
    },
  },
  {
    id: 'T06',
    name: '三次超时进 error（R3-5）',
    async run(ctx) {
      await ctx.post('/control/faults', {
        faults: [{ on: { mode: 'app', func: FUNC_RAND_WRITE }, action: 'disconnect', ms: 5000, times: 1 }],
      });
      const channel = await ctx.connect();
      const client = new ParamClient(channel);
      try {
        client.write([{ addr: 0x2024, raw: 1 }]);
        await waitFor(() => client.phase === 'error', 6000, '等待会话进入 error');
        const atError = await ctx.stats();
        client.write([{ addr: 0x2024, raw: 1 }]);
        await waitFor(() => client.throttleTimer === null, 1000, '等待写窗口关闭');
        await sleep(400);
        const after = await ctx.stats();
        assert(
          after.framesIn === atError.framesIn,
          `进 error 后仍出帧：framesIn ${atError.framesIn} → ${after.framesIn}`,
        );
        return {
          phase: client.phase,
          timeouts: client.stats.timeouts,
          retries: client.stats.retries,
          framesAtError: atError.framesIn,
          framesAfterError: after.framesIn,
        };
      } finally {
        client.dispose();
        channel.close();
      }
    },
  },
  {
    id: 'T07',
    name: '写合并（R3-6）',
    async run(ctx) {
      const channel = await ctx.connect();
      const client = new ParamClient(channel);
      try {
        const before = await ctx.stats();
        for (let index = 0; index < 120; index += 1) {
          client.write([{ addr: 0x2025, raw: index % 4 }]);
          await delay(16);
        }
        await waitFor(() => client.throttleTimer === null && client.pendingWrites.size === 0, 2000, '等待写窗口清空');
        await sleep(200);
        const after = await ctx.stats();
        const delta = after.framesIn - before.framesIn;
        assert(delta <= 20, `120 次写产生 ${delta} 帧，超过 20`);
        assert(delta >= 1, `120 次写竟然没有出帧`);
        const readback = await client.readRandom([0x2025]);
        const raw = readback.entries.find((entry) => entry.addr === 0x2025)?.raw;
        assert(raw === 119 % 4, `末次写 0x2025=${119 % 4} 未落地，回读 ${raw}`);
        return { writes: 120, durationMs: 2000, framesInDelta: delta, lastValue: raw };
      } finally {
        client.dispose();
        channel.close();
      }
    },
  },
  {
    id: 'T08',
    name: '电平三段（R5-1）',
    async run(ctx) {
      const channel = await ctx.connect();
      const client = new ParamClient(channel);
      try {
        client.setPolling(true);
        await client.sync();
        const samples = [];
        for (const raw of [0, 128, 256]) {
          await ctx.post('/control/level', { pattern: 'step', value: raw });
          const sample = await waitFor(
            () => {
              const state = client.levelState();
              return state.valid && state.raw === raw ? state : null;
            },
            3000,
            `等待电平 ${raw} 的采样`,
          );
          samples.push({ configuredRaw: raw, observedRaw: sample.raw, inputRmsDb: Number(sample.db.toFixed(3)) });
        }
        assert(samples[0].inputRmsDb <= -90, `raw=0 的 inputRms ${samples[0].inputRmsDb} > -90`);
        assert(Math.abs(samples[1].inputRmsDb + 48) <= 6, `raw=128 的 inputRms ${samples[1].inputRmsDb} 不在 -48±6`);
        assert(samples[2].inputRmsDb >= -6, `raw=256 的 inputRms ${samples[2].inputRmsDb} < -6`);
        return { samples, levelAddr: `0x${hex4(LEVEL_ADDR)}` };
      } finally {
        client.dispose();
        channel.close();
      }
    },
  },
  {
    id: 'T09',
    name: '掉线电平失效（R5-3）',
    async run(ctx) {
      const channel = await ctx.connect();
      const client = new ParamClient(channel);
      try {
        client.setPolling(true);
        await client.sync();
        await ctx.post('/control/level', { pattern: 'step', value: 128 });
        const sample = await waitFor(
          () => {
            const state = client.levelState();
            return state.valid ? state : null;
          },
          3000,
          '等待首个有效电平采样',
        );
        assert(sample.valid, '电平采样一开始就无效');
        const lastSampleAt = client.level.at;
        await ctx.post('/control/faults', {
          faults: [{ on: { mode: 'app', func: FUNC_RAND_READ }, action: 'disconnect', ms: 3000, times: 1 }],
        });
        const flippedAt = await waitFor(
          () => (client.levelState().valid ? null : Date.now()),
          4000,
          '等待 inputValid === false',
        );
        const staleAfterMs = flippedAt - lastSampleAt;
        assert(staleAfterMs <= LEVEL_STALE_MS + 100, `失效耗时 ${staleAfterMs} ms 超过阈值 ${LEVEL_STALE_MS} ms`);
        return {
          staleAfterMs,
          thresholdMs: LEVEL_STALE_MS,
          lastRaw: client.level.raw,
          inputValid: client.levelState().valid,
          droppedPolls: client.stats.droppedPolls,
        };
      } finally {
        client.dispose();
        channel.close();
      }
    },
  },
  {
    id: 'T10',
    name: '丢帧重试（R3-2）',
    async run(ctx) {
      await ctx.post('/control/faults', {
        faults: [2, 5, 8].map((nth) => ({ on: { mode: 'app', func: FUNC_RAND_READ, nth }, action: 'drop', times: 1 })),
      });
      const channel = await ctx.connect();
      const client = new ParamClient(channel);
      try {
        const replies = [];
        for (let index = 0; index < 10; index += 1) {
          const reply = await client.readRandom([0x2025]);
          assert(reply.kind === 'rand', `第 ${index + 1} 次读的应答类型是 ${reply.kind}`);
          replies.push(reply.entries.length);
        }
        assert(client.phase !== 'error', '丢 30% 后会话进了 error');
        assert(client.stats.retries > 0, `重试计数 ${client.stats.retries}，应 > 0`);
        client.write([{ addr: 0x2024, raw: 1 }]);
        await sleep(TIMING.writeThrottleMs + 250);
        const readback = await client.readRandom([0x2024]);
        const raw = readback.entries.find((entry) => entry.addr === 0x2024)?.raw;
        assert(raw === 1, `丢帧用例末尾的写没有落地，回读 ${raw}`);
        return {
          requests: replies.length,
          dropped: Math.min(3, client.stats.timeouts),
          timeouts: client.stats.timeouts,
          retries: client.stats.retries,
          finalWrite: raw,
        };
      } finally {
        client.dispose();
        channel.close();
      }
    },
  },
  {
    id: 'T11',
    name: 'DFU 成功（R6-4）',
    async run(ctx) {
      const built = buildPackage({
        image: syntheticImage(4096),
        modelCode: MODEL_APP,
        modelName: 'MIC M001',
        version: { x: 1, y: 2, z: 3 },
      });
      const channel = await ctx.connect();
      const runner = new DfuRunner(channel);
      let loaded;
      try {
        loaded = runner.load(built.bytes, { deviceModelCode: MODEL_APP });
        assert(loaded.ok, `预检拒绝：${JSON.stringify(loaded.rejection)}`);
        const result = await runner.run();
        assert(result.phase === 'settling', `DFU 停在 ${result.phase}：${JSON.stringify(result.error)}`);
      } finally {
        channel.close();
      }
      const verifyChannel = await ctx.connect();
      const client = new ParamClient(verifyChannel);
      try {
        const snapshot = await client.sync();
        const version = [snapshot.device.firmware.x, snapshot.device.firmware.y, snapshot.device.firmware.z];
        assert(version[0] === 1 && version[1] === 2 && version[2] === 3, `回读版本 ${version.join('.')}，应为 1.2.3`);
        runner.complete({ ok: true });
        const stats = await ctx.stats();
        assert(
          stats.firmwareVersion.join('.') === '1.2.3',
          `/control/stats 的 firmwareVersion 为 ${JSON.stringify(stats.firmwareVersion)}`,
        );
        assert(stats.mode === 'app', `/control/stats 的 mode 为 ${stats.mode}，应为 app`);
        return {
          blocks: built.info.blocks,
          imageBytes: built.info.length,
          phase: runner.phase,
          version: version.join('.'),
          dfuStatus: stats.dfuStatus,
          mode: stats.mode,
          versionSynthetic: stats.versionSynthetic,
        };
      } finally {
        client.dispose();
        verifyChannel.close();
      }
    },
  },
  {
    id: 'T12',
    name: '丢第 40 块（R6-5）',
    async run(ctx) {
      const built = buildPackage({
        image: syntheticImage(256 * 81 + 128),
        modelCode: MODEL_APP,
        modelName: 'MIC M001',
        version: { x: 1, y: 2, z: 3 },
      });
      assert(built.info.blocks === 82, `包块数 ${built.info.blocks}，应为 82`);
      await ctx.post('/control/faults', {
        faults: [{ on: { mode: 'bootloader', dfuCmd: DFU_CMD_BLOCK, phase: 'block', nth: 40 }, action: 'dropAck', times: 1 }],
      });
      const channel = await ctx.connect();
      const runner = new DfuRunner(channel);
      let result;
      try {
        const loaded = runner.load(built.bytes, { deviceModelCode: MODEL_APP });
        assert(loaded.ok, `预检拒绝：${JSON.stringify(loaded.rejection)}`);
        result = await runner.run();
        assert(result.phase === 'settling', `DFU 停在 ${result.phase}：${JSON.stringify(result.error)}`);
        const midStats = await ctx.stats();
        assert(
          result.round === 2,
          `重来轮次为 ${result.round}，应为 2（faultsFired=${midStats.faultsFired} droppedAcks=${midStats.droppedAcks} framesIn=${midStats.framesIn}）`,
        );
      } finally {
        channel.close();
      }
      const verifyChannel = await ctx.connect();
      const client = new ParamClient(verifyChannel);
      try {
        const snapshot = await client.sync();
        const version = [snapshot.device.firmware.x, snapshot.device.firmware.y, snapshot.device.firmware.z];
        assert(version.join('.') === '1.2.3', `回读版本 ${version.join('.')}，应为 1.2.3`);
        const stats = await ctx.stats();
        assert(stats.droppedAcks >= 1, `droppedAcks=${stats.droppedAcks}，应为 1`);
        runner.complete({ ok: true });
        return {
          blocks: built.info.blocks,
          round: result.round,
          droppedAcks: stats.droppedAcks,
          version: version.join('.'),
          infoFrames: result.sends.filter((entry) => entry.kind === 'info').length,
        };
      } finally {
        client.dispose();
        verifyChannel.close();
      }
    },
  },
  {
    id: 'T13',
    name: '丢第 40 块回执（R6-6）',
    async run(ctx) {
      const built = buildPackage({
        image: syntheticImage(256 * 81 + 128),
        modelCode: MODEL_APP,
        modelName: 'MIC M001',
        version: { x: 1, y: 2, z: 3 },
      });
      const faultMs = 2000;
      await ctx.post('/control/faults', {
        faults: [
          {
            on: { mode: 'bootloader', dfuCmd: DFU_CMD_BLOCK, phase: 'block', nth: 40 },
            action: 'delay',
            ms: faultMs,
            times: 1,
          },
        ],
      });
      const channel = await ctx.connect();
      const runner = new DfuRunner(channel);
      let result;
      try {
        const loaded = runner.load(built.bytes, { deviceModelCode: MODEL_APP });
        assert(loaded.ok, `预检拒绝：${JSON.stringify(loaded.rejection)}`);
        result = await runner.run({ quiesceMs: faultMs + 300 });
        assert(result.phase === 'settling', `DFU 停在 ${result.phase}：${JSON.stringify(result.error)}`);
        assert(result.round === 2, `重来轮次为 ${result.round}，应为 2`);
      } finally {
        channel.close();
      }
      const sequence = result.sends;
      const repeated = [];
      for (let index = 1; index < sequence.length; index += 1) {
        const previous = sequence[index - 1];
        const current = sequence[index];
        if (previous.kind === 'block' && current.kind === 'block' && previous.index === current.index) {
          repeated.push({ index, block: current.index, round: current.round });
        }
      }
      assert(repeated.length === 0, `发送序列里出现同块连发：${JSON.stringify(repeated)}`);
      const afterTimeout = sequence.findIndex(
        (entry, index) => entry.kind === 'info' && index > 0 && sequence[index - 1].kind === 'block',
      );
      assert(afterTimeout > 0, '超时后没有整轮重来的信息帧');
      const verifyChannel = await ctx.connect();
      const client = new ParamClient(verifyChannel);
      try {
        const snapshot = await client.sync();
        const version = [snapshot.device.firmware.x, snapshot.device.firmware.y, snapshot.device.firmware.z];
        assert(version.join('.') === '1.2.3', `回读版本 ${version.join('.')}，应为 1.2.3`);
        runner.complete({ ok: true });
        return {
          blocks: built.info.blocks,
          round: result.round,
          repeatedBlocks: repeated.length,
          restartAfterBlock: sequence[afterTimeout - 1].index,
          version: version.join('.'),
        };
      } finally {
        client.dispose();
        verifyChannel.close();
      }
    },
  },
  {
    id: 'T14',
    name: '设备侧校验和错（R6-7）',
    async run(ctx) {
      const built = buildPackage({
        image: syntheticImage(4096),
        modelCode: MODEL_APP,
        modelName: 'MIC M001',
        version: { x: 1, y: 0, z: 1 },
      });
      const tampered = tamperByte(built.bytes, 100);
      const channel = await ctx.connect();
      const runner = new DfuRunner(channel);
      let failed;
      try {
        // 刻意跳过上位机预检：A27 已证明预检会拒绝内容错的包，这里要取证的是设备侧的 FAIL 分支
        const loaded = runner.load(tampered, { skipPreflight: true });
        assert(loaded.ok, `结构解析失败：${JSON.stringify(loaded.rejection)}`);
        failed = await runner.run();
        assert(failed.phase === 'failed', `DFU 停在 ${failed.phase}，应为 failed`);
        assert(failed.error?.kind === 'statusFail', `错误类型 ${failed.error?.kind}，应为 statusFail`);
      } finally {
        channel.close();
      }
      const stats = await ctx.stats();
      assert(stats.dfuStatus === DFU_STATUS_FAIL, `dfuStatus=${stats.dfuStatus}，应为 ${DFU_STATUS_FAIL}`);
      assert(stats.mode === 'bootloader', `mode=${stats.mode}，应为 bootloader`);

      const retryChannel = await ctx.connect();
      const retryRunner = new DfuRunner(retryChannel);
      const verifyClient = new ParamClient(retryChannel);
      try {
        const retryLoaded = retryRunner.load(built.bytes, { deviceModelCode: MODEL_APP });
        assert(retryLoaded.ok, `重试预检拒绝：${JSON.stringify(retryLoaded.rejection)}`);
        // 设备已在 bootloader：参数协议 EnterDfu 在这里无人应答，直接发信息帧复位指针（设计 §5.11）
        const retry = await retryRunner.run({ skipEnter: true });
        assert(retry.phase === 'settling', `重试停在 ${retry.phase}：${JSON.stringify(retry.error)}`);
        const version = await readFirmwareVersion(verifyClient);
        const versionText = `${version.x}.${version.y}.${version.z}`;
        assert(versionText === '1.0.1', `重试后版本 ${versionText}，应为 1.0.1`);
        retryRunner.complete({ ok: true });
        return {
          blocks: built.info.blocks,
          failedPhase: failed.phase,
          errorKind: failed.error?.kind,
          errorBlock: failed.error?.blockIndex,
          dfuStatus: stats.dfuStatus,
          modeAfterFail: stats.mode,
          retryPhase: retry.phase,
          retryVersion: versionText,
        };
      } finally {
        verifyClient.dispose();
        retryChannel.close();
      }
    },
  },
  {
    id: 'T15',
    name: '升级中断电（R7-4 powerLoss）',
    async run(ctx) {
      const built = buildPackage({
        image: syntheticImage(256 * 40),
        modelCode: MODEL_APP,
        modelName: 'MIC M001',
        version: { x: 2, y: 0, z: 0 },
      });
      await ctx.post('/control/faults', {
        faults: [
          { on: { mode: 'bootloader', dfuCmd: DFU_CMD_BLOCK, phase: 'block', nth: 10 }, action: 'powerLoss', times: 1 },
        ],
      });
      const channel = await ctx.connect();
      const runner = new DfuRunner(channel);
      try {
        const loaded = runner.load(built.bytes, { deviceModelCode: MODEL_APP });
        assert(loaded.ok, `预检拒绝：${JSON.stringify(loaded.rejection)}`);
        assert(await runner.enterDfu(), 'EnterDfu 没有拿到 ACK 0x0000');
        const probe = await runner.probeInfo();
        assert(probe.kind === 'ok', `信息帧探测失败：${JSON.stringify(probe)}`);
        for (let index = 0; index < 9; index += 1) {
          const step = await runner.sendBlock(index);
          assert(step.kind === 'continue', `第 ${index + 1} 块回执 ${step.kind}，应为 continue`);
        }
        const tenth = await runner.sendBlock(9);
        assert(tenth.kind === 'timeout', `第 10 块回执 ${tenth.kind}，应为 timeout（已断电）`);
        const framesAtLoss = channel.inFrames;
        const eleventh = await runner.sendBlock(10);
        assert(eleventh.kind === 'timeout', `断电后仍收到回执 ${eleventh.kind}`);
        assert(channel.inFrames === framesAtLoss, `断电后仍收到 ${channel.inFrames - framesAtLoss} 帧`);
      } finally {
        channel.close();
      }
      const stats = await ctx.stats();
      assert(stats.mode === 'bootloader', `断电后 mode=${stats.mode}，应为 bootloader`);
      await ctx.post('/control/mode', { mode: 'app' });
      const recoverChannel = await ctx.connect();
      const recoverClient = new ParamClient(recoverChannel);
      try {
        const snapshot = await recoverClient.sync();
        assert(snapshot.device.modelCode === MODEL_APP, `恢复后型号码 ${snapshot.device.modelCode}`);
        const after = await ctx.stats();
        assert(after.mode === 'app', `POST /control/mode 后 mode=${after.mode}`);
        return {
          blocksSentBeforeLoss: 10,
          blockedFrames: stats.framesIn,
          modeAfterLoss: stats.mode,
          modeAfterRecover: after.mode,
          recoveredModelCode: snapshot.device.modelCode,
        };
      } finally {
        recoverClient.dispose();
        recoverChannel.close();
      }
    },
  },
  {
    id: 'T16',
    name: '帧粘连（R7-4 sticky）',
    async run(ctx) {
      await ctx.post('/control/registers', { values: { '0x2010': 0x1122, '0x2011': 0x3344 } });
      const channel = await ctx.connect();
      const client = new ParamClient(channel);
      try {
        // 先做一次 10 词连续读，让侧车记住"上一条回执"（30 B 帧 → 粘连时整帧前置）
        const first = await client.readSeq(PRESET_START, 10);
        assert(first.values.length === 10, `首读回 ${first.values.length} 词，应为 10`);
        await ctx.post('/control/faults', {
          faults: [{ on: { mode: 'app', func: FUNC_SEQ_READ }, action: 'sticky', times: 1 }],
        });
        const report = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('等待粘连报告超时')), 3000);
          channel.setParamHandler(null);
          channel.reportListener = (payload) => {
            clearTimeout(timer);
            channel.reportListener = null;
            resolve(payload);
          };
          channel
            .sendFrame(encodeParamFrame(FUNC_SEQ_READ, encodeSeqRead(0x2010, 2)), 'sticky 探针 0x2010..0x2011')
            .catch((error) => reject(error));
        });
        channel.setParamHandler((frame) => client.handleFrame(frame));
        assert(report.frames.length === 2, `粘连报告解出 ${report.frames.length} 帧，应为 2`);
        assert(report.issues.length === 0, `粘连报告产生 ${report.issues.length} 条解析告警`);
        const target = report.frames.find((frame) => frame.func === FUNC_SEQ_READ && readWord(frame.data, 0) === 0x2010);
        assert(target, '粘连报告里没有本次请求的应答帧');
        const values = [readWord(target.data, 4), readWord(target.data, 6)];
        assert(values[0] === 0x1122 && values[1] === 0x3344, `粘连帧的数据 ${JSON.stringify(values)} 与写入值不符`);
        const again = await client.readSeq(0x2010, 2);
        assert(again.values[0] === 0x1122 && again.values[1] === 0x3344, '故障用尽后的回读失败');
        return {
          reportBytes: report.frames.reduce((sum, frame) => sum + frame.data.length + 6, 0),
          framesInReport: report.frames.length,
          issues: report.issues.length,
          requested: { start: '0x2010', values: values.map((value) => `0x${hex4(value)}`) },
          followUpRead: 'ok',
        };
      } finally {
        client.dispose();
        channel.close();
      }
    },
  },
  {
    id: 'T17',
    name: '预检拒绝 + 零出帧（R6-2/R6-3）',
    async run(ctx) {
      const built = buildPackage({
        image: syntheticImage(4096),
        modelCode: MODEL_APP,
        modelName: 'MIC M001',
        version: { x: 1, y: 2, z: 3 },
      });
      const baseline = (await ctx.stats()).framesIn;
      const channel = await ctx.connect();
      const runner = new DfuRunner(channel);
      try {
        const tampered = runner.load(tamperByte(built.bytes, 100), { deviceModelCode: MODEL_APP });
        assert(!tampered.ok, '篡改包竟然通过预检');
        assert(
          tampered.rejection.problem === 'checksumMismatch',
          `篡改包的拒绝原因 ${tampered.rejection.problem}，应为 checksumMismatch`,
        );
        assert(runner.phase === 'failed', `预检拒绝后 phase=${runner.phase}`);
        assert(runner.error?.kind === 'preflight', `预检拒绝后 error.kind=${runner.error?.kind}`);

        const oversized = runner.load(overrideLength(built.bytes, 0x40000), { deviceModelCode: MODEL_APP });
        assert(!oversized.ok, '超界包竟然通过预检');
        assert(
          oversized.rejection.problem === 'limitExceeded',
          `超界包的拒绝原因 ${oversized.rejection.problem}，应为 limitExceeded`,
        );
        await sleep(100);
        const after = await ctx.stats();
        assert(after.framesIn === baseline, `预检拒绝期间出帧：framesIn ${baseline} → ${after.framesIn}`);
        return {
          tampered: { problem: tampered.rejection.problem, phase: runner.phase, errorKind: runner.error?.kind },
          oversized: { problem: oversized.rejection.problem, declaredLength: 0x40000 },
          framesIn: { before: baseline, after: after.framesIn },
        };
      } finally {
        channel.close();
      }
    },
  },
  {
    id: 'T18',
    name: 'Bootld 包不可达（R6-9）',
    async run(ctx) {
      const boot = buildPackage({
        image: syntheticImage(1024),
        modelCode: MODEL_BOOTLOADER,
        modelName: 'MIC M001 BOOT',
        version: { x: 1, y: 0, z: 0 },
      });
      const baseline = (await ctx.stats()).framesIn;
      const channel = await ctx.connect();
      const runner = new DfuRunner(channel);
      try {
        const loaded = runner.load(boot.bytes, { deviceModelCode: MODEL_APP });
        assert(!loaded.ok, 'Bootld 包竟然通过预检');
        assert(loaded.rejection.detail?.reason === 'bootld', `拒绝原因 ${JSON.stringify(loaded.rejection.detail)}`);
        assert(loaded.rejection.problem === 'modelMissing', `problem=${loaded.rejection.problem}，应为 modelMissing`);
        await sleep(100);
        const after = await ctx.stats();
        assert(after.framesIn === baseline, `Bootld 包预检拒绝了却仍出帧：${baseline} → ${after.framesIn}`);
        return {
          reason: loaded.rejection.detail?.reason,
          problem: loaded.rejection.problem,
          i18nKey: 'fw.error.internalOnly',
          framesIn: { before: baseline, after: after.framesIn },
        };
      } finally {
        channel.close();
      }
    },
  },
  {
    id: 'T19',
    name: '诊断日志（R8-1/R8-2）',
    async run(ctx) {
      await ctx.post('/control/faults', {
        faults: [{ on: { mode: 'app', func: FUNC_RAND_WRITE }, action: 'crcError', times: 1 }],
      });
      const channel = await ctx.connect();
      const client = new ParamClient(channel);
      try {
        const request = encodeParamFrame(FUNC_RAND_WRITE, encodeRandWrite([{ addr: 0x2024, raw: 1 }]));
        const requestHex = hexBytes(request);
        client.write([{ addr: 0x2024, raw: 1 }]);
        await waitFor(() => channel.crcErrors > 0, 3000, '等待 CRC 错被诊断面计数');
        await waitFor(
          () => client.errors.length === 0 && client.stats.timeouts > 0,
          3000,
          '等待 CRC 错引发的重试',
        );
        await sleep(TIMING.writeThrottleMs + 400);
        const outEntry = channel.diag.find((entry) => entry.dir === 'out' && entry.hex === requestHex);
        assert(outEntry, '诊断日志里没有本次写的请求帧');
        const inAck = channel.diag.find((entry) => entry.dir === 'in' && entry.summary.startsWith('ACK 0x0000'));
        assert(inAck, '诊断日志里没有 ACK 0x0000 回执');
        assert(channel.crcErrors === 1, `crcErrors=${channel.crcErrors}，应为 1`);
        return {
          requestHex,
          ackSummary: inAck.summary,
          crcErrors: channel.crcErrors,
          retries: client.stats.retries,
          diagEntries: channel.diag.length,
          truncatedHex: outEntry.hex.length > 0,
        };
      } finally {
        client.dispose();
        channel.close();
      }
    },
  },
  {
    id: 'T20',
    name: '冷启动自恢复（R4-4）',
    async run(ctx) {
      const channel = await ctx.connect();
      const client = new ParamClient(channel);
      let written;
      try {
        client.write([
          { addr: 0x2024, raw: 1 },
          { addr: 0x2025, raw: 3 },
        ]);
        await sleep(TIMING.writeThrottleMs + 250);
        const before = await client.readRandom([0x2024, 0x2025]);
        written = Object.fromEntries(before.entries.map((entry) => [entry.addr, entry.raw]));
        assert(written[0x2024] === 1 && written[0x2025] === 3, `写后回读 ${JSON.stringify(written)}`);
      } finally {
        client.dispose();
        channel.close();
      }
      const reconnected = await ctx.connect();
      const restarted = new ParamClient(reconnected);
      try {
        const snapshot = await restarted.sync();
        const values = {
          '0x2024': snapshot.preset.values.get(0x2024),
          '0x2025': snapshot.preset.values.get(0x2025),
        };
        assert(values['0x2024'] === 1, `重连后 0x2024=${values['0x2024']}，应为 1`);
        assert(values['0x2025'] === 3, `重连后 0x2025=${values['0x2025']}，应为 3`);
        return {
          writtenBeforeDisconnect: { '0x2024': written[0x2024], '0x2025': written[0x2025] },
          afterReconnect: values,
          presetWords: snapshot.preset.values.size,
        };
      } finally {
        restarted.dispose();
        reconnected.close();
      }
    },
  },
];

// ---------------------------------------------------------------- 环境准备

async function probeEnvironment(options) {
  const bridgeHttp = `http://127.0.0.1:${options.port}`;
  const controlHttp = `http://127.0.0.1:${options.controlPort}`;
  let bridgeAlive = false;
  try {
    const health = await requestJson(`${bridgeHttp}/healthz`);
    bridgeAlive = health.ok;
  } catch {
    bridgeAlive = false;
  }
  let controlAlive = false;
  try {
    const stats = await requestJson(`${controlHttp}/control/stats`);
    controlAlive = stats.ok && typeof stats.body?.mode === 'string';
  } catch {
    controlAlive = false;
  }
  if (bridgeAlive) {
    const devices = await getJson(`${bridgeHttp}/api/devices`);
    const ours = (devices?.devices ?? []).some((device) => device.deviceId === DEVICE_ID);
    if (!ours) {
      return { status: 'foreign', message: `端口 ${options.port} 被别人的进程占用：/api/devices 里没有 ${DEVICE_ID}` };
    }
  }
  if (controlAlive && !bridgeAlive) {
    return { status: 'foreign', message: `控制端口 ${options.controlPort} 已被占用（不是本仓侧车）` };
  }
  if (bridgeAlive && controlAlive) return { status: 'reuse' };
  if (bridgeAlive && !controlAlive) {
    return { status: 'foreign', message: `桥在跑但 ${options.controlPort} 上没有侧车；先停掉占用者再跑自检` };
  }
  return { status: 'start' };
}

async function waitForControl(options, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stats = await requestJson(`http://127.0.0.1:${options.controlPort}/control/stats`);
      if (stats.ok && stats.body?.bridgeConnected === true) return;
    } catch {
      // 侧车还没起来
    }
    await delay(200);
  }
  throw new Error(`侧车 ${timeoutMs} ms 内没有连上桥（控制面 ${options.controlPort}）`);
}

function parseSelfTestArgs(argv) {
  const options = {
    keep: false,
    port: 8765,
    controlPort: 8766,
    timeoutMs: 60_000,
    bridgeUrl: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--keep') {
      options.keep = true;
    } else if (flag === '--port') {
      options.port = Number(argv[(index += 1)]);
    } else if (flag === '--control-port') {
      options.controlPort = Number(argv[(index += 1)]);
    } else if (flag === '--timeout-ms') {
      options.timeoutMs = Number(argv[(index += 1)]);
    } else {
      throw new Error(`未知参数 ${flag}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 0xffff) {
    throw new Error(`--port 必须是 1..65535 的整数，当前 ${options.port}`);
  }
  if (!Number.isInteger(options.controlPort) || options.controlPort <= 0 || options.controlPort > 0xffff) {
    throw new Error(`--control-port 必须是 1..65535 的整数，当前 ${options.controlPort}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000) {
    throw new Error(`--timeout-ms 必须 ≥ 1000，当前 ${options.timeoutMs}`);
  }
  options.bridgeUrl = `ws://127.0.0.1:${options.port}/ws`;
  return options;
}

function timestampOf(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function runCase(entry, ctx, timeoutMs) {
  const startedAt = Date.now();
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`用例超时 ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const detail = await Promise.race([entry.run(ctx), guard]);
    return { id: entry.id, name: entry.name, ok: true, detail: detail ?? {}, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      id: entry.id,
      name: entry.name,
      ok: false,
      detail: { error: error instanceof Error ? error.message : String(error) },
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export const CASE_IDS = Object.freeze(CASES.map((entry) => entry.id));

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseSelfTestArgs(argv);
  } catch (error) {
    console.error(`${TAG} ${error.message}`);
    return 2;
  }

  const startedAt = new Date();
  const python = resolvePython();
  if (python === null) {
    console.error(`${TAG} Python 不可用：${process.env.MICSTUDIO_PYTHON ?? DEFAULT_PYTHON}（用 MICSTUDIO_PYTHON 指定）`);
    return 2;
  }

  let environment;
  try {
    environment = await probeEnvironment(options);
  } catch (error) {
    console.error(`${TAG} 环境探测失败：${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (environment.status === 'foreign') {
    console.error(`${TAG} ${environment.message}`);
    return 2;
  }

  const handles = { bridge: null, sidecar: null };
  const killAll = () => {
    killChild(handles.sidecar);
    killChild(handles.bridge);
  };
  // --keep 的语义是"脚本退出、进程留着"，所以既不能在退出时清理，也不能让子进程把事件循环挂住
  if (!options.keep) process.on('exit', killAll);

  if (environment.status === 'start') {
    let device;
    try {
      device = await startVDevice({ port: options.port, controlPort: options.controlPort, deviceId: DEVICE_ID, stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (error) {
      console.error(`${TAG} 拉起虚拟下位机失败：${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    handles.bridge = device.bridge;
    handles.sidecar = device.sidecar;
    try {
      await waitForControl(options);
    } catch (error) {
      console.error(`${TAG} ${error instanceof Error ? error.message : String(error)}`);
      if (!options.keep) killAll();
      return 2;
    }
  }

  const ctx = createContext(options);
  const results = [];
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const stamp = timestampOf(startedAt);
  const jsonPath = path.join(ARTIFACT_DIR, `selftest-${stamp}.json`);
  const logPath = path.join(ARTIFACT_DIR, `selftest-${stamp}.log`);
  console.log(`${TAG} artifacts ${path.relative(REPO_ROOT, jsonPath)}`);

  for (const entry of CASES) {
    try {
      await ctx.post('/control/reset');
    } catch (error) {
      results.push({
        id: entry.id,
        name: entry.name,
        ok: false,
        detail: { error: `POST /control/reset 失败：${error instanceof Error ? error.message : String(error)}` },
        durationMs: 0,
      });
      console.log(`FAIL ${entry.id} ${entry.name} reset 失败`);
      continue;
    }
    const result = await runCase(entry, ctx, options.timeoutMs);
    results.push(result);
    const line = `${result.ok ? 'PASS' : 'FAIL'} ${result.id} ${result.name} (${result.durationMs} ms)`;
    console.log(line);
    if (!result.ok) console.log(`     ${result.detail.error}`);
  }

  const passed = results.filter((entry) => entry.ok).length;
  const failed = results.length - passed;
  const finishedAt = new Date();
  const summary = { passed, failed, total: results.length };

  const payload = {
    version: '1.1.0',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    bridgeUrl: options.bridgeUrl,
    controlUrl: `http://127.0.0.1:${options.controlPort}`,
    environment: environment.status,
    reused: environment.status === 'reuse',
    scope: 'protocol-level（非 UI 级；UI 取证见验收文档 A28/A31/A37）',
    summary,
    cases: results,
  };
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const logLines = [
    `# vdevice selftest ${startedAt.toISOString()}`,
    `# bridge ${options.bridgeUrl} control http://127.0.0.1:${options.controlPort} environment=${environment.status}`,
    ...results.map((entry) => `${entry.ok ? 'PASS' : 'FAIL'} ${entry.id} ${entry.name} detail=${JSON.stringify(entry.detail)}`),
    `SUMMARY passed=${passed} failed=${failed}`,
  ];
  writeFileSync(logPath, `${logLines.join('\n')}\n`, 'utf8');

  if (!options.keep) killAll();
  else {
    handles.bridge?.unref();
    handles.sidecar?.unref();
    console.log(`${TAG} --keep：bridge pid=${handles.bridge?.pid ?? '-'} sidecar pid=${handles.sidecar?.pid ?? '-'}`);
  }
  console.log(`SUMMARY passed=${passed} failed=${failed}`);
  return failed === 0 ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`${TAG} 自检脚本异常：${error instanceof Error ? error.stack : String(error)}`);
      process.exitCode = 1;
    });
}
