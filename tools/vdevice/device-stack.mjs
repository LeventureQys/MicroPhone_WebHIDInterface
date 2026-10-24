/**
 * 设备侧参数协议栈：寄存器文件 + 0x10/0x11/0x12/0x13 应答 + ACK。
 *
 * 独立实现：与上位机 src/renderer/src/device/proto/** 互为对拍（两侧各写一遍 CRC 与组帧，任何一边写错，
 * 另一边的单测就会红）。本文件是纯逻辑，不碰 WS / HTTP / 文件系统，回执一律从构造参数 onReplies 交出。
 */

export const MODE_APP = 'app';
export const MODE_BOOTLOADER = 'bootloader';
/** 设备 → 主机方向使用的报告（63 B 载荷，见需求 §3.2） */
export const REPORT_ID_IN = 0x11;
export const PAYLOAD_BYTES = 63;
export const MAX_FRAME_BYTES = 512;

export const ACK_NO_ERR = 0x0000;
export const ACK_DEV_ADDR_ERR = 0x0001;
export const ACK_LEN_ERR = 0x0002;
export const ACK_CHECKSUM_ERR = 0x0003;
export const ACK_READ_ONLY_ERR = 0x0004;
export const ACK_DATA_ERR = 0x0005;

/** 电平是实时量：写入忽略、读取给当前值（P11） */
export const LEVEL_ADDR = 0x2057;
/** 写 1 进 DFU（P10） */
export const ENTER_DFU_ADDR = 0x1008;
export const PRESET_START = 0x2000;
export const PRESET_END = 0x2071;

const UNIT_ID = 0x00;
const FUNC_ACK = 0x02;
const FUNC_RAND_WRITE = 0x10;
const FUNC_SEQ_WRITE = 0x11;
const FUNC_RAND_READ = 0x12;
const FUNC_SEQ_READ = 0x13;

const ACCESS_READ = 'r';
const ACCESS_RW = 'rw';
const ACCESS_NONE = 'none';
const WORD_MAX = 0xffff;

function spec(region, addr, field, rawMin, rawMax, access, kind, defaultRaw) {
  return Object.freeze({ region, addr, field, rawMin, rawMax, access, kind, defaultRaw });
}

function asciiWordRows(base, count, prefix) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(spec('info', base + index, `${prefix}${index + 1}`, 0, WORD_MAX, ACCESS_READ, 'string', 0));
  }
  return rows;
}

/** 设备信息 0x0000–0x003D（62 项，全部只读） */
function infoRows() {
  const rows = [...asciiWordRows(0x0000, 3, 'mc'), ...asciiWordRows(0x0003, 8, 'dn')];
  const scalars = [
    ['fwX', 1],
    ['fwY', 0],
    ['fwZ', 0],
    ['fwBuild', 0],
    ['fwType', 1],
    ['dsp1X', 1],
    ['dsp1Y', 0],
    ['dsp1Z', 0],
    ['dsp2X', 1],
    ['dsp2Y', 0],
    ['dsp2Z', 0],
    ['vid', 0x0a67],
    ['pid', 0x0010],
    ['dateY', 2027],
    ['dateM', 1],
    ['dateD', 1],
    ['timeH', 0],
    ['timeM', 0],
    ['timeS', 0],
  ];
  scalars.forEach(([field, defaultRaw], index) => {
    rows.push(spec('info', 0x000b + index, field, 0, WORD_MAX, ACCESS_READ, 'scalar', defaultRaw));
  });
  rows.push(...asciiWordRows(0x001e, 32, 'sn'));
  return rows;
}

