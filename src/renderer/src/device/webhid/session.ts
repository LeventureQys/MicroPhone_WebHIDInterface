import type {
  WebHidDeviceHandle,
  WebHidDeviceSummary,
  WebHidErrorCode,
  WebHidKit,
  WebHidKitBridge,
  WebHidMode,
  WebHidReportSample,
  WebHidSessionState,
  WebHidUsageFilter,
} from './types';

/** 状态/设备变化（低频：连接、枚举、开关设备） */
export const CHANGE_EVENT = 'change';
/** 单条输入报告（高频：设备推一条派发一次，视图自行节流） */
export const REPORT_EVENT = 'report';

const MAX_REPORTS = 32;

interface DeviceEntry {
  readonly id: string;
  readonly mode: WebHidMode;
  readonly handle: WebHidDeviceHandle;
}

export interface WebHidSessionOptions {
  /** 注入面；应用传 createWebHidKit()，单测传假实现 */
  readonly kit: WebHidKit;
  readonly bridgeUrl?: string;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 清理路径一律吞异常：设备已断开时 close() 抛错没有意义，也不该盖住原始错误 */
function quietly(task: () => Promise<unknown> | undefined): void {
  try {
    void Promise.resolve(task()).catch(() => {});
  } catch {
    // close() 同步抛错的实现同样忽略
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  return null;
}

function toHex(bytes: Uint8Array): string {
  const parts = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) parts[i] = bytes[i].toString(16).toUpperCase().padStart(2, '0');
  return parts.join(' ');
}

function deviceId(handle: WebHidDeviceHandle, mode: WebHidMode, index: number): string {
  if (mode === 'virtual' && handle.deviceId) return handle.deviceId;
  // 真机没有 deviceId：用 vid/pid + 枚举序位合成，刷新时同一台设备保持同一个 id
  const vid = handle.vendorId.toString(16).padStart(4, '0');
  const pid = handle.productId.toString(16).padStart(4, '0');
  return `${mode}-${vid}-${pid}-${index}`;
}

/**
 * WebHID 会话：把 webhid-kit 的两种通道收成一份可观察状态。
 *
 * 边界说明：这里只做发现、开关设备、报告解码，不做参数 ↔ 字节映射
 * （映射待设备报告描述符确认，见 device/protocol.ts）。因此它不实现 Transport，
 * AppStore 的 MockTransport 链路保持不变。
 */
export class WebHidSession extends EventTarget {
  readonly #kit: WebHidKit;
  #state: WebHidSessionState;
  #bridge: WebHidKitBridge | null = null;
  #handles = new Map<string, DeviceEntry>();
  #listeners = new Map<string, (event: Event) => void>();
  #reports: WebHidReportSample[] = [];

