import type { ReportIds } from './protocol';
import type { DeviceSnapshot, DiagEntry, SessionPhase, SessionStats, TransportError } from './proto/session';
import type { WebHidDeviceHandle } from './webhid/types';

/**
 * 3.1 的错误 / 诊断 / 统计类型直接对外转出：界面层只 import 本文件，
 * 不必知道它们来自 `device/proto/**`（AGENTS.md §Architecture：业务走 device 入口）。
 */
export type { DeviceSnapshot, DiagEntry, SessionStats, TransportError } from './proto/session';

export type TransportState = 'idle' | 'connecting' | 'ready' | 'error';

/**
 * 同步相位。3.1 在 `proto/session.ts` 里命名为 `SessionPhase`，任务书 §4.1 的 `SyncPhase`
 * 是同一套取值；这里只做别名而不重复声明联合类型，避免两份枚举漂移
 * （`proto/session.ts` 属 SubStage 3.1 产出，3.2 不得修改）。
 */
export type SyncPhase = SessionPhase;

export interface LevelFrame {
  /** 毫秒时间戳 */
  readonly t: number;
  /** 输入 RMS，dBFS，-96..0 */
  readonly inputRms: number;
  readonly inputPeak: number;
  readonly outputRms: number;
  readonly outputPeak: number;
  /** 缺省 true；false 表示该通道无数据（界面显示 —，R5-4/R5-5） */
  readonly inputValid?: boolean;
  readonly outputValid?: boolean;
}

export interface ParamWrite {
  readonly id: string;
  readonly value: number;
}

/** EQ 可调段能写的四个字段（段的 Enable 不写，B7） */
export type EqBandField = 'type' | 'freq' | 'gain' | 'q';

/**
 * EQ 可调段的一次字段写入。段 1–7 对应寄存器 `0x2027`–`0x2049`（每段 5 个地址）。
 *
 * 单独一条通道而不是塞进 `ParamWrite`：EQ 段不是 `PARAMS` 里的 42 项标量，
 * 没有 paramId，换算与编号规则都在 `device/registers.ts` 的 `eqBandAddr` 里。
 */
export interface EqBandWrite {
  /** 段号 1..7（与协议 `band1`…`band7` 对齐，不是数组下标） */
  readonly band: number;
  readonly field: EqBandField;
  /** 工程量（Hz / dB / Q / 枚举 0..4） */
  readonly value: number;
}

export interface ParamReadResult {
  /** paramId → 工程量，只含 42 项标量（EQ 段另见 `bands`） */
  readonly preset: Readonly<Record<string, number>>;
  readonly device: DeviceSnapshot | null;
  /**
   * EQ 可调段 1–7 的回读值，键为寄存器字段名（`band1.type` / `band1.freq` / `band1.gain` /
   * `band1.q`），值为工程量。EQ 段不是 `PARAMS` 里的 42 项标量，塞不进 `preset`，
   * 但 `DeviceLink` 需要它们回填 `store.bands`（任务书 §4.5 第 1 条）；
   * 缺省表示该通道不提供 EQ 回读（Mock、单测假实现），调用方保持本地段值。
   */
  readonly bands?: Readonly<Record<string, number>>;
}

export interface Transport {
  readonly kind: 'mock' | 'webhid';
  state(): TransportState;
  /** 失败 → state 'error' 并派发 onError，不向调用方抛出 */
  open(): Promise<void>;
  close(): Promise<void>;
  /** 同步返回，永不抛出；内部失败经 onStateChange / onError 报告 */
  write(updates: readonly ParamWrite[]): void;
  /**
   * EQ 可调段写入（段 1–7 / 寄存器 `0x2027`–`0x2049`）。
   *
   * 可选方法：`AppStore.setBands` 只用 `?.` 调用，不实现它的通道（测试假实现）不会被这条契约卡住；
   * 但 `MockTransport` 与 `WebHidTransport` 都必须实现，否则 EQ 改动不会离开界面（R2-5 的写半边）。
   */
  writeBands?(updates: readonly EqBandWrite[]): void;
  onLevels(cb: (frame: LevelFrame) => void): () => void;
  onStateChange(cb: (state: TransportState) => void): () => void;

  /** 全量回读；失败时 reject，调用方（DeviceLink）负责降级 */
  readAll(): Promise<ParamReadResult>;
  onSync(cb: (phase: SyncPhase) => void): () => void;
  onParamEcho(cb: (echo: { readonly id: string; readonly value: number }) => void): () => void;
  onError(cb: (error: TransportError) => void): () => void;
  onDiag(cb: (entry: DiagEntry) => void): () => void;
}

/**
 * 绑定了具体设备的通道：固件升级这类"直接收发报告"的功能需要拿到设备句柄与字节流。
 *
 * 刻意不并进 `Transport`：Mock 没有设备可给，`AppStore` 与界面也不该看见这层；
 * `DeviceLink.transport()` 只在真实设备通道上返回它。
 */
export interface DeviceBoundTransport extends Transport {
  /** 已打开的设备句柄，带 `sendReport(reportId, payload)` */
  readonly device: WebHidDeviceHandle;
  readonly reportIds: ReportIds;
  /** 订阅所有 IN 报告载荷（不含 report ID）；返回退订函数 */
  onInputBytes(cb: (bytes: Uint8Array) => void): () => void;
  /** 停轮询 + 暂停把 IN 字节喂给参数会话（字节仍派发给 `onInputBytes` 订阅者） */
  suspend(): Promise<void>;
  /** 恢复喂字节并重新 sync */
  resume(): Promise<void>;
  /**
   * 参数会话的统计快照（出帧/入帧/CRC 错/超时/重试/丢弃/队列）。
   *
   * 只读 getter：诊断面板（5.1）要在不订阅 `Transport` 事件的前提下拿到计数，
   * 而 `Transport` 本体刻意不带这层（Mock 没有会话）。
   */
  stats(): SessionStats;
  /** 一键自检（R8-2）；可选，通道未实现时诊断面板会禁用按钮 */
  selfCheck?(): Promise<SelfCheckResult>;
}

/** `WebHidTransport.selfCheck()` 的结果形状 */
export interface SelfCheckStep {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SelfCheckResult {
  readonly ok: boolean;
  readonly steps: readonly SelfCheckStep[];
}
