/**
 * 参数会话：唯一在途请求槽 + 写合并节流 + 超时重试 + 回读同步 + 电平轮询 + 诊断数据面。
 *
 * 本文件刻意不碰 WebHID / DOM / 真实定时器：出站靠注入的 `send`，入站靠 `handleBytes`，
 * 时间靠注入的 `Clock` / `Timers`。原因是参数协议一问一答（ACK 帧不带原 Func 与地址，
 * 参数协议 §附A.4），只有把时间与通道都做成可注入，超时/重试/轮询这些用例才能用假时钟
 * 精确断言边界，而不是靠真实 sleep（需求 C8）。
 *
 * 规则编号（S-a…S-m）对应设计文档 §5.5 与任务书 SubStage 3.1 §4.2。
 */

import type { ReportIds } from '../protocol';
import { PAYLOAD_BYTES, splitFrame } from '../protocol';
import {
  CONFIG,
  DEV_INFO,
  LEVEL_ADDR,
  PRESET_COUNT,
  PRESET_START,
  decodeAsciiWords,
  findRegister,
} from '../registers';
import {
  ACK_CHECKSUM_ERR,
  ACK_DEV_ADDR_ERR,
  ACK_NO_ERR,
  ackToErrorCode,
  encodeRandRead,
  encodeRandWrite,
  encodeSeqRead,
  encodeSeqWrite,
  parseReply,
  type AckReply,
  type RandReadReply,
  type ReadReply,
  type WordPair,
} from './codec';
import {
  FUNC_ACK,
  FUNC_RAND_READ,
  FUNC_RAND_WRITE,
  FUNC_SEQ_READ,
  FUNC_SEQ_WRITE,
  encodeFrame,
  decodeStream,
  type DecodeIssue,
  type ParamFrame,
} from './frame';
import { TIMING, defaultClock, defaultTimers, type Clock, type Timers } from './timing';

export type SessionPhase = 'idle' | 'syncing' | 'ready' | 'error';

export interface TransportError {
  readonly kind: 'timeout' | 'crc' | 'readOnly' | 'range' | 'addr' | 'len' | 'disconnected';
  readonly addr?: number;
  readonly id?: string;
  /** CP_ACK 原始码；本地错误（超时/通道错误）没有码 */
  readonly ack?: number;
  readonly message: string;
}

export interface DiagEntry {
  readonly at: number;
  readonly dir: 'out' | 'in';
  readonly hex: string;
  readonly summary: string;
  readonly level: 'info' | 'warn' | 'error';
}

export interface SessionStats {
  readonly outFrames: number;
  readonly inFrames: number;
  readonly crcErrors: number;
  readonly timeouts: number;
  readonly retries: number;
  readonly droppedPolls: number;
  readonly queueDepth: number;
}

export interface PresetSnapshot {
  readonly start: number;
  readonly values: Readonly<Record<number, number>>;
}

export interface DeviceSnapshot {
  readonly modelCode: string;
  readonly deviceName: string;
  readonly firmware: { readonly x: number; readonly y: number; readonly z: number; readonly build: number };
  readonly firmwareType: number;
  readonly vid: number;
  readonly pid: number;
  readonly serial: string;
  readonly comErrAck: number;
}

export interface ParamSessionOptions {
  /** 出站：一帧切好的 63 B 报文按顺序调用；返回 Promise 用于背压，失败视为通道错误（S-l） */
  readonly send: (reports: readonly Uint8Array[]) => void | Promise<void>;
  /**
   * 设计 §5.5 保留字段：report ID 由调用方的 `send` 闭包拼（C2 不允许硬编码），
   * 会话只产出 63 B 载荷，因此这里既不读也不用它。
   */
  readonly reportIds?: ReportIds;
  readonly clock?: Clock;
  readonly timers?: Timers;
  readonly timing?: Partial<typeof TIMING>;
  readonly onPhase?: (phase: SessionPhase) => void;
  readonly onEcho?: (addr: number, raw: number) => void;
  readonly onError?: (error: TransportError) => void;
  readonly onDiag?: (entry: DiagEntry) => void;
  readonly onLevel?: (sample: { readonly raw: number; readonly at: number }) => void;
  readonly onStats?: (stats: SessionStats) => void;
  /** 诊断环形缓冲长度，默认 500（R8-4） */
  readonly ringSize?: number;
}

/** 设备名共 8 词；本版本只读前 3 词（需求 R4-3 的写法，够做设备摘要） */
const SYNC_DEVICE_NAME_WORDS = 3;
const DEFAULT_DIAG_RING = 500;
const ISSUE_HEX_BYTES = 16;
const EMPTY = new Uint8Array(0);

const ACK_TEXT: Readonly<Record<number, string>> = Object.freeze({
  0: '成功',
  1: '地址错',
  2: '长度错',
  3: '校验错',
  4: '只读',
  5: '超范围',
});

type ReplyExpect = 'ack' | 'read';

interface Task {
  readonly frame: Uint8Array;
  readonly reports: readonly Uint8Array[];
  readonly expect: ReplyExpect;
  readonly summary: string;
  /** 轮询任务用 `pollTimeoutMs` 且在超时时丢弃本次而不是重试（S-f） */
  readonly poll: boolean;
  readonly onOk: (frame: ParamFrame) => void;
  readonly onFail: (error: TransportError) => void;
}

