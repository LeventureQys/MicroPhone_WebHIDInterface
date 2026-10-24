/**
 * DFU 会话状态机（R6）：预检 → 进 DFU → 探测 → 逐块写入 → 收尾 → 验证。
 *
 * 这里没有 DOM、没有文案、没有业务状态：进度只发 i18n 键，失败只发结构化 `DfuError`，
 * 由 `FirmwareController`（4.2 阶段二）决定怎么说。定时能力全部走注入的 `Timers` / `Clock` / `TIMING`，
 * 单测能把 1.5 s 的块超时推到毫秒级，业务代码里没有裸的 `setTimeout` / `Date.now`（C8）。
 *
 * 两条最容易写坏的硬约束（DFU 材料 §6）：
 * 1. `preflight` 一帧都不发 —— 能变砖的输入（长度越界 / 校验和不符 / 型号不符）必须在发帧前拒绝；
 * 2. 歧义态（块超时 / `0x02` / SigmaBus ACK 校验错）只能"重发信息帧整轮重来"，绝不补发单块：
 *    协议里没有序号也没有回读，补发会让 Flash 指针与主机的认知错位（DFU 材料 §6 ⑪）。
 *
 * 通道前后是两套协议：进 DFU 走参数协议（App 还在跑，`0x1008=1`），进 DFU 之后只认 SigmaBus
 * （Bootloader 侧，`CMD 0x0B`）。所以 `handleBytes` 按当前阶段选解码器，见 `handleBytes` 注释。
 */
import { PAYLOAD_BYTES, splitFrame } from '../protocol';
import { ACK_NO_ERR, encodeRandWrite } from '../proto/codec';
import { FUNC_ACK, FUNC_RAND_WRITE, decodeStream, encodeFrame } from '../proto/frame';
import type { DiagEntry } from '../proto/session';
import { TIMING, defaultClock, defaultTimers, type Clock, type Timers } from '../proto/timing';
import {
  DFU_STATUS_CODE_ERR,
  DFU_STATUS_CONTINUE,
  DFU_STATUS_FAIL,
  DFU_STATUS_INFO_ERR,
  DFU_STATUS_SUCCESS,
  SIGMA_ACK_CHECKSUM_ERR,
  SIGMA_ACK_DEV_ADDR_ERR,
  SIGMA_ACK_LEN_ERR,
  decodeDfuStatus,
  decodeSigmaAck,
  decodeSigmaStream,
  encodeDfuInfoFrame,
  encodeSigmaFrame,
  type SigmaFrame,
} from './frame';
import {
  BOOT_MODEL_CODE,
  GAMMA_BYTES,
  encodeBlockFrame,
  parseImage,
  type DfuInfo,
  type ImageRejection,
  type ParsedImage,
} from './image';

export type DfuPhase =
  | 'idle'
  | 'preflight'
  | 'ready'
  | 'entering'
  | 'probing'
  | 'writing'
  | 'settling'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'aborted';

export interface DfuProgress {
  readonly phase: DfuPhase;
  /** 当前块下标，0 起；`blockTotal - 1` 表示末块 */
  readonly blockIndex: number;
  readonly blockTotal: number;
  /** 0..100，按设计 §6.7 的权重：进入 5 / 探测 5 / 写入 85 / 收尾验证 5 */
  readonly percent: number;
  /** 第几轮（从 1 起）；歧义态整轮重来会 +1 */
  readonly round: number;
  /** i18n 键，`fw.phase.<phase>` */
  readonly message: string;
}

export interface DfuError {
  readonly kind:
    | 'preflight'
    | 'enterTimeout'
    | 'probeFailed'
    | 'statusCode'
    | 'statusInfo'
    | 'statusFail'
    | 'timeout'
    | 'restartExhausted'
    | 'settle'
    | 'verify'
    | 'channel';
  readonly status?: number;
  readonly round?: number;
  readonly blockIndex?: number;
  readonly detail?: string;
}

export interface DfuSessionOptions {
  /** 出站：一帧已切好的 63 B 报文按顺序调用；返回 Promise 用于背压，抛错视为通道错误 */
  readonly send: (reports: readonly Uint8Array[]) => void | Promise<void>;
  readonly timers?: Timers;
  readonly clock?: Clock;
  readonly timing?: Partial<typeof TIMING>;
  /** 当前设备型号码（`DeviceLink` 的 `DeviceSnapshot.modelCode`）；拿不到返回 null */
  readonly deviceModelCode: () => string | null;
  /** R6-9：`Bootld` 包默认拒绝，只有自检脚本与单测可以传 true（消费级界面没有这个开关） */
  readonly allowBootld?: boolean;
  readonly onProgress?: (progress: DfuProgress) => void;
  readonly onError?: (error: DfuError) => void;
  readonly onDiag?: (entry: DiagEntry) => void;
}

