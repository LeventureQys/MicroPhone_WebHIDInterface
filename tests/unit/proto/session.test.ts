import { describe, expect, it } from 'vitest';
import { PAYLOAD_BYTES, splitFrame } from '../../../src/renderer/src/device/protocol';
import {
  ACK_CHECKSUM_ERR,
  ACK_DATA_ERR,
  ACK_DEV_ADDR_ERR,
  ACK_NO_ERR,
  ACK_READ_ONLY_ERR,
  encodeAck,
  encodeRandWrite,
  encodeSeqWrite,
  type AckCode,
} from '../../../src/renderer/src/device/proto/codec';
import {
  FUNC_ACK,
  FUNC_RAND_READ,
  FUNC_RAND_WRITE,
  FUNC_SEQ_READ,
  FUNC_SEQ_WRITE,
  decodeStream,
  encodeFrame,
  type ParamFrame,
} from '../../../src/renderer/src/device/proto/frame';
import {
  LEVEL_ADDR,
  PRESET_COUNT,
  PRESET_START,
  encodeAsciiWords,
} from '../../../src/renderer/src/device/registers';
import {
  ParamSession,
  levelToDb,
  type DiagEntry,
  type SessionPhase,
  type TransportError,
} from '../../../src/renderer/src/device/proto/session';
import { TIMING, type Clock, type Timers } from '../../../src/renderer/src/device/proto/timing';

/** S-e 随机读的 46 个地址（主 Agent 裁定 R-13）；刻意内联，避免与实现同源自证 */
const EXPECTED_SYNC_INFO_ADDRS: readonly number[] = [
  0x0000, 0x0001, 0x0002, 0x0003, 0x0004, 0x0005,
  0x000b, 0x000c, 0x000d, 0x000e, 0x000f,
  0x0016, 0x0017,
  0x001e, 0x001f, 0x0020, 0x0021, 0x0022, 0x0023, 0x0024, 0x0025, 0x0026, 0x0027,
  0x0028, 0x0029, 0x002a, 0x002b, 0x002c, 0x002d, 0x002e, 0x002f, 0x0030, 0x0031,
  0x0032, 0x0033, 0x0034, 0x0035, 0x0036, 0x0037, 0x0038, 0x0039, 0x003a, 0x003b,
  0x003c, 0x003d,
  0x1007,
];

// ---- 假时钟（C8：不 sleep，全部用假时钟推进） ----

class FakeClock implements Clock {
  private t = 0;

  now(): number {
    return this.t;
  }

  set(value: number): void {
    this.t = value;
  }
}

class FakeTimers implements Timers {
  private seq = 0;
  private readonly tasks = new Map<number, { at: number; fn: () => void }>();

  constructor(private readonly clock: FakeClock) {}

  setTimeout(fn: () => void, ms: number): unknown {
    this.seq += 1;
    this.tasks.set(this.seq, { at: this.clock.now() + Math.max(0, ms), fn });
    return this.seq;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  get pending(): number {
    return this.tasks.size;
  }

  /** 按到期时间（同刻按登记顺序）逐个执行，时钟停在该定时器的到期时刻 */
  advance(ms: number): void {
    const target = this.clock.now() + ms;
    for (;;) {
      let chosen = -1;
      let chosenAt = Number.POSITIVE_INFINITY;
      for (const [id, task] of this.tasks) {
        if (task.at > target) continue;
        if (task.at < chosenAt || (task.at === chosenAt && (chosen < 0 || id < chosen))) {
          chosen = id;
          chosenAt = task.at;
        }
      }
      if (chosen < 0) break;
      const task = this.tasks.get(chosen);
      this.tasks.delete(chosen);
      if (task === undefined) break;
      this.clock.set(task.at);
      task.fn();
    }
    this.clock.set(Math.max(this.clock.now(), target));
  }
}

// ---- 假设备：记录 63 B 报告、解析请求帧、按寄存器模型造应答 ----

interface FakeDeviceOptions {
  readonly autoReply?: boolean;
}

class FakeDevice {
  readonly reports: Uint8Array[] = [];
  readonly requests: ParamFrame[] = [];
  readonly registers = new Map<number, number>();
  autoReply: boolean;
  /** 返回 true 表示丢弃该请求的应答（模拟丢帧）；序号 = 收到的请求帧序号 */
  dropReply: ((index: number) => boolean) | null = null;
  /** 非 null 时所有写应答都用这个 ACK 码（模拟设备报错） */
  ackOverride: AckCode | null = null;
  /** 按请求序号给出写应答的 ACK 码，优先于 `ackOverride`（模拟"前两次报错、第三次成功"） */
  ackFor: ((index: number) => AckCode) | null = null;
  /** 返回 true 表示该地址不在随机读应答里（模拟设备少回字段） */
  omitRandomRead: ((addr: number) => boolean) | null = null;
  /** 返回非 null 时用该 ACK 码代替读响应（模拟设备用 `0x02` 拒绝读请求，新 S-h） */
  readAckFor: ((index: number) => AckCode | null) | null = null;

  private readonly pendingReply: Uint8Array[] = [];
  private inbound: Uint8Array = new Uint8Array(0);
  private readonly onInput: (bytes: Uint8Array) => void;

  constructor(onInput: (bytes: Uint8Array) => void, options: FakeDeviceOptions = {}) {
    this.onInput = onInput;
    this.autoReply = options.autoReply ?? true;
  }

  send = (reports: readonly Uint8Array[]): void => {
    for (const report of reports) this.feed(report);
  };

  /** 逐条投递一条挂起的应答；用于断言"收到应答后才会发下一帧" */
  deliverOne(): boolean {
    const reply = this.pendingReply.shift();
    if (reply === undefined) return false;
    this.deliver(reply);
    return true;
  }

  deliverAll(): void {
    while (this.deliverOne()) {
      /* 逐条投递：每次投递可能触发下一帧请求 */
    }
  }

  private feed(report: Uint8Array): void {
    this.reports.push(report.slice());
    const merged = new Uint8Array(this.inbound.length + report.length);
    merged.set(this.inbound, 0);
    merged.set(report, this.inbound.length);
    const result = decodeStream(merged);
    this.inbound = result.rest;
    for (const frame of result.frames) this.handle(frame);
  }