interface Inflight {
  readonly task: Task;
  attempts: number;
  timer: unknown;
  /**
   * 被新的 `sync()` 顶掉的在途请求。协议没有请求序号，帧一旦上了总线就不能丢弃：
   * 它的应答会被下一条请求当成自己的应答（真机 2026-10-26 第二轮：电平轮询的 0x12
   * 应答抢答了 sync 的 0x13）。因此只把它标记成"静默"——应答到达时吞掉、超时不重发，
   * 槽位释放后新一轮 sync 才发帧。
   */
  abandoned: boolean;
  /** `abandoned` 时等「总线回到空闲」的 Promise 与兑现函数 */
  drain: Promise<void> | null;
  releaseDrain: (() => void) | null;
}

interface WriteGroup {
  readonly start: number;
  readonly values: readonly number[];
}

function addrRange(start: number, count: number): number[] {
  const out: number[] = [];
  for (let index = 0; index < count; index += 1) out.push(start + index);
  return out;
}

/**
 * S-e 的 46 个地址（顺序即请求数据顺序，主 Agent 裁定 R-13）：
 * 型号码 3 + 设备名前 3 词 + 固件版本 4 + 固件类型 1 + VID 1 + PID 1 + SN 32 + 通讯错误 1。
 * 一条 `0x12` 帧：请求 92 B、响应 184 B，远低于 506 B 上限（地址数上限 126）。
 */
const SYNC_INFO_ADDRS: readonly number[] = Object.freeze([
  ...addrRange(DEV_INFO.modelCode.addr, DEV_INFO.modelCode.words),
  ...addrRange(DEV_INFO.deviceName.addr, SYNC_DEVICE_NAME_WORDS),
  ...addrRange(DEV_INFO.firmware.addr, DEV_INFO.firmware.words),
  DEV_INFO.fwType.addr,
  DEV_INFO.vid.addr,
  DEV_INFO.pid.addr,
  ...addrRange(DEV_INFO.serial.addr, DEV_INFO.serial.words),
  CONFIG.comErrAck,
]);

function hex(value: number, digits: number): string {
  return (value >>> 0).toString(16).toUpperCase().padStart(digits, '0');
}

function hexBytes(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const byte of bytes) parts.push(hex(byte, 2));
  return parts.join(' ');
}

/** 帧没有保留原始字节（`ParamFrame.data` 不含 Len/CRC），重编码得到逐字节相同的帧 */
function frameBytes(frame: ParamFrame): Uint8Array {
  return encodeFrame(frame.func, frame.data, frame.unitId);
}

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (tail.length === 0) return head;
  const merged = new Uint8Array(head.length + tail.length);
  merged.set(head, 0);
  merged.set(tail, head.length);
  return merged;
}

function isReadReply(reply: ReadReply | RandReadReply | AckReply): reply is ReadReply {
  return 'values' in reply;
}

function isRandReadReply(reply: ReadReply | RandReadReply | AckReply): reply is RandReadReply {
  return 'entries' in reply;
}

function isAckReply(reply: ReadReply | RandReadReply | AckReply): reply is AckReply {
  return 'ack' in reply;
}

function isPresetAddr(addr: number): boolean {
  return addr >= PRESET_START && addr < PRESET_START + PRESET_COUNT;
}

function wordsOf(words: ReadonlyMap<number, number>, start: number, count: number): number[] {
  const out: number[] = [];
  for (let index = 0; index < count; index += 1) out.push(words.get(start + index) ?? 0);
  return out;
}

function readSummary(addrs: readonly number[]): string {
  if (addrs.length === 1) return `读 0x${hex(addrs[0], 4)}`;
  const shown = addrs
    .slice(0, 8)
    .map((addr) => `0x${hex(addr, 4)}`)
    .join(',');
  const tail = addrs.length > 8 ? ',…' : '';
  return `读 ${shown}${tail} (${addrs.length})`;
}

function writeSummary(addr: number, raw: number): string {
  const field = findRegister(addr)?.field ?? '';
  return field ? `写 0x${hex(addr, 4)} ${field} = ${raw}` : `写 0x${hex(addr, 4)} = ${raw}`;
}

function describeInbound(frame: ParamFrame): { summary: string; level: DiagEntry['level'] } {
  const data = frame.data;
  switch (frame.func) {
    case FUNC_ACK: {
      if (data.length < 2) return { summary: `ACK 格式不符（${data.length} B）`, level: 'error' };
      const code = (data[0] << 8) | data[1];
      const text = ACK_TEXT[code] ?? '未知';
      return { summary: `ACK 0x${hex(code, 4)} ${text}`, level: code === ACK_NO_ERR ? 'info' : 'error' };
    }
    case FUNC_SEQ_READ: {
      if (data.length < 4) return { summary: `读回（数据 ${data.length} B）`, level: 'info' };
      const start = (data[0] << 8) | data[1];
      const count = (data[2] << 8) | data[3];
      const end = count > 0 ? start + count - 1 : start;
      return { summary: `读回 0x${hex(start, 4)}..0x${hex(end, 4)} (${count})`, level: 'info' };
    }
    case FUNC_RAND_READ: {
      const count = Math.floor(data.length / 4);
      if (count === 1) {
        const addr = (data[0] << 8) | data[1];
        const raw = (data[2] << 8) | data[3];
        return { summary: `读回 0x${hex(addr, 4)} = ${raw}`, level: 'info' };
      }
      return { summary: `读回 ${count} 项`, level: 'info' };
    }
    // 设备主动上报（真机固件用它推实时电平）：不是"跑题帧"，按 info 记，别刷成 warn
    case FUNC_RAND_WRITE: {
      const count = Math.floor(data.length / 4);
      if (count === 1) {
        const addr = (data[0] << 8) | data[1];
        const raw = (data[2] << 8) | data[3];
        return { summary: `设备上报 0x${hex(addr, 4)} = ${raw}`, level: 'info' };
      }
      return { summary: `设备上报 ${count} 项`, level: 'info' };
    }
    default:
      return { summary: `入站写帧 0x${hex(frame.func, 2)}（${data.length} B）`, level: 'warn' };
  }
}

