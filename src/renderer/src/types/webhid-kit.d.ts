/**
 * webhid-kit 的本地类型声明。
 *
 * 上游（third_party/web_hid_utils/packages/webhid-kit）是零依赖、零构建的原生 ESM，
 * 不随包发 .d.ts；子模块只读引用，不为本仓的 TypeScript 去改它，所以在这里按实际用到的
 * 表面声明。运行时由 vite 别名 @webhid-kit 指向子模块的 src/index.js，
 * 声明与实现的偏差由 tests/unit/webhid-kit.test.ts 在真实代码上验证。
 */
declare module '@webhid-kit' {
  export const VERSION: string;
  export const DEFAULT_BRIDGE_URL: string;
  export const BRIDGE_PROTOCOL: string;

  export interface KitDecodedReport {
    readonly reportId: number;
    readonly reportType: string;
    readonly byteLength: number;
    readonly values: Record<string, number>;
    readonly arrays: ReadonlyArray<{ key: string; values: readonly number[] }>;
    readonly constants: readonly unknown[];
  }

  /** BridgedHIDDevice 与 NativeHidHandle 的公共表面（W3C HIDDevice 的子集 + 编解码） */
  export interface KitHIDDevice extends EventTarget {
    readonly deviceId?: string;
    readonly vendorId: number;
    readonly productId: number;
    readonly productName?: string;
    readonly serialNumber?: string;
    readonly opened: boolean;
    open(): Promise<void>;
    close(): Promise<void>;
    decode?(reportType: string, reportId: number, data: Uint8Array | DataView): KitDecodedReport;
  }

  export interface KitHID {
    readonly transport: unknown;
    onconnect: ((event: Event) => void) | null;
    ondisconnect: ((event: Event) => void) | null;
    getDevices(): Promise<KitHIDDevice[]>;
    /** 非标准：忽略授权集合，列出桥上的全部设备 */
    getAllDevices(): Promise<KitHIDDevice[]>;
    requestDevice(options?: {
      filters?: ReadonlyArray<Record<string, number>>;
      exclusionFilters?: ReadonlyArray<Record<string, number>>;
    }): Promise<KitHIDDevice[]>;
    connect(): Promise<KitHID>;
    disconnect(): void;
  }

  export interface InstalledVirtualHid {
    readonly hid: KitHID;
    readonly transport: unknown;
    readonly restore: () => void;
    readonly url: string;
  }

  export function installVirtualHid(options?: {
    url?: string;
    target?: object;
    chooser?: unknown;
    autoConnect?: boolean;
    WebSocketImpl?: unknown;
  }): Promise<InstalledVirtualHid>;

  /**
   * 上游 `native.js` 的 `NativeHidHandle`：与 `BridgedHIDDevice` 不同，它**不转发**
   * `vendorId / productId / productName / serialNumber`，身份信息只在 `device` 本体上。
   * 本仓的句柄契约要求这三项，因此 `./device/webhid/kit.ts` 负责补适配。
   */
  export interface KitNativeHIDDevice extends EventTarget {
    readonly device: {
      readonly vendorId: number;
      readonly productId: number;
      readonly productName?: string;
      readonly serialNumber?: string;
    };
    readonly opened: boolean;
    open(): Promise<void>;
    close(): Promise<void>;
    forget?(): Promise<void>;
    sendReport(reportId: number, data: Uint8Array): Promise<void>;
    sendFeatureReport(reportId: number, data: Uint8Array): Promise<void>;
    receiveFeatureReport(reportId: number): Promise<DataView>;
    decode?(reportType: string, reportId: number, data: Uint8Array | DataView): KitDecodedReport;
  }

  export function restoreNativeHid(options?: { target?: object }): boolean;
  export function isNativeWebHidAvailable(target?: object): boolean;
  export function getNativeDevices(target?: object): Promise<KitNativeHIDDevice[]>;
  export function requestNativeHidDevice(options?: {
    filters?: ReadonlyArray<Record<string, number>>;
    exclusionFilters?: ReadonlyArray<Record<string, number>>;
  }): Promise<KitNativeHIDDevice[]>;

  export interface KitReportSpec {
    readonly reportId: number;
    readonly bitLength: number;
    readonly byteLength: number;
    readonly fields: readonly unknown[];
  }

  export interface KitLayout {
    readonly usesReportIds: boolean;
    readonly input: Record<string, KitReportSpec>;
    readonly output: Record<string, KitReportSpec>;
    readonly feature: Record<string, KitReportSpec>;
  }

  export function parseReportDescriptor(
    bytes: Uint8Array | ReadonlyArray<number>,
    stringDescriptors?: readonly string[],
  ): unknown[];
  export function computeLayout(collections: unknown[]): KitLayout;
  export function toW3CCollections(collections: unknown[]): unknown[];

  export class DeviceCodec {
    constructor(layout: KitLayout);
    readonly layout: KitLayout;
    decode(reportType: string, reportId: number, data: Uint8Array | DataView): KitDecodedReport;
    encode(
      reportType: string,
      reportId: number,
      options?: {
        base?: Uint8Array | null;
        values?: Record<string, number>;
        arrays?: Record<string, readonly number[]>;
      },
    ): Uint8Array;
    fieldKeys(reportType: string, reportId: number): string[];
  }

  export function hexToBytes(text: string): Uint8Array;
  export function bytesToHex(bytes: Uint8Array, separator?: string): string;
  export function intToBytes(value: number, length: number, littleEndian?: boolean): Uint8Array;
  export function bytesToInt(bytes: Uint8Array, littleEndian?: boolean): number;
}
