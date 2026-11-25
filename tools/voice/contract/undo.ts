/**
 * 撤销栈（Alpha v1.3.0 / SubStage 4.2 §4.1，设计文档 §3.6）。
 *
 * 一条 `UndoEntry` 记的是**前值**：本轮要写哪些 `(param | band.field)`，每个在写之前是多少。
 * 撤销就是拿这组前值原样再写一遍（同一套 sink、同一套夹紧），因此不需要"反向 delta"，
 * 也不会因为场景/音色的整包写入而漏项——快照里本来就是本轮碰到的全量。
 *
 * 两条硬约束（§8 禁止事项）：
 *
 * 1. 撤销成功之后**不再**把这次撤销入栈（避免"撤销的撤销"成环）；
 * 2. 撤销成功后该快照丢弃——连续两次 `undo` 连续回退到更早的状态。
 *
 * `peek()` 不是 §4.1 契约里的方法，但 §5 要求"撤销时 sink 不可用 → 栈顶不弹出（保持可重试）"，
 * 所以执行器必须先看后写、成功才 `pop()`；这一条只能靠 `peek()` 表达。
 */

import type { EqField } from './rules';

export type { EqField };

/** 标量前值 */
export interface UndoWrite {
  readonly param: string;
  readonly value: number;
}

/** EQ 段字段前值（`band` 是 1..7，不是寄存器里的 0..6） */
export interface UndoBandWrite {
  readonly band: number;
  readonly field: EqField;
  readonly value: number;
}

export interface UndoEntry {
  /** 产生这条快照的 turn（`t-0001`…） */
  readonly turn: string;
  /** `Date.now()` */
  readonly at: number;
  writes: UndoWrite[];
  bandWrites: UndoBandWrite[];
  scene: string | null;
  tone: string | null;
}

/** §3.6 的栈深 */
export const DEFAULT_UNDO_DEPTH = 5;

function cloneEntry(entry: UndoEntry): UndoEntry {
  return {
    turn: entry.turn,
    at: entry.at,
    writes: entry.writes.map((write) => ({ param: write.param, value: write.value })),
    bandWrites: entry.bandWrites.map((write) => ({
      band: write.band,
      field: write.field,
      value: write.value,
    })),
    scene: entry.scene,
    tone: entry.tone,
  };
}

export class UndoStack {
  private readonly limit: number;

  private readonly items: UndoEntry[] = [];

  constructor(depth: number = DEFAULT_UNDO_DEPTH) {
    if (!Number.isInteger(depth) || depth <= 0) {
      throw new Error(`E_UNDO_DEPTH: 撤销栈深必须是正整数，收到 ${String(depth)}`);
    }
    this.limit = depth;
  }

  /** 入栈；超过深度丢最旧的一条 */
  push(entry: UndoEntry): void {
    this.items.push(cloneEntry(entry));
    while (this.items.length > this.limit) this.items.shift();
  }

  /** 出栈；空栈返回 `null` */
  pop(): UndoEntry | null {
    const last = this.items.pop();
    return last ? cloneEntry(last) : null;
  }

  /** 只看不弹（撤销失败要保留栈顶，见 §5） */
  peek(): UndoEntry | null {
    const last = this.items[this.items.length - 1];
    return last ? cloneEntry(last) : null;
  }

  depth(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }
}

/** `snapshotEntry` 的入参：`canonicalize` 产出的写入集（子集即可） */
export interface SnapshotCommand {
  readonly writes: readonly UndoWrite[];
  readonly bandWrites: readonly UndoBandWrite[];
  readonly scene?: string | null;
  readonly tone?: string | null;
}

/**
 * 把"本轮要写什么"折算成"前值快照"。
 *
 * `prev(paramId)` 由调用方提供（执行器传 `readback.currentValueOf` 绑上当前状态）：
 * 快照必须与写入走同一套取值规则，否则撤销写回去的值会与设备上的真实前值差一档。
 */
export function snapshotEntry(
  command: SnapshotCommand,
  prev: (paramId: string) => number,
  turn: string,
  now: number = Date.now(),
): UndoEntry {
  return {
    turn,
    at: now,
    writes: command.writes.map((write) => ({ param: write.param, value: prev(write.param) })),
    bandWrites: command.bandWrites.map((write) => ({
      band: write.band,
      field: write.field,
      value: prev(`eq.band${write.band}.${write.field}`),
    })),
    scene: command.scene ?? null,
    tone: command.tone ?? null,
  };
}
