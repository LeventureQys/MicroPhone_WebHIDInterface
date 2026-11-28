/**
 * 后台自动连接（默认开）：系统里插着 M001（VID 0x0A67 / PID 0x0010）而上位机还没连上时，
 * 主动把它连起来，不必用户先去设备页点「连接」再点「打开」。
 *
 * 只碰"真机通道"上的目标设备，边界写死在这里：
 * 1. 用户连的是虚拟桥接（`ready` + `virtual`）→ 完全不抢；
 * 2. 用户主动断开（设备页「断开 / 关闭」）→ `pause()`，直到设备被拔掉一次或用户自己再点连接；
 * 3. 升级中（`status='dfu'`）与正在连接（`'connecting'`）→ 不动；
 * 4. 参数同步失败：从没连上过（开机就在 Bootloader）→ `parked` 立即停手；
 *    连上过再掉下去 → 按失败退避重试 `maxAttempts` 次（设备可能只是还没缓过来）；
 * 5. 环境没有原生 WebHID / 连续失败 → 指数退避，最多 `maxAttempts` 次后停手。
 *
 * 掉线本身不会 `pause()`：拔线 → 链路 error → 设备不在的每一拍都重置状态 → 插回即自动重连。
 *
 * 查"插着没有"优先走原生 HID 插拔事件；轮询只作兜底（默认 5 s），且只按 VID/PID
 * 过滤存在性，不解析报告描述符（2026-11-13 反馈：不要频繁查询 USB 状态/描述符）。
 *
 * 依赖窄结构接口（`AutoConnectLink` / `AutoConnectSession`），`DeviceLink` 与 `WebHidSession`
 * 天然满足；单测不必造整条链路，也不必真的起 WebHID。
 */
import { EXPECTED_PRODUCT_ID, EXPECTED_VENDOR_ID, type LinkState } from './link';
import { defaultTimers, type Timers } from './proto/timing';
import type { WebHidDeviceSummary, WebHidMode, WebHidSessionState } from './webhid';

/** 自动连接需要的连接编排面（`DeviceLink` 满足它） */
export interface AutoConnectLink {
  getState(): LinkState;
  attach(deviceId: string): Promise<void>;
  /**
   * 链路状态变化（可选）。设备可能是别的路径连上的（用户手动连接 / 会话恢复），
   * 只看 5 s 一次的 tick 会漏掉"这台设备其实已经可用过"，设备复位后就容易误判成升级模式。
   */
  onChange?(cb: () => void): () => void;
}

/** 自动连接需要的设备会话面（`WebHidSession` 满足它） */
export interface AutoConnectSession {
  getState(): WebHidSessionState;
  /** 环境是否具备原生 WebHID；没有就别轮询 */
  nativeAvailable(): boolean;
  /**
   * 只读探测真机（会话没连上时也能查"插着没有"）。
   * 传 VID/PID 时只返回匹配设备，且不解析报告描述符；不传则枚举全部（单测 / 诊断用）。
   */
  probeNative(target?: {
    readonly vendorId: number;
    readonly productId: number;
  }): Promise<readonly WebHidDeviceSummary[]>;
  connect(mode?: WebHidMode): Promise<void>;
  refresh(): Promise<void>;
  /** 原生 HID 插拔事件；有它就不必靠高频轮询发现设备（可选，环境不支持时缺省） */
  watchNative?(cb: () => void): () => void;
}

export interface AutoConnectOptions {
  readonly link: AutoConnectLink;
  readonly session: AutoConnectSession;
  /** 目标设备 VID；缺省 M001（0x0A67） */
  readonly vendorId?: number;
  /** 目标设备 PID；缺省 M001（0x0010） */
  readonly productId?: number;
  /** 轮询间隔：插拔事件会立刻触发检查，这里只是事件不可用时的兜底 */
  readonly intervalMs?: number;
  /** 连续失败多少次后停手（等设备重新插上或用户手动连接） */
  readonly maxAttempts?: number;
  /**
   * 设备中途复位（参数同步失败、看起来像重新插拔）后，在判定"停在升级模式"之前
   * 还愿意再试几次。设备刚重启时 USB 已枚举但 Modbus 还没起来，一次失败不代表救不回来。
   */
  readonly coldSyncRetries?: number;
  readonly timers?: Timers;
  /** 诊断/日志出口；缺省静默 */
  readonly onEvent?: (message: string) => void;
}

/** 只在诊断与单测里读；界面不展示 */
export interface AutoConnectState {
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly parked: boolean;
  readonly attempts: number;
}

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 3;
/** 设备复位后第一次同步失败时的重试间隔：设备刚重启要一点时间才能应答整段回读 */
const COLD_SYNC_RETRY_MS = 2000;
const DEFAULT_COLD_SYNC_RETRIES = 2;
/** 退避上限：设备一直连不上时也别每 5 s 摸一次 */
const MAX_BACKOFF_MS = 30000;
/** 插拔事件合并窗口：系统一次拔插常连发 connect/disconnect 两条 */
const USB_EVENT_SETTLE_MS = 300;

