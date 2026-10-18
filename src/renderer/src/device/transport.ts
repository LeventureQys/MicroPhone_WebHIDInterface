export type TransportState = 'idle' | 'connecting' | 'ready' | 'error';

export interface LevelFrame {
  /** 毫秒时间戳 */
  t: number;
  /** 输入 RMS，dBFS，-96..0 */
  inputRms: number;
  inputPeak: number;
  outputRms: number;
  outputPeak: number;
}

export interface ParamWrite {
  id: string;
  value: number;
}

export interface Transport {
  readonly kind: 'mock' | 'webhid';
  state(): TransportState;
  /** 失败 → state 'error' 并 console.warn，不向调用方抛出 */
  open(): Promise<void>;
  close(): Promise<void>;
  /** 同步返回，永不抛出；内部失败经 onStateChange 报告 */
  write(updates: readonly ParamWrite[]): void;
  onLevels(cb: (frame: LevelFrame) => void): () => void;
  onStateChange(cb: (state: TransportState) => void): () => void;
}
