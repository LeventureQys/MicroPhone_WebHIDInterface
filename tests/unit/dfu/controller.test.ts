import { describe, expect, it } from 'vitest';
import { PAYLOAD_BYTES, splitFrame } from '../../../src/renderer/src/device/protocol';
import { ACK_NO_ERR, encodeAck } from '../../../src/renderer/src/device/proto/codec';
import { FUNC_ACK, FUNC_RAND_WRITE, decodeStream, encodeFrame } from '../../../src/renderer/src/device/proto/frame';
import type { DeviceSnapshot, DiagEntry } from '../../../src/renderer/src/device/proto/session';
import { TIMING, type Clock, type Timers } from '../../../src/renderer/src/device/proto/timing';
import {
  DFU_CMD_BLOCK,
  DFU_CMD_INFO,
  DFU_CMD_STATUS,
  DFU_STATUS_CONTINUE,
  DFU_STATUS_FAIL,
  DFU_STATUS_SUCCESS,
  SIGMA_CMD_DFU,
  decodeSigmaStream,
  encodeSigmaFrame,
} from '../../../src/renderer/src/device/dfu/frame';
import {
  BLOCK_BYTES,
  encodeBlockFrame,
  encodeInfoFrame,
  gammaEncrypt,
  sum32LittleEndianWords,
  type DfuInfo,
} from '../../../src/renderer/src/device/dfu/image';
import {
  CLOSE_BLOCKED_DETAIL,
  FirmwareController,
  type FirmwareChannel,
  type FirmwareLink,
} from '../../../src/renderer/src/device/dfu/controller';
import type { LinkState } from '../../../src/renderer/src/device/link';
import type { WebHidDeviceHandle } from '../../../src/renderer/src/device/webhid/types';

// ---- 假时钟 ----

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

function plainBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

interface BuildOptions {
  readonly modelCode?: string;
  readonly modelName?: string;
  readonly version?: { readonly x: number; readonly y: number; readonly z: number };
}

/** 厂商包：EnterDfu(参数写帧) + Info(90 B) + N×Block，与 4.1 的 parseImage 同构 */
function buildPackage(plain: Uint8Array, options: BuildOptions = {}): Uint8Array {
  const cipher = gammaEncrypt(plain);
  const blocks: Uint8Array[] = [];
  for (let offset = 0; offset < cipher.length; offset += BLOCK_BYTES) {
    blocks.push(cipher.slice(offset, Math.min(offset + BLOCK_BYTES, cipher.length)));
  }
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const info: DfuInfo = {
    modelCode: options.modelCode ?? '000000',
    modelName: options.modelName ?? '000000',
    version: options.version ?? { x: 0, y: 0, z: 0 },
    length: total,
    checksum: sum32LittleEndianWords(plain),
  };
  return concat([
    encodeSigmaFrame(0x03, new Uint8Array([0x08, 0x10, 0x01, 0x00])),
    encodeInfoFrame(info),
    ...blocks.map((block) => encodeBlockFrame(block)),
  ]);
}

const PLAIN = plainBytes(1024);
const BLOCK_TOTAL = 4;
const PKG = buildPackage(PLAIN, { modelCode: 'JYM001', modelName: 'M001', version: { x: 1, y: 2, z: 3 } });
const BOOT_PKG = buildPackage(PLAIN, { modelCode: 'Bootld', modelName: '000000' });

/** 假设备：把控制器发出的报文还原成帧，按计划回状态帧；所有动作记进同一条时间线 */
class FakeChannel implements FirmwareChannel {
  readonly reportIds = { out: 0x51, in: 0x11 };
  readonly device: WebHidDeviceHandle;
  respondEnter = true;
  respondInfo: (round: number) => number | null = () => DFU_STATUS_CONTINUE;
  respondBlock: (index: number, round: number) => number | null = (index) =>
    index === BLOCK_TOTAL - 1 ? DFU_STATUS_SUCCESS : DFU_STATUS_CONTINUE;

  private readonly listeners = new Set<(bytes: Uint8Array) => void>();
  private pending: Uint8Array = new Uint8Array(0);
  private round = 0;
  private blockIndex = -1;

