import { describe, expect, it } from 'vitest';
import { PAYLOAD_BYTES, splitFrame } from '../../../src/renderer/src/device/protocol';
import { ACK_NO_ERR, encodeAck, type AckCode } from '../../../src/renderer/src/device/proto/codec';
import { FUNC_ACK, decodeStream, encodeFrame } from '../../../src/renderer/src/device/proto/frame';
import type { DiagEntry } from '../../../src/renderer/src/device/proto/session';
import { TIMING, type Clock, type Timers } from '../../../src/renderer/src/device/proto/timing';
import {
  DFU_CMD_BLOCK,
  DFU_CMD_INFO,
  DFU_CMD_STATUS,
  DFU_STATUS_CODE_ERR,
  DFU_STATUS_CONTINUE,
  DFU_STATUS_FAIL,
  DFU_STATUS_INFO_ERR,
  DFU_STATUS_SUCCESS,
  SIGMA_ACK_CHECKSUM_ERR,
  SIGMA_CMD_ACK,
  SIGMA_CMD_DFU,
  decodeSigmaStream,
  encodeSigmaFrame,
} from '../../../src/renderer/src/device/dfu/frame';
import {
  BLOCK_BYTES,
  encodeBlockFrame,
  encodeInfoFrame,
  gammaEncrypt,
  parseImage,
  sum32LittleEndianWords,
  type DfuInfo,
  type ParsedImage,
} from '../../../src/renderer/src/device/dfu/image';
import {
  DfuSession,
  type DfuError,
  type DfuProgress,
  type DfuSessionOptions,
} from '../../../src/renderer/src/device/dfu/session';

// ---- 假时钟（C8：不 sleep，超时全部用假时钟推进） ----

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

// ---- 假下位机：解析 63 B 报文还原帧，按计划造回执 ----

interface SentFrame {
  readonly kind: 'enter' | 'info' | 'block';
  /** 第几轮（信息帧计数，1 起）；enter 恒为 0 */
  readonly round: number;
  /** 块在本轮的下标；enter/info 为 -1 */
  readonly index: number;
  readonly bytes: Uint8Array;
}

type Reply =
  | { readonly ack: number }
  | { readonly sigmaAck: number }
  | { readonly status: number }
  | null;

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

/** 设备→主机状态帧，与 DFU 材料 §2.4 实测字节同构：`C4 0A 00 00 0B 01 00 <status> CRC` */
function statusFrame(status: number): Uint8Array {
  return encodeSigmaFrame(SIGMA_CMD_DFU, new Uint8Array([DFU_CMD_STATUS, 0x00, status]));
}

/** 设备→主机 SigmaBus ACK，错误码 16 位小端（设计 §5.9 / 变更记录 R-4） */
function sigmaAckFrame(err: number): Uint8Array {
  return encodeSigmaFrame(SIGMA_CMD_ACK, new Uint8Array([err & 0xff, (err >> 8) & 0xff]));
}

class FakeBootloader {
  readonly log: SentFrame[] = [];
  readonly reports: Uint8Array[] = [];
  plan: (event: SentFrame) => Reply = () => null;

  private rest = new Uint8Array(0);
  private round = 0;
  private blockIndex = -1;

  constructor(private readonly deliver: (bytes: Uint8Array) => void) {}

  send = (reports: readonly Uint8Array[]): void => {
    for (const report of reports) this.reports.push(report.slice());
    const event = this.decode(concat(reports));
    if (event === null) return;
    this.log.push(event);
    const reply = this.plan(event);
    if (reply === null) return;
    if ('ack' in reply) {
      this.emit(encodeFrame(FUNC_ACK, encodeAck(reply.ack as AckCode)));
      return;
    }
    if ('sigmaAck' in reply) {
      this.emit(sigmaAckFrame(reply.sigmaAck));
      return;
    }
    this.emit(statusFrame(reply.status));
  };

