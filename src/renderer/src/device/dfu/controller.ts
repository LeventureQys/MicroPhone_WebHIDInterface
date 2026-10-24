/**
 * 固件升级编排（R6）：文件 → 预检 → 用户确认 → DFU 会话 → 收尾重连 → 版本回读 → 结果。
 *
 * 这一层只做编排，不做协议：帧怎么发在 `DfuSession`（4.2 阶段一），
 * 设备怎么开关在 `DeviceLink`（3.2）。它负责三件别处不该知道的事：
 * 1. 把 `DfuSession.send` 接到真实设备的 `sendReport`（并保证"零出帧"路径真的没有出站）；
 * 2. DFU 期间的入站字节分流（`transport.onInputBytes` → `session.handleBytes`）；
 * 3. DFU 期间的主进程守卫（`setDfuActive`）与收尾后的版本比对（`verify`）。
 *
 * 依赖用窄结构接口（`FirmwareLink`/`FirmwareChannel`）而不是类：`DeviceLink` 与
 * `DeviceBoundTransport` 天然满足它们，单测也不必造整条链路。
 */
import type { DiagEntry, DeviceSnapshot } from '../proto/session';
import { TIMING, type Clock, type Timers } from '../proto/timing';
import type { WebHidDeviceHandle } from '../webhid/types';
import type { LinkState } from '../link';
import type { ReportIds } from '../protocol';
import type { DfuInfo } from './image';
import type { DfuError, DfuPhase, DfuProgress } from './session';
import { DfuSession } from './session';

/** DFU 需要的最小设备通道面（`DeviceBoundTransport` 满足它） */
export interface FirmwareChannel {
  readonly device: WebHidDeviceHandle;
  readonly reportIds: ReportIds;
  onInputBytes(cb: (bytes: Uint8Array) => void): () => void;
}

/** DFU 需要的最小连接编排面（`DeviceLink` 满足它） */
export interface FirmwareLink {
  transport(): FirmwareChannel | null;
  getState(): LinkState;
  suspendForDfu(): Promise<void>;
  resumeAfterDfu(): Promise<void>;
  attach(deviceId: string): Promise<void>;
}

export interface FirmwareState {
  readonly phase: DfuPhase;
  readonly progress: DfuProgress | null;
  readonly error: DfuError | null;
  readonly info: DfuInfo | null;
  readonly confirmed: boolean;
  readonly fileName: string | null;
}

export interface FirmwareControllerOptions {
  readonly link: FirmwareLink;
  /** 单测注入；缺省用 `file.arrayBuffer()` */
  readonly readFile?: (file: File) => Promise<Uint8Array>;
  readonly timers?: Timers;
  readonly clock?: Clock;
  readonly timing?: Partial<typeof TIMING>;
  /** DFU 帧诊断（主线程接 `DiagnosticsHub.push`） */
  readonly onDiag?: (entry: DiagEntry) => void;
  /** 主进程守卫（`window.micstudio.setDfuActive`）；单测注入以断言调用顺序 */
  readonly setDfuActive?: (active: boolean) => void | Promise<void>;
  /** 关窗被拦截的通知订阅（`window.micstudio.onDfuCloseBlocked`） */
  readonly onCloseBlocked?: (cb: () => void) => (() => void) | void;
}

/** 关窗被拦截时 `DfuError.detail` 的标记：phase 不变，界面只提示不中断 */
export const CLOSE_BLOCKED_DETAIL = 'close-blocked';
/** 通配镜像：型号不参与比对，版本也不比对（设备侧本来就不看） */
const WILDCARD_MODEL_CODE = '000000';
const EMPTY_STATE: Omit<FirmwareState, 'phase'> = Object.freeze({
  progress: null,
  error: null,
  info: null,
  confirmed: false,
  fileName: null,
});

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sameState(left: FirmwareState, right: FirmwareState): boolean {
  return (
    left.phase === right.phase &&
    left.progress === right.progress &&
    left.error === right.error &&
    left.info === right.info &&
    left.confirmed === right.confirmed &&
    left.fileName === right.fileName
  );
}

/** 预检拒绝 → 文案键：`detail.reason` 优先，其次 `problem` */
export function rejectionKey(rejection: { readonly problem: string; readonly detail?: Readonly<Record<string, number | string>> }): string {
  const reason = rejection.detail?.reason;
  if (reason === 'bootld') return 'fw.error.internalOnly';
  if (reason === 'unknown-device') return 'fw.error.modelUnknown';
  if (reason === 'mismatch') return 'fw.error.modelMismatch';
  return `fw.reject.${rejection.problem}`;
}

/** 状态码错误 → 文案键 */
export function errorKeyOf(kind: DfuError['kind']): string {
  return `fw.error.${kind}`;
}