/** 设备配置 0x1000–0x100D（14 项）；access 为 none 的行本版本不参与读写，写入按只读处理 */
function configRows() {
  return [
    spec('config', 0x1000, 'heartbeat', 0, WORD_MAX, ACCESS_NONE, 'scalar', 700),
    spec('config', 0x1001, 'unitAddr', 0, WORD_MAX, ACCESS_RW, 'scalar', 0),
    spec('config', 0x1002, 'presetCount', 0, WORD_MAX, ACCESS_NONE, 'scalar', 1),
    spec('config', 0x1003, 'startupNo', 0, WORD_MAX, ACCESS_NONE, 'scalar', 1),
    spec('config', 0x1004, 'saveNo', 0, WORD_MAX, ACCESS_NONE, 'scalar', 1),
    spec('config', 0x1005, 'loadNo', 0, WORD_MAX, ACCESS_NONE, 'scalar', 1),
    spec('config', 0x1006, 'deleteNo', 0, WORD_MAX, ACCESS_NONE, 'scalar', 0),
    spec('config', 0x1007, 'comErrAck', 1, 5, ACCESS_READ, 'scalar', 0),
    spec('config', 0x1008, 'enterDfu', 0, WORD_MAX, ACCESS_RW, 'scalar', 0),
    spec('config', 0x1009, 'reinit', 0, WORD_MAX, ACCESS_NONE, 'scalar', 0),
    spec('config', 0x100a, 'factoryReset', 0, WORD_MAX, ACCESS_NONE, 'scalar', 0),
    spec('config', 0x100b, 'syncFlag', 0, 1, ACCESS_NONE, 'scalar', 0),
    spec('config', 0x100c, 'sysErr1', 0, WORD_MAX, ACCESS_READ, 'scalar', 0),
    spec('config', 0x100d, 'sysErr2', 0, WORD_MAX, ACCESS_READ, 'scalar', 0),
  ];
}

const EQ_BAND_DEFAULTS = [
  { type: 4, freq: 50, q: 7 },
  { type: 3, freq: 20000, q: 7 },
  { type: 0, freq: 215, q: 8 },
  { type: 0, freq: 1000, q: 15 },
  { type: 0, freq: 2000, q: 10 },
  { type: 0, freq: 5000, q: 10 },
  { type: 0, freq: 10000, q: 7 },
];

/**
 * 当前预设 0x2000–0x2071（114 项）。
 * rawMin/rawMax 是原始值边界：需求附录 B.3 给的是工程量范围，这里按 A.5 标定式反算后取整。
 */