  private handle(frame: ParamFrame): void {
    const index = this.requests.length;
    this.requests.push(frame);
    const reply = this.replyTo(frame, index);
    if (reply === null) return;
    if (this.dropReply?.(index) === true) return;
    if (this.autoReply) this.deliver(reply);
    else this.pendingReply.push(reply);
  }

  private deliver(reply: Uint8Array): void {
    for (const report of splitFrame(reply, PAYLOAD_BYTES)) this.onInput(report);
  }

  private word(data: Uint8Array, offset: number): number {
    return ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0);
  }

  private replyTo(frame: ParamFrame, index: number): Uint8Array | null {
    const data = frame.data;
    switch (frame.func) {
      case FUNC_SEQ_READ: {
        const readAck = this.readAckFor?.(index) ?? null;
        if (readAck !== null) return encodeFrame(FUNC_ACK, encodeAck(readAck));
        const start = this.word(data, 0);
        const count = this.word(data, 2);
        const values: number[] = [];
        for (let index = 0; index < count; index += 1) values.push(this.registers.get(start + index) ?? 0);
        return encodeFrame(FUNC_SEQ_READ, encodeSeqWrite(start, values));
      }
      case FUNC_RAND_READ: {
        const readAck = this.readAckFor?.(index) ?? null;
        if (readAck !== null) return encodeFrame(FUNC_ACK, encodeAck(readAck));
        const entries: { addr: number; raw: number }[] = [];
        for (let offset = 0; offset + 1 < data.length; offset += 2) {
          const addr = this.word(data, offset);
          if (this.omitRandomRead?.(addr) === true) continue;
          entries.push({ addr, raw: this.registers.get(addr) ?? 0 });
        }
        return encodeFrame(FUNC_RAND_READ, encodeRandWrite(entries));
      }
      case FUNC_SEQ_WRITE: {
        const start = this.word(data, 0);
        const count = this.word(data, 2);
        for (let index = 0; index < count; index += 1) {
          this.registers.set(start + index, this.word(data, 4 + index * 2));
        }
        return this.ackReply(index);
      }
      case FUNC_RAND_WRITE: {
        for (let offset = 0; offset + 3 < data.length; offset += 4) {
          this.registers.set(this.word(data, offset), this.word(data, offset + 2));
        }
        return this.ackReply(index);
      }
      default:
        return null;
    }
  }

  private ackReply(index: number): Uint8Array {
    const code = this.ackFor?.(index) ?? this.ackOverride ?? ACK_NO_ERR;
    return encodeFrame(FUNC_ACK, encodeAck(code));
  }
}

// ---- 夹具 ----

interface HarnessEvents {
  readonly phases: SessionPhase[];
  readonly errors: TransportError[];
  readonly diags: DiagEntry[];
  readonly levels: { raw: number; at: number }[];
  readonly echoes: [number, number][];
  stats: number;
  sends: number;
}

interface Harness {
  readonly clock: FakeClock;
  readonly timers: FakeTimers;
  readonly device: FakeDevice;
  readonly session: ParamSession;
  readonly events: HarnessEvents;
}

function createHarness(options: {
  readonly autoReply?: boolean;
  readonly timing?: Partial<typeof TIMING>;
  readonly ringSize?: number;
} = {}): Harness {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const events: HarnessEvents = {
    phases: [],
    errors: [],
    diags: [],
    levels: [],
    echoes: [],
    stats: 0,
    sends: 0,
  };
  let session!: ParamSession;
  const device = new FakeDevice((bytes) => session.handleBytes(bytes), {
    autoReply: options.autoReply,
  });
  session = new ParamSession({
    send: (reports) => {
      events.sends += 1;
      device.send(reports);
    },
    clock,
    timers,
    timing: options.timing,
    ringSize: options.ringSize,
    onPhase: (phase) => events.phases.push(phase),
    onError: (error) => events.errors.push(error),
    onDiag: (entry) => events.diags.push(entry),
    onLevel: (sample) => events.levels.push({ raw: sample.raw, at: sample.at }),
    onEcho: (addr, raw) => events.echoes.push([addr, raw]),
    onStats: () => {
      events.stats += 1;
    },
  });
  return { clock, timers, device, session, events };
}

/** 假设备的设备信息区（寄存器表 §B.1 的布局） */
function seedDeviceInfo(device: FakeDevice): void {
  const put = (start: number, words: readonly number[]): void => {
    words.forEach((word, index) => device.registers.set(start + index, word));
  };
  put(0x0000, encodeAsciiWords('JYM001', 3));
  put(0x0003, encodeAsciiWords('M001', 2));
  put(0x000b, [1, 0, 0, 0]);
  device.registers.set(0x000f, 1);
  device.registers.set(0x0016, 2663);
  device.registers.set(0x0017, 16);
  put(0x001e, encodeAsciiWords('VHID-MIC-M001', 32));
  device.registers.set(0x1007, 0);
}

/** 推进假时钟直到没有待触发的定时器（重试都在假时钟里跑完） */
function settle(harness: Harness): void {
  for (let step = 0; step < 200 && harness.timers.pending > 0; step += 1) {
    harness.timers.advance(TIMING.requestTimeoutMs);
  }
}

function diagOf(harness: Harness, dir: 'out' | 'in'): DiagEntry[] {
  return harness.session.diagnostics().filter((entry) => entry.dir === dir);
}

/** 期望 Promise 失败并取回 `Error(name='TransportError')`；成功则抛断言错误 */
async function failureOf(pending: Promise<unknown>): Promise<Error & { transportError?: TransportError }> {
  const outcome = await pending.then(
    () => null,
    (reason: unknown) => reason as Error & { transportError?: TransportError },
  );
  if (outcome === null) throw new Error('期望请求失败，但 Promise 成功了');
  return outcome;
}

const VOLATILE_ADDRS = [0x2024, 0x2026, 0x2028, 0x202a, 0x202c, 0x202e, 0x2030, 0x2032, 0x2034, 0x2036];

// ---- 用例 ----