/**
 * Promise 拒绝值：标准 `Error` 携带 `TransportError`，上层（3.2）用 `errorKeyOf` 映射文案，
 * 不必依赖错误信息字符串。
 */
function transportFailure(error: TransportError): Error {
  const failure = new Error(error.message);
  failure.name = 'TransportError';
  (failure as Error & { transportError?: TransportError }).transportError = error;
  return failure;
}

/** raw 0..256 → dBFS（线性假设，Q4 待确认）：clamp(raw/256,0,1) * 96 - 96 */
export function levelToDb(raw: number): number {
  if (!Number.isFinite(raw)) return -96;
  const normalized = Math.min(1, Math.max(0, raw / 256));
  return normalized * 96 - 96;
}

export class ParamSession {
  private readonly send: (reports: readonly Uint8Array[]) => void | Promise<void>;
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly timing: typeof TIMING;
  private readonly onPhaseCb?: (phase: SessionPhase) => void;
  private readonly onEchoCb?: (addr: number, raw: number) => void;
  private readonly onErrorCb?: (error: TransportError) => void;
  private readonly onDiagCb?: (entry: DiagEntry) => void;
  private readonly onLevelCb?: (sample: { readonly raw: number; readonly at: number }) => void;
  private readonly onStatsCb?: (stats: SessionStats) => void;
  private readonly ring: DiagEntry[] = [];
  private readonly ringSize: number;
  private readonly pendingWrites = new Map<number, number>();

  private phaseValue: SessionPhase = 'idle';
  private queue: Task[] = [];
  private inflight: Inflight | null = null;
  private throttleTimer: unknown = null;
  private pollTimer: unknown = null;
  private pollingWanted = false;
  private inbound: Uint8Array = EMPTY;
  private counts = { outFrames: 0, inFrames: 0, crcErrors: 0, timeouts: 0, retries: 0, droppedPolls: 0 };
  private disposed = false;
  private statsScheduled = false;
  /** error 相位下 `write()` 只派发一次 disconnected（S-j） */
  private errorNotified = false;
  /** sync 代次：被新 sync 取代的旧 sync 不得再改相位 / 派发致命错误 */
  private syncGeneration = 0;
  /** sync 开头等老请求回包期间压住轮询：那时相位还是 ready，轮询会插进两轮之间 */
  private drainingSync = false;

  constructor(options: ParamSessionOptions) {
    this.send = options.send;
    this.clock = options.clock ?? defaultClock();
    this.timers = options.timers ?? defaultTimers();
    this.timing = { ...TIMING, ...options.timing };
    this.onPhaseCb = options.onPhase;
    this.onEchoCb = options.onEcho;
    this.onErrorCb = options.onError;
    this.onDiagCb = options.onDiag;
    this.onLevelCb = options.onLevel;
    this.onStatsCb = options.onStats;
    const requested = Math.floor(options.ringSize ?? DEFAULT_DIAG_RING);
    this.ringSize = Number.isFinite(requested) && requested >= 1 ? requested : DEFAULT_DIAG_RING;
  }

  phase(): SessionPhase {
    return this.phaseValue;
  }

  stats(): SessionStats {
    return {
      outFrames: this.counts.outFrames,
      inFrames: this.counts.inFrames,
      crcErrors: this.counts.crcErrors,
      timeouts: this.counts.timeouts,
      retries: this.counts.retries,
      droppedPolls: this.counts.droppedPolls,
      queueDepth: this.queue.length,
    };
  }

  diagnostics(): readonly DiagEntry[] {
    return this.ring.slice();
  }

