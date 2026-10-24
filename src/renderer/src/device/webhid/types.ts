/**
 * 本仓对 webhid-kit 的最小契约。
 *
 * session 只依赖这层，不直接 import 子模块：单测可以注入假实现，
 * 也就不会把浏览器 WebSocket / 设备行为带进 happy-dom。
 * 真实实现见 ./kit.ts，唯一 import '@webhid-kit' 的地方。
 */

/** 设备通道：virtual 走本地桥接，native 走浏览器原生 WebHID */
export type WebHidMode = 'virtual' | 'native';

export type WebHidStatus = 'idle' | 'connecting' | 'ready' | 'error';

/** 面向界面的失败分类；文案键 = `device.error.<code>`，原始 message 另外保留 */
export type WebHidErrorCode = 'nativeUnavailable' | 'bridge' | 'device' | 'noSelection' | 'unknown';

/**
 * 真机设备选择器的 usage 过滤条件（W3C `HIDDeviceFilter` 的最小子集）。
 *
 * Electron 33 的 `HIDDevice` 不带 collections / usage page，主进程无法按 usage 复核，
 * 所以 usage 过滤只能落在渲染进程的 `requestDevice({ filters })`（设计 R-9 / §9 B13）。
 */
export interface WebHidUsageFilter {
  readonly usagePage: number;
  readonly usage: number;
}

export interface WebHidDeviceHandle {
  /** 桥接设备自带；真机没有，由 session 合成 */
  readonly deviceId?: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  /**
   * 出站报告（`0x51`，63 B 载荷）。3.2 起参数协议经它出站：
   * 桥接设备与 `NativeHidHandle` 都提供，但在本仓契约里保持可选，
   * 由 `WebHidTransport.open()` 显式校验（缺了就当设备不可用）。
   */
  sendReport?(reportId: number, data: Uint8Array): Promise<void>;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  /** 字段级解码；桥接设备与 NativeHidHandle 都有 */
  decode?(reportType: string, reportId: number, data: Uint8Array): { values: Record<string, number> };
}

export interface WebHidDeviceSummary {
  readonly id: string;
  readonly mode: WebHidMode;
  readonly productName: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly opened: boolean;
}

export interface WebHidReportSample {
  readonly deviceId: string;
  readonly reportId: number;
  readonly hex: string;
  readonly values: Readonly<Record<string, number>>;
  readonly at: number;
}

export interface WebHidSessionState {
  readonly status: WebHidStatus;
  readonly mode: WebHidMode;
  readonly bridgeUrl: string;
  readonly error: string | null;
  readonly errorCode: WebHidErrorCode | null;
  readonly devices: readonly WebHidDeviceSummary[];
  readonly lastReport: WebHidReportSample | null;
}

export interface WebHidKitBridge {
  list(): Promise<WebHidDeviceHandle[]>;
  restore(): void;
}

/** webhid-kit 的注入面：默认实现见 ./kit.ts */
export interface WebHidKit {
  readonly version: string;
  readonly bridgeUrl: string;
  readonly bridgeProtocol: string;
  installVirtualBridge(url: string): Promise<WebHidKitBridge>;
  nativeAvailable(): boolean;
  nativeDevices(): Promise<WebHidDeviceHandle[]>;
  /** 传空 / 不传 = 不带过滤，行为与改动前一致 */
  requestNativeDevice(filters?: readonly WebHidUsageFilter[]): Promise<WebHidDeviceHandle[]>;
}