describe('S-a 唯一在途槽 / R3-1 严格串行', () => {
  it('连续写 10 个地址：回执前永远只有一帧在途，写完队列为空', () => {
    const harness = createHarness({ autoReply: false });
    VOLATILE_ADDRS.forEach((addr, index) => harness.session.write([{ addr, raw: index + 1 }]));
    harness.timers.advance(TIMING.writeThrottleMs);

    expect(harness.device.requests).toHaveLength(1);

    for (let sent = 1; sent <= VOLATILE_ADDRS.length; sent += 1) {
      expect(harness.device.requests).toHaveLength(sent);
      expect(harness.session.stats().queueDepth).toBe(VOLATILE_ADDRS.length - sent);
      expect(harness.device.deliverOne()).toBe(true);
    }

    const written = harness.device.requests.map((frame) => (frame.data[0] << 8) | frame.data[1]);
    expect(written).toEqual(VOLATILE_ADDRS);
    expect(harness.session.stats().queueDepth).toBe(0);
    expect(harness.session.stats().outFrames).toBe(VOLATILE_ADDRS.length);
    expect(harness.events.errors).toHaveLength(0);
  });
});

describe('S-c 重试 / R3-2 30% 丢帧', () => {
  it('30% 丢帧下靠重试全部写成功，寄存器模型与最后一次值一致', () => {
    const harness = createHarness();
    // 30% 的请求序号丢应答：0/3/6 (mod 10) 间隔 3、3、4，保证同一请求不会连续丢 3 次
    harness.device.dropReply = (index) => index % 10 === 0 || index % 10 === 3 || index % 10 === 6;

    const expected = new Map<number, number>();
    VOLATILE_ADDRS.forEach((addr, index) => {
      const raw = 100 + index;
      expected.set(addr, raw);
      harness.session.write([{ addr, raw }]);
    });
    settle(harness);

    for (const [addr, raw] of expected) expect(harness.device.registers.get(addr)).toBe(raw);
    expect(harness.session.stats().retries).toBeGreaterThan(0);
    expect(harness.session.stats().outFrames).toBeGreaterThan(VOLATILE_ADDRS.length);
    expect(harness.session.stats().queueDepth).toBe(0);
    expect(harness.session.phase()).not.toBe('error');
    expect(harness.events.errors).toHaveLength(0);
  });

  it('ACK_CHECKSUM_ERR 可重试：连续两次校验错后第 3 次成功，不进 error', () => {
    const harness = createHarness();
    harness.device.ackFor = (index) => (index < 2 ? ACK_CHECKSUM_ERR : ACK_NO_ERR);

    harness.session.write([{ addr: 0x2024, raw: 1 }]);
    harness.timers.advance(TIMING.writeThrottleMs);

    expect(harness.device.requests).toHaveLength(3);
    expect(harness.session.stats().retries).toBe(2);
    expect(harness.session.stats().outFrames).toBe(3);
    expect(harness.session.phase()).not.toBe('error');
    expect(harness.events.errors).toHaveLength(0);
    expect(harness.device.registers.get(0x2024)).toBe(1);
  });
});

describe('S-c 不重试的错误码 / R3-4', () => {
  it('ACK_READ_ONLY_ERR：不重试、派发 readOnly、phase 保持 ready', async () => {
    const harness = createHarness();
    seedDeviceInfo(harness.device);
    await harness.session.sync();
    const before = harness.device.requests.length;

    harness.device.ackOverride = ACK_READ_ONLY_ERR;
    harness.session.write([{ addr: 0x2024, raw: 1 }]);
    harness.timers.advance(TIMING.writeThrottleMs);

    expect(harness.device.requests).toHaveLength(before + 1);
    expect(harness.events.errors).toHaveLength(1);
    expect(harness.events.errors[0]).toMatchObject({ kind: 'readOnly', ack: ACK_READ_ONLY_ERR });
    expect(harness.session.phase()).toBe('ready');
    expect(harness.session.stats().retries).toBe(0);

    harness.timers.advance(2000);
    expect(harness.device.requests).toHaveLength(before + 1);
    expect(harness.session.stats().timeouts).toBe(0);
  });

  it('ACK_DEV_ADDR_ERR 属于可重试类：三次都错后进 error（kind=addr、retries=2）', () => {
    const harness = createHarness();
    harness.device.ackOverride = ACK_DEV_ADDR_ERR;

    harness.session.write([{ addr: 0x2024, raw: 1 }]);
    harness.timers.advance(TIMING.writeThrottleMs);

    expect(harness.device.requests).toHaveLength(TIMING.requestRetries + 1);
    expect(harness.session.phase()).toBe('error');
    expect(harness.events.errors).toHaveLength(1);
    expect(harness.events.errors[0]).toMatchObject({ kind: 'addr', ack: ACK_DEV_ADDR_ERR });
    expect(harness.session.stats().retries).toBe(TIMING.requestRetries);
    expect(harness.session.stats().outFrames).toBe(TIMING.requestRetries + 1);
  });
});

describe('S-d 三次失败进 error / R3-5', () => {
  it('三次超时：phase=error + onPhase(error) + onError(timeout)，之后 write 只派发一次 disconnected', () => {
    const harness = createHarness({ autoReply: false });
    harness.session.write([{ addr: 0x2024, raw: 1 }]);
    harness.timers.advance(TIMING.writeThrottleMs);
    expect(harness.device.requests).toHaveLength(1);

    harness.timers.advance(TIMING.requestTimeoutMs);
    expect(harness.device.requests).toHaveLength(2);
    harness.timers.advance(TIMING.requestTimeoutMs);
    expect(harness.device.requests).toHaveLength(3);
    expect(harness.session.phase()).not.toBe('error');

    harness.timers.advance(TIMING.requestTimeoutMs);
    expect(harness.session.phase()).toBe('error');
    expect(harness.events.phases).toEqual(['error']);
    expect(harness.events.errors).toHaveLength(1);
    expect(harness.events.errors[0].kind).toBe('timeout');
    expect(harness.session.stats().timeouts).toBe(3);
    expect(harness.session.stats().retries).toBe(2);

    const sentBefore = harness.device.requests.length;
    harness.session.write([{ addr: 0x2024, raw: 2 }]);
    harness.session.write([{ addr: 0x2025, raw: 3 }]);
    harness.timers.advance(5000);

    expect(harness.events.errors).toHaveLength(2);
    expect(harness.events.errors[1].kind).toBe('disconnected');
    expect(harness.device.requests).toHaveLength(sentBefore);
  });

  it('S-j：error 后 sync() 可重连回 ready，read() 在 error 中直接拒绝', async () => {
    const harness = createHarness({ autoReply: false });
    harness.session.write([{ addr: 0x2024, raw: 1 }]);
    harness.timers.advance(TIMING.writeThrottleMs);
    harness.timers.advance(TIMING.requestTimeoutMs * 3);
    expect(harness.session.phase()).toBe('error');

    await expect(harness.session.read([LEVEL_ADDR])).rejects.toThrow(/error/);

    harness.device.autoReply = true;
    seedDeviceInfo(harness.device);
    const result = await harness.session.sync();

    expect(harness.session.phase()).toBe('ready');
    expect(result.preset.start).toBe(PRESET_START);
    expect(result.device.modelCode).toBe('JYM001');
    expect(harness.events.phases).toEqual(['error', 'syncing', 'ready']);
  });
});