  /**
   * 上电回读（S-e）：一条 `0x13` 读整段预设 + 一条 `0x12` 读设备信息。
   * 两条帧在同一个 FIFO 里按序排队，回读期间的写请求排在它们之后（R4-2）；
   * 若回读期间用 await 分两步入队，写请求会插到两条回读帧之间（C4 禁止）。
   */
  async sync(): Promise<{ readonly preset: PresetSnapshot; readonly device: DeviceSnapshot }> {
    if (this.disposed) throw new Error('参数会话已销毁');
    this.syncGeneration += 1;
    const generation = this.syncGeneration;
    // 总线空闲时 cancelWork 返回 null，sync 的开头保持同步执行（回读帧立刻发出）；
    // 只有在途请求需要等回包时才让出一次微任务，避免它的应答被本轮请求认领。
    this.drainingSync = true;
    const drain = this.cancelWork();
    if (drain !== null) {
      try {
        await drain;
      } finally {
        this.drainingSync = false;
      }
      if (this.disposed) throw new Error('参数会话已销毁');
      if (generation !== this.syncGeneration) throw new Error('同步已被新的同步请求取代');
    } else {
      this.drainingSync = false;
    }
    this.setPhase('syncing');

    let preset: PresetSnapshot | null = null;
    const pending = new Promise<{ preset: PresetSnapshot; device: DeviceSnapshot }>(
      (resolve, reject) => {
        const presetFrame = encodeFrame(
          FUNC_SEQ_READ,
          encodeSeqRead(PRESET_START, PRESET_COUNT),
        );
        this.queue.push(
          this.createTask({
            frame: presetFrame,
            expect: 'read',
            summary: `读 0x${hex(PRESET_START, 4)}..0x${hex(PRESET_START + PRESET_COUNT - 1, 4)} (${PRESET_COUNT})`,
            onOk: (replyFrame) => {
              if (replyFrame.func === FUNC_ACK) {
                reject(
                  transportFailure({
                    kind: 'len',
                    message: '设备对预设回读回了 ACK 成功但没有数据，无法组快照',
                  }),
                );
                return;
              }
              let parsed: ReadReply | RandReadReply | AckReply;
              try {
                parsed = parseReply(replyFrame);
              } catch (error) {
                reject(transportFailure({ kind: 'len', message: `预设回读应答解析失败：${String(error)}` }));
                return;
              }
              if (!isReadReply(parsed)) {
                reject(transportFailure({ kind: 'len', message: '预设回读应答不是连续读响应' }));
                return;
              }
              preset = this.collectPreset(parsed);
            },
            onFail: (error) => reject(transportFailure(error)),
          }),
        );

        const infoFrame = encodeFrame(FUNC_RAND_READ, encodeRandRead(SYNC_INFO_ADDRS));
        this.queue.push(
          this.createTask({
            frame: infoFrame,
            expect: 'read',
            summary: readSummary(SYNC_INFO_ADDRS),
            onOk: (replyFrame) => {
              if (replyFrame.func === FUNC_ACK) {
                reject(
                  transportFailure({
                    kind: 'len',
                    message: '设备对设备信息读回了 ACK 成功但没有数据，无法组快照',
                  }),
                );
                return;
              }
              let parsed: ReadReply | RandReadReply | AckReply;
              try {
                parsed = parseReply(replyFrame);
              } catch (error) {
                reject(transportFailure({ kind: 'len', message: `设备信息应答解析失败：${String(error)}` }));
                return;
              }
              if (!isRandReadReply(parsed)) {
                reject(transportFailure({ kind: 'len', message: '设备信息应答不是随机读响应' }));
                return;
              }
              if (preset === null) {
                reject(transportFailure({ kind: 'len', message: '回读序列不完整（预设段缺失）' }));
                return;
              }
              resolve({ preset, device: this.buildDeviceSnapshot(parsed.entries) });
            },
            onFail: (error) => reject(transportFailure(error)),
          }),
        );

        this.pump();
      },
    );

    let result: { preset: PresetSnapshot; device: DeviceSnapshot };
    try {
      result = await pending;
    } catch (error) {
      // 非致命失败（应答解析不了 / 设备用 ACK 终止回读）：回读是连接门禁，失败必须
      // 落到 error，否则会话永远停在 'syncing'，轮询也永远起不来。致命路径已自己进过 error。
      // kind 跟随原始错误（ACK 0x0005 → range、0x0004 → readOnly），别一律报 'len' 带偏排查方向。
      if (!this.disposed && generation === this.syncGeneration && this.phaseValue === 'syncing') {
        const original = (error as { transportError?: TransportError }).transportError;
        this.failFatal(
          original ?? {
            kind: 'len',
            message: `回读失败：${error instanceof Error ? error.message : String(error)}`,
          },
        );
      }
      throw error;
    }

    this.setPhase('ready');
    this.startPolling();
    return result;
  }
  /** 写请求；内部按 `writeThrottleMs` 合并窗口，调用方立即返回（S-b） */
  write(entries: readonly WordPair[]): void {
    if (this.disposed) return;
    if (this.phaseValue === 'error') {
      if (!this.errorNotified) {
        this.errorNotified = true;
        this.dispatchError({
          kind: 'disconnected',
          message: '会话处于 error 状态，写请求已丢弃；请重新同步',
        });
      }
      return;
    }
    let queued = false;
    for (const entry of entries) {
      this.pendingWrites.set(entry.addr, entry.raw);
      queued = true;
    }
    if (!queued) return;
    if (this.throttleTimer === null) {
      this.throttleTimer = this.timers.setTimeout(() => this.flushWrites(), this.timing.writeThrottleMs);
    }
    this.emitStats();
  }

  /**
   * 读若干地址（自检/单地址轮询复用）；在 `error` 相位直接拒绝（S-j）。
   * 设备用 `0x02 ACK_NO_ERR` 终止读请求时 resolve `{ entries: [] }`（"成功但没有数据"），
   * 不伪造地址与值；错误码则按 S-h/S-c 分流（可重试的 0x0001/0x0003 重试，其余 reject）。
   */
  read(addrs: readonly number[]): Promise<RandReadReply> {
    if (this.disposed) return Promise.reject(new Error('参数会话已销毁'));
    if (this.phaseValue === 'error') {
      return Promise.reject(
        transportFailure({ kind: 'disconnected', message: '会话处于 error 状态，读请求被拒绝' }),
      );
    }
    let frame: Uint8Array;
    let summary: string;
    try {
      frame = encodeFrame(FUNC_RAND_READ, encodeRandRead(addrs));
      summary = readSummary(addrs);
    } catch (error) {
      return Promise.reject(error as Error);
    }
    return new Promise<RandReadReply>((resolve, reject) => {
      this.queue.push(
        this.createTask({
          frame,
          expect: 'read',
          summary,
          onOk: (replyFrame) => {
            // S-h：`0x02 ACK_NO_ERR` 也能终止读请求——设备说"成功但没有数据"。
            // 用空 entries 表达，不伪造地址与值（3.2 自检用例依赖这个形态）。
            if (replyFrame.func === FUNC_ACK) {
              resolve({ entries: [] });
              return;
            }
            let parsed: ReadReply | RandReadReply | AckReply;
            try {
              parsed = parseReply(replyFrame);
            } catch (error) {
              reject(transportFailure({ kind: 'len', message: `应答解析失败：${String(error)}` }));
              return;
            }
            if (!isRandReadReply(parsed)) {
              reject(transportFailure({ kind: 'len', message: '应答不是随机读响应' }));
              return;
            }
            resolve(parsed);
          },
          onFail: (error) => reject(transportFailure(error)),
        }),
      );
      this.pump();
    });
  }