function presetRows() {
  const rows = [
    spec('preset', 0x2000, 'checksum', 0, WORD_MAX, ACCESS_READ, 'checksum', 0),
    spec('preset', 0x2001, 'validFlag', 0, 1, ACCESS_RW, 'scalar', 1),
  ];
  for (let index = 0; index < 32; index += 1) {
    rows.push(spec('preset', 0x2002 + index, `presetName${index + 1}`, 0, WORD_MAX, ACCESS_RW, 'string', 0));
  }
  rows.push(
    spec('preset', 0x2022, 'mute', 0, 1, ACCESS_RW, 'scalar', 0),
    spec('preset', 0x2023, 'micGain', 0, 100, ACCESS_READ, 'scalar', 100),
    spec('preset', 0x2024, 'encOnOff', 0, 1, ACCESS_RW, 'scalar', 0),
    spec('preset', 0x2025, 'encLevel', 0, 3, ACCESS_RW, 'scalar', 0),
    spec('preset', 0x2026, 'eqMode', 0, 4, ACCESS_RW, 'scalar', 1),
  );
  EQ_BAND_DEFAULTS.forEach((band, index) => {
    const base = 0x2027 + index * 5;
    rows.push(
      spec('preset', base, `band${index + 1}.enable`, 0, 1, ACCESS_RW, 'scalar', 1),
      spec('preset', base + 1, `band${index + 1}.type`, 0, 4, ACCESS_RW, 'scalar', band.type),
      spec('preset', base + 2, `band${index + 1}.freq`, 20, 20000, ACCESS_RW, 'scalar', band.freq),
      spec('preset', base + 3, `band${index + 1}.gain`, 0, 440, ACCESS_RW, 'scalar', 320),
      spec('preset', base + 4, `band${index + 1}.q`, 1, 120, ACCESS_RW, 'scalar', band.q),
    );
  });
  rows.push(
    spec('preset', 0x204a, 'compEnable', 0, 1, ACCESS_RW, 'scalar', 0),
    spec('preset', 0x204b, 'compMakeUpGain', 0, 600, ACCESS_RW, 'scalar', 0),
    spec('preset', 0x204c, 'compThreshold', 0, 600, ACCESS_RW, 'scalar', 580),
    spec('preset', 0x204d, 'compAttack', 1, 2000, ACCESS_RW, 'scalar', 5),
    spec('preset', 0x204e, 'compRelease', 50, 20000, ACCESS_RW, 'scalar', 1000),
    spec('preset', 0x204f, 'compRate', 10, 1000, ACCESS_RW, 'scalar', 60),
    spec('preset', 0x2050, 'compKneeWidth', 0, 600, ACCESS_RW, 'scalar', 10),
    spec('preset', 0x2051, 'limitEnable', 0, 1, ACCESS_RW, 'scalar', 0),
    spec('preset', 0x2052, 'limitPreGain', 0, 0, ACCESS_NONE, 'reserved', 0),
    spec('preset', 0x2053, 'limitThreshold', 0, 600, ACCESS_RW, 'scalar', 580),
    spec('preset', 0x2054, 'limitAttack', 1, 2000, ACCESS_RW, 'scalar', 5),
    spec('preset', 0x2055, 'limitRelease', 50, 20000, ACCESS_RW, 'scalar', 500),
    spec('preset', 0x2056, 'limitRate', 0, 0, ACCESS_NONE, 'reserved', 0),
    spec('preset', LEVEL_ADDR, 'micLevel', 0, 256, ACCESS_READ, 'live', 0),
    spec('preset', 0x2058, 'micSigMute', 0, 1, ACCESS_RW, 'scalar', 0),
    spec('preset', 0x2059, 'hpOnOff', 0, 1, ACCESS_RW, 'scalar', 1),
    spec('preset', 0x205a, 'hpGain', 0, 100, ACCESS_READ, 'scalar', 100),
    spec('preset', 0x205b, 'noisegateThresholdDb', 0, 91, ACCESS_RW, 'scalar', 0),
    spec('preset', 0x205c, 'noisegateRatio', 50, 999, ACCESS_RW, 'scalar', 50),
    spec('preset', 0x205d, 'noisegateAttackMs', 5, 500, ACCESS_RW, 'scalar', 5),
    spec('preset', 0x205e, 'noisegateReleaseMs', 5, 500, ACCESS_RW, 'scalar', 5),
    spec('preset', 0x205f, 'noisegateKneeWidthDb', 6, 12, ACCESS_RW, 'scalar', 6),
    spec('preset', 0x2060, 'noisegateHpFreq', 60, 200, ACCESS_RW, 'scalar', 60),
    spec('preset', 0x2061, 'drc3Fc1', 50, 10000, ACCESS_RW, 'scalar', 50),
    spec('preset', 0x2062, 'drc3Fc2', 50, 10000, ACCESS_RW, 'scalar', 50),
  );
  const zones = [
    { base: 0x2063, name: 'drc3Low' },
    { base: 0x2068, name: 'drc3High' },
    { base: 0x206d, name: 'drc3Mid' },
  ];
  for (const zone of zones) {
    rows.push(
      spec('preset', zone.base, `${zone.name}PreGain`, 0, 400, ACCESS_RW, 'scalar', 0),
      spec('preset', zone.base + 1, `${zone.name}Threshold`, 0, 800, ACCESS_RW, 'scalar', 0),
      spec('preset', zone.base + 2, `${zone.name}AttackTime`, 1, 400, ACCESS_RW, 'scalar', 1),
      spec('preset', zone.base + 3, `${zone.name}ReleaseTime`, 5, 680, ACCESS_RW, 'scalar', 5),
      spec('preset', zone.base + 4, `${zone.name}Ratio`, 10, 200, ACCESS_RW, 'scalar', 1),
    );
  }
  return rows;
}

const SPECS = Object.freeze([...infoRows(), ...configRows(), ...presetRows()]);
const SPEC_BY_ADDR = new Map(SPECS.map((entry) => [entry.addr, entry]));

const SHIPPED_IDENTITY = Object.freeze({
  modelCode: 'JYM001',
  deviceName: 'MIC M001',
  serial: 'VHID-MIC-M001',
});

function writeAsciiWords(target, base, count, text) {
  const bytes = new Uint8Array(count * 2);
  for (let index = 0; index < text.length && index < bytes.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0x7f;
  }
  for (let index = 0; index < count; index += 1) {
    target.set(base + index, (bytes[index * 2] << 8) | bytes[index * 2 + 1]);
  }
}

function readAsciiWords(registers, base, count) {
  let text = '';
  for (let index = 0; index < count; index += 1) {
    const word = registers.get(base + index) ?? 0;
    const high = (word >> 8) & 0xff;
    const low = word & 0xff;
    if (high === 0) return text;
    text += String.fromCharCode(high);
    if (low === 0) return text;
    text += String.fromCharCode(low);
  }
  return text;
}