  constructor(private readonly timeline: string[]) {
    this.device = {
      vendorId: 0x352f,
      productId: 0x0111,
      opened: true,
      open: async (): Promise<void> => undefined,
      close: async (): Promise<void> => undefined,
      sendReport: async (_reportId: number, data: Uint8Array): Promise<void> => {
        this.feed(data);
      },
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    };
  }

  onInputBytes(cb: (bytes: Uint8Array) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(frame: Uint8Array): void {
    for (const report of splitFrame(frame, PAYLOAD_BYTES)) {
      for (const cb of [...this.listeners]) cb(report);
    }
  }

  private feed(report: Uint8Array): void {
    const bytes = concat([this.pending, report]);
    if (bytes[0] === 0x00) {
      // 进 DFU 走参数协议：一条 10 B 帧 + 补零，全在一条报告里
      const decoded = decodeStream(bytes);
      this.pending = new Uint8Array(0);
      for (const frame of decoded.frames) {
        if (frame.func !== FUNC_RAND_WRITE) continue;
        this.timeline.push('send:enter');
        if (this.respondEnter) this.emit(encodeFrame(FUNC_ACK, encodeAck(ACK_NO_ERR)));
      }
      return;
    }
    const decoded = decodeSigmaStream(bytes);
    this.pending = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.data[0] === DFU_CMD_INFO) {
        this.round += 1;
        this.blockIndex = -1;
        this.timeline.push('send:info');
        const status = this.respondInfo(this.round);
        if (status !== null) this.emit(statusFrame(status));
        continue;
      }
      if (frame.data[0] !== DFU_CMD_BLOCK) continue;
      this.blockIndex += 1;
      this.timeline.push(`send:block:${this.blockIndex}`);
      const status = this.respondBlock(this.blockIndex, this.round);
      if (status !== null) this.emit(statusFrame(status));
    }
  }
}

function statusFrame(status: number): Uint8Array {
  return encodeSigmaFrame(SIGMA_CMD_DFU, new Uint8Array([DFU_CMD_STATUS, 0x00, status]));
}

function snapshot(firmware: { x: number; y: number; z: number; build: number }): DeviceSnapshot {
  return {
    modelCode: 'JYM001',
    deviceName: 'MIC M001',
    firmware,
    firmwareType: 0,
    vid: 0x352f,
    pid: 0x0111,
    serial: 'VHID-MIC-M001',
    comErrAck: 0,
  };
}

class FakeLink implements FirmwareLink {
  channel: FakeChannel | null;
  device: DeviceSnapshot | null = snapshot({ x: 1, y: 1, z: 0, build: 0 });
  deviceId: string | null = 'mic-m001';
  /** resume 之后设备回读到的版本（默认就是镜像版本 → verify 通过） */
  versionAfterResume = { x: 1, y: 2, z: 3, build: 0 };

  constructor(
    private readonly timeline: string[],
    channel: FakeChannel,
  ) {
    this.channel = channel;
  }

  transport(): FirmwareChannel | null {
    return this.channel;
  }

  getState(): LinkState {
    return {
      status: 'ready',
      mode: 'virtual',
      deviceId: this.deviceId,
      sync: 'ready',
      error: null,
      errorCode: null,
      device: this.device,
      warning: null,
    };
  }

  async suspendForDfu(): Promise<void> {
    this.timeline.push('suspend');
  }

  async resumeAfterDfu(): Promise<void> {
    this.timeline.push('resume');
    this.device = snapshot(this.versionAfterResume);
  }

  async attach(deviceId: string): Promise<void> {
    this.timeline.push(`attach:${deviceId}`);
    this.deviceId = deviceId;
  }
}

interface Harness {
  readonly controller: FirmwareController;
  readonly link: FakeLink;
  readonly channel: FakeChannel;
  readonly timeline: string[];
  readonly clock: FakeClock;
  readonly timers: FakeTimers;
  readonly diags: DiagEntry[];
}

const diags: DiagEntry[] = [];