  setPolling(enabled: boolean): void {
    if (this.disposed) return;
    this.pollingWanted = enabled;
    if (enabled) this.startPolling();
    else this.stopPolling();
  }

  handleBytes(bytes: Uint8Array): void {
    if (this.disposed || bytes.length === 0) return;
    const input = concatBytes(this.inbound, bytes);
    const result = decodeStream(input);
    this.inbound = result.rest;
    for (const issue of result.issues) this.recordIssue(issue, input);
    for (const frame of result.frames) {
      this.counts.inFrames += 1;
      const described = describeInbound(frame);
      this.pushDiag({
        at: this.clock.now(),
        dir: 'in',
        hex: hexBytes(frameBytes(frame)),
        summary: described.summary,
        level: described.level,
      });
      this.handleFrame(frame);
    }
    this.emitStats();
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopPolling();
    this.clearThrottle();
    const inflight = this.inflight;
    if (inflight !== null) {
      this.clearInflightTimer(inflight);
      this.releaseInflight(inflight);
      // 被 sync 顶掉的请求已静默，别再让它走 disconnected 回调（它的 Promise 已无人等待）
      if (!inflight.abandoned) inflight.task.onFail({ kind: 'disconnected', message: '参数会话已销毁' });
    }
    const dropped = this.queue;
    this.queue = [];
    for (const task of dropped) task.onFail({ kind: 'disconnected', message: '参数会话已销毁' });
    this.pendingWrites.clear();
    this.inbound = EMPTY;
    this.disposed = true;
  }

  // ---- 队列与在途槽（S-a） ----

  private createTask(options: {
    readonly frame: Uint8Array;
    readonly expect: ReplyExpect;
    readonly summary: string;
    readonly poll?: boolean;
    readonly onOk: (frame: ParamFrame) => void;
    readonly onFail: (error: TransportError) => void;
  }): Task {
    return {
      frame: options.frame,
      reports: splitFrame(options.frame, PAYLOAD_BYTES),
      expect: options.expect,
      summary: options.summary,
      poll: options.poll ?? false,
      onOk: options.onOk,
      onFail: options.onFail,
    };
  }

  private pump(): void {
    if (this.disposed || this.inflight !== null || this.queue.length === 0) {
      this.emitStats();
      return;
    }
    if (this.phaseValue === 'error') {
      this.emitStats();
      return;
    }
    const task = this.queue.shift() as Task;
    this.inflight = { task, attempts: 0, timer: null, abandoned: false, drain: null, releaseDrain: null };
    this.sendAttempt();
    this.emitStats();
  }

  private sendAttempt(): void {
    const inflight = this.inflight;
    if (inflight === null || this.disposed) return;
    inflight.attempts += 1;
    const timeoutMs = inflight.task.poll ? this.timing.pollTimeoutMs : this.timing.requestTimeoutMs;
    inflight.timer = this.timers.setTimeout(() => this.onRequestTimeout(inflight), timeoutMs);
    this.counts.outFrames += 1;
    this.pushDiag({
      at: this.clock.now(),
      dir: 'out',
      hex: hexBytes(inflight.task.frame),
      summary: inflight.attempts > 1 ? `重发（第 ${inflight.attempts} 次）${inflight.task.summary}` : inflight.task.summary,
      level: inflight.attempts > 1 ? 'warn' : 'info',
    });
    this.sendReports(inflight.task.reports);
  }

  private sendReports(reports: readonly Uint8Array[]): void {
    let result: void | Promise<void>;
    try {
      result = this.send(reports);
    } catch (error) {
      this.failChannel(error);
      return;
    }
    if (result !== undefined && result !== null && typeof (result as PromiseLike<void>).then === 'function') {
      void (result as PromiseLike<void>).then(undefined, (error: unknown) => this.failChannel(error));
    }
  }

  private onRequestTimeout(inflight: Inflight): void {
    if (this.disposed || this.inflight !== inflight) return;
    inflight.timer = null;
    if (inflight.abandoned) {
      // 被 sync 顶掉的请求：只释放槽位，不重发（重发会让下一轮 sync 再收一条迟到应答）
      this.releaseInflight(inflight);
      this.emitStats();
      this.pump();
      return;
    }
    if (inflight.task.poll) {
      // S-f：轮询超时只丢本次，不重试、不改 phase
      this.counts.droppedPolls += 1;
      this.releaseInflight(inflight);
      this.pushDiag({
        at: this.clock.now(),
        dir: 'out',
        hex: hexBytes(inflight.task.frame),
        summary: `轮询超时丢弃本次：${inflight.task.summary}`,
        level: 'warn',
      });
      this.emitStats();
      this.pump();
      return;
    }
    this.counts.timeouts += 1;
    this.pushDiag({
      at: this.clock.now(),
      dir: 'out',
      hex: hexBytes(inflight.task.frame),
      summary: `超时未应答（第 ${inflight.attempts} 次）：${inflight.task.summary}`,
      level: 'warn',
    });
    this.retryOrFail({ kind: 'timeout', message: `请求超时：${inflight.task.summary}` });
  }