describe('S-b 写合并与节流 / R3-6', () => {
  it('2 秒 120 次写：send ≤ 20 次，载荷是窗口内最后一次值', () => {
    const harness = createHarness();
    for (let index = 1; index <= 120; index += 1) {
      harness.session.write([{ addr: 0x2024, raw: index }]);
      harness.timers.advance(16);
    }
    harness.timers.advance(200);

    expect(harness.events.sends).toBeLessThanOrEqual(20);
    expect(harness.events.sends).toBeGreaterThan(0);

    const frames = harness.device.requests;
    expect(frames.length).toBe(harness.events.sends);
    for (const frame of frames) {
      expect(frame.func).toBe(FUNC_RAND_WRITE);
      expect(frame.data).toHaveLength(4);
      expect((frame.data[0] << 8) | frame.data[1]).toBe(0x2024);
    }
    const payloads = frames.map((frame) => (frame.data[2] << 8) | frame.data[3]);
    expect(payloads).toEqual([...payloads].sort((left, right) => left - right));
    expect(payloads[payloads.length - 1]).toBe(120);
    expect(harness.device.registers.get(0x2024)).toBe(120);
  });

  it('同窗口相邻预设地址合成一条 0x11；不相邻地址各走一条 0x10', () => {
    const harness = createHarness();
    harness.session.write([
      { addr: 0x205d, raw: 5 },
      { addr: 0x205e, raw: 10 },
      { addr: 0x205f, raw: 7 },
    ]);
    harness.timers.advance(TIMING.writeThrottleMs);

    expect(harness.device.requests).toHaveLength(1);
    const seq = harness.device.requests[0];
    expect(seq.func).toBe(FUNC_SEQ_WRITE);
    expect((seq.data[0] << 8) | seq.data[1]).toBe(0x205d);
    expect((seq.data[2] << 8) | seq.data[3]).toBe(3);
    const values = [0, 1, 2].map((index) => (seq.data[4 + index * 2] << 8) | seq.data[5 + index * 2]);
    expect(values).toEqual([5, 10, 7]);

    const before = harness.device.requests.length;
    harness.session.write([
      { addr: 0x2024, raw: 1 },
      { addr: 0x2026, raw: 2 },
    ]);
    harness.timers.advance(TIMING.writeThrottleMs);

    const randFrames = harness.device.requests.slice(before);
    expect(randFrames).toHaveLength(2);
    expect(randFrames.every((frame) => frame.func === FUNC_RAND_WRITE)).toBe(true);
    expect(randFrames.map((frame) => (frame.data[0] << 8) | frame.data[1])).toEqual([0x2024, 0x2026]);
  });

  it('同一窗口内同 addr 只发最后值，非预设地址不参与 0x11 合并', () => {
    const harness = createHarness();
    harness.session.write([{ addr: 0x1007, raw: 1 }]);
    harness.session.write([{ addr: 0x1008, raw: 2 }]);
    harness.timers.advance(TIMING.writeThrottleMs);

    const frames = harness.device.requests;
    expect(frames).toHaveLength(2);
    expect(frames.every((frame) => frame.func === FUNC_RAND_WRITE)).toBe(true);
  });
});