  /** 进 DFU 走参数协议（首字节 0x00），之后只走 SigmaBus（首字节 0xC4） */
  private decode(bytes: Uint8Array): SentFrame | null {
    if (bytes[0] === 0x00) {
      const decoded = decodeStream(bytes);
      if (decoded.frames.length === 0) return null;
      this.round = 0;
      this.blockIndex = -1;
      return { kind: 'enter', round: 0, index: -1, bytes };
    }
    const decoded = decodeSigmaStream(concat([this.rest, bytes]));
    this.rest = decoded.rest;
    const frame = decoded.frames[0];
    if (frame === undefined) return null;
    if (frame.data[0] === DFU_CMD_INFO) {
      this.round += 1;
      this.blockIndex = -1;
      return { kind: 'info', round: this.round, index: -1, bytes };
    }
    if (frame.data[0] !== DFU_CMD_BLOCK) return null;
    this.blockIndex += 1;
    return { kind: 'block', round: this.round, index: this.blockIndex, bytes };
  }

  private emit(bytes: Uint8Array): void {
    for (const report of splitFrame(bytes, PAYLOAD_BYTES)) this.deliver(report);
  }
}

// ---- 固件包夹具：App 包 = EnterDfu + Info + N × Block（与出厂包同构） ----

const ENTER_DFU_DATA = new Uint8Array([0x08, 0x10, 0x01, 0x00]);

function plainBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

interface BuildOptions {
  readonly modelCode?: string;
  readonly modelName?: string;
  readonly version?: { readonly x: number; readonly y: number; readonly z: number };
  readonly blockSize?: number;
  readonly lengthOverride?: number;
  readonly checksumOverride?: number;
}

function buildPackage(plain: Uint8Array, options: BuildOptions = {}): Uint8Array {
  const blockSize = options.blockSize ?? BLOCK_BYTES;
  const cipher = gammaEncrypt(plain);
  const blocks: Uint8Array[] = [];
  for (let offset = 0; offset < cipher.length; offset += blockSize) {
    blocks.push(cipher.slice(offset, Math.min(offset + blockSize, cipher.length)));
  }
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const info: DfuInfo = {
    modelCode: options.modelCode ?? '000000',
    modelName: options.modelName ?? '000000',
    version: options.version ?? { x: 0, y: 0, z: 0 },
    length: options.lengthOverride ?? total,
    checksum: options.checksumOverride ?? sum32LittleEndianWords(plain),
  };
  return concat([
    encodeSigmaFrame(0x03, ENTER_DFU_DATA),
    encodeInfoFrame(info),
    ...blocks.map((block) => encodeBlockFrame(block)),
  ]);
}

function parsed(pkg: Uint8Array): ParsedImage {
  const result = parseImage(pkg);
  if (!result.ok) throw new Error(`fixture is not a valid package: ${result.rejection.problem}`);
  return result.image;
}

/** 1024 B 明文 → 4 块 256 B；型号码与假设备一致 */
const BLOCK_TOTAL = 4;
const PLAIN = plainBytes(1024);
const PKG = buildPackage(PLAIN, { modelCode: 'JYM001', modelName: 'M001', version: { x: 1, y: 2, z: 3 } });

// ---- 夹具：会话 + 假设备 ----

interface Harness {
  readonly session: DfuSession;
  readonly device: FakeBootloader;
  readonly clock: FakeClock;
  readonly timers: FakeTimers;
  readonly progress: DfuProgress[];
  readonly errors: DfuError[];
  readonly diags: DiagEntry[];
}

interface HarnessOptions {
  readonly modelCode?: string | null;
  readonly allowBootld?: boolean;
  readonly plan?: (event: SentFrame) => Reply;
  readonly send?: DfuSessionOptions['send'];
  readonly timing?: Partial<typeof TIMING>;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const progress: DfuProgress[] = [];
  const errors: DfuError[] = [];
  const diags: DiagEntry[] = [];
  const wire: { handle?: (bytes: Uint8Array) => void } = {};
  const device = new FakeBootloader((bytes) => wire.handle?.(bytes));
  if (options.plan !== undefined) device.plan = options.plan;
  const session = new DfuSession({
    send: options.send ?? ((reports) => device.send(reports)),
    timers,
    clock,
    timing: options.timing,
    deviceModelCode: () => (options.modelCode === undefined ? 'JYM001' : options.modelCode),
    allowBootld: options.allowBootld,
    onProgress: (value) => progress.push(value),
    onError: (value) => errors.push(value),
    onDiag: (value) => diags.push(value),
  });
  wire.handle = (bytes) => session.handleBytes(bytes);
  return { session, device, clock, timers, progress, errors, diags };
}

/** 让所有挂起的微任务跑完（会话内部的 await 链不受假定时器影响，用真宏任务收尾最可靠） */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function advance(harness: Harness, ms: number): Promise<void> {
  harness.timers.advance(ms);
  await settle();
}