  private retryOrFail(error: TransportError): void {
    const inflight = this.inflight;
    if (inflight === null) return;
    if (inflight.abandoned) {
      // 已被 sync 顶掉：错误码也只当"总线回到空闲"，不重发、不派发
      this.releaseInflight(inflight);
      this.emitStats();
      this.pump();
      return;
    }
    if (inflight.attempts <= this.timing.requestRetries) {
      this.counts.retries += 1;
      this.clearInflightTimer(inflight);
      this.sendAttempt();
      this.emitStats();
      return;
    }
    this.failFatal(error);
  }

  // ---- 入站与应答归属（S-g / S-h） ----

  private handleFrame(frame: ParamFrame): void {
    // 设备主动上报（真机固件以 `0x10` 推 0x2057 实时电平）：它不属于任何在途请求，
    // 若按"当前没有在途请求"丢掉，电平表在真机上永远是静止的。
    if (frame.func === FUNC_RAND_WRITE) {
      this.handlePush(frame);
      return;
    }
    const inflight = this.inflight;
    if (inflight === null) {
      this.unexpectedFrame(frame, '当前没有在途请求');
      return;
    }
    // S-h：`0x02` ACK 可以终止任何在途请求。协议 A.2/A.3 里 ACK 是双向响应码，
    // 设备拒绝一次读（地址错/校验错/只读/超范围）同样回 `0x02`；不在这里接住，
    // 一次"读了不存在的地址"就会退化成 500 ms × 3 超时并把整条链路打成 error。
    if (frame.func === FUNC_ACK) {
      this.settleAck(frame);
      return;
    }
    if (inflight.task.expect === 'ack') {
      this.unexpectedFrame(frame, '在途请求为写（等 0x02）');
      return;
    }
    if (frame.func !== FUNC_RAND_READ && frame.func !== FUNC_SEQ_READ) {
      this.unexpectedFrame(frame, '在途请求为读（等 0x12/0x13）');
      return;
    }
    this.settle(frame);
  }

  /**
   * 设备主动上报帧：载荷与随机读应答同形（`addr + raw` 四字节一组），所以复用同一个解析器。
   * 0x2057 走电平回调，其余地址按"设备侧值已变"走 echo，让界面跟上设备自己的改动。
   */
  private handlePush(frame: ParamFrame): void {
    let parsed: ReadReply | RandReadReply | AckReply;
    try {
      parsed = parseReply({ unitId: frame.unitId, func: FUNC_RAND_READ, data: frame.data });
    } catch (error) {
      this.pushDiag({
        at: this.clock.now(),
        dir: 'in',
        hex: hexBytes(frameBytes(frame)),
        summary: `设备上报帧格式不符：${String(error)}`,
        level: 'error',
      });
      return;
    }
    if (!isRandReadReply(parsed)) return;
    for (const entry of parsed.entries) {
      if (entry.addr === LEVEL_ADDR) this.onLevelCb?.({ raw: entry.raw, at: this.clock.now() });
      else this.onEchoCb?.(entry.addr, entry.raw);
    }
  }

  private unexpectedFrame(frame: ParamFrame, detail: string): void {
    this.pushDiag({
      at: this.clock.now(),
      dir: 'in',
      hex: hexBytes(frameBytes(frame)),
      summary: `unexpected 帧 func 0x${hex(frame.func, 2)}：${detail}`,
      level: 'warn',
    });
  }

  private settleAck(frame: ParamFrame): void {
    let reply: ReadReply | RandReadReply | AckReply;
    try {
      reply = parseReply(frame);
    } catch (error) {
      this.completeWithError({
        kind: 'len',
        message: `ACK 帧格式不符：${String(error)}`,
      });
      return;
    }
    if (!isAckReply(reply)) {
      this.completeWithError({ kind: 'len', message: '应答不是 ACK' });
      return;
    }
    const code = reply.ack;
    if (code === ACK_NO_ERR) {
      // 正常完成；终止读请求时把 ACK 帧原样交给任务的 onOk 决定"空结果"还是"无数据即失败"
      this.settle(frame);
      return;
    }
    if (code === ACK_CHECKSUM_ERR || code === ACK_DEV_ADDR_ERR) {
      this.retryOrFail({
        kind: code === ACK_CHECKSUM_ERR ? 'crc' : 'addr',
        ack: code,
        message: `设备返回 ${ACK_TEXT[code] ?? '未知错误'}（0x${hex(code, 4)}）`,
      });
      return;
    }
    const mapped = ackToErrorCode(code);
    this.completeWithError({
      kind: mapped === null || mapped === 'crc' || mapped === 'addr' ? 'len' : mapped,
      ack: code,
      message: `设备返回 ${ACK_TEXT[code] ?? '未知错误'}（0x${hex(code, 4)}）`,
    });
  }

  private settle(frame: ParamFrame): void {
    const inflight = this.inflight;
    if (inflight === null) return;
    this.clearInflightTimer(inflight);
    this.releaseInflight(inflight);
    // 被 sync 顶掉的请求：应答归它，静默吞掉，别去 resolve 上一轮的 Promise
    if (!inflight.abandoned) inflight.task.onOk(frame);
    this.emitStats();
    this.pump();
  }