export class AutoConnector {
  private readonly link: AutoConnectLink;
  private readonly session: AutoConnectSession;
  private readonly vendorId: number;
  private readonly productId: number;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly timers: Timers;
  private readonly onEvent?: (message: string) => void;

  private timer: unknown = null;
  private watchOff: (() => void) | null = null;
  private linkOff: (() => void) | null = null;
  private watchTimer: unknown = null;
  private stopped = true;
  private paused = false;
  private parked = false;
  private inFlight: Promise<void> | null = null;
  private pausedForDfu = false;
  private attempts = 0;
  /**
   * 这一轮插着期间链路是否连上过。
   *
   * 用来区分两种"同步失败"：开机时设备就停在升级模式（立即停手，别对着 Bootloader 空转）
   * 与"连上过之后掉下去、重连时设备还没缓过来"（要给几次退避重试，否则一次失败就再也连不回来）。
   */
  private wasReady = false;
  /** 冷启动重试次数：设备刚复位回来时 USB 已枚举、Modbus 还没起来，一次同步说明不了问题 */
  private coldAttempts = 0;
  private readonly coldSyncRetries: number;

  constructor(options: AutoConnectOptions) {
    this.link = options.link;
    this.session = options.session;
    this.vendorId = options.vendorId ?? EXPECTED_VENDOR_ID;
    this.productId = options.productId ?? EXPECTED_PRODUCT_ID;
    this.intervalMs = Math.max(200, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.coldSyncRetries = Math.max(0, options.coldSyncRetries ?? DEFAULT_COLD_SYNC_RETRIES);
    this.timers = options.timers ?? defaultTimers();
    this.onEvent = options.onEvent;
  }

  /** 开始后台轮询（幂等）；设置页开关打开时也走这里 */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.paused = false;
    this.parked = false;
    this.attempts = 0;
    this.wasReady = false;
    this.coldAttempts = 0;
    this.bindWatch();
    this.bindLink();
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watchTimer !== null) {
      this.timers.clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    this.watchOff?.();
    this.watchOff = null;
    this.linkOff?.();
    this.linkOff = null;
  }

  /** 设置页开关：关掉立即停，打开立刻查一次 */
  setEnabled(enabled: boolean): void {
    if (enabled) this.start();
    else this.stop();
  }

  /** 用户在设备页主动断开：别再自动连，直到设备被拔掉或用户自己再连 */
  pause(): void {
    this.paused = true;
  }

  /** 用户手动连接 / 打开：撤销暂停与停手，立刻再查一次 */
  resume(): void {
    this.paused = false;
    this.parked = false;
    this.attempts = 0;
    if (!this.stopped) this.schedule(0);
  }

  /** DFU 要独占 HID，等已在运行的设备枚举与参数同步退出，再移交句柄。 */
  async pauseForDfu(): Promise<void> {
    this.pausedForDfu = true;
    await this.inFlight;
  }

  resumeAfterDfu(reconnect = true): void {
    this.pausedForDfu = false;
    if (!reconnect) this.paused = true;
    this.schedule(0);
  }

  state(): AutoConnectState {
    return {
      enabled: !this.stopped,
      paused: this.paused,
      parked: this.parked,
      attempts: this.attempts,
    };
  }