export const FIRMWARE_CHANGE_EVENT = 'change';

export type SelectFileResult =
  | { readonly ok: true; readonly info: DfuInfo; readonly blocks: number }
  | { readonly ok: false; readonly message: string };

/**
 * 固件升级控制器：把固件包、`DfuSession`、`DeviceLink` 与主进程守卫串成一条可观察的流程。
 * 视图只读 `state()` + `onChange`，不直接碰会话。
 */
export class FirmwareController extends EventTarget {
  private readonly options: FirmwareControllerOptions;
  private _state: FirmwareState;
  private _session: DfuSession | null = null;
  private _bytes: Uint8Array | null = null;
  private _running = false;

  constructor(options: FirmwareControllerOptions) {
    super();
    this.options = options;
    this._state = Object.freeze({ phase: 'idle', ...EMPTY_STATE });
  }

  state(): FirmwareState {
    return this._state;
  }

  onChange(cb: (state: FirmwareState) => void): () => void {
    const handler = (event: Event): void => {
      cb((event as CustomEvent<FirmwareState>).detail);
    };
    this.addEventListener(FIRMWARE_CHANGE_EVENT, handler);
    return () => {
      this.removeEventListener(FIRMWARE_CHANGE_EVENT, handler);
    };
  }

  /**
   * 读文件 + 预检，**不发任何帧**（R6-2/R6-3/R6-9）。
   * 失败返回文案键，由视图直接渲染；成功把 phase 推到 `ready` 并保存字节。
   */
  async selectFile(file: File): Promise<SelectFileResult> {
    this.disposeSession();
    this._bytes = null;
    this.patch({ ...EMPTY_STATE, phase: 'idle', fileName: file.name });

    const channel = this.options.link.transport();
    if (channel === null) {
      this.patch({ phase: 'failed' });
      return { ok: false, message: 'fw.error.noDevice' };
    }

    let bytes: Uint8Array;
    try {
      bytes = await this.readFile(file);
    } catch (error) {
      this.patch({ phase: 'failed', error: { kind: 'preflight', detail: describe(error) } });
      return { ok: false, message: 'fw.reject.frame' };
    }

    const session = this.createSession();
    const prepared = session.preflight(bytes);
    this.patch({ phase: session.phase() });
    if (!prepared.ok) {
      return { ok: false, message: rejectionKey(prepared.rejection) };
    }
    this._bytes = bytes;
    this.patch({
      phase: 'ready',
      info: prepared.info,
      error: null,
      confirmed: false,
    });
    return { ok: true, info: prepared.info, blocks: prepared.blocks };
  }

  /** 用户勾选"我已知悉升级中断的后果" */
  setConfirmed(confirmed: boolean): void {
    this.patch({ confirmed });
  }

  /**
   * 开始升级。未确认 → 抛 `Error('confirmation required')` 且**零出帧**。
   * 失败不抛：错误进 `state.error`（界面据此渲染"重试 / 重插"），设备状态不回滚。
   */
  async start(): Promise<void> {
    const bytes = this._bytes;
    if (bytes === null) throw new Error('no firmware selected');
    if (!this._state.confirmed) throw new Error('confirmation required');
    if (this._running) throw new Error('dfu already running');
    if (this.options.link.transport() === null) {
      this.patch({ phase: 'failed', error: { kind: 'channel', detail: 'fw.error.noDevice' } });
      return;
    }

    // 重试（上一轮已 failed/done）必须换一个新会话：会话跑完就不再接受 run()
    let session = this._session;
    if (session === null || (session.phase() !== 'preflight' && session.phase() !== 'ready')) {
      session = this.createSession();
      const prepared = session.preflight(bytes);
      this.patch({ phase: session.phase() });
      if (!prepared.ok) return;
    }

    this._running = true;
    this.patch({ error: null, confirmed: true });
    const offInput = this.subscribeInput();
    const offClose = this.subscribeCloseBlocked();
    try {
      // 顺序是硬约束（R4-7）：先停参数链路，再开主进程守卫，最后才开始发帧
      await this.options.link.suspendForDfu();
      await this.setDfuActive(true);
      await session.run(bytes);
      // run() 在 settling 处返回：设备正在重启，重连并全量回读
      await this.options.link.resumeAfterDfu();
      const verdict = this.verifyVersion(this.options.link.getState().device);
      if (verdict.ok) session.complete();
      else session.complete({ ok: false, detail: verdict.detail });
    } catch (error) {
      const message = describe(error);
      // abort 是用户动作，不是错误；其余失败由会话的 onError 落进 state.error
      if (message !== 'dfu aborted' && this._state.error === null) {
        this.patch({ phase: session.phase(), error: { kind: 'channel', detail: message } });
      }
    } finally {
      offInput();
      offClose();
      await this.setDfuActive(false);
      this._running = false;
      this.patch({ phase: session.phase() });
    }
  }