  /**
   * 非重试类失败（只读/超范围/长度错/格式不符）：完成该请求，不改 phase（S-c）。
   * 只有写请求派发全局 `onError`（UI 要提示「只读 / 超范围」）；读请求只把错误交给
   * Promise，别把设备的"这条数据读不出来"当成通道故障。
   */
  private completeWithError(error: TransportError): void {
    const inflight = this.inflight;
    if (inflight === null) return;
    this.clearInflightTimer(inflight);
    this.releaseInflight(inflight);
    if (inflight.abandoned) {
      // 被 sync 顶掉：拒绝 / 只读 / 超范围都只意味着"这条请求结束了"，不通知上一轮
      this.emitStats();
      this.pump();
      return;
    }
    this.pushDiag({
      at: this.clock.now(),
      dir: 'out',
      hex: hexBytes(inflight.task.frame),
      summary: `请求失败：${error.message}`,
      level: 'error',
    });
    inflight.task.onFail(error);
    if (inflight.task.expect === 'ack') this.dispatchError(error);
    this.emitStats();
    this.pump();
  }

  // ---- 致命错误与通道错误（S-d / S-l） ----

  private failFatal(error: TransportError): void {
    if (this.disposed) return;
    const inflight = this.inflight;
    if (inflight !== null) {
      this.clearInflightTimer(inflight);
      this.releaseInflight(inflight);
    }
    this.clearThrottle();
    this.pendingWrites.clear();
    this.stopPolling();
    const dropped = this.queue;
    this.queue = [];
    this.errorNotified = false;
    this.pushDiag({
      at: this.clock.now(),
      dir: 'out',
      hex: inflight === null ? '' : hexBytes(inflight.task.frame),
      summary: `进入 error：${error.message}`,
      level: 'error',
    });
    this.setPhase('error');
    // 被 sync 顶掉的在途请求已经静默收尾，别让它的 Promise 再走一遍 error
    if (inflight !== null && !inflight.abandoned) inflight.task.onFail(error);
    for (const task of dropped) task.onFail(error);
    this.dispatchError(error);
    this.emitStats();
  }

  private failChannel(cause: unknown): void {
    if (this.disposed) return;
    const message = cause instanceof Error ? cause.message : String(cause);
    this.failFatal({ kind: 'disconnected', message: `通道错误：${message}` });
  }

  // ---- 写合并与节流（S-b / §6.4） ----