  constructor(options: WebHidSessionOptions) {
    super();
    this.#kit = options.kit;
    this.#state = Object.freeze({
      status: 'idle',
      mode: 'virtual',
      bridgeUrl: options.bridgeUrl ?? options.kit.bridgeUrl,
      error: null,
      errorCode: null,
      devices: Object.freeze([]),
      lastReport: null,
    });
  }

  getState(): WebHidSessionState {
    return this.#state;
  }

  /** 套件版本 / 桥协议，仅用于界面展示来源 */
  get kitVersion(): string {
    return this.#kit.version;
  }

  get bridgeProtocol(): string {
    return this.#kit.bridgeProtocol;
  }

  /** 最近若干条输入报告，新的在末尾 */
  recentReports(): readonly WebHidReportSample[] {
    return this.#reports.slice();
  }

  onChange(cb: (state: WebHidSessionState) => void): () => void {
    const handler = (event: Event): void => {
      cb((event as CustomEvent<WebHidSessionState>).detail);
    };
    this.addEventListener(CHANGE_EVENT, handler);
    return () => {
      this.removeEventListener(CHANGE_EVENT, handler);
    };
  }

  onReport(cb: (sample: WebHidReportSample) => void): () => void {
    const handler = (event: Event): void => {
      cb((event as CustomEvent<WebHidReportSample>).detail);
    };
    this.addEventListener(REPORT_EVENT, handler);
    return () => {
      this.removeEventListener(REPORT_EVENT, handler);
    };
  }

  setBridgeUrl(url: string): void {
    const next = url.trim();
    if (next.length === 0 || next === this.#state.bridgeUrl) return;
    this.#patch({ bridgeUrl: next });
  }

  async connect(mode: WebHidMode = this.#state.mode): Promise<void> {
    if (this.#state.status === 'connecting') return;
    this.#teardown();
    this.#patch({ status: 'connecting', mode, error: null, errorCode: null, devices: [], lastReport: null });

    try {
      let handles: readonly WebHidDeviceHandle[];
      if (mode === 'virtual') {
        const bridge = await this.#kit.installVirtualBridge(this.#state.bridgeUrl);
        this.#bridge = bridge;
        handles = await bridge.list();
      } else {
        if (!this.#kit.nativeAvailable()) {
          this.#patch({
            status: 'error',
            error: 'navigator.hid is unavailable in this environment',
            errorCode: 'nativeUnavailable',
          });
          return;
        }
        handles = await this.#kit.nativeDevices();
      }
      // 一次 patch 落定，订阅方只看到 connecting → ready 两跳
      this.#patch({
        status: 'ready',
        devices: this.#syncHandles(handles, mode),
        error: null,
        errorCode: null,
      });
    } catch (error) {
      this.#teardown();
      this.#patch({
        status: 'error',
        devices: [],
        error: messageOf(error),
        errorCode: mode === 'virtual' ? 'bridge' : 'unknown',
      });
    }
  }

  async disconnect(): Promise<void> {
    this.#teardown();
    this.#patch({ status: 'idle', devices: [], error: null, errorCode: null, lastReport: null });
  }

  /** 重新枚举当前通道的设备（设备插拔后不必断开重连） */
  async refresh(): Promise<void> {
    if (this.#state.status !== 'ready') return;
    try {
      const handles =
        this.#state.mode === 'virtual' && this.#bridge
          ? await this.#bridge.list()
          : await this.#kit.nativeDevices();
      this.#applyDevices(handles, this.#state.mode);
      this.#patch({ error: null, errorCode: null });
    } catch (error) {
      this.#patch({ error: messageOf(error), errorCode: this.#state.mode === 'virtual' ? 'bridge' : 'unknown' });
    }
  }

  /**
   * 真机通道：唤起系统设备选择器。
   *
   * `filters` 一路透传到 `navigator.hid.requestDevice({ filters })`：Electron 33 的
   * `HIDDevice` 没有 collections，usage 过滤只能在渲染进程这一层做（设计 R-9 / §9 B13）。
   * 不传 = 不带过滤（与改动前一致）。Electron 主进程目前仍直接取消授权，返回空。
   */
  async requestNativeDevice(filters?: readonly WebHidUsageFilter[]): Promise<void> {
    if (this.#state.mode !== 'native' || this.#state.status !== 'ready') return;
    try {
      const handles = await this.#kit.requestNativeDevice(filters);
      if (handles.length === 0) {
        this.#patch({ error: 'requestDevice resolved with no device', errorCode: 'noSelection' });
        return;
      }
      this.#applyDevices(handles, 'native');
      this.#patch({ error: null, errorCode: null });
    } catch (error) {
      this.#patch({ error: messageOf(error), errorCode: 'device' });
    }
  }

  /**
   * 按摘要 id 取回设备句柄：`getState().devices` 只有摘要（给界面画列表用），
   * `DeviceLink` 要拿句柄构造 `WebHidTransport`，又不能自己持有句柄表，
   * 因此由会话提供这个只读出口。找不到返回 null。
   */
  handleOf(id: string): WebHidDeviceHandle | null {
    return this.#handles.get(id)?.handle ?? null;
  }

  async openDevice(id: string): Promise<void> {
    const entry = this.#handles.get(id);
    if (!entry) return;
    try {
      await entry.handle.open();
      this.#attach(entry);
      this.#patch({ devices: this.#summaries(), error: null, errorCode: null });
    } catch (error) {
      this.#patch({ error: messageOf(error), errorCode: 'device' });
    }
  }

  async closeDevice(id: string): Promise<void> {
    const entry = this.#handles.get(id);
    if (!entry) return;
    try {
      await entry.handle.close();
    } catch (error) {
      this.#patch({ error: messageOf(error), errorCode: 'device' });
    } finally {
      this.#detach(entry);
      this.#patch({ devices: this.#summaries() });
    }
  }

  /** 视图销毁时调用：不留监听、不留打开的设备 */
  dispose(): void {
    this.#teardown();
  }

  // -- internals --------------------------------------------------------

  #patch(partial: Partial<WebHidSessionState>): void {
    this.#state = Object.freeze({ ...this.#state, ...partial });
    this.dispatchEvent(new CustomEvent<WebHidSessionState>(CHANGE_EVENT, { detail: this.#state }));
  }

  #teardown(): void {
    for (const entry of this.#handles.values()) {
      this.#detach(entry);
      if (entry.handle.opened) quietly(() => entry.handle.close());
    }
    this.#handles.clear();
    this.#listeners.clear();
    this.#reports = [];
    const bridge = this.#bridge;
    this.#bridge = null;
    try {
      bridge?.restore();
    } catch {
      // 桥接已断开时 restore 可能抛，恢复 navigator.hid 失败不影响会话状态
    }
  }

  #applyDevices(handles: readonly WebHidDeviceHandle[], mode: WebHidMode): void {
    this.#patch({ devices: this.#syncHandles(handles, mode) });
  }

  /** 重建句柄表并返回摘要；不改状态，由调用方决定何时 patch */
  #syncHandles(handles: readonly WebHidDeviceHandle[], mode: WebHidMode): readonly WebHidDeviceSummary[] {
    const seen = new Set<string>();
    const next = new Map<string, DeviceEntry>();

    handles.forEach((handle, index) => {
      const id = deviceId(handle, mode, index);
      if (seen.has(id)) return;
      seen.add(id);
      const previous = this.#handles.get(id);
      if (previous && previous.handle !== handle) this.#detach(previous);
      const entry: DeviceEntry = { id, mode, handle };
      next.set(id, entry);
      if (handle.opened) this.#attach(entry);
    });

    for (const [id, entry] of this.#handles) {
      if (!seen.has(id)) this.#detach(entry);
    }

    this.#handles = next;
    return this.#summaries();
  }

  #summaries(): readonly WebHidDeviceSummary[] {
    const out: WebHidDeviceSummary[] = [];
    for (const entry of this.#handles.values()) {
      out.push({
        id: entry.id,
        mode: entry.mode,
        productName: entry.handle.productName || `HID ${entry.handle.vendorId}/${entry.handle.productId}`,
        vendorId: entry.handle.vendorId,
        productId: entry.handle.productId,
        opened: entry.handle.opened,
      });
    }
    return Object.freeze(out);
  }

  #attach(entry: DeviceEntry): void {
    if (this.#listeners.has(entry.id)) return;
    const listener = (event: Event): void => {
      this.#onInputReport(entry.id, event);
    };
    entry.handle.addEventListener('inputreport', listener);
    this.#listeners.set(entry.id, listener);
  }

  #detach(entry: DeviceEntry): void {
    const listener = this.#listeners.get(entry.id);
    if (!listener) return;
    try {
      entry.handle.removeEventListener('inputreport', listener);
    } catch {
      // 设备对象已释放时移除监听失败，忽略
    }
    this.#listeners.delete(entry.id);
  }

  #onInputReport(id: string, event: Event): void {
    const detail = (event as CustomEvent<unknown>).detail ?? event;
    const report = detail as { reportId?: unknown; data?: unknown };
    const bytes = toBytes(report.data);
    if (!bytes) return;

    const reportId = Number(report.reportId ?? 0);
    const entry = this.#handles.get(id);
    let values: Record<string, number> = {};
    try {
      values = entry?.handle.decode?.('input', reportId, bytes)?.values ?? {};
    } catch {
      // 描述符与数据不匹配时保留原始 hex，不打断后续报告
      values = {};
    }

    const sample: WebHidReportSample = { deviceId: id, reportId, hex: toHex(bytes), values, at: Date.now() };
    this.#reports.push(sample);
    if (this.#reports.length > MAX_REPORTS) this.#reports.splice(0, this.#reports.length - MAX_REPORTS);
    this.#state = Object.freeze({ ...this.#state, lastReport: sample });
    this.dispatchEvent(new CustomEvent<WebHidReportSample>(REPORT_EVENT, { detail: sample }));
  }
}

/** 供视图做错误文案映射：`device.error.<code>` */
export function errorKeyOf(code: WebHidErrorCode | null): string {
  return `device.error.${code ?? 'unknown'}`;
}