  /** 中止（只在 settle 之前有效，会话自己判定） */
  abort(): void {
    this._session?.abort();
  }

  /** 重插后再试：重新 attach 当前设备（设备此时在 Bootloader 里）再跑一次 */
  async replugAndRetry(): Promise<void> {
    const deviceId = this.options.link.getState().deviceId;
    if (deviceId !== null) await this.options.link.attach(deviceId);
    await this.start();
  }

  /** 释放会话定时器（视图关闭 / 重新选文件时） */
  dispose(): void {
    this.disposeSession();
  }

  // ---- 会话与入站 ----

  private createSession(): DfuSession {
    this.disposeSession();
    const session = new DfuSession({
      send: async (reports: readonly Uint8Array[]): Promise<void> => {
        // 通道每次现取：选文件与开始之间可能发生过 detach/attach
        const channel = this.options.link.transport();
        if (channel === null) throw new Error('device channel is gone');
        const sendReport = channel.device.sendReport;
        if (typeof sendReport !== 'function') throw new Error('device handle has no sendReport');
        for (const report of reports) await sendReport.call(channel.device, channel.reportIds.out, report);
      },
      timers: this.options.timers,
      clock: this.options.clock,
      timing: this.options.timing,
      deviceModelCode: () => this.options.link.getState().device?.modelCode ?? null,
      // R6-9：消费级入口永远不给 Bootld 开后门
      allowBootld: false,
      onProgress: (progress) => {
        // 收尾开始了就表示这一轮成功在望：把"升级中不能关窗"的临时提示收掉
        const clearNotice = progress.phase === 'settling' && this._state.error?.detail === CLOSE_BLOCKED_DETAIL;
        this.patch(clearNotice ? { phase: progress.phase, progress, error: null } : { phase: progress.phase, progress });
      },
      onError: (error) => this.patch({ error }),
      onDiag: this.options.onDiag,
    });
    this._session = session;
    return session;
  }

  /** DFU 期间把 IN 字节交给会话；参数会话此时已被 `suspend()` 掐断，不抢流 */
  private subscribeInput(): () => void {
    const channel = this.options.link.transport();
    if (channel === null) return () => undefined;
    return channel.onInputBytes((bytes) => this._session?.handleBytes(bytes));
  }

  /** 升级中关窗被主进程拦下：phase 不变，只派发一条可读提示（R6-8） */
  private subscribeCloseBlocked(): () => void {
    const subscribe =
      this.options.onCloseBlocked ??
      ((cb: () => void): (() => void) | void => window.micstudio?.onDfuCloseBlocked?.(cb));
    const off = subscribe(() => {
      this.patch({ error: { kind: 'channel', detail: CLOSE_BLOCKED_DETAIL } });
    });
    return typeof off === 'function' ? off : () => undefined;
  }

  private disposeSession(): void {
    const session = this._session;
    this._session = null;
    session?.dispose();
  }

  // ---- 版本与守卫 ----

  /**
   * 收尾比对：设备回读的 `X.Y.Z` 必须等于镜像版本（`000000` 通配镜像跳过）。
   * 不一致不代表升级失败——设备已经回到 App——但必须告诉用户"版本没变"。
   */
  private verifyVersion(device: DeviceSnapshot | null): { ok: boolean; detail?: string } {
    const info = this._state.info;
    if (info === null) return { ok: true };
    if (info.modelCode === WILDCARD_MODEL_CODE) return { ok: true };
    if (device === null) return { ok: false, detail: 'device snapshot missing after resume' };
    const { x, y, z } = device.firmware;
    if (x === info.version.x && y === info.version.y && z === info.version.z) return { ok: true };
    return {
      ok: false,
      detail: `device ${x}.${y}.${z} does not match image ${info.version.x}.${info.version.y}.${info.version.z}`,
    };
  }

  private async setDfuActive(active: boolean): Promise<void> {
    const inject = this.options.setDfuActive;
    try {
      if (inject !== undefined) await inject(active);
      else await window.micstudio?.setDfuActive?.(active);
    } catch {
      // 守卫是尽力而为：拿不到主进程也不能盖住升级本身的结论
    }
  }

  private readFile(file: File): Promise<Uint8Array> {
    const read = this.options.readFile;
    if (read !== undefined) return read(file);
    return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }

  private patch(partial: Partial<FirmwareState>): void {
    const next: FirmwareState = Object.freeze({ ...this._state, ...partial });
    if (sameState(next, this._state)) return;
    this._state = next;
    this.dispatchEvent(new CustomEvent<FirmwareState>(FIRMWARE_CHANGE_EVENT, { detail: this._state }));
  }
}