  private clearThrottle(): void {
    if (this.throttleTimer !== null) {
      this.timers.clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
  }

  private flushWrites(): void {
    this.throttleTimer = null;
    if (this.disposed) return;
    if (this.pendingWrites.size === 0) return;
    const entries = [...this.pendingWrites.entries()].sort((left, right) => left[0] - right[0]);
    this.pendingWrites.clear();
    for (const group of groupWrites(entries)) this.queue.push(this.createWriteTask(group));
    this.emitStats();
    this.pump();
  }

  private createWriteTask(group: WriteGroup): Task {
    const merge = group.values.length >= 2;
    const data = merge
      ? encodeSeqWrite(group.start, group.values)
      : encodeRandWrite([{ addr: group.start, raw: group.values[0] }]);
    const frame = encodeFrame(merge ? FUNC_SEQ_WRITE : FUNC_RAND_WRITE, data);
    const summary = merge
      ? `写 0x${hex(group.start, 4)}..0x${hex(group.start + group.values.length - 1, 4)} (${group.values.length})`
      : writeSummary(group.start, group.values[0]);
    return this.createTask({
      frame,
      expect: 'ack',
      summary,
      onOk: () => undefined,
      onFail: () => undefined,
    });
  }

  // ---- 轮询（S-f） ----

  private startPolling(): void {
    if (this.disposed || !this.pollingWanted || this.phaseValue !== 'ready' || this.pollTimer !== null) return;
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.disposed) return;
    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = null;
      this.pollTick();
    }, this.timing.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer === null) return;
    this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private pollTick(): void {
    if (this.disposed || !this.pollingWanted || this.phaseValue !== 'ready' || this.drainingSync) return;
    // S-f：有待发写、队列非空或在途请求时低优先级轮询让位
    if (this.inflight !== null || this.queue.length > 0 || this.pendingWrites.size > 0) {
      this.counts.droppedPolls += 1;
      this.emitStats();
      this.schedulePoll();
      return;
    }
    const frame = encodeFrame(FUNC_RAND_READ, encodeRandRead([LEVEL_ADDR]));
    this.queue.push(
      this.createTask({
        frame,
        expect: 'read',
        summary: `读 0x${hex(LEVEL_ADDR, 4)}`,
        poll: true,
        onOk: (replyFrame) => this.deliverLevel(replyFrame),
        onFail: () => undefined,
      }),
    );
    this.pump();
    this.schedulePoll();
  }

  private deliverLevel(frame: ParamFrame): void {
    let parsed: ReadReply | RandReadReply | AckReply;
    try {
      parsed = parseReply(frame);
    } catch (error) {
      this.pushDiag({
        at: this.clock.now(),
        dir: 'in',
        hex: hexBytes(frameBytes(frame)),
        summary: `电平应答解析失败：${String(error)}`,
        level: 'error',
      });
      return;
    }
    if (!isRandReadReply(parsed)) return;
    const entry = parsed.entries.find((item) => item.addr === LEVEL_ADDR);
    if (!entry) return;
    this.onLevelCb?.({ raw: entry.raw, at: this.clock.now() });
  }

  // ---- 快照装配 ----

  private collectPreset(reply: ReadReply): PresetSnapshot {
    const values: Record<number, number> = {};
    reply.values.forEach((raw, index) => {
      values[reply.start + index] = raw;
    });
    // R4-8：0x2057 是实时电平，不是预设字段；不丢会把某一瞬间的电平存进预设
    delete values[LEVEL_ADDR];
    const preset: PresetSnapshot = { start: reply.start, values };
    for (const addr of Object.keys(values).map(Number).sort((left, right) => left - right)) {
      this.onEchoCb?.(addr, values[addr]);
    }
    return preset;
  }

  private buildDeviceSnapshot(entries: readonly WordPair[]): DeviceSnapshot {
    const words = new Map<number, number>();
    for (const entry of entries) words.set(entry.addr, entry.raw);
    return {
      modelCode: decodeAsciiWords(wordsOf(words, DEV_INFO.modelCode.addr, DEV_INFO.modelCode.words)),
      deviceName: decodeAsciiWords(wordsOf(words, DEV_INFO.deviceName.addr, DEV_INFO.deviceName.words)),
      firmware: {
        x: words.get(DEV_INFO.firmware.addr) ?? 0,
        y: words.get(DEV_INFO.firmware.addr + 1) ?? 0,
        z: words.get(DEV_INFO.firmware.addr + 2) ?? 0,
        build: words.get(DEV_INFO.firmware.addr + 3) ?? 0,
      },
      firmwareType: words.get(DEV_INFO.fwType.addr) ?? 0,
      vid: words.get(DEV_INFO.vid.addr) ?? 0,
      pid: words.get(DEV_INFO.pid.addr) ?? 0,
      serial: decodeAsciiWords(wordsOf(words, DEV_INFO.serial.addr, DEV_INFO.serial.words)),
      comErrAck: words.get(CONFIG.comErrAck) ?? 0,
    };
  }

  // ---- 诊断与统计（S-i / S-m） ----

  private recordIssue(issue: DecodeIssue, input: Uint8Array): void {
    const slice = input.subarray(issue.offset, Math.min(input.length, issue.offset + ISSUE_HEX_BYTES));
    if (issue.problem === 'crc') {
      this.counts.crcErrors += 1;
      this.pushDiag({
        at: this.clock.now(),
        dir: 'in',
        hex: hexBytes(slice),
        summary: `CRC 错：${issue.detail}`,
        level: 'error',
      });
      return;
    }
    this.pushDiag({
      at: this.clock.now(),
      dir: 'in',
      hex: hexBytes(slice),
      summary: `解析告警（${issue.problem}）：${issue.detail}`,
      level: 'warn',
    });
  }

  private pushDiag(entry: DiagEntry): void {
    if (this.disposed) return;
    this.ring.push(entry);
    while (this.ring.length > this.ringSize) this.ring.shift();
    this.onDiagCb?.(entry);
  }

  private dispatchError(error: TransportError): void {
    if (this.disposed) return;
    this.onErrorCb?.(error);
  }

  private emitStats(): void {
    if (this.disposed || this.statsScheduled || this.onStatsCb === undefined) return;
    this.statsScheduled = true;
    queueMicrotask(() => {
      this.statsScheduled = false;
      if (this.disposed) return;
      this.onStatsCb?.(this.stats());
    });
  }

  private setPhase(next: SessionPhase): void {
    if (this.phaseValue === next) return;
    this.phaseValue = next;
    if (next !== 'error') this.errorNotified = false;
    if (this.disposed) return;
    this.onPhaseCb?.(next);
  }

  // ---- 生命周期辅助 ----

  private clearInflightTimer(inflight: Inflight): void {
    if (inflight.timer === null) return;
    this.timers.clearTimeout(inflight.timer);
    inflight.timer = null;
  }

  /**
   * 重新 sync 前清场（S-j 的"重连"语义）：尚未发出的队列、待发表与定时器可以直接丢，
   * **但已经发到总线上的那一条不能丢**——协议帧里没有请求序号，丢掉在途请求会把它的
   * 应答留给下一条请求认领。这里把在途请求标记为 abandoned，等它回包或超时释放槽位，
   * 返回的 Promise 兑现时总线才是干净的，新 sync 的帧才能发；总线本来就空闲时返回 null。
   */
  private cancelWork(): Promise<void> | null {
    this.stopPolling();
    this.clearThrottle();
    this.pendingWrites.clear();
    const interrupted: TransportError = { kind: 'disconnected', message: '请求被新的同步请求中断' };
    const dropped = this.queue;
    this.queue = [];
    for (const task of dropped) task.onFail(interrupted);
    const inflight = this.inflight;
    if (inflight === null) {
      this.emitStats();
      return null;
    }
    if (inflight.drain !== null) return inflight.drain;
    inflight.abandoned = true;
    inflight.drain = new Promise<void>((resolve) => {
      inflight.releaseDrain = resolve;
    });
    // 老请求的 Promise 现在就以"被中断"结束（S-j），但它的帧已经上了总线：
    // 应答到达时只用来释放槽位、不回调 onOk，否则会把老一轮的数据写进新一轮。
    inflight.task.onFail(interrupted);
    this.emitStats();
    return inflight.drain;
  }

  /** 释放在途槽位；被 abandon 的请求在这里兑现「总线已空闲」的等待 */
  private releaseInflight(inflight: Inflight): void {
    if (this.inflight === inflight) this.inflight = null;
    const release = inflight.releaseDrain;
    inflight.releaseDrain = null;
    release?.();
  }
}

/** 按 addr 升序把同批写分组：预设区内连续（+1）的相邻地址合成一组（S-b / §6.4） */
function groupWrites(entries: readonly (readonly [number, number])[]): WriteGroup[] {
  const groups: WriteGroup[] = [];
  let current: { start: number; last: number; values: number[] } | null = null;
  for (const [addr, raw] of entries) {
    const mergeable =
      current !== null && isPresetAddr(current.last) && isPresetAddr(addr) && addr === current.last + 1;
    if (mergeable && current !== null) {
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