  /** 单次检查。定时循环与单测共用；任何异常都不允许把后台任务带走 */
  async tickOnce(): Promise<void> {
    // 刻意不看 `stopped`：单测与诊断要能单独跑一次检查（`stop()` 只停后续排程）
    if (this.inFlight !== null || this.pausedForDfu) return;
    this.inFlight = this.runStep();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  // ---- 内部 ---------------------------------------------------------------

  private async runStep(): Promise<void> {
    let delay = this.intervalMs;
    try {
      delay = await this.step();
    } catch (error) {
      delay = this.fail(`检查失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.schedule(delay);
  }

  /** 一次完整检查；返回下一拍延迟 */
  private async step(): Promise<number> {
    if (!this.session.nativeAvailable()) {
      // 没有 navigator.hid（浏览器 / 沙箱）：轮询没有意义，直接停手
      this.log('当前环境没有原生 WebHID，后台自动连接退出');
      this.stop();
      return this.intervalMs;
    }

    const link = this.link.getState();
    if (link.status === 'ready') {
      // 连上了：记一笔"这一轮插着期间曾经可用"（掉线后重连的判定要用），也不再探测
      this.wasReady = true;
      this.reset();
      return this.intervalMs;
    }
    if (link.status === 'connecting' || link.status === 'dfu') return this.intervalMs;

    const session = this.session.getState();
    // 用户连的是虚拟桥接：不抢真机通道
    if (session.status === 'ready' && session.mode === 'virtual') return this.intervalMs;

    const present = (
      await this.session.probeNative({ vendorId: this.vendorId, productId: this.productId })
    ).some((item) => this.matches(item));
    if (!present) {
      // 设备不在：撤销"手动断开"的暂停与失败停手，下次插上就该自动连
      this.paused = false;
      // 拔掉了就回到"这一轮还没连上过"：再插回时若同步失败，按开机就在升级模式处理
      this.wasReady = false;
      this.coldAttempts = 0;
      this.reset();
      return this.intervalMs;
    }
    if (this.paused || this.parked || this.pausedForDfu) return this.intervalMs;

    if (session.status !== 'ready' || session.mode !== 'native') {
      await this.session.connect('native');
      if (this.session.getState().status !== 'ready') {
        return this.fail('切换到真机通道失败');
      }
    } else {
      await this.session.refresh();
    }

    const target = this.session.getState().devices.find((item) => this.matches(item));
    if (target === undefined || this.pausedForDfu) return this.intervalMs;

    this.log(`发现 ${target.productName}（${target.id}），尝试自动连接`);
    await this.link.attach(target.id);

    const after = this.link.getState();
    if (after.status === 'ready') {
      this.wasReady = true;
      this.reset();
      this.log('自动连接成功');
      return this.intervalMs;
    }
    // 参数同步失败：开机就连不上多半是设备停在升级模式，自动重连永远不会成功，停手等固件抽屉；
    // 但"连上过又掉下去"的情况（刚复位 / USB 抖动 / 设备还没缓过来）要给几次退避重试，
    // 否则一次重连失败就再也不会自己连回来（用户要求：丢失连接后要尝试重连）。
    if (after.errorCode === 'sync') {
      if (!this.wasReady) {
        // 设备自己复位（固件把参数落盘后重启）在 USB 上看起来就是"拔掉又插回"：
        // USB 已枚举、Modbus 还没起来，第一次同步必然失败。给两次短的冷启动重试，
        // 仍然失败才当成停在升级模式（Bootloader 也是这个症状，多试两次不影响它被停手）。
        if (this.coldAttempts < this.coldSyncRetries) {
          this.coldAttempts += 1;
          this.log(`设备还没有准备好应答参数同步（第 ${this.coldAttempts}/${this.coldSyncRetries} 次重试）`);
          return COLD_SYNC_RETRY_MS;
        }
        this.parked = true;
        this.log('设备参数同步失败（可能停在升级模式），停止自动重连');
        return this.backoff();
      }
      return this.fail('重连后参数同步失败');
    }
    return this.fail(`自动连接失败（${after.error ?? '未知原因'}）`);
  }

  private matches(summary: WebHidDeviceSummary): boolean {
    return summary.vendorId === this.vendorId && summary.productId === this.productId;
  }

  /** 订阅链路状态：设备哪怕不是后台连上的，也要记住"这台设备曾经可用" */
  private bindLink(): void {
    if (this.linkOff !== null) return;
    if (typeof this.link.onChange !== 'function') return;
    try {
      this.linkOff = this.link.onChange(() => this.noteLinkState());
    } catch {
      this.linkOff = null;
    }
  }

  private noteLinkState(): void {
    if (this.link.getState().status !== 'ready') return;
    this.wasReady = true;
  }

  /**
   * 订阅原生 HID 插拔：设备插上/拔掉时立刻查一次，不必等下一拍轮询。
   *
   * 轮询保留为兜底（每 5 s），既是环境不支持事件时的退路，也防止漏事件。
   * 这同时把"频繁查询 USB 状态 / 解析描述符"从每秒级降到事件驱动（2026-11-13 反馈）。
   */
  private bindWatch(): void {
    if (this.watchOff !== null) return;
    if (typeof this.session.watchNative !== 'function') return;
    try {
      this.watchOff = this.session.watchNative(() => this.onUsbChange());
    } catch {
      // 加不上事件监听不影响轮询兜底
      this.watchOff = null;
    }
  }

  private onUsbChange(): void {
    if (this.stopped || this.watchTimer !== null) return;
    this.watchTimer = this.timers.setTimeout(() => {
      this.watchTimer = null;
      if (!this.stopped) this.schedule(0);
    }, USB_EVENT_SETTLE_MS);
  }

  private reset(): void {
    this.attempts = 0;
    this.coldAttempts = 0;
    this.parked = false;
  }

  /** 记一次失败并返回退避后的下一拍延迟；连续失败到上限就停手 */
  private fail(reason: string): number {
    this.attempts += 1;
    if (this.attempts >= this.maxAttempts) this.parked = true;
    this.log(`${reason}（第 ${this.attempts}/${this.maxAttempts} 次）`);
    return this.backoff();
  }

  private backoff(): number {
    const grown = this.intervalMs * 2 ** Math.max(0, this.attempts - 1);
    return Math.min(Math.max(this.intervalMs, grown), MAX_BACKOFF_MS);
  }

  private schedule(ms: number): void {
    if (this.stopped || this.pausedForDfu) return;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.tickOnce();
    }, ms);
  }

  private log(message: string): void {
    this.onEvent?.(message);
  }
}