function makeHarness(options: { readonly withChannel?: boolean } = {}): Harness {
  closeHandlers.length = 0;
  diags.length = 0;
  const timeline: string[] = [];
  const channel = new FakeChannel(timeline);
  const link = new FakeLink(timeline, channel);
  if (options.withChannel === false) link.channel = null;
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const controller = new FirmwareController({
    link,
    readFile: async (file: File): Promise<Uint8Array> => new Uint8Array(await file.arrayBuffer()),
    timers,
    clock,
    setDfuActive: (active: boolean): void => {
      timeline.push(`dfuActive:${active}`);
    },
    onDiag: (entry) => diags.push(entry),
    onCloseBlocked: (cb: () => void): (() => void) => {
      closeHandlers.push(cb);
      return () => {
        const index = closeHandlers.indexOf(cb);
        if (index >= 0) closeHandlers.splice(index, 1);
      };
    },
  });
  return { controller, link, channel, timeline, clock, timers, diags };
}

const closeHandlers: Array<() => void> = [];

function fileOf(bytes: Uint8Array, name = 'app.bin'): File {
  return new File([bytes], name, { type: 'application/octet-stream' });
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('FirmwareController', () => {
  it('1. selectFile 对 Bootld 包返回 internalOnly，且 start() 不可用（R6-9）', async () => {
    const h = makeHarness();
    const result = await h.controller.selectFile(fileOf(BOOT_PKG, 'bootld.bin'));
    expect(result).toEqual({ ok: false, message: 'fw.error.internalOnly' });
    expect(h.controller.state().info).toBeNull();
    expect(h.timeline).toEqual([]);
    await expect(h.controller.start()).rejects.toThrow('no firmware selected');
    expect(h.timeline).toEqual([]);
  });

  it('2. 未确认时 start() 抛错且零出帧', async () => {
    const h = makeHarness();
    const selected = await h.controller.selectFile(fileOf(PKG));
    expect(selected.ok).toBe(true);
    expect(h.controller.state().phase).toBe('ready');
    await expect(h.controller.start()).rejects.toThrow('confirmation required');
    expect(h.timeline).toEqual([]);
    expect(h.controller.state().phase).toBe('ready');
  });

  it('3. 确认后按 suspend → setDfuActive(true) → run → resume → setDfuActive(false) 执行', async () => {
    const h = makeHarness();
    await h.controller.selectFile(fileOf(PKG));
    h.controller.setConfirmed(true);
    const run = h.controller.start();
    await settle();
    await run;

    expect(h.timeline).toEqual([
      'suspend',
      'dfuActive:true',
      'send:enter',
      'send:info',
      'send:block:0',
      'send:block:1',
      'send:block:2',
      'send:block:3',
      'resume',
      'dfuActive:false',
    ]);
    expect(h.controller.state().phase).toBe('done');
    expect(h.controller.state().error).toBeNull();
    expect(h.controller.state().info?.version).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('4. 失败路径也一定调用 setDfuActive(false)（try/finally）', async () => {
    const h = makeHarness();
    h.channel.respondInfo = () => null;
    await h.controller.selectFile(fileOf(PKG));
    h.controller.setConfirmed(true);
    const run = h.controller.start();
    await settle();
    for (let attempt = 0; attempt < TIMING.dfuProbeAttempts; attempt += 1) {
      h.timers.advance(TIMING.dfuProbeTimeoutMs);
      await settle();
    }
    await run;

    expect(h.controller.state().phase).toBe('failed');
    expect(h.controller.state().error?.kind).toBe('probeFailed');
    expect(h.timeline).toContain('dfuActive:true');
    expect(h.timeline).toContain('dfuActive:false');
    expect(h.timeline.at(-1)).toBe('dfuActive:false');
    expect(h.timeline).not.toContain('resume');
  });

  it('5. 版本不一致 → verify 失败，但设备已回到正常工作模式', async () => {
    const h = makeHarness();
    h.link.versionAfterResume = { x: 1, y: 2, z: 4, build: 0 };
    await h.controller.selectFile(fileOf(PKG));
    h.controller.setConfirmed(true);
    const run = h.controller.start();
    await settle();
    await run;

    expect(h.controller.state().phase).toBe('failed');
    expect(h.controller.state().error?.kind).toBe('verify');
    expect(h.controller.state().error?.detail).toContain('1.2.4');
    expect(h.timeline).toContain('resume');
    expect(h.timeline.at(-1)).toBe('dfuActive:false');
  });

  it('3b. DFU 帧诊断经 onDiag 上抛（与参数帧共用同一个诊断 hub）', async () => {
    const h = makeHarness();
    await h.controller.selectFile(fileOf(PKG));
    h.controller.setConfirmed(true);
    const run = h.controller.start();
    await settle();
    await run;

    const summaries = h.diags.map((entry) => entry.summary);
    expect(summaries.some((line) => line.startsWith('EnterDfu 0x1008=1'))).toBe(true);
    expect(summaries.some((line) => line.startsWith('DFU info len=1024'))).toBe(true);
    expect(summaries).toContain('DFU block 1/4');
    expect(summaries).toContain('DFU status 0x05 SUCCESS');
  });

  it('5b. 未连设备时 selectFile 直接失败且零出帧；关窗拦截只提示不改 phase', async () => {
    const offline = makeHarness({ withChannel: false });
    const result = await offline.controller.selectFile(fileOf(PKG));
    expect(result).toEqual({ ok: false, message: 'fw.error.noDevice' });
    expect(offline.timeline).toEqual([]);

    const h = makeHarness();
    // 第 1 轮第 2 块不回执：让流程停在 writing，好在"升级中"注入关窗事件
    h.channel.respondBlock = (index, round) => {
      if (round === 1 && index === 1) return null;
      return index === BLOCK_TOTAL - 1 ? DFU_STATUS_SUCCESS : DFU_STATUS_CONTINUE;
    };
    await h.controller.selectFile(fileOf(PKG));
    h.controller.setConfirmed(true);
    const run = h.controller.start();
    await settle();
    expect(h.controller.state().phase).toBe('writing');
    expect(closeHandlers).toHaveLength(1);

    closeHandlers.forEach((cb) => cb());
    expect(h.controller.state().phase).toBe('writing');
    expect(h.controller.state().error).toEqual({ kind: 'channel', detail: CLOSE_BLOCKED_DETAIL });

    h.timers.advance(TIMING.dfuBlockTimeoutMs);
    await settle();
    await run;
    expect(h.controller.state().phase).toBe('done');
    expect(h.controller.state().error).toBeNull();
  });

  it('6. 失败后不 reset、不再勾确认也能重试成功（设备停在 bootloader，EnterDfu 无人应答）', async () => {
    const h = makeHarness();
    // 第 1 轮第 2 块回 0x04 → statusFail（设备随即停在 bootloader）
    h.channel.respondBlock = (index, round) => {
      if (round === 1 && index === 1) return DFU_STATUS_FAIL;
      return index === BLOCK_TOTAL - 1 ? DFU_STATUS_SUCCESS : DFU_STATUS_CONTINUE;
    };
    await h.controller.selectFile(fileOf(PKG));
    h.controller.setConfirmed(true);
    const first = h.controller.start();
    await settle();
    await first;
    expect(h.controller.state().phase).toBe('failed');
    expect(h.controller.state().error?.kind).toBe('statusFail');
    expect(h.controller.state().confirmed).toBe(true);

    // 重试：bootloader 里没有参数协议，EnterDfu 不再有 ACK；外部不做任何 reset
    h.channel.respondEnter = false;
    h.timeline.length = 0;
    const retry = h.controller.start();
    await settle();
    h.timers.advance(TIMING.requestTimeoutMs);
    await settle();
    h.timers.advance(TIMING.requestTimeoutMs);
    await settle();
    await retry;

    expect(h.controller.state().phase).toBe('done');
    expect(h.controller.state().error).toBeNull();
    // 两次 EnterDfu 都超时，靠信息帧进入 writing 并跑完
    expect(h.timeline).toEqual([
      'suspend',
      'dfuActive:true',
      'send:enter',
      'send:enter',
      'send:info',
      'send:block:0',
      'send:block:1',
      'send:block:2',
      'send:block:3',
      'resume',
      'dfuActive:false',
    ]);
  });
});