describe('S-e 回读 / R4-8', () => {
  it('一条 0x13 读整段预设（丢弃 0x2057）+ 一条 0x12 读 46 个设备信息地址', async () => {
    const harness = createHarness();
    seedDeviceInfo(harness.device);
    harness.device.registers.set(LEVEL_ADDR, 200);
    harness.device.registers.set(0x2001, 1);

    const result = await harness.session.sync();

    expect(harness.device.requests).toHaveLength(2);
    const [presetFrame, infoFrame] = harness.device.requests;

    expect(presetFrame.func).toBe(FUNC_SEQ_READ);
    expect((presetFrame.data[0] << 8) | presetFrame.data[1]).toBe(PRESET_START);
    expect((presetFrame.data[2] << 8) | presetFrame.data[3]).toBe(PRESET_COUNT);

    expect(infoFrame.func).toBe(FUNC_RAND_READ);
    expect(infoFrame.data).toHaveLength(EXPECTED_SYNC_INFO_ADDRS.length * 2);
    const addrs: number[] = [];
    for (let offset = 0; offset + 1 < infoFrame.data.length; offset += 2) {
      addrs.push((infoFrame.data[offset] << 8) | infoFrame.data[offset + 1]);
    }
    expect(addrs).toEqual(EXPECTED_SYNC_INFO_ADDRS);

    expect(result.preset.start).toBe(PRESET_START);
    expect(Object.prototype.hasOwnProperty.call(result.preset.values, LEVEL_ADDR)).toBe(false);
    expect(result.preset.values[0x2001]).toBe(1);
    expect(Object.keys(result.preset.values)).toHaveLength(PRESET_COUNT - 1);
    expect(harness.events.echoes).toHaveLength(PRESET_COUNT - 1);
    expect(harness.events.echoes.every(([addr]) => addr !== LEVEL_ADDR)).toBe(true);
    expect(harness.events.echoes[0][0]).toBe(PRESET_START);

    expect(result.device).toEqual({
      modelCode: 'JYM001',
      deviceName: 'M001',
      firmware: { x: 1, y: 0, z: 0, build: 0 },
      firmwareType: 1,
      vid: 2663,
      pid: 16,
      serial: 'VHID-MIC-M001',
      comErrAck: 0,
    });
    expect(harness.session.phase()).toBe('ready');
    expect(harness.events.phases).toEqual(['syncing', 'ready']);
  });

  it('S-e 容错：设备少回字段时快照取默认 0 / 空串', async () => {
    const harness = createHarness();
    seedDeviceInfo(harness.device);
    harness.device.omitRandomRead = (addr) => addr === 0x0016 || addr === 0x0017 || addr >= 0x001e;

    const result = await harness.session.sync();

    expect(result.device.vid).toBe(0);
    expect(result.device.pid).toBe(0);
    expect(result.device.serial).toBe('');
    expect(result.device.modelCode).toBe('JYM001');
    expect(result.device.firmwareType).toBe(1);
  });

  it('S-e：回读三次超时后 sync() 拒绝，Error 携带 TransportError 且进 error', async () => {
    const harness = createHarness({ autoReply: false });
    const pending = harness.session.sync();

    harness.timers.advance(TIMING.requestTimeoutMs * 3);

    const outcome = await pending.then(
      () => ({ ok: true as const }),
      (reason: unknown) => ({
        ok: false as const,
        reason: reason as Error & { transportError?: TransportError },
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('sync() 不应在三次超时后成功');
    expect(outcome.reason).toBeInstanceOf(Error);
    expect(outcome.reason.name).toBe('TransportError');
    expect(outcome.reason.transportError?.kind).toBe('timeout');
    expect(harness.session.phase()).toBe('error');
    expect(harness.events.errors[0].kind).toBe('timeout');
    expect(harness.session.stats().timeouts).toBe(3);
  });
});

describe('R4-2 回读期间写排队', () => {
  it('回读未完成时只发两条回读帧，回读后写帧按 addr 升序发出', async () => {
    const harness = createHarness({ autoReply: false });
    seedDeviceInfo(harness.device);

    const pendingSync = harness.session.sync();
    expect(harness.device.requests).toHaveLength(1);
    expect(harness.device.requests[0].func).toBe(FUNC_SEQ_READ);

    const addrs = [0x2024, 0x2026, 0x2028];
    addrs.forEach((addr, index) => harness.session.write([{ addr, raw: index + 1 }]));
    harness.timers.advance(TIMING.writeThrottleMs);

    expect(harness.device.requests).toHaveLength(1);
    // 队列里还有第二条回读帧 + 3 条写帧（S-a 的 queueDepth 不含在途）
    expect(harness.session.stats().queueDepth).toBe(4);

    harness.device.deliverOne();
    expect(harness.device.requests).toHaveLength(2);
    expect(harness.device.requests[1].func).toBe(FUNC_RAND_READ);

    harness.device.deliverOne();
    await pendingSync;
    expect(harness.session.phase()).toBe('ready');

    harness.device.deliverAll();
    const writeFrames = harness.device.requests.slice(2);
    expect(writeFrames).toHaveLength(3);
    expect(writeFrames.map((frame) => (frame.data[0] << 8) | frame.data[1])).toEqual(addrs);
    expect(harness.session.stats().queueDepth).toBe(0);
  });
});

describe('S-e × S-f 竞态：sync() 不能丢掉已上总线的请求', () => {
  /** 让 await 链推进到下一次真正发帧的位置 */
  const flushMicrotasks = async (): Promise<void> => {
    for (let round = 0; round < 4; round += 1) await Promise.resolve();
  };

  it('在途轮询的应答不得被新 sync 的 0x13 认领（真机 2026-10-26 第二轮）', async () => {
    const harness = createHarness({ autoReply: false });
    seedDeviceInfo(harness.device);

    const first = harness.session.sync();
    harness.device.deliverOne();
    harness.device.deliverOne();
    await first;
    expect(harness.session.phase()).toBe('ready');

    harness.session.setPolling(true);
    harness.timers.advance(TIMING.pollIntervalMs);
    expect(harness.device.requests).toHaveLength(3);
    const poll = harness.device.requests[2];
    expect(poll.func).toBe(FUNC_RAND_READ);
    expect(poll.data).toHaveLength(2);
    expect(((poll.data[0] << 8) | poll.data[1])).toBe(LEVEL_ADDR);

    const second = harness.session.sync();
    await flushMicrotasks();
    // 关键断言：轮询还挂在总线上时，sync 的 0x13 一条都不能发出去。
    // 修复前这里立刻发 0x13，随后轮询的 0x12 应答被它认领 → sync 以「不是连续读响应」失败。
    expect(harness.device.requests).toHaveLength(3);
    expect(harness.session.phase()).toBe('ready');
    expect(harness.events.levels).toHaveLength(0);

    harness.device.deliverOne(); // 轮询应答：只用来释放槽位，不再回调（老请求已中断）
    await flushMicrotasks();
    expect(harness.events.levels).toHaveLength(0);
    expect(harness.device.requests).toHaveLength(4);
    expect(harness.device.requests[3].func).toBe(FUNC_SEQ_READ);
    expect(harness.session.phase()).toBe('syncing');

    harness.device.deliverOne();
    harness.device.deliverOne();
    await expect(second).resolves.toBeTruthy();
    expect(harness.session.phase()).toBe('ready');

    // 回读完成后轮询重启，电平采样恢复
    harness.timers.advance(TIMING.pollIntervalMs);
    harness.device.deliverOne();
    await flushMicrotasks();
    expect(harness.events.levels).toHaveLength(1);
  });

  it('在途请求超时也不重发：只释放槽位让新 sync 继续', async () => {
    const harness = createHarness({ autoReply: false });
    seedDeviceInfo(harness.device);

    const first = harness.session.sync();
    harness.device.deliverOne();
    harness.device.deliverOne();
    await first;

    harness.device.dropReply = (index) => index === 2; // 轮询应答丢失（第 3 条请求）
    harness.session.setPolling(true);
    harness.timers.advance(TIMING.pollIntervalMs);
    expect(harness.device.requests).toHaveLength(3);

    const second = harness.session.sync();
    await flushMicrotasks();
    expect(harness.device.requests).toHaveLength(3);

    // 轮询应答不来 → 轮询超时（S-f）释放槽位；sync 不得因此重发轮询帧
    harness.timers.advance(TIMING.pollTimeoutMs);
    await flushMicrotasks();
    expect(harness.device.requests).toHaveLength(4);
    expect(harness.device.requests[3].func).toBe(FUNC_SEQ_READ);
    expect(harness.session.stats().retries).toBe(0);

    harness.device.deliverOne();
    harness.device.deliverOne();
    await expect(second).resolves.toBeTruthy();
  });
});

describe('S-f 轮询 / R5-2', () => {
  it('ready 后 1000 ms 内轮询 45…55 次，onLevel 给出原始值', async () => {
    const harness = createHarness();
    seedDeviceInfo(harness.device);
    await harness.session.sync();
    harness.device.registers.set(LEVEL_ADDR, 200);

    const before = harness.device.requests.length;
    harness.session.setPolling(true);
    for (let tick = 0; tick < 50; tick += 1) harness.timers.advance(TIMING.pollIntervalMs);

    const polls = harness.device.requests
      .slice(before)
      .filter((frame) => frame.func === FUNC_RAND_READ && frame.data.length === 2);

    expect(polls.length).toBeGreaterThanOrEqual(45);
    expect(polls.length).toBeLessThanOrEqual(55);
    expect(polls.every((frame) => ((frame.data[0] << 8) | frame.data[1]) === LEVEL_ADDR)).toBe(true);
    expect(harness.events.levels.length).toBe(polls.length);
    expect(harness.events.levels[0]).toEqual({ raw: 200, at: expect.any(Number) });
    expect(harness.session.stats().droppedPolls).toBe(0);
  });

  it('有待发写时节流窗口内轮询让位：不发轮询帧且 droppedPolls+1', async () => {
    const harness = createHarness();
    seedDeviceInfo(harness.device);
    await harness.session.sync();
    harness.session.setPolling(true);

    harness.session.write([{ addr: 0x2024, raw: 1 }]);
    const before = harness.device.requests.length;
    harness.timers.advance(TIMING.pollIntervalMs);

    expect(harness.device.requests).toHaveLength(before);
    expect(harness.session.stats().droppedPolls).toBe(1);
  });

  it('轮询在途超过 pollTimeoutMs：丢弃本次、不重试、不进 error', async () => {
    const harness = createHarness();
    seedDeviceInfo(harness.device);
    await harness.session.sync();
    harness.device.autoReply = false;

    harness.session.setPolling(true);
    const before = harness.device.requests.length;
    harness.timers.advance(TIMING.pollIntervalMs);
    expect(harness.device.requests).toHaveLength(before + 1);

    harness.timers.advance(TIMING.pollTimeoutMs);

    expect(harness.session.stats().droppedPolls).toBeGreaterThanOrEqual(1);
    expect(harness.session.phase()).toBe('ready');
    expect(harness.events.errors).toHaveLength(0);
    expect(harness.session.stats().timeouts).toBe(0);
    expect(harness.session.stats().retries).toBe(0);
  });

  it('setPolling(false) 后不再发轮询帧', async () => {
    const harness = createHarness();
    seedDeviceInfo(harness.device);
    await harness.session.sync();
    harness.session.setPolling(true);
    harness.timers.advance(TIMING.pollIntervalMs * 3);
    const before = harness.device.requests.length;
    harness.session.setPolling(false);
    harness.timers.advance(TIMING.pollIntervalMs * 10);
    expect(harness.device.requests).toHaveLength(before);
  });
});

describe('S-g / S-h / S-i 入站与诊断', () => {
  it('半帧不产出、完整帧产出 1 条 in、补位零不刷 issue', () => {
    const harness = createHarness({ autoReply: false });
    harness.session.write([{ addr: 0x2024, raw: 1 }]);
    harness.timers.advance(TIMING.writeThrottleMs);
    expect(diagOf(harness, 'out')).toHaveLength(1);
    expect(diagOf(harness, 'out')[0].summary).toContain('写 0x2024');

    const ack = encodeFrame(FUNC_ACK, encodeAck(ACK_NO_ERR));
    harness.session.handleBytes(ack.subarray(0, 3));
    expect(harness.session.stats().inFrames).toBe(0);
    expect(diagOf(harness, 'in')).toHaveLength(0);

    harness.session.handleBytes(ack.subarray(3));
    expect(harness.session.stats().inFrames).toBe(1);
    expect(diagOf(harness, 'in')).toHaveLength(1);
    expect(diagOf(harness, 'in')[0].summary).toBe('ACK 0x0000 成功');

    // 第二次写：应答按 63 B 报告补齐 0x00，补位零必须被静默丢掉（R-1）
    harness.session.write([{ addr: 0x2024, raw: 2 }]);
    harness.timers.advance(TIMING.writeThrottleMs);
    const padded = new Uint8Array(PAYLOAD_BYTES);
    padded.set(ack);
    harness.session.handleBytes(padded);

    expect(harness.session.stats().inFrames).toBe(2);
    expect(diagOf(harness, 'in')).toHaveLength(2);
    expect(harness.events.diags.filter((entry) => entry.summary.startsWith('解析告警'))).toHaveLength(0);
    expect(harness.session.stats().crcErrors).toBe(0);
  });

  it('错 CRC 帧：crcErrors+1 且诊断有 error 级条目', () => {
    const harness = createHarness({ autoReply: false });
    const bad = encodeFrame(FUNC_ACK, encodeAck(ACK_NO_ERR));
    bad[bad.length - 1] ^= 0xff;

    harness.session.handleBytes(bad);

    expect(harness.session.stats().crcErrors).toBe(1);
    expect(harness.session.stats().inFrames).toBe(0);
    const errors = harness.session.diagnostics().filter((entry) => entry.level === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].summary).toContain('CRC');
  });

  it('无在途请求时收到帧：记 warn（summary 含 unexpected），不改变 phase', () => {
    const harness = createHarness({ autoReply: false });
    harness.session.handleBytes(encodeFrame(FUNC_ACK, encodeAck(ACK_NO_ERR)));

    const warns = harness.session.diagnostics().filter((entry) => entry.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].summary).toContain('unexpected');
    expect(harness.session.phase()).toBe('idle');
  });

  it('在途为写却收到读响应：记 warn 并丢弃，不改变在途状态', () => {
    const harness = createHarness({ autoReply: false });
    harness.session.write([{ addr: 0x2024, raw: 1 }]);
    harness.timers.advance(TIMING.writeThrottleMs);

    const readReply = encodeFrame(FUNC_RAND_READ, encodeRandWrite([{ addr: LEVEL_ADDR, raw: 128 }]));
    harness.session.handleBytes(readReply);

    const warns = harness.session.diagnostics().filter((entry) => entry.level === 'warn');
    expect(warns.some((entry) => entry.summary.includes('unexpected'))).toBe(true);
    expect(harness.events.levels).toHaveLength(0);
    // 在途仍是写：推进一个请求超时后应重发而不是被读响应"完成"
    harness.timers.advance(TIMING.requestTimeoutMs);
    expect(harness.device.requests).toHaveLength(2);
    expect(harness.session.stats().retries).toBe(1);
  });

  it('设备主动上报 0x2057（0x10 帧）：进电平回调、记 info、不改变 phase', () => {
    const harness = createHarness({ autoReply: false });
    harness.session.handleBytes(encodeFrame(FUNC_RAND_WRITE, encodeRandWrite([{ addr: LEVEL_ADDR, raw: 200 }])));

    expect(harness.events.levels).toHaveLength(1);
    expect(harness.events.levels[0].raw).toBe(200);
    expect(harness.session.phase()).toBe('idle');
    const inbound = diagOf(harness, 'in');
    expect(inbound).toHaveLength(1);
    expect(inbound[0].level).toBe('info');
    expect(inbound[0].summary).toContain('设备上报');
    expect(inbound.some((entry) => entry.summary.includes('unexpected'))).toBe(false);
  });

  it('设备主动上报非电平地址：走 echo，不进电平回调', () => {
    const harness = createHarness({ autoReply: false });
    harness.session.handleBytes(encodeFrame(FUNC_RAND_WRITE, encodeRandWrite([{ addr: 0x2024, raw: 1 }])));

    expect(harness.events.echoes).toEqual([[0x2024, 1]]);
    expect(harness.events.levels).toHaveLength(0);
  });

  it('设备主动上报帧载荷不合法：记 error 诊断，不抛异常', () => {
    const harness = createHarness({ autoReply: false });
    harness.session.handleBytes(encodeFrame(FUNC_RAND_WRITE, Uint8Array.from([0x20, 0x57, 0x01])));

    // 入站帧描述（info）与解析失败（error）各一条：这里只关心后者
    const errors = diagOf(harness, 'in').filter((entry) => entry.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].summary).toContain('格式不符');
    expect(harness.events.levels).toHaveLength(0);
  });

  it('诊断环形缓冲按 ringSize 限长且时间升序', () => {
    const harness = createHarness({ ringSize: 3 });
    for (let index = 0; index < 5; index += 1) {
      harness.session.write([{ addr: 0x2024, raw: index }]);
      harness.timers.advance(TIMING.writeThrottleMs);
    }
    const entries = harness.session.diagnostics();
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.at)).toEqual([...entries.map((entry) => entry.at)].sort((l, r) => l - r));
  });
});