function runCaught(session: DfuSession, pkg: Uint8Array): Promise<Error | null> {
  return session.run(pkg).then(
    () => null,
    (error: Error) => error,
  );
}

function labels(device: FakeBootloader): string[] {
  return device.log.map((frame) => (frame.kind === 'block' ? `block:${frame.index}` : frame.kind));
}

/** 相邻去重后的阶段序列 */
function phaseSequence(progress: readonly DfuProgress[]): string[] {
  const out: string[] = [];
  for (const item of progress) {
    if (out[out.length - 1] !== item.phase) out.push(item.phase);
  }
  return out;
}

const happyPlan = (event: SentFrame): Reply => {
  if (event.kind === 'enter') return { ack: ACK_NO_ERR };
  if (event.kind === 'info') return { status: DFU_STATUS_CONTINUE };
  return { status: event.index === BLOCK_TOTAL - 1 ? DFU_STATUS_SUCCESS : DFU_STATUS_CONTINUE };
};

// ---- §6 的 12 条用例 ----

describe('DfuSession 快乐路径', () => {
  it('1. enter → info → 逐块 → 0x05 → settling，percent 单调不减且停在 95', async () => {
    const h = makeHarness({ plan: happyPlan });
    const run = runCaught(h.session, PKG);
    await settle();
    expect(await run).toBeNull();
    expect(h.session.phase()).toBe('settling');

    // EnterDfu 是参数协议帧 `00 10 00 0A 10 08 00 01 8D 09`（任务书 §4.1 的逐字节原文）
    expect(hexOf(h.device.log[0].bytes.subarray(0, 10))).toBe('00 10 00 0A 10 08 00 01 8D 09');
    // 一帧一块、块间等回执，没有流水线
    expect(labels(h.device)).toEqual(['enter', 'info', 'block:0', 'block:1', 'block:2', 'block:3']);

    // 块帧与 4.1 的编码函数逐字节一致：发的是 image.blocks（密文原样），不重加密、不重切块
    const image = parsed(PKG);
    for (let index = 0; index < BLOCK_TOTAL; index += 1) {
      const sent = h.device.log[2 + index];
      const expected = encodeBlockFrame(image.blocks[index]);
      expect(hexOf(sent.bytes.subarray(0, expected.length))).toBe(hexOf(expected));
    }

    expect(phaseSequence(h.progress)).toEqual([
      'preflight',
      'ready',
      'entering',
      'probing',
      'writing',
      'settling',
    ]);
    expect(h.progress[0].percent).toBe(0);
    const percents = h.progress.map((item) => item.percent);
    for (let index = 1; index < percents.length; index += 1) {
      expect(percents[index]).toBeGreaterThanOrEqual(percents[index - 1]);
      expect(percents[index]).toBeLessThanOrEqual(100);
    }
    const lastWriting = h.progress.filter((item) => item.phase !== 'settling').at(-1);
    expect(lastWriting?.percent).toBe(95);
    const settling = h.progress.filter((item) => item.phase === 'settling');
    expect(settling).toHaveLength(1);
    expect(settling[0].percent).toBe(95);
    expect(settling[0].blockTotal).toBe(BLOCK_TOTAL);
    expect(settling[0].message).toBe('fw.phase.settling');
    expect(settling[0].round).toBe(1);

    // 诊断条目：每条出站帧一条，格式按任务书 §4.1
    const info = h.diags.find((item) => item.dir === 'out' && item.summary.startsWith('DFU info'));
    expect(info?.summary).toMatch(/^DFU info len=1024 csum=0x[0-9A-F]{8}$/);
    expect(h.diags.some((item) => item.dir === 'out' && item.summary === 'DFU block 1/4')).toBe(true);
    expect(h.diags.some((item) => item.dir === 'in' && item.summary === 'DFU status 0x05 SUCCESS')).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('1b. 回执帧字节与 DFU 材料 §2.4/§2.5 的实测字节一致', () => {
    expect(hexOf(statusFrame(DFU_STATUS_CONTINUE))).toBe('C4 0A 00 00 0B 01 00 03 23 FF');
    expect(hexOf(statusFrame(DFU_STATUS_SUCCESS))).toBe('C4 0A 00 00 0B 01 00 05 21 FF');
    expect(hexOf(sigmaAckFrame(SIGMA_ACK_CHECKSUM_ERR))).toBe('C4 09 00 00 02 03 00 2E FF');
  });
});

describe('DfuSession 预检边界', () => {
  it('2. 预检失败零出帧（R6-2/R6-3）', async () => {
    const h = makeHarness({ plan: happyPlan });
    const tampered = buildPackage(PLAIN, { modelCode: 'JYM001', checksumOverride: 0x12345678 });
    await expect(h.session.run(tampered)).rejects.toThrow(/preflight/);
    expect(h.device.reports).toHaveLength(0);
    expect(h.device.log).toHaveLength(0);
    expect(h.errors).toEqual([{ kind: 'preflight', detail: expect.stringContaining('checksumMismatch') }]);
    expect(h.session.phase()).toBe('failed');

    const garbage = makeHarness({ plan: happyPlan });
    await expect(garbage.session.run(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).rejects.toThrow(/preflight/);
    expect(garbage.device.reports).toHaveLength(0);
    expect(garbage.errors[0].kind).toBe('preflight');
  });

  it('12. Bootld 包：allowBootld 缺省拒绝，注入 true 才能进 probing（R6-9 / B9）', async () => {
    const boot = buildPackage(plainBytes(1024), { modelCode: 'Bootld', modelName: '000000' });

    const denied = makeHarness({ plan: happyPlan });
    const pre = denied.session.preflight(boot);
    expect(pre.ok).toBe(false);
    if (!pre.ok) {
      expect(pre.rejection.problem).toBe('modelMissing');
      expect(pre.rejection.detail?.reason).toBe('bootld');
    }
    expect(denied.device.reports).toHaveLength(0);
    expect(denied.errors).toEqual([{ kind: 'preflight', detail: expect.stringContaining('modelMissing') }]);

    const deniedRun = makeHarness({ plan: happyPlan });
    await expect(deniedRun.session.run(boot)).rejects.toThrow(/preflight/);
    expect(deniedRun.device.reports).toHaveLength(0);

    const allowed = makeHarness({
      plan: (event) => (event.kind === 'enter' ? { ack: ACK_NO_ERR } : null),
      allowBootld: true,
    });
    const run = runCaught(allowed.session, boot);
    await settle();
    expect(allowed.session.phase()).toBe('probing');
    expect(labels(allowed.device)).toEqual(['enter', 'info']);
    allowed.session.dispose();
    expect((await run)?.message).toBe('dfu aborted');
  });
});

describe('DfuSession 探测与歧义态', () => {
  it('3. 探测超时：信息帧重发 3 次后 probeFailed', async () => {
    const h = makeHarness({ plan: (event) => (event.kind === 'enter' ? { ack: ACK_NO_ERR } : null) });
    const run = runCaught(h.session, PKG);
    await settle();
    for (let attempt = 0; attempt < TIMING.dfuProbeAttempts; attempt += 1) {
      await advance(h, TIMING.dfuProbeTimeoutMs);
    }
    const error = await run;
    expect(error?.message).toBe('dfu probeFailed');
    expect(h.device.log.filter((item) => item.kind === 'info')).toHaveLength(TIMING.dfuProbeAttempts);
    expect(labels(h.device)).toEqual(['enter', 'info', 'info', 'info']);
    expect(h.errors).toEqual([{ kind: 'probeFailed', round: 1, detail: expect.any(String) }]);
    expect(h.session.phase()).toBe('failed');
  });

  it('4. 块超时整轮重来（R6-6）：重发信息帧、从第 0 块重来、不补发单块', async () => {
    const plan = (event: SentFrame): Reply => {
      if (event.kind === 'enter') return { ack: ACK_NO_ERR };
      if (event.kind === 'info') return { status: DFU_STATUS_CONTINUE };
      if (event.round === 1 && event.index === 1) return null;
      return { status: event.index === BLOCK_TOTAL - 1 ? DFU_STATUS_SUCCESS : DFU_STATUS_CONTINUE };
    };
    const h = makeHarness({ plan });
    const run = runCaught(h.session, PKG);
    await settle();
    expect(labels(h.device)).toEqual(['enter', 'info', 'block:0', 'block:1']);
    expect(h.session.phase()).toBe('writing');

    await advance(h, TIMING.dfuBlockTimeoutMs);
    expect(await run).toBeNull();
    expect(h.session.phase()).toBe('settling');
    expect(labels(h.device)).toEqual([
      'enter',
      'info',
      'block:0',
      'block:1',
      'info',
      'block:0',
      'block:1',
      'block:2',
      'block:3',
    ]);
    // 超时后的下一帧必须是信息帧（复位设备指针），不是同一块的重发
    expect(h.device.log[4].kind).toBe('info');
    const sequence = labels(h.device);
    for (let index = 1; index < sequence.length; index += 1) {
      expect(sequence[index]).not.toBe(sequence[index - 1]);
    }
    expect(h.progress.at(-1)?.round).toBe(2);
    expect(h.progress.some((item) => item.phase === 'writing' && item.round === 2)).toBe(true);
    expect(h.diags.some((item) => item.summary.includes('超时') && item.summary.includes('整轮重来'))).toBe(true);
    expect(h.diags.some((item) => item.summary.includes('上一轮：block 2/4 timeout'))).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('5. 回执丢失（R6-5）：设备收到了块但不回状态帧，同样整轮重来', async () => {
    const plan = (event: SentFrame): Reply => {
      if (event.kind === 'enter') return { ack: ACK_NO_ERR };
      if (event.kind === 'info') return { status: DFU_STATUS_CONTINUE };
      if (event.round === 1 && event.index === 1) return null;
      return { status: event.index === BLOCK_TOTAL - 1 ? DFU_STATUS_SUCCESS : DFU_STATUS_CONTINUE };
    };
    const h = makeHarness({ plan });
    const run = runCaught(h.session, PKG);
    await settle();
    // 第 2 块确实发出去了（假设备收到了），只是没回执
    expect(h.device.log.filter((item) => item.kind === 'block' && item.round === 1)).toHaveLength(2);

    await advance(h, TIMING.dfuBlockTimeoutMs);
    expect(await run).toBeNull();
    const sequence = labels(h.device);
    expect(sequence.slice(0, 4)).toEqual(['enter', 'info', 'block:0', 'block:1']);
    expect(sequence[4]).toBe('info');
    expect(h.device.log.filter((item) => item.kind === 'block' && item.round === 1).length).toBe(2);
    expect(h.progress.at(-1)?.round).toBe(2);
    expect(h.errors).toEqual([]);
  });

  it('6. 0x02 歧义态：整轮重来', async () => {
    const plan = (event: SentFrame): Reply => {
      if (event.kind === 'enter') return { ack: ACK_NO_ERR };
      if (event.kind === 'info') return { status: DFU_STATUS_CONTINUE };
      if (event.round === 1 && event.index === 0) return { status: DFU_STATUS_CODE_ERR };
      return { status: event.index === BLOCK_TOTAL - 1 ? DFU_STATUS_SUCCESS : DFU_STATUS_CONTINUE };
    };
    const h = makeHarness({ plan });
    const run = runCaught(h.session, PKG);
    await settle();
    expect(await run).toBeNull();
    expect(h.device.log.filter((item) => item.kind === 'info')).toHaveLength(2);
    expect(h.device.log[1].kind).toBe('info');
    expect(h.device.log[2].kind).toBe('block'); // 第 1 轮第 0 块回 0x02
    expect(h.device.log[3].kind).toBe('info'); // 直接重发信息帧
    expect(h.session.phase()).toBe('settling');
    expect(h.diags.some((item) => item.summary === 'DFU status 0x02 CODE_ERR')).toBe(true);
    expect(h.progress.at(-1)?.round).toBe(2);
    expect(h.errors).toEqual([]);
  });

  it('7. 三轮都失败 → restartExhausted', async () => {
    const plan = (event: SentFrame): Reply => {
      if (event.kind === 'enter') return { ack: ACK_NO_ERR };
      if (event.kind === 'info') return { status: DFU_STATUS_CONTINUE };
      return { status: DFU_STATUS_CODE_ERR };
    };
    const h = makeHarness({ plan });
    const run = runCaught(h.session, PKG);
    await settle();
    const error = await run;
    expect(error?.message).toBe('dfu restartExhausted');
    expect(h.device.log.filter((item) => item.kind === 'info')).toHaveLength(TIMING.dfuRoundRestarts);
    expect(h.errors).toEqual([
      { kind: 'restartExhausted', round: TIMING.dfuRoundRestarts, detail: 'block 1/4 status 0x02' },
    ]);
    expect(h.session.phase()).toBe('failed');
    const sends = h.device.reports.length;
    await advance(h, TIMING.dfuBlockTimeoutMs * 3);
    expect(h.device.reports).toHaveLength(sends);
  });

  it('8. 0x01 → statusInfo 且不再发块', async () => {
    const h = makeHarness({
      plan: (event) => {
        if (event.kind === 'enter') return { ack: ACK_NO_ERR };
        return { status: DFU_STATUS_INFO_ERR };
      },
    });
    const run = runCaught(h.session, PKG);
    await settle();
    expect((await run)?.message).toBe('dfu statusInfo');
    expect(labels(h.device)).toEqual(['enter', 'info']);
    expect(h.errors).toEqual([{ kind: 'statusInfo', status: DFU_STATUS_INFO_ERR, round: 1 }]);
    expect(h.session.phase()).toBe('failed');
  });

  it('9. 0x04 → statusFail，不发后续块（可立即重试）', async () => {
    const h = makeHarness({
      plan: (event) => {
        if (event.kind === 'enter') return { ack: ACK_NO_ERR };
        if (event.kind === 'info') return { status: DFU_STATUS_CONTINUE };
        return { status: event.index === 1 ? DFU_STATUS_FAIL : DFU_STATUS_CONTINUE };
      },
    });
    const run = runCaught(h.session, PKG);
    await settle();
    expect((await run)?.message).toBe('dfu statusFail');
    expect(labels(h.device)).toEqual(['enter', 'info', 'block:0', 'block:1']);
    expect(h.errors).toEqual([{ kind: 'statusFail', status: DFU_STATUS_FAIL, round: 1, blockIndex: 1 }]);
    expect(h.session.phase()).toBe('failed');
  });
});

describe('DfuSession 收尾与中止', () => {
  it('10. settling 期间零出帧；complete() 后 phase=done', async () => {
    const h = makeHarness({ plan: happyPlan });
    const run = runCaught(h.session, PKG);
    await settle();
    expect(await run).toBeNull();
    expect(h.session.phase()).toBe('settling');
    const sends = h.device.reports.length;

    await advance(h, TIMING.dfuSettleTimeoutMs - 1);
    expect(h.device.reports).toHaveLength(sends);
    // 收尾期设备可能还在吐旧回执：只记 warn，不回帧、不改 phase
    h.session.handleBytes(statusFrame(DFU_STATUS_CONTINUE));
    expect(h.device.reports).toHaveLength(sends);
    expect(h.session.phase()).toBe('settling');
    expect(h.progress.at(-1)?.percent).toBe(95);
    expect(h.diags.at(-1)?.level).toBe('info');

    h.session.complete();
    expect(h.session.phase()).toBe('done');
    expect(h.progress.map((item) => item.phase)).toContain('verifying');
    expect(h.progress.at(-1)?.percent).toBe(100);
    await advance(h, TIMING.dfuSettleTimeoutMs * 2);
    expect(h.errors).toEqual([]);
    expect(h.device.reports).toHaveLength(sends);
  });

  it('11. abort()：writing 中生效、settling 后返回 false', async () => {
    const plan = (event: SentFrame): Reply => {
      if (event.kind === 'enter') return { ack: ACK_NO_ERR };
      if (event.kind === 'info') return { status: DFU_STATUS_CONTINUE };
      return event.index === 1 ? null : { status: DFU_STATUS_CONTINUE };
    };
    const h = makeHarness({ plan });
    const run = runCaught(h.session, PKG);
    await settle();
    expect(h.session.phase()).toBe('writing');
    expect(h.session.abort()).toBe(true);
    expect(h.session.phase()).toBe('aborted');
    const sends = h.device.reports.length;
    await advance(h, TIMING.dfuBlockTimeoutMs * 2);
    expect(h.device.reports).toHaveLength(sends);
    expect((await run)?.message).toBe('dfu aborted');
    expect(h.errors).toEqual([]);

    const settled = makeHarness({ plan: happyPlan });
    const settledRun = runCaught(settled.session, PKG);
    await settle();
    expect(await settledRun).toBeNull();
    expect(settled.session.phase()).toBe('settling');
    expect(settled.session.abort()).toBe(false);
    expect(settled.session.phase()).toBe('settling');
  });

  it('10b. settle 超时 → settle 失败且仍零出帧', async () => {
    const h = makeHarness({ plan: happyPlan });
    const run = runCaught(h.session, PKG);
    await settle();
    expect(await run).toBeNull();
    const sends = h.device.reports.length;
    await advance(h, TIMING.dfuSettleTimeoutMs);
    expect(h.session.phase()).toBe('failed');
    expect(h.errors).toEqual([{ kind: 'settle', round: 1, detail: expect.any(String) }]);
    expect(h.device.reports).toHaveLength(sends);
  });
});

describe('DfuSession 型号与调用约束', () => {
  it('12b. 型号不匹配 / 拿不到设备型号都被预检挡下；通用镜像 000000 不比对', async () => {
    const mismatch = makeHarness({ plan: happyPlan, modelCode: 'JYM009' });
    const result = mismatch.session.preflight(PKG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.problem).toBe('modelMissing');
      expect(result.rejection.detail?.reason).toBe('mismatch');
      expect(result.rejection.detail?.deviceModelCode).toBe('JYM009');
      expect(result.rejection.detail?.imageModelCode).toBe('JYM001');
    }
    expect(mismatch.device.reports).toHaveLength(0);

    const unknown = makeHarness({ plan: happyPlan, modelCode: null });
    const unknownResult = unknown.session.preflight(PKG);
    expect(unknownResult.ok).toBe(false);
    if (!unknownResult.ok) expect(unknownResult.rejection.detail?.reason).toBe('unknown-device');

    const wildcard = buildPackage(PLAIN, { modelCode: '000000' });
    const anyDevice = makeHarness({ plan: happyPlan, modelCode: 'OTHER1' });
    expect(anyDevice.session.preflight(wildcard).ok).toBe(true);

    const mismatchPackage = buildPackage(PLAIN, { modelCode: 'JYM002' });
    const strict = makeHarness({ plan: happyPlan });
    expect(strict.session.preflight(mismatchPackage).ok).toBe(false);
    expect(strict.device.reports).toHaveLength(0);
  });

  it('12c. 运行中再次 run / 运行中 preflight 都被拒绝，且不再出帧', async () => {
    const plan = (event: SentFrame): Reply => {
      if (event.kind === 'enter') return { ack: ACK_NO_ERR };
      if (event.kind === 'info') return { status: DFU_STATUS_CONTINUE };
      return null;
    };
    const h = makeHarness({ plan });
    const run = runCaught(h.session, PKG);
    await settle();
    const sends = h.device.reports.length;
    await expect(h.session.run(PKG)).rejects.toThrow('dfu already running');
    expect(() => h.session.preflight(PKG)).toThrow('dfu already running');
    expect(h.device.reports).toHaveLength(sends);
    h.session.dispose();
    expect((await run)?.message).toBe('dfu aborted');
  });

  it("12d. 预检成功但设备回 0x0003 ACK 校验错：按歧义态整轮重来", async () => {
    const plan = (event: SentFrame): Reply => {
      if (event.kind === 'enter') return { ack: ACK_NO_ERR };
      if (event.kind === 'info') return { status: DFU_STATUS_CONTINUE };
      if (event.round === 1 && event.index === 1) return { sigmaAck: SIGMA_ACK_CHECKSUM_ERR };
      return { status: event.index === BLOCK_TOTAL - 1 ? DFU_STATUS_SUCCESS : DFU_STATUS_CONTINUE };
    };
    const h = makeHarness({ plan });
    const run = runCaught(h.session, PKG);
    await settle();
    expect(await run).toBeNull();
    expect(h.device.log.filter((item) => item.kind === 'info')).toHaveLength(2);
    expect(h.diags.some((item) => item.summary === 'DFU sigma ack 0x0003 CHECKSUM_ERR')).toBe(true);
    expect(h.progress.at(-1)?.round).toBe(2);
    expect(h.errors).toEqual([]);
  });

  it('12e. send 抛错 → channel 失败；complete({ok:false}) → verify 失败', async () => {
    const broken = makeHarness({
      send: () => {
        throw new Error('device went away');
      },
    });
    const brokenRun = runCaught(broken.session, PKG);
    await settle();
    expect((await brokenRun)?.message).toBe('dfu channel');
    expect(broken.errors).toEqual([{ kind: 'channel', detail: 'device went away' }]);
    expect(broken.session.phase()).toBe('failed');

    const h = makeHarness({ plan: happyPlan });
    const run = runCaught(h.session, PKG);
    await settle();
    expect(await run).toBeNull();
    h.session.complete({ ok: false, detail: 'version 1.2.3 != 1.2.4' });
    expect(h.session.phase()).toBe('failed');
    expect(h.errors).toEqual([{ kind: 'verify', round: 1, detail: 'version 1.2.3 != 1.2.4' }]);
    // verify 失败后定时器已清，不会再冒出 settle 失败
    await advance(h, TIMING.dfuSettleTimeoutMs * 2);
    expect(h.errors).toHaveLength(1);
  });

  it('12f. dispose() 清掉所有定时器并让挂起的 run 收场', async () => {
    const h = makeHarness({ plan: () => null });
    const run = runCaught(h.session, PKG);
    await settle();
    expect(h.timers.pending).toBe(1);
    h.session.dispose();
    expect(h.timers.pending).toBe(0);
    expect((await run)?.message).toBe('dfu aborted');
    expect(h.session.phase()).toBe('aborted');
    expect(h.errors).toEqual([]);
  });
});

describe('DfuSession 进入时序（「立即重试」不再被 EnterDfu 卡死）', () => {
  const blockReply = (index: number): Reply =>
    index === BLOCK_TOTAL - 1 ? { status: DFU_STATUS_SUCCESS } : { status: DFU_STATUS_CONTINUE };

  it('13. 设备已在 bootloader：EnterDfu 无 ACK、信息帧回 0x03 → 照样跑到 settling', async () => {
    const h = makeHarness({
      plan: (event) => {
        // 上一轮失败后设备停在 bootloader：参数协议帧没人答，SigmaBus 信息帧照答 0x03
        if (event.kind === 'enter') return null;
        if (event.kind === 'info') return { status: DFU_STATUS_CONTINUE };
        return blockReply(event.index);
      },
    });
    const run = runCaught(h.session, PKG);
    await settle();
    await advance(h, TIMING.requestTimeoutMs);
    await advance(h, TIMING.requestTimeoutMs);
    expect(await run).toBeNull();

    expect(h.session.phase()).toBe('settling');
    expect(labels(h.device)).toEqual(['enter', 'enter', 'info', 'block:0', 'block:1', 'block:2', 'block:3']);
    expect(h.errors).toEqual([]);
    // 没有 ACK 也拿到了"进入 5 + 探测 5"：信息帧确认在 Bootloader 后补上
    const settling = h.progress.filter((item) => item.phase === 'settling');
    expect(settling).toHaveLength(1);
    expect(settling[0].percent).toBe(95);
    expect(h.diags.some((item) => item.summary.includes('EnterDfu 没有 ACK'))).toBe(true);
  });

  it('14. entering 超时 + 信息帧第一次超时、第二次 0x03 → 正常完成', async () => {
    const h = makeHarness({
      plan: (event) => {
        if (event.kind === 'enter') return null;
        if (event.kind === 'info') return event.round === 1 ? null : { status: DFU_STATUS_CONTINUE };
        return blockReply(event.index);
      },
    });
    const run = runCaught(h.session, PKG);
    await settle();
    await advance(h, TIMING.requestTimeoutMs);
    await advance(h, TIMING.requestTimeoutMs);
    await advance(h, TIMING.dfuProbeTimeoutMs);
    expect(await run).toBeNull();

    expect(h.session.phase()).toBe('settling');
    expect(labels(h.device)).toEqual([
      'enter',
      'enter',
      'info',
      'info',
      'block:0',
      'block:1',
      'block:2',
      'block:3',
    ]);
    expect(h.errors).toEqual([]);
  });

  it('15. entering 超时 + 探测也超时 → enterTimeout（不是 probeFailed）', async () => {
    const h = makeHarness({ plan: () => null });
    const run = runCaught(h.session, PKG);
    await settle();
    await advance(h, TIMING.requestTimeoutMs);
    await advance(h, TIMING.requestTimeoutMs);
    for (let attempt = 0; attempt < TIMING.dfuProbeAttempts; attempt += 1) {
      await advance(h, TIMING.dfuProbeTimeoutMs);
    }
    expect((await run)?.message).toBe('dfu enterTimeout');
    expect(h.errors).toEqual([{ kind: 'enterTimeout', round: 1, detail: expect.stringContaining('信息帧') }]);
    expect(labels(h.device)).toEqual(['enter', 'enter', 'info', 'info', 'info']);
    expect(h.session.phase()).toBe('failed');
  });
});
