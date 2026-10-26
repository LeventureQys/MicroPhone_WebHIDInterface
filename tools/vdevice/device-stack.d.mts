export declare const MODE_APP: 'app';
export declare const MODE_BOOTLOADER: 'bootloader';
export declare const REPORT_ID_IN: number;
export declare const PAYLOAD_BYTES: number;
export declare const MAX_FRAME_BYTES: number;

export declare const ACK_NO_ERR: number;
export declare const ACK_DEV_ADDR_ERR: number;
export declare const ACK_LEN_ERR: number;
export declare const ACK_CHECKSUM_ERR: number;
export declare const ACK_READ_ONLY_ERR: number;
export declare const ACK_DATA_ERR: number;

export declare const LEVEL_ADDR: number;
export declare const ENTER_DFU_ADDR: number;
export declare const PRESET_START: number;
export declare const PRESET_END: number;

/** 解出一帧后交给 hooks.onFrame 的上下文；action 改成 'drop' 可让该帧不产生任何回执 */
export interface DecodedFrame {
  mode: string;
  func: number;
  data: Uint8Array;
  len: number;
  at: number;
  action: 'process' | 'drop';
}

export interface StackTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface StackHooks {
  onFrame?: (frame: DecodedFrame) => void;
  onReplies?: (reports: Uint8Array[]) => void;
}

export interface DeviceFirmware {
  x: number;
  y: number;
  z: number;
  build: number;
  type: number;
}

export interface DeviceInfo {
  modelCode: string;
  deviceName: string;
  firmware: DeviceFirmware;
  vid: number;
  pid: number;
  serial: string;
}

export interface DeviceInfoInput {
  modelCode?: string;
  deviceName?: string;
  firmware?: Partial<DeviceFirmware>;
  vid?: number;
  pid?: number;
  serial?: string;
}

export interface StackStats {
  framesIn: number;
  framesOut: number;
  byFunc: Record<string, number>;
  unknownFunc: number;
  rejectedReadOnly: number;
  rejectedRange: number;
}

export interface ParamStackOptions {
  registers?: Map<number, number>;
  info?: DeviceInfoInput;
  timers?: StackTimers;
  now?: () => number;
  onReplies: (reports: Uint8Array[]) => void;
  hooks?: StackHooks;
}

export declare function crc16(bytes: Uint8Array): number;
export declare function buildFrame(func: number, data?: ArrayLike<number> | null): Uint8Array;
export declare function splitReports(bytes: Uint8Array): Uint8Array[];
export declare function defaultRegisters(): Map<number, number>;

export declare class ParamStack {
  constructor(opts: ParamStackOptions);
  readonly mode: string;
  readonly timers: StackTimers;
  feed(payload: Uint8Array | ArrayLike<number>): void;
  setMode(mode: string): void;
  readRegister(addr: number): number | undefined;
  writeRegister(addr: number, raw: number): void;
  /** 设备主动上报（协议 1026 §4，0x10 设备→主机）；返回是否真的发了帧 */
  pushParams(pairs: ReadonlyArray<{ addr: number; raw: number }>): boolean;
  snapshot(): Record<string, number>;
  info(): DeviceInfo;
  stats(): StackStats;
  dfuRequested(): boolean;
  /** 取走一次"进 DFU"请求：读到即清空 */
  takeDfuRequest(): boolean;
  reset(): void;
}
