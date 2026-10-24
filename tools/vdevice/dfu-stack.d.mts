export declare const SIGMA_START: 196;
export declare const CMD_DFU: 11;
export declare const CMD_ACK: 2;
export declare const CMD_PARAM_WRITE: 3;

export declare const DFU_CMD_STATUS: 1;
export declare const DFU_CMD_INFO: 2;
export declare const DFU_CMD_BLOCK: 3;

export declare const DFU_STATUS_INFO_ERR: 1;
export declare const DFU_STATUS_CODE_ERR: 2;
export declare const DFU_STATUS_CONTINUE: 3;
export declare const DFU_STATUS_FAIL: 4;
export declare const DFU_STATUS_SUCCESS: 5;

export declare const SIGMA_ACK_DEV_ADDR_ERR: 1;
export declare const SIGMA_ACK_LEN_ERR: 2;
export declare const SIGMA_ACK_CHECKSUM_ERR: 3;

export declare const GAMMA_KEY: number;
export declare const GAMMA_BYTES: number;
export declare const BLOCK_BYTES: number;
export declare const APP_MAX_BYTES: number;
export declare const BOOT_MAX_BYTES: number;
export declare const MAX_SIGMA_FRAME: number;
export declare const SIGMA_OVERHEAD: number;
export declare const INFO_FRAME_BYTES: number;
export declare const STATUS_FRAME_BYTES: number;
export declare const ACK_FRAME_BYTES: number;
export declare const CHIP_ID: number;

export type DfuState = 'idle' | 'infoAccepted' | 'done' | 'failed';

export interface DfuVersion {
  x: number;
  y: number;
  z: number;
}

export interface DfuImageInfo {
  modelCode: string;
  modelName: string;
  version: DfuVersion;
  length: number;
  checksum: number;
}

export interface DfuFlash {
  /** 已写入的明文字节数 */
  bytes: number;
  /** 32 位小端字累加值 */
  checksum: number;
  /** 已接受的块数 */
  blocks: number;
}

export interface DfuStats {
  framesIn: number;
  framesOut: number;
}

export interface DfuStackOptions {
  modelCode?: string;
  allowBootld?: boolean;
  now?: () => number;
  timers?: unknown;
  onReplies: (reports: Uint8Array[]) => void;
}

export declare function sigmaCrc(bytes: Uint8Array): number;
export declare function buildSigmaFrame(cmd: number, data?: ArrayLike<number> | null, addr?: number): Uint8Array;
export declare function decodeSigmaFrames(bytes: Uint8Array): Uint8Array[];
export declare function gammaDecrypt(bytes: Uint8Array): Uint8Array;
export declare function gammaEncrypt(bytes: Uint8Array): Uint8Array;
export declare function sum32Words(bytes: Uint8Array): number;
export declare function splitReports(bytes: Uint8Array): Uint8Array[];

export declare class DfuStack {
  constructor(opts: DfuStackOptions);
  readonly modelCode: string;
  feed(payload: Uint8Array | ArrayLike<number>): void;
  state(): DfuState;
  lastStatus(): number | null;
  flash(): DfuFlash;
  info(): DfuImageInfo | null;
  completed(): boolean;
  stats(): DfuStats;
  powerLoss(): void;
  reset(): void;
}