export type DfuPreflightResult =
  | { readonly ok: true; readonly info: DfuInfo; readonly blocks: number; readonly encrypted: boolean }
  | { readonly ok: false; readonly rejection: ImageRejection };

/** `complete()` 的入参：版本回读由调用方做，结论回传到这里（见文件末 `complete` 注释） */
export interface DfuCompletion {
  readonly ok: boolean;
  readonly detail?: string;
}

/** 进 DFU 是参数写 `0x1008=1`：这是唯一在 App 模式下发的一帧 */
const ENTER_DFU_ADDR = 0x1008;
const ENTER_DFU_VALUE = 0x0001;
/** 首发 + 重发 1 次：ACK 只证明"帧被处理了"，不能证明换了模式（DFU 材料 §2.1/§6 ⑬） */
const ENTER_DFU_ATTEMPTS = 2;
/** 通用镜像：设备侧不校验型号，主机侧也不必匹配 */
const WILDCARD_MODEL_CODE = '000000';

/** 设计 §6.7：进入 5 + 探测 5 + 写入 85 + 收尾验证 5 */
const ENTER_POINTS = 5;
const PROBE_POINTS = 5;
const WRITE_POINTS = 85;
const SETTLE_POINTS = 5;

const STATUS_TEXT: Readonly<Record<number, string>> = Object.freeze({
  [DFU_STATUS_INFO_ERR]: 'INFO_ERR',
  [DFU_STATUS_CODE_ERR]: 'CODE_ERR',
  [DFU_STATUS_CONTINUE]: 'CONTINUE',
  [DFU_STATUS_FAIL]: 'FAIL',
  [DFU_STATUS_SUCCESS]: 'SUCCESS',
});

const SIGMA_ACK_TEXT: Readonly<Record<number, string>> = Object.freeze({
  [SIGMA_ACK_DEV_ADDR_ERR]: 'DEV_ADDR_ERR',
  [SIGMA_ACK_LEN_ERR]: 'LEN_ERR',
  [SIGMA_ACK_CHECKSUM_ERR]: 'CHECKSUM_ERR',
});

const EMPTY = new Uint8Array(0);

/** 预检内部拒绝原因：`ImageRejection.problem` 是 4.1 的封闭枚举，细分类别只能走 `detail.reason` */
const REASON_BOOTLD = 'bootld';
const REASON_UNKNOWN_DEVICE = 'unknown-device';
const REASON_MISMATCH = 'mismatch';

function hex(value: number, digits: number): string {
  return (value >>> 0).toString(16).toUpperCase().padStart(digits, '0');
}

function hexBytes(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const byte of bytes) parts.push(hex(byte, 2));
  return parts.join(' ');
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

type SlotKind = 'ack' | 'status';

