/**
 * 诊断数据面：帧日志环形缓冲 + 统计聚合 + 可复制的纯文本导出（R8）。
 *
 * 与 `proto/session.ts` 分开的理由：会话只负责"产生"条目，面板（Stage 5）只负责"展示"，
 * 两边共享同一条环形缓冲规则，避免面板自己再实现一遍上限与排序（R8-4）。
 * 本文件不碰 DOM：派生自 `EventTarget`，订阅方自己决定怎么画。
 */

import type { DiagEntry, SessionStats } from './proto/session';

/** 与 `SessionStats` 同构；设计文档 §5.12 称 `DiagStats`，任务书 §4.4 称 `DiagnosticsStats` */
export interface DiagnosticsStats extends SessionStats {}

export type DiagStats = DiagnosticsStats;

export const ENTRY_EVENT = 'entry';
export const STATS_EVENT = 'stats';

const DEFAULT_RING_SIZE = 500;
const UNKNOWN_DEVICE = '未连接';

const ZERO_STATS: SessionStats = Object.freeze({
  outFrames: 0,
  inFrames: 0,
  crcErrors: 0,
  timeouts: 0,
  retries: 0,
  droppedPolls: 0,
  queueDepth: 0,
});

function zeroStats(): SessionStats {
  return { ...ZERO_STATS };
}

function pad(value: number, digits: number): string {
  return String(value).padStart(digits, '0');
}

/** 日志行时间戳按本地时间显示（贴进问题单时人工对表最直接） */
function formatTime(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '--:--:--.---';
  return `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}

function formatStats(stats: SessionStats): string {
  return (
    `统计：出帧 ${stats.outFrames} / 入帧 ${stats.inFrames} / CRC 错 ${stats.crcErrors} / ` +
    `超时 ${stats.timeouts} / 重试 ${stats.retries} / 丢弃轮询 ${stats.droppedPolls} / 队列 ${stats.queueDepth}`
  );
}

function formatEntry(entry: DiagEntry): string {
  const arrow = entry.dir === 'out' ? '→' : '←';
  return `${formatTime(entry.at)}  ${arrow}  ${entry.hex}   ${entry.summary}`;
}

export class DiagnosticsHub extends EventTarget {
  private readonly ringSize: number;
  private readonly ring: DiagEntry[] = [];
  private current: SessionStats = zeroStats();
  private device = UNKNOWN_DEVICE;

  constructor(options?: { readonly ringSize?: number }) {
    super();
    const requested = Math.floor(options?.ringSize ?? DEFAULT_RING_SIZE);
    this.ringSize = Number.isFinite(requested) && requested >= 1 ? requested : DEFAULT_RING_SIZE;
  }

  /** 环形写入：超出 `ringSize` 丢最旧（R8-4），并派发 `entry` 事件 */
  push(entry: DiagEntry): void {
    this.ring.push(entry);
    while (this.ring.length > this.ringSize) this.ring.shift();
    this.dispatchEvent(new CustomEvent<DiagEntry>(ENTRY_EVENT, { detail: entry }));
  }

  /** 时间升序；返回副本，调用方改不动内部状态 */
  entries(): readonly DiagEntry[] {
    return this.ring.slice().sort((left, right) => left.at - right.at);
  }

  /**
   * 合并更新统计（`Partial` 语义：只覆盖传入的字段），并派发 `stats` 事件。
   * `deviceSummary` 不参与 `stats()`，只用于 `toText()` 的设备行（任务书 §4.4）。
   */
  update(stats: Partial<SessionStats> & { readonly deviceSummary?: string }): void {
    const next = { ...this.current };
    if (stats.outFrames !== undefined) next.outFrames = stats.outFrames;
    if (stats.inFrames !== undefined) next.inFrames = stats.inFrames;
    if (stats.crcErrors !== undefined) next.crcErrors = stats.crcErrors;
    if (stats.timeouts !== undefined) next.timeouts = stats.timeouts;
    if (stats.retries !== undefined) next.retries = stats.retries;
    if (stats.droppedPolls !== undefined) next.droppedPolls = stats.droppedPolls;
    if (stats.queueDepth !== undefined) next.queueDepth = stats.queueDepth;
    this.current = next;
    if (stats.deviceSummary !== undefined) this.device = stats.deviceSummary;
    this.dispatchEvent(new CustomEvent<SessionStats>(STATS_EVENT, { detail: this.stats() }));
  }

  stats(): SessionStats {
    return { ...this.current };
  }

  /** 可直接贴进问题单的纯文本（R8-3） */
  toText(): string {
    const lines = ['# MIC STUDIO 诊断日志', `设备：${this.device}`, formatStats(this.current)];
    for (const entry of this.entries()) lines.push(formatEntry(entry));
    return lines.join('\n');
  }

  /** 清空日志与统计；设备摘要属于连接信息，换设备前不清（重连后仍要能看出是哪台） */
  clear(): void {
    this.ring.length = 0;
    this.current = zeroStats();
  }
}