describe('S-h（新口径）0x02 ACK 可终止任何在途请求', () => {
  it('读 + ACK 0x0000：resolve 空结果 { entries: [] }，不伪造地址与值', async () => {
    const harness = createHarness();
    seedDeviceInfo(harness.device);
    await harness.session.sync();
    harness.device.readAckFor = () => ACK_NO_ERR;

    const reply = await harness.session.read([0x2060]);

    expect(reply).toEqual({ entries: [] });
    expect(harness.session.phase()).toBe('ready');
    expect(harness.session.stats().retries).toBe(0);
    expect(harness.events.errors).toHaveLength(0);
  });

  it('读 + ACK 0x0005：reject kind=range、不重试、phase 仍 ready、不派发全局 onError', async () => {
    const harness = createHarness();
    seedDeviceInfo(harness.device);
    await harness.session.sync();
    harness.device.readAckFor = () => ACK_DATA_ERR;
    const before = harness.device.requests.length;

    const failure = await failureOf(harness.session.read([0x2060]));

    expect(harness.device.requests).toHaveLength(before + 1);
    expect(harness.session.stats().retries).toBe(0);
    expect(harness.session.phase()).toBe('ready');
    expect(harness.events.errors).toHaveLength(0);
    expect(failure.name).toBe('TransportError');
    expect(failure.transportError).toMatchObject({ kind: 'range', ack: ACK_DATA_ERR });
  });

  it('读 + ACK 0x0004：reject kind=readOnly、不重试', async () => {
    const harness = createHarness();
    const before = harness.device.requests.length;
    harness.device.readAckFor = () => ACK_READ_ONLY_ERR;

    const failure = await failureOf(harness.session.read([0x2024]));

    expect(harness.device.requests).toHaveLength(before + 1);
    expect(harness.session.stats().retries).toBe(0);
    expect(failure.transportError).toMatchObject({ kind: 'readOnly', ack: ACK_READ_ONLY_ERR });
    expect(harness.events.errors).toHaveLength(0);
  });

  it('读 + ACK 0x0003：重试一次，第二次拿到正常读响应后 resolve', async () => {
    const harness = createHarness({ autoReply: false });
    harness.device.registers.set(LEVEL_ADDR, 200);
    harness.device.readAckFor = (index) => (index === 0 ? ACK_CHECKSUM_ERR : null);

    const pending = harness.session.read([LEVEL_ADDR]);
    expect(harness.device.requests).toHaveLength(1);

    harness.device.deliverOne();
    expect(harness.device.requests).toHaveLength(2);

    harness.device.deliverOne();
    const reply = await pending;

    expect(reply.entries).toEqual([{ addr: LEVEL_ADDR, raw: 200 }]);
    expect(harness.session.stats().retries).toBe(1);
    expect(harness.session.phase()).not.toBe('error');
    expect(harness.events.errors).toHaveLength(0);
  });

  it('读 + 三次 ACK 0x0001：重试 2 次后按 S-d 进 error（kind=addr）', async () => {
    const harness = createHarness();
    harness.device.readAckFor = () => ACK_DEV_ADDR_ERR;

    const failure = await failureOf(harness.session.read([LEVEL_ADDR]));

    expect(harness.device.requests).toHaveLength(TIMING.requestRetries + 1);
    expect(harness.session.stats().retries).toBe(TIMING.requestRetries);
    expect(failure.transportError?.kind).toBe('addr');
    expect(harness.session.phase()).toBe('error');
    expect(harness.events.errors).toHaveLength(1);
  });

  it('S-e：整段回读被 ACK 0x0000 终止 → sync() 拒绝、不伪造快照、落到 error', async () => {
    const harness = createHarness({ autoReply: false });
    harness.device.readAckFor = () => ACK_NO_ERR;

    const pending = harness.session.sync();
    expect(harness.device.requests).toHaveLength(1);

    harness.device.deliverOne();
    const failure = await failureOf(pending);

    expect(failure.transportError?.kind).toBe('len');
    expect(harness.session.phase()).toBe('error');
    expect(harness.events.errors).toHaveLength(1);
    expect(harness.events.echoes).toHaveLength(0);
  });

  it('S-e：整段预设读被 ACK 0x0005 终止 → onError 的 kind 跟随原始错误（range）', async () => {
    const harness = createHarness({ autoReply: false });
    harness.device.readAckFor = () => ACK_DATA_ERR;

    const pending = harness.session.sync();
    expect(harness.device.requests).toHaveLength(1);

    harness.device.deliverOne();
    const failure = await failureOf(pending);

    expect(failure.transportError).toMatchObject({ kind: 'range', ack: ACK_DATA_ERR });
    expect(harness.session.phase()).toBe('error');
    expect(harness.events.errors).toHaveLength(1);
    expect(harness.events.errors[0]).toMatchObject({ kind: 'range', ack: ACK_DATA_ERR });
    expect(harness.events.echoes).toHaveLength(0);
  });

  it('S-e：整段预设读被 ACK 0x0004 终止 → onError 的 kind 是 readOnly', async () => {
    const harness = createHarness({ autoReply: false });
    harness.device.readAckFor = () => ACK_READ_ONLY_ERR;

    const pending = harness.session.sync();
    harness.device.deliverOne();
    await failureOf(pending);

    expect(harness.session.phase()).toBe('error');
    expect(harness.events.errors).toHaveLength(1);
    expect(harness.events.errors[0]).toMatchObject({ kind: 'readOnly', ack: ACK_READ_ONLY_ERR });
  });
});

