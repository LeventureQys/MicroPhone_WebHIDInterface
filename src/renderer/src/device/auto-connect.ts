/**
 * 后台自动连接（默认开）：系统里插着 M001（VID 0x0A67 / PID 0x0010）而上位机还没连上时，
 * 主动把它连起来，不必用户先去设备页点「连接」再点「打开」。
 *
 * 只碰"真机通道"上的目标设备，边界写死在这里：
 * 1. 用户连的是虚拟桥接（`ready` + `virtual`）→ 完全不抢；
 * 2. 用户主动断开（设备页「断开 / 关闭」）→ `pause()`，直到设备被拔掉一次或用户自己再点连接；
 * 3. 升级中（`status='dfu'`）与正在连接（`'connecting'`）→ 不动；
 * 4. 参数同步失败（设备停在 Bootloader）→ 自动重连永远不会成功，`parked` 停手等固件抽屉；
 * 5. 环境没有原生 WebHID / 连接连续失败 → 指数退避，最多 `maxAttempts` 次后停手。
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
}

/** 自动连接需要的设备会话面（`WebHidSession` 满足它） */
export interface AutoConnectSession {
  getState(): WebHidSessionState;
  /** 环境是否具备原生 WebHID；没有就别轮询 */
  nativeAvailable(): boolean;
  /** 只读探测真机（会话没连上时也能查"插着没有"） */
  probeNative(): Promise<readonly WebHidDeviceSummary[]>;
  connect(mode?: WebHidMode): Promise<void>;
  refresh(): Promise<void>;
}

export interface AutoConnectOptions {
  readonly link: AutoConnectLink;
  readonly session: AutoConnectSession;
  /** 目标设备 VID；缺省 M001（0x0A67） */
  readonly vendorId?: number;
  /** 目标设备 PID；缺省 M001（0x0010） */
  readonly productId?: number;
  /** 轮询间隔；`getDevices()` 很便宜，1.5 s 足够跟上插拔 */
  readonly intervalMs?: number;
  /** 连续失败多少次后停手（等设备重新插上或用户手动连接） */
  readonly maxAttempts?: number;
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

const DEFAULT_INTERVAL_MS = 1500;
const DEFAULT_MAX_ATTEMPTS = 3;
/** 退避上限：设备一直连不上时也别每 1.5 s 摸一次 */
const MAX_BACKOFF_MS = 15000;

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
  private stopped = true;
  private paused = false;
  private parked = false;
  private busy = false;
  private attempts = 0;

  constructor(options: AutoConnectOptions) {
    this.link = options.link;
    this.session = options.session;
    this.vendorId = options.vendorId ?? EXPECTED_VENDOR_ID;
    this.productId = options.productId ?? EXPECTED_PRODUCT_ID;
    this.intervalMs = Math.max(200, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
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
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
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
    if (this.busy) return;
    this.busy = true;
    let delay = this.intervalMs;
    try {
      delay = await this.step();
    } catch (error) {
      delay = this.fail(`检查失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.busy = false;
    }
    if (!this.stopped) this.schedule(delay);
  }

  // ---- 内部 ---------------------------------------------------------------

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
      this.reset();
      return this.intervalMs;
    }
    if (link.status === 'connecting' || link.status === 'dfu') return this.intervalMs;

    const session = this.session.getState();
    // 用户连的是虚拟桥接：不抢真机通道
    if (session.status === 'ready' && session.mode === 'virtual') return this.intervalMs;

    const present = (await this.session.probeNative()).some((item) => this.matches(item));
    if (!present) {
      // 设备不在：撤销"手动断开"的暂停与失败停手，下次插上就该自动连
      this.paused = false;
      this.reset();
      return this.intervalMs;
    }
    if (this.paused || this.parked) return this.intervalMs;

    if (session.status !== 'ready' || session.mode !== 'native') {
      await this.session.connect('native');
      if (this.session.getState().status !== 'ready') {
        return this.fail('切换到真机通道失败');
      }
    } else {
      await this.session.refresh();
    }

    const target = this.session.getState().devices.find((item) => this.matches(item));
    if (target === undefined) return this.intervalMs; // 列表刚变，下一拍再试

    this.log(`发现 ${target.productName}（${target.id}），尝试自动连接`);
    await this.link.attach(target.id);

    const after = this.link.getState();
    if (after.status === 'ready') {
      this.reset();
      this.log('自动连接成功');
      return this.intervalMs;
    }
    // 参数同步失败＝设备停在升级模式：自动重连永远不会成功，交给固件抽屉
    if (after.errorCode === 'sync') {
      this.parked = true;
      this.log('设备参数同步失败（可能停在升级模式），停止自动重连');
      return this.backoff();
    }
    return this.fail(`自动连接失败（${after.error ?? '未知原因'}）`);
  }

  private matches(summary: WebHidDeviceSummary): boolean {
    return summary.vendorId === this.vendorId && summary.productId === this.productId;
  }

  private reset(): void {
    this.attempts = 0;
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
    if (this.stopped) return;
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