type SlotResult =
  | { readonly kind: 'value'; readonly value: number }
  | { readonly kind: 'ackError'; readonly err: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' };

type ExchangeResult = SlotResult | { readonly kind: 'channel'; readonly detail: string };

interface Slot {
  readonly kind: SlotKind;
  readonly timer: unknown;
  readonly resolve: (result: SlotResult) => void;
}

/** 单步结论；`playRound` 不会返回 `ok`，用 `RoundStep` 收窄 */
type Step =
  | { readonly kind: 'ok' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failed'; readonly error: DfuError }
  | { readonly kind: 'restart'; readonly reason: string }
  | { readonly kind: 'settled' };

/**
 * 进 DFU 阶段的结论：`noAck` 不是失败（设备可能已经在 Bootloader 里，那一帧没人答），
 * 由后续的信息帧探测定案；只有通道错误才在这里失败。
 */
type EnterOutcome =
  | { readonly kind: 'acked' }
  | { readonly kind: 'noAck'; readonly detail: string }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failed'; readonly error: DfuError };

type RoundStep = Exclude<Step, { readonly kind: 'ok' }>;

function isRunningPhase(phase: DfuPhase): boolean {
  return (
    phase === 'entering' || phase === 'probing' || phase === 'writing' || phase === 'settling' || phase === 'verifying'
  );
}

/** 前 8 KB 是 Gamma 密文：`parseImage` 已给出密文与明文，二者不等就说明这块确实被加密过 */
function isGammaEncrypted(image: ParsedImage): boolean {
  const limit = Math.min(image.cipher.length, GAMMA_BYTES) & ~3;
  for (let i = 0; i < limit; i += 1) {
    if (image.cipher[i] !== image.plain[i]) return true;
  }
  return false;
}

export class DfuSession {
  private readonly send: DfuSessionOptions['send'];
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly timing: typeof TIMING;
  private readonly deviceModelCode: () => string | null;
  private readonly allowBootld: boolean;
  private readonly onProgressCb?: (progress: DfuProgress) => void;
  private readonly onErrorCb?: (error: DfuError) => void;
  private readonly onDiagCb?: (entry: DiagEntry) => void;

  private phaseValue: DfuPhase = 'idle';
  private image: ParsedImage | null = null;
  private inbound: Uint8Array = EMPTY;

  private round = 1;
  private blockIndex = 0;
  private blockTotal = 0;
  private sentBlocks = 0;
  private enterDone = false;
  private probeDone = false;
  private settleDone = false;

  private slot: Slot | null = null;
  private settleTimer: unknown = null;
  private disposed = false;

  constructor(options: DfuSessionOptions) {
    this.send = options.send;
    this.clock = options.clock ?? defaultClock();
    this.timers = options.timers ?? defaultTimers();
    this.timing = { ...TIMING, ...options.timing };
    this.deviceModelCode = options.deviceModelCode;
    this.allowBootld = options.allowBootld === true;
    this.onProgressCb = options.onProgress;
    this.onErrorCb = options.onError;
    this.onDiagCb = options.onDiag;
  }

  phase(): DfuPhase {
    return this.phaseValue;
  }

  /**
   * 仅预检，不发任何帧（R6-2/R6-3 的"拒绝且不发帧"全靠这个边界保证）。
   * 成功把 phase 推到 `ready` 并缓存镜像；失败推到 `failed` 并派发 `onError({kind:'preflight'})`。
   *
   * 拒绝共三类，`ImageRejection.problem` 都用 `modelMissing`（4.1 的枚举里没有"不匹配"这一项），
   * 具体类别看 `rejection.detail.reason`：`bootld` / `unknown-device` / `mismatch`。
   */
  preflight(bytes: Uint8Array): DfuPreflightResult {
    if (isRunningPhase(this.phaseValue)) throw new Error('dfu already running');
    this.image = null;
    this.transition('preflight');

    const parsed = parseImage(bytes);
    if (!parsed.ok) return this.rejectPreflight(parsed.rejection);

    const image = parsed.image;
    const info = image.info;

    if (info.modelCode === BOOT_MODEL_CODE) {
      // R6-9：Bootld 包能把设备刷成"只会进 Bootloader"，消费级入口不提供
      if (!this.allowBootld) {
        return this.rejectPreflight(this.modelRejection(REASON_BOOTLD, info, '固件包是 Bootloader 镜像'));
      }
    } else if (info.modelCode !== WILDCARD_MODEL_CODE) {
      const deviceModel = this.deviceModelCode();
      if (deviceModel === null) {
        return this.rejectPreflight(
          this.modelRejection(REASON_UNKNOWN_DEVICE, info, '拿不到当前设备的型号码'),
        );
      }
      if (deviceModel !== info.modelCode) {
        return this.rejectPreflight(
          this.modelRejection(REASON_MISMATCH, info, `设备型号码 ${deviceModel} 与镜像型号码 ${info.modelCode} 不一致`, deviceModel),
        );
      }
    }

    this.image = image;
    this.blockTotal = image.blocks.length;
    this.blockIndex = 0;
    this.sentBlocks = 0;
    this.enterDone = false;
    this.probeDone = false;
    this.settleDone = false;
    this.round = 1;
    this.inbound = EMPTY;
    this.transition('ready');
    return { ok: true, info, blocks: image.blocks.length, encrypted: isGammaEncrypted(image) };
  }

  /**
   * 完整流程。`0x05` 到达（进入 `settling`）即 resolve —— 收尾重连与版本回读属于调用方，
   * 回读结束后调用 `complete()` 把 phase 推到 `done`。
   * 失败 reject(`Error`) 并**已**派发 `onError`；`abort()` 触发的 reject 不派发 `onError`（不是错误）。
   */
  async run(bytes: Uint8Array): Promise<void> {
    // 'idle' 也算可调用：`run` 自己会做一遍预检（谁都不想因为"少调了一次 preflight"就刷错固件），
    // 真正要挡的是"已经在跑"（entering/probing/writing/settling/verifying）
    if (this.phaseValue !== 'idle' && this.phaseValue !== 'preflight' && this.phaseValue !== 'ready') {
      throw new Error('dfu already running');
    }
    if (this.disposed) throw new Error('dfu session disposed');

    const prepared = this.preflight(bytes);
    if (!prepared.ok) throw new Error(`dfu preflight failed: ${prepared.rejection.message}`);
    const image = this.image;
    if (image === null) throw new Error('dfu image missing after preflight');

    this.transition('entering');
    const entered = await this.enterDfu();
    if (entered.kind === 'aborted') throw new Error('dfu aborted');
    if (entered.kind === 'failed') {
      this.reportFailure(entered.error);
      throw new Error(`dfu ${entered.error.kind}`);
    }
    // ACK 只说明"帧被处理了"，不证明换了模式（DFU 材料 §2.1/§6 ⑬）。
    // 反过来"没有 ACK"也不能证明没换：上一轮失败后设备本来就停在 Bootloader，那里没有参数协议，
    // 这一帧注定超时。所以这里**不判失败**，交给信息帧探测确认（重试场景的唯一入口）。
    const enteredAcked = entered.kind === 'acked';
    if (!enteredAcked) {
      this.pushDiag('out', '', `EnterDfu 没有 ACK（${entered.detail}），改由信息帧探测确认是否已在升级模式`, 'warn');
    } else {
      this.enterDone = true;
      this.emitProgress('entering');
    }
    this.transition('probing');

    let restartReason: string | undefined;
    for (;;) {
      const step = await this.playRound(image, restartReason);
      if (step.kind === 'settled') return;
      if (step.kind === 'aborted') throw new Error('dfu aborted');
      if (step.kind === 'failed') {
        // "既没 ACK 也没状态帧"才是原来的 enterTimeout；探测到了但状态异常仍按原语义报（statusInfo / statusFail / statusCode）
        const error: DfuError =
          step.error.kind === 'probeFailed' && !enteredAcked
            ? {
                kind: 'enterTimeout',
                round: step.error.round,
                detail: `EnterDfu 没有 ACK，${this.timing.dfuProbeAttempts} 次信息帧也没有状态回执`,
              }
            : step.error;
        this.reportFailure(error);
        throw new Error(`dfu ${error.kind}`);
      }
      this.round += 1;
      if (this.round > this.timing.dfuRoundRestarts) {
        const error: DfuError = { kind: 'restartExhausted', round: this.round - 1, detail: step.reason };
        this.reportFailure(error);
        throw new Error(`dfu ${error.kind}`);
      }
      // 整轮重来：清回包缓冲，信息帧会把设备的 IapAddress / DataCount / 校验和全部清零
      this.inbound = EMPTY;
      this.sentBlocks = 0;
      this.probeDone = false;
      this.blockIndex = 0;
      restartReason = step.reason;
    }
  }

  /**
   * 用户主动中止：只在 `settling` 之前有效（`0x05` 之后设备已经在收尾，主机无法中断它）。
   * 返回是否真的中止了 —— `settling` 之后返回 false，与任务书 §5 的口径一致。
   */
  abort(): boolean {
    if (this.phaseValue !== 'entering' && this.phaseValue !== 'probing' && this.phaseValue !== 'writing') {
      return false;
    }
    this.transition('aborted');
    this.settleSlot({ kind: 'aborted' });
    return true;
  }

  /**
   * 由调用方在 settle 完成、版本回读结束后调用，把 phase 推到 `done`（中间经过 `verifying`）。
   *
   * 任务书 §4.5 的签名是 `complete(): void`；这里多一个可选入参，因为版本比对发生在调用方，
   * `DfuError.kind` 里的 `verify` 必须由本类派发才能让 phase 与错误一致（阶段二 `FirmwareController` 用）。
   * 不传入参等价于"验证通过"。
   */
  complete(verification?: DfuCompletion): void {
    if (this.phaseValue !== 'settling' && this.phaseValue !== 'verifying') return;
    this.clearSettleTimer();
    if (verification !== undefined && !verification.ok) {
      this.reportFailure({ kind: 'verify', round: this.round, detail: verification.detail });
      return;
    }
    this.transition('verifying');
    this.settleDone = true;
    this.transition('done');
  }

  /**
   * 喂入设备回来的字节。按当前阶段选解码器：
   * - `entering`：App 还活着，回的是参数协议 ACK（`00 02 00 08 00 00 CRC`），走 `decodeStream`；
   * - 之后：Bootloader 只说 SigmaBus，走 `decodeSigmaStream` + `decodeDfuStatus` / `decodeSigmaAck`。
   * 没挂着的等待时收到帧只记 warn 诊断并丢弃（DFU 材料 §6 ⑫：收尾期设备可能还在吐旧回执）。
   */
  handleBytes(bytes: Uint8Array): void {
    if (this.disposed || bytes.length === 0) return;
    if (this.phaseValue === 'entering') {
      this.handleParamBytes(bytes);
      return;
    }
    if (this.phaseValue === 'idle' || this.phaseValue === 'preflight' || this.phaseValue === 'ready') return;
    this.handleSigmaBytes(bytes);
  }

  /** 清所有定时器；运行中的会话会被就地中止（`run()` 以 `Error('dfu aborted')` 收场） */
  dispose(): void {
    this.disposed = true;
    this.clearSettleTimer();
    this.settleSlot({ kind: 'aborted' });
    if (isRunningPhase(this.phaseValue)) this.phaseValue = 'aborted';
    this.inbound = EMPTY;
  }

  // ---- 阶段实现 ----

  /**
   * App 模式：写 `0x1008=1` 并等参数协议 ACK。
   *
   * 返回 `noAck` 而不是失败：设备若已经在 Bootloader 里，这一帧根本没人答（Bootloader 只说 SigmaBus），
   * 而"进没进 DFU"本来就要靠下一阶段的信息帧确认（DFU 材料 §6 ⑬）。
   */
  private async enterDfu(): Promise<EnterOutcome> {
    const frame = encodeFrame(
      FUNC_RAND_WRITE,
      encodeRandWrite([{ addr: ENTER_DFU_ADDR, raw: ENTER_DFU_VALUE }]),
    );
    const summary = `EnterDfu 0x${hex(ENTER_DFU_ADDR, 4)}=${ENTER_DFU_VALUE}`;
    for (let attempt = 1; attempt <= ENTER_DFU_ATTEMPTS; attempt += 1) {
      const result = await this.exchange(frame, summary, 'ack', this.timing.requestTimeoutMs);
      if (result.kind === 'aborted') return { kind: 'aborted' };
      if (result.kind === 'channel') return { kind: 'failed', error: { kind: 'channel', detail: result.detail } };
      if (result.kind === 'value' && result.value === ACK_NO_ERR) return { kind: 'acked' };
      if (result.kind === 'timeout') {
        this.diagTimeout(frame, `${summary} 超时 ${this.timing.requestTimeoutMs} ms（第 ${attempt}/${ENTER_DFU_ATTEMPTS} 次）`);
      }
      // 非 0 ACK 与 ACK 校验错同样只重发一次；设备已在 Bootloader 时这帧是幂等的
    }
    return { kind: 'noAck', detail: `${ENTER_DFU_ATTEMPTS} 次都没有 ACK 0x0000` };
  }

  private async playRound(image: ParsedImage, restartReason: string | undefined): Promise<RoundStep> {
    this.transition('probing');
    const probe = await this.probe(image, restartReason);
    if (probe.kind !== 'ok') return probe;
    // 设备答了信息帧，说明它确实在 Bootloader 里 —— 没有 EnterDfu ACK 的重试场景到这里才算"进去了"
    this.enterDone = true;
    this.probeDone = true;
    this.emitProgress('probing');
    this.transition('writing');
    return this.writeBlocks(image);
  }

  /** 信息帧是协议里唯一的"复位指针"原语，探测重试与整轮重来发的是同一帧（DFU 材料 §6 ⑪） */
  private async probe(image: ParsedImage, restartReason: string | undefined): Promise<Step> {
    const info = image.info;
    const base = `DFU info len=${info.length} csum=0x${hex(info.checksum, 8)}`;
    const summary = restartReason === undefined ? base : `${base}（第 ${this.round} 轮，上一轮：${restartReason}）`;
    const frame = encodeDfuInfoFrame(info);

    for (let attempt = 1; attempt <= this.timing.dfuProbeAttempts; attempt += 1) {
      const result = await this.exchange(frame, summary, 'status', this.timing.dfuProbeTimeoutMs);
      if (result.kind === 'aborted') return { kind: 'aborted' };
      if (result.kind === 'channel') return { kind: 'failed', error: { kind: 'channel', detail: result.detail } };
      if (result.kind === 'timeout') {
        this.diagTimeout(
          frame,
          `DFU info 探测超时 ${this.timing.dfuProbeTimeoutMs} ms（第 ${attempt}/${this.timing.dfuProbeAttempts} 次）`,
        );
        continue;
      }
      if (result.kind === 'ackError') {
        return { kind: 'restart', reason: `info frame sigma ack ${this.ackText(result.err)}` };
      }
      switch (result.value) {
        case DFU_STATUS_CONTINUE:
          return { kind: 'ok' };
        case DFU_STATUS_INFO_ERR:
          return { kind: 'failed', error: { kind: 'statusInfo', status: result.value, round: this.round } };
        case DFU_STATUS_FAIL:
          return { kind: 'failed', error: { kind: 'statusFail', status: result.value, round: this.round } };
        case DFU_STATUS_CODE_ERR:
          return { kind: 'restart', reason: 'info frame status 0x02' };
        default:
          return { kind: 'failed', error: { kind: 'statusCode', status: result.value, round: this.round } };
      }
    }
    return {
      kind: 'failed',
      error: {
        kind: 'probeFailed',
        round: this.round,
        detail: `${this.timing.dfuProbeAttempts} 次信息帧都没有状态回执`,
      },
    };
  }

  /**
   * 逐块写：发一块、等一块的回执，绝不流水线（设备 OUT 缓冲只有 4 个 64 B 槽，一块就占 5 个，
   * DFU 材料 §6 ⑤）。块的字节直接取 `image.blocks`（密文原样），不重切、不重加密、不重算校验和。
   */
  private async writeBlocks(image: ParsedImage): Promise<RoundStep> {
    const total = image.blocks.length;
    for (let index = 0; index < total; index += 1) {
      if (this.phaseValue === 'aborted') return { kind: 'aborted' };
      this.blockIndex = index;
      this.emitProgress('writing');

      const frame = encodeBlockFrame(image.blocks[index]);
      const result = await this.exchange(frame, `DFU block ${index + 1}/${total}`, 'status', this.timing.dfuBlockTimeoutMs);
      if (result.kind === 'aborted') return { kind: 'aborted' };
      if (result.kind === 'channel') return { kind: 'failed', error: { kind: 'channel', detail: result.detail } };
      if (result.kind === 'timeout') {
        // 歧义态：可能没写、也可能写了但回执丢了。补发会让指针与认知错位，只能整轮重来
        this.diagTimeout(
          frame,
          `DFU block ${index + 1}/${total} 超时 ${this.timing.dfuBlockTimeoutMs} ms，整轮重来`,
        );
        return { kind: 'restart', reason: `block ${index + 1}/${total} timeout` };
      }
      if (result.kind === 'ackError') {
        return { kind: 'restart', reason: `block ${index + 1}/${total} sigma ack ${this.ackText(result.err)}` };
      }

      this.sentBlocks = index + 1;
      const status = result.value;
      if (status === DFU_STATUS_SUCCESS) {
        this.emitProgress('writing');
        this.enterSettling();
        return { kind: 'settled' };
      }
      if (status === DFU_STATUS_CONTINUE) {
        this.emitProgress('writing');
        continue;
      }
      if (status === DFU_STATUS_CODE_ERR) {
        return { kind: 'restart', reason: `block ${index + 1}/${total} status 0x02` };
      }
      if (status === DFU_STATUS_INFO_ERR) {
        return {
          kind: 'failed',
          error: { kind: 'statusInfo', status, round: this.round, blockIndex: index },
        };
      }
      if (status === DFU_STATUS_FAIL) {
        return { kind: 'failed', error: { kind: 'statusFail', status, round: this.round, blockIndex: index } };
      }
      return { kind: 'failed', error: { kind: 'statusCode', status, round: this.round, blockIndex: index } };
    }
    // 块全发完却只收到 0x03：设备没给终态，同样属于歧义
    return { kind: 'restart', reason: `no final status after ${total} blocks` };
  }

  /** 收到 `0x05` 后：停发一切帧，只等调用方重连 + 回读 + `complete()`（DFU 材料 §6 ⑫） */
  private enterSettling(): void {
    // 走到这里说明触发 `0x05` 的那次等待已经回收，不会再有人发帧（`sendFrame` 另有 settling 断言兜底）
    this.transition('settling');
    this.settleTimer = this.timers.setTimeout(() => {
      this.settleTimer = null;
      this.reportFailure({
        kind: 'settle',
        round: this.round,
        detail: `${this.timing.dfuSettleTimeoutMs} ms 内没有收到重连与版本回读`,
      });
    }, this.timing.dfuSettleTimeoutMs);
  }

  // ---- 收发 ----

  /**
   * 先挂等待再发帧：单测的假设备会在 `send` 里同步回执，先发后等会让那条回执找不到归属。
   */
  private async exchange(
    frame: Uint8Array,
    summary: string,
    kind: SlotKind,
    timeoutMs: number,
  ): Promise<ExchangeResult> {
    const pending = this.awaitSlot(kind, timeoutMs);
    const sent = await this.sendFrame(frame, summary);
    if (sent.kind === 'failed') {
      this.settleSlot({ kind: 'aborted' });
      return { kind: 'channel', detail: sent.error.detail ?? 'send failed' };
    }
    return pending;
  }

  private async sendFrame(frame: Uint8Array, summary: string): Promise<{ kind: 'ok' } | { kind: 'failed'; error: DfuError }> {
    if (this.phaseValue === 'settling' || this.phaseValue === 'verifying' || this.phaseValue === 'done') {
      // 收尾期发帧会被设备当成新状态（DFU 材料 §6 ⑫），这里是内部不变式，不是用户可达路径
      throw new Error(`dfu: refused to send in phase ${this.phaseValue}`);
    }
    this.pushDiag('out', hexBytes(frame), summary, 'info');
    try {
      await this.send(splitFrame(frame, PAYLOAD_BYTES));
    } catch (error) {
      return { kind: 'failed', error: { kind: 'channel', detail: describe(error) } };
    }
    return { kind: 'ok' };
  }

  private awaitSlot(kind: SlotKind, timeoutMs: number): Promise<SlotResult> {
    return new Promise<SlotResult>((resolve) => {
      const timer = this.timers.setTimeout(() => {
        // 只有"当前这一次等待"自己的定时器才算超时：abort/dispose 会先把 slot 换成 null
        if (this.slot === null || this.slot.timer !== timer) return;
        this.slot = null;
        resolve({ kind: 'timeout' });
      }, timeoutMs);
      this.slot = { kind, timer, resolve };
    });
  }

  private settleSlot(result: SlotResult): void {
    const slot = this.slot;
    if (slot === null) return;
    this.timers.clearTimeout(slot.timer);
    this.slot = null;
    slot.resolve(result);
  }

  // ---- 入站 ----

  /** App 模式（`entering`）：参数协议帧，只认 `FUNC_ACK`，码是大端 */
  private handleParamBytes(bytes: Uint8Array): void {
    const decoded = decodeStream(bytes);
    for (const issue of decoded.issues) {
      this.pushDiag('in', '', `参数帧解析问题 ${issue.problem} @${issue.offset}：${issue.detail}`, 'warn');
    }
    for (const frame of decoded.frames) {
      const raw = encodeFrame(frame.func, frame.data, frame.unitId);
      if (frame.func !== FUNC_ACK) {
        this.pushDiag('in', hexBytes(raw), `EnterDfu 阶段收到非 ACK 帧 Func 0x${hex(frame.func, 2)}`, 'warn');
        continue;
      }
      const code = ((frame.data[0] ?? 0) << 8) | (frame.data[1] ?? 0);
      this.pushDiag(
        'in',
        hexBytes(raw),
        `EnterDfu ack 0x${hex(code, 4)}${code === ACK_NO_ERR ? ' OK' : ' ERR'}`,
        code === ACK_NO_ERR ? 'info' : 'error',
      );
      if (this.slot?.kind === 'ack') this.settleSlot({ kind: 'value', value: code });
    }
  }

  /** Bootloader 模式：SigmaBus 帧；半帧留到下一次喂入（帧可跨任意多个 63 B 报告） */
  private handleSigmaBytes(bytes: Uint8Array): void {
    const merged = new Uint8Array(this.inbound.length + bytes.length);
    merged.set(this.inbound, 0);
    merged.set(bytes, this.inbound.length);
    const decoded = decodeSigmaStream(merged);
    this.inbound = decoded.rest;
    for (const issue of decoded.issues) {
      this.pushDiag('in', '', `SigmaBus 帧解析问题 ${issue.problem} @${issue.offset}：${issue.detail}`, 'warn');
    }
    for (const frame of decoded.frames) this.handleSigmaFrame(frame);
  }

  private handleSigmaFrame(frame: SigmaFrame): void {
    const raw = encodeSigmaFrame(frame.cmd, frame.data, frame.addr);
    const status = decodeDfuStatus(frame);
    if (status !== null) {
      const text = STATUS_TEXT[status.status] ?? 'UNKNOWN';
      this.pushDiag(
        'in',
        hexBytes(raw),
        `DFU status 0x${hex(status.status, 2)} ${text}`,
        status.status === DFU_STATUS_CONTINUE || status.status === DFU_STATUS_SUCCESS ? 'info' : 'warn',
      );
      if (this.slot?.kind === 'status') this.settleSlot({ kind: 'value', value: status.status });
      return;
    }
    const ack = decodeSigmaAck(frame);
    if (ack !== null) {
      this.pushDiag(
        'in',
        hexBytes(raw),
        `DFU sigma ack 0x${hex(ack.err, 4)} ${SIGMA_ACK_TEXT[ack.err] ?? 'UNKNOWN'}`,
        ack.err === 0 ? 'info' : 'error',
      );
      // ACK 意味着整帧被丢弃、Flash 指针没前进：与"状态帧"不同，按歧义态整轮重来处理（设计 §5.11）
      if (ack.err !== 0 && this.slot?.kind === 'status') this.settleSlot({ kind: 'ackError', err: ack.err });
      return;
    }
    this.pushDiag('in', hexBytes(raw), `DFU 未匹配帧 cmd 0x${hex(frame.cmd, 2)} len=${frame.data.length}`, 'warn');
  }

  // ---- 状态与事件 ----

  private transition(phase: DfuPhase): void {
    this.phaseValue = phase;
    this.emitProgress(phase);
  }

  private emitProgress(phase: DfuPhase = this.phaseValue): void {
    if (this.onProgressCb === undefined) return;
    this.onProgressCb({
      phase,
      blockIndex: this.blockIndex,
      blockTotal: this.blockTotal,
      percent: this.percent(),
      round: this.round,
      message: `fw.phase.${phase}`,
    });
  }

  private percent(): number {
    let value = 0;
    if (this.enterDone) value += ENTER_POINTS;
    if (this.probeDone) value += PROBE_POINTS;
    if (this.blockTotal > 0) {
      value += (WRITE_POINTS * Math.min(this.sentBlocks, this.blockTotal)) / this.blockTotal;
    }
    if (this.settleDone) value += SETTLE_POINTS;
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  private reportFailure(error: DfuError): void {
    this.settleSlot({ kind: 'aborted' });
    this.clearSettleTimer();
    this.settleDone = false;
    this.onErrorCb?.(error);
    this.transition('failed');
  }

  private clearSettleTimer(): void {
    if (this.settleTimer === null) return;
    this.timers.clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  private rejectPreflight(rejection: ImageRejection): DfuPreflightResult {
    this.reportFailure({ kind: 'preflight', detail: `${rejection.problem}: ${rejection.message}` });
    return { ok: false, rejection };
  }

  /**
   * 型号层面的拒绝。`modelMissing` 是 `ImageProblem` 里最接近的一项（镜像型号码本身已由 `parseImage`
   * 保证是 6 个可打印字符），具体类别放在 `detail.reason`，供界面选不同文案。
   */
  private modelRejection(
    reason: string,
    info: DfuInfo,
    message: string,
    deviceModel?: string,
  ): ImageRejection {
    const detail: Record<string, number | string> = { reason, imageModelCode: info.modelCode };
    if (deviceModel !== undefined) detail.deviceModelCode = deviceModel;
    return { problem: 'modelMissing', message, detail };
  }

  private ackText(err: number): string {
    return `0x${hex(err, 4)} ${SIGMA_ACK_TEXT[err] ?? 'UNKNOWN'}`;
  }

  private diagTimeout(frame: Uint8Array, summary: string): void {
    this.pushDiag('out', hexBytes(frame), summary, 'warn');
  }

  private pushDiag(dir: 'out' | 'in', hexText: string, summary: string, level: DiagEntry['level']): void {
    this.onDiagCb?.({ at: this.clock.now(), dir, hex: hexText, summary, level });
  }
}