describe('S-k dispose', () => {
  it('dispose 后推进 10 秒：不再发帧、不再派发任何事件、无残留定时器', async () => {
    const harness = createHarness();
    seedDeviceInfo(harness.device);
    await harness.session.sync();
    harness.session.setPolling(true);
    harness.timers.advance(TIMING.pollIntervalMs * 2);

    const sent = harness.device.requests.length;
    const levels = harness.events.levels.length;

    harness.session.dispose();
    await Promise.resolve();
    const diags = harness.events.diags.length;
    const statsCalls = harness.events.stats;
    const phases = harness.events.phases.length;
    const errors = harness.events.errors.length;

    harness.timers.advance(10_000);

    expect(harness.timers.pending).toBe(0);
    expect(harness.device.requests).toHaveLength(sent);
    expect(harness.events.levels).toHaveLength(levels);
    expect(harness.events.diags).toHaveLength(diags);
    expect(harness.events.stats).toBe(statsCalls);
    expect(harness.events.phases).toHaveLength(phases);
    expect(harness.events.errors).toHaveLength(errors);

    harness.session.write([{ addr: 0x2024, raw: 3 }]);
    harness.session.setPolling(true);
    harness.timers.advance(1000);
    expect(harness.device.requests).toHaveLength(sent);
  });
});