function applyInfo(registers, info) {
  if (typeof info.modelCode === 'string') writeAsciiWords(registers, 0x0000, 3, info.modelCode);
  if (typeof info.deviceName === 'string') writeAsciiWords(registers, 0x0003, 8, info.deviceName);
  if (typeof info.serial === 'string') writeAsciiWords(registers, 0x001e, 32, info.serial);
  if (Number.isInteger(info.vid)) registers.set(0x0016, info.vid & WORD_MAX);
  if (Number.isInteger(info.pid)) registers.set(0x0017, info.pid & WORD_MAX);
  const firmware = info.firmware;
  if (!firmware) return;
  const layout = { x: 0x000b, y: 0x000c, z: 0x000d, build: 0x000e, type: 0x000f };
  for (const [field, addr] of Object.entries(layout)) {
    if (Number.isInteger(firmware[field])) registers.set(addr, firmware[field] & WORD_MAX);
  }
}

function concatBytes(left, right) {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

/** Modbus CRC-16：初值 0xFFFF，多项式 0xA001，发送时低字节在前（需求附录 A.1 / 设计文档 §6.1） */
export function crc16(bytes) {
  let crc = 0xffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return crc & 0xffff;
}

/** 组一帧：UnitID | Func | LenHi | LenLo | Data | CRCLo | CRCHi；Len 是整帧字节数 */
export function buildFrame(func, data) {
  const payload = data ? Uint8Array.from(data) : new Uint8Array(0);
  const frame = new Uint8Array(payload.length + 6);
  frame[0] = UNIT_ID;
  frame[1] = func & 0xff;
  frame[2] = (frame.length >> 8) & 0xff;
  frame[3] = frame.length & 0xff;
  frame.set(payload, 4);
  const crc = crc16(frame.subarray(0, frame.length - 2));
  frame[frame.length - 2] = crc & 0xff;
  frame[frame.length - 1] = (crc >> 8) & 0xff;
  return frame;
}

/** 切 63 B 报告载荷，右侧补 0x00；不补 0xFF/0xC4（设计文档 §5.1） */
export function splitReports(bytes) {
  const reports = [];
  for (let offset = 0; offset < bytes.length; offset += PAYLOAD_BYTES) {
    const chunk = new Uint8Array(PAYLOAD_BYTES);
    chunk.set(bytes.subarray(offset, offset + PAYLOAD_BYTES));
    reports.push(chunk);
  }
  return reports;
}

/** 预设区 114 项 + 设备信息 62 项 + 设备配置 14 项 = 190 项默认原始值 */
export function defaultRegisters() {
  const registers = new Map();
  for (const entry of SPECS) registers.set(entry.addr, entry.defaultRaw);
  writeAsciiWords(registers, 0x0000, 3, SHIPPED_IDENTITY.modelCode);
  writeAsciiWords(registers, 0x0003, 8, SHIPPED_IDENTITY.deviceName);
  writeAsciiWords(registers, 0x001e, 32, SHIPPED_IDENTITY.serial);
  return registers;
}

export class ParamStack {
  #mode = MODE_APP;
  #registers;
  #timers;
  #now;
  #onReplies;
  #hooks;
  #buffer = new Uint8Array(0);
  #dfuRequested = false;
  #framesIn = 0;
  #framesOut = 0;
  #byFunc = new Map();
  #unknownFunc = 0;
  #rejectedReadOnly = 0;
  #rejectedRange = 0;

  constructor(opts) {
    if (!opts || typeof opts.onReplies !== 'function') {
      throw new TypeError('ParamStack requires opts.onReplies(reports)');
    }
    this.#registers = opts.registers instanceof Map ? new Map(opts.registers) : defaultRegisters();
    this.#timers = opts.timers ?? { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    this.#now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.#onReplies = opts.onReplies;
    this.#hooks = opts.hooks ?? {};
    if (opts.info) applyInfo(this.#registers, opts.info);
  }

  get mode() {
    return this.#mode;
  }

  /** 注入的定时器：2.2 的延迟类故障复用同一套，单测可替换成假时钟 */
  get timers() {
    return this.#timers;
  }

  setMode(mode) {
    if (mode !== MODE_APP && mode !== MODE_BOOTLOADER) throw new RangeError(`unknown mode ${mode}`);
    this.#mode = mode;
    this.#buffer = new Uint8Array(0);
  }

  feed(payload) {
    if (this.#mode !== MODE_APP) return;
    const bytes = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
    if (bytes.length === 0) return;
    this.#buffer = concatBytes(this.#buffer, bytes);
    const replies = [];
    this.#drain(replies);
    if (replies.length > 0) this.#publish(replies);
  }

  readRegister(addr) {
    return this.#registers.get(addr);
  }

  writeRegister(addr, raw) {
    this.#registers.set(addr, raw & WORD_MAX);
  }

  snapshot() {
    const out = {};
    for (const [addr, raw] of this.#registers) {
      out[`0x${addr.toString(16).toUpperCase().padStart(4, '0')}`] = raw;
    }
    return out;
  }

  info() {
    const registers = this.#registers;
    return {
      modelCode: readAsciiWords(registers, 0x0000, 3),
      deviceName: readAsciiWords(registers, 0x0003, 8),
      firmware: {
        x: registers.get(0x000b) ?? 0,
        y: registers.get(0x000c) ?? 0,
        z: registers.get(0x000d) ?? 0,
        build: registers.get(0x000e) ?? 0,
        type: registers.get(0x000f) ?? 0,
      },
      vid: registers.get(0x0016) ?? 0,
      pid: registers.get(0x0017) ?? 0,
      serial: readAsciiWords(registers, 0x001e, 32),
    };
  }

  stats() {
    return {
      framesIn: this.#framesIn,
      framesOut: this.#framesOut,
      byFunc: Object.fromEntries(this.#byFunc),
      unknownFunc: this.#unknownFunc,
      rejectedReadOnly: this.#rejectedReadOnly,
      rejectedRange: this.#rejectedRange,
    };
  }

  dfuRequested() {
    return this.#dfuRequested;
  }

  /**
   * 取走一次"进 DFU"请求：读到就清空。
   * 侧车切到 bootloader 后必须消费掉，否则之后每条参数回执都会再触发一次切换。
   */
  takeDfuRequest() {
    const requested = this.#dfuRequested;
    this.#dfuRequested = false;
    return requested;
  }

  reset() {
    this.#buffer = new Uint8Array(0);
  }

  #publish(reports) {
    if (typeof this.#hooks.onReplies === 'function') this.#hooks.onReplies(reports);
    this.#onReplies(reports);
  }

  #pushFrame(replies, func, data) {
    replies.push(...splitReports(buildFrame(func, data)));
    this.#framesOut += 1;
  }

  #pushAck(replies, code) {
    this.#pushFrame(replies, FUNC_ACK, [(code >> 8) & 0xff, code & 0xff]);
  }

  #drain(replies) {
    for (;;) {
      if (this.#buffer.length === 0) return;
      if (this.#buffer.length < 4) {
        // 不足一帧的尾巴只能是填充：整段全 0 就丢掉，否则等下一包补齐头部
        if (this.#buffer.every((byte) => byte === 0)) this.#buffer = new Uint8Array(0);
        return;
      }
      const len = (this.#buffer[2] << 8) | this.#buffer[3];
      if (len === 0) {
        // 报告尾部补 0x00（需求 §3.2）：帧尾之后全是填充，等下一包的新帧
        this.#buffer = new Uint8Array(0);
        return;
      }
      if (len < 6 || len > MAX_FRAME_BYTES) {
        // 帧长字段不可信时已无法再对齐字节流，回长度错并清空累积器
        this.#buffer = new Uint8Array(0);
        this.#pushAck(replies, ACK_LEN_ERR);
        return;
      }
      if (this.#buffer.length < len) return;
      const frame = this.#buffer.subarray(0, len);
      this.#buffer = this.#buffer.subarray(len);
      this.#handleFrame(frame, replies);
    }
  }

  #handleFrame(frame, replies) {
    const len = frame.length;
    this.#framesIn += 1;
    const expected = frame[len - 2] | (frame[len - 1] << 8);
    if (crc16(frame.subarray(0, len - 2)) !== expected) {
      this.#pushAck(replies, ACK_CHECKSUM_ERR);
      return;
    }
    const func = frame[1];
    const hooks = this.#hooks;
    if (typeof hooks.onFrame === 'function') {
      const context = { mode: this.#mode, func, data: Uint8Array.from(frame.subarray(4, len - 2)), len, at: this.#now(), action: 'process' };
      hooks.onFrame(context);
      if (context.action === 'drop') return;
    }
    if (frame[0] !== UNIT_ID) {
      this.#pushAck(replies, ACK_DEV_ADDR_ERR);
      return;
    }
    const isKnown = func === FUNC_RAND_WRITE || func === FUNC_SEQ_WRITE || func === FUNC_RAND_READ || func === FUNC_SEQ_READ;
    if (!isKnown) {
      this.#unknownFunc += 1;
      this.#pushAck(replies, ACK_LEN_ERR);
      return;
    }
    this.#byFunc.set(func, (this.#byFunc.get(func) ?? 0) + 1);
    const data = frame.subarray(4, len - 2);
    if (func === FUNC_RAND_WRITE) this.#writeRandom(data, replies);
    else if (func === FUNC_SEQ_WRITE) this.#writeSequential(data, replies);
    else if (func === FUNC_RAND_READ) this.#readRandom(data, replies);
    else this.#readSequential(data, replies);
  }

  #writeRandom(data, replies) {
    if (data.length === 0 || data.length % 4 !== 0) {
      this.#pushAck(replies, ACK_LEN_ERR);
      return;
    }
    const items = [];
    for (let index = 0; index < data.length; index += 4) {
      items.push({ addr: (data[index] << 8) | data[index + 1], raw: (data[index + 2] << 8) | data[index + 3] });
    }
    this.#commit(items, replies);
  }

  #writeSequential(data, replies) {
    if (data.length < 6) {
      this.#pushAck(replies, ACK_LEN_ERR);
      return;
    }
    const addr = (data[0] << 8) | data[1];
    const count = (data[2] << 8) | data[3];
    if (count === 0 || data.length !== 4 + count * 2) {
      this.#pushAck(replies, ACK_LEN_ERR);
      return;
    }
    const items = [];
    for (let index = 0; index < count; index += 1) {
      items.push({ addr: addr + index, raw: (data[4 + index * 2] << 8) | data[5 + index * 2] });
    }
    this.#commit(items, replies);
  }

  /** 整帧要么全落地要么全不落地：先逐项校验，任一项不合法就只回错误码（P6） */
  #commit(items, replies) {
    const writes = [];
    for (const item of items) {
      const entry = SPEC_BY_ADDR.get(item.addr);
      if (!entry) {
        this.#pushAck(replies, ACK_DEV_ADDR_ERR);
        return;
      }
      if (entry.kind === 'live') continue;
      if (entry.access !== ACCESS_RW) {
        this.#rejectedReadOnly += 1;
        this.#pushAck(replies, ACK_READ_ONLY_ERR);
        return;
      }
      if (item.raw < entry.rawMin || item.raw > entry.rawMax) {
        this.#rejectedRange += 1;
        this.#pushAck(replies, ACK_DATA_ERR);
        return;
      }
      writes.push(item);
    }
    for (const item of writes) this.#registers.set(item.addr, item.raw);
    const dfuHit = writes.some((item) => item.addr === ENTER_DFU_ADDR && item.raw === 1);
    this.#pushAck(replies, ACK_NO_ERR);
    if (dfuHit) this.#dfuRequested = true;
  }

  #readRandom(data, replies) {
    if (data.length === 0 || data.length % 2 !== 0) {
      this.#pushAck(replies, ACK_LEN_ERR);
      return;
    }
    const payload = new Uint8Array(data.length * 2);
    for (let index = 0; index < data.length; index += 2) {
      const addr = (data[index] << 8) | data[index + 1];
      if (!SPEC_BY_ADDR.has(addr)) {
        this.#pushAck(replies, ACK_DEV_ADDR_ERR);
        return;
      }
      const value = this.#registers.get(addr) ?? 0;
      const offset = index * 2;
      payload[offset] = (addr >> 8) & 0xff;
      payload[offset + 1] = addr & 0xff;
      payload[offset + 2] = (value >> 8) & 0xff;
      payload[offset + 3] = value & 0xff;
    }
    this.#pushFrame(replies, FUNC_RAND_READ, payload);
  }

  #readSequential(data, replies) {
    if (data.length !== 4) {
      this.#pushAck(replies, ACK_LEN_ERR);
      return;
    }
    const addr = (data[0] << 8) | data[1];
    const count = (data[2] << 8) | data[3];
    if (count === 0) {
      this.#pushAck(replies, ACK_LEN_ERR);
      return;
    }
    const payload = new Uint8Array(4 + count * 2);
    payload[0] = data[0];
    payload[1] = data[1];
    payload[2] = data[2];
    payload[3] = data[3];
    for (let index = 0; index < count; index += 1) {
      const current = addr + index;
      if (!SPEC_BY_ADDR.has(current)) {
        this.#pushAck(replies, ACK_DEV_ADDR_ERR);
        return;
      }
      const value = this.#registers.get(current) ?? 0;
      payload[4 + index * 2] = (value >> 8) & 0xff;
      payload[5 + index * 2] = value & 0xff;
    }
    this.#pushFrame(replies, FUNC_SEQ_READ, payload);
  }
}