describe('S-l 通道异常隔离', () => {
  it('send 同步抛错：phase=error、onError(disconnected)、不向调用方抛出', () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const phases: SessionPhase[] = [];
    const errors: TransportError[] = [];
    const session = new ParamSession({
      send: () => {
        throw new Error('报告队列已满');
      },
      clock,
      timers,
      onPhase: (phase) => phases.push(phase),
      onError: (error) => errors.push(error),
    });

    expect(() => {
      session.write([{ addr: 0x2024, raw: 1 }]);
      timers.advance(TIMING.writeThrottleMs);
    }).not.toThrow();

    expect(session.phase()).toBe('error');
    expect(phases).toEqual(['error']);
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe('disconnected');
    expect(errors[0].message).toContain('报告队列已满');
  });

  it('send 返回 rejected Promise：同样进 error 且不产生未处理拒绝', async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const errors: TransportError[] = [];
    const session = new ParamSession({
      send: () => Promise.reject(new Error('桥接已断开')),
      clock,
      timers,
      onError: (error) => errors.push(error),
    });

    session.write([{ addr: 0x2024, raw: 1 }]);
    timers.advance(TIMING.writeThrottleMs);
    await Promise.resolve();
    await Promise.resolve();

    expect(session.phase()).toBe('error');
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe('disconnected');
    expect(errors[0].message).toContain('桥接已断开');
  });
});

describe('S-m 统计合并', () => {
  it('一次写 + 一次应答：onStats 调用 1…3 次且在微任务内合并', async () => {
    const harness = createHarness();
    const before = harness.events.stats;

    harness.session.write([{ addr: 0x2024, raw: 1 }]);
    harness.timers.advance(TIMING.writeThrottleMs);
    await Promise.resolve();
    await Promise.resolve();

    const calls = harness.events.stats - before;
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(calls).toBeLessThanOrEqual(3);
    expect(harness.session.stats().outFrames).toBe(1);
    expect(harness.session.stats().inFrames).toBe(1);
    expect(harness.session.stats().queueDepth).toBe(0);
  });
});

describe('levelToDb', () => {
  it('0→-96、128→-48、256→0、越界夹紧', () => {
    expect(levelToDb(0)).toBe(-96);
    expect(levelToDb(128)).toBe(-48);
    expect(levelToDb(256)).toBe(0);
    expect(levelToDb(300)).toBe(0);
    expect(levelToDb(-5)).toBe(-96);
  });
});
