export type MeterChannelState = 'live' | 'muted' | 'unavailable';

export interface MeterChannel {
  readonly label: string;
  readonly rms: number;
  readonly peak: number;
  /**
   * 缺省 'live'。'unavailable' = 该通道没有数据（未连接 / 设备无输出通路）：
   * 不画柱、读数显示 `—`、峰值保持清零；'muted' = 有效静音：空柱 + `−∞`。
   */
  readonly state?: MeterChannelState;
}

interface MeterOptions {
  minDb?: number;
  rmsLabel?: string;
  peakLabel?: string;
}

/** 刻度按设计文档 §5.14：-60/-48/-36/-24/-12/-6/0 dBFS */
const TICKS = [0, -6, -12, -24, -36, -48, -60];
const HOLD_MS = 1200;
const HOLD_DECAY_DB_PER_SEC = 20;
const ATTACK_COEF = 0.55;
const RELEASE_COEF = 0.12;
const MIN_DB = -60;
/** 无数据的读数占位：静音用 −∞，无数据用 —（R5-5：两者外观必须不同） */
const UNAVAILABLE_TEXT = '—';
const MUTED_TEXT = '−∞';
const PAD_TOP = 26;
const PAD_BOTTOM = 44;
const SCALE_WIDTH = 34;
const PAD_RIGHT = 6;
const MAX_BAR_WIDTH = 38;
const MIN_BAR_WIDTH = 16;
/** LED 段：3 px 亮段 + 1.5 px 缝 */
const SEGMENT_PX = 3;
const SEGMENT_GAP = 1.5;
/** 分区按常见调音台习惯：-18 以下绿、-18…-6 黄、-6 以上红 */
const ZONE_MID_DB = -18;
const ZONE_HOT_DB = -6;
/** 峰值读数超过这条线就标红，提示快削波了 */
const CLIP_WARN_DB = -1;

const COLOR = {
  low: '#3ecf8e',
  mid: '#f2c14e',
  hot: '#ff5f57',
  idle: '#ffffff',
  label: '#a9b0bc',
  readout: '#6c7482',
  readoutStrong: '#d5d9e0',
  scale: '#5d6472',
  scaleZero: '#a9b0bc',
};

function zoneColor(db: number): string {
  if (db > ZONE_HOT_DB) return COLOR.hot;
  if (db > ZONE_MID_DB) return COLOR.mid;
  return COLOR.low;
}

interface ChannelMemory {
  rms: number;
  holdDb: number;
  holdAt: number;
}

function clampDb(value: number, minDb: number): number {
  if (!Number.isFinite(value)) return minDb;
  return Math.max(minDb, Math.min(0, value));
}

/** 读数文案：`unavailable` 与 `muted` 各自有独立占位符，不能都画成 −∞ */
export function formatDb(value: number, minDb: number): string {
  if (!Number.isFinite(value) || value <= minDb) return MUTED_TEXT;
  return value.toFixed(1);
}

/** 通道态感知的读数：不可用画 —，静音画 −∞，其余沿用 `formatDb` */
export function meterText(value: number, state: MeterChannelState | undefined, minDb: number = MIN_DB): string {
  if (state === 'unavailable') return UNAVAILABLE_TEXT;
  if (state === 'muted') return MUTED_TEXT;
  return formatDb(value, minDb);
}

/**
 * 双通道垂直电平表：RMS 柱 + 峰值保持线 + dBFS 刻度。
 * 峰值保持与释放包络在表内计算，Transport 只需要给瞬时帧（设计文档 §5.14）。
 */
export class MeterCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly minDb: number;
  private readonly rmsLabel: string;
  private readonly peakLabel: string;
  private readonly memory = new Map<string, ChannelMemory>();
  private width = 0;
  private height = 0;
  private dpr = 1;
  private lastFrameAt = 0;

  constructor(canvas: HTMLCanvasElement, options: MeterOptions = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.minDb = options.minDb ?? MIN_DB;
    this.rmsLabel = options.rmsLabel ?? 'RMS';
    this.peakLabel = options.peakLabel ?? 'PK';
  }

  render(channels: MeterChannel[]): void {
    if (!this.ctx) return;
    this.syncSize();

    const ctx = this.ctx;
    const { width, height, minDb } = this;
    const now = performance.now();
    const dt = this.lastFrameAt === 0 ? 0 : Math.min(0.2, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;

    ctx.clearRect(0, 0, width, height);

    const bottom = height - PAD_BOTTOM;
    const top = PAD_TOP;
    const plotHeight = Math.max(20, bottom - top);
    const plotWidth = Math.max(20, width - SCALE_WIDTH - PAD_RIGHT);
    const count = Math.max(1, channels.length);
    const slotWidth = plotWidth / count;
    const barWidth = Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, slotWidth * 0.36));

    const yOf = (db: number): number => top + plotHeight * (1 - (clampDb(db, minDb) - minDb) / (0 - minDb));
    const snap = (value: number): number => Math.round(value * this.dpr) / this.dpr;

    this.drawScale(ctx, yOf);

    const pitch = SEGMENT_PX + SEGMENT_GAP;
    const segments = Math.max(4, Math.floor((plotHeight + SEGMENT_GAP) / pitch));
    const segmentHeight = (plotHeight + SEGMENT_GAP) / segments - SEGMENT_GAP;
    const dbPerSegment = (0 - minDb) / segments;

    channels.forEach((channel, index) => {
      const centerX = SCALE_WIDTH + slotWidth * index + slotWidth / 2;
      const x = snap(centerX - barWidth / 2);
      const unavailable = channel.state === 'unavailable';
      const memory = this.memorize(channel, now, dt);

      // LED 段：不可用时整列只画中性暗段，有数据时未点亮的段保留各自分区的底色
      for (let i = 0; i < segments; i += 1) {
        const segTop = bottom - (i + 1) * (segmentHeight + SEGMENT_GAP) + SEGMENT_GAP;
        const segDb = minDb + (i + 1) * dbPerSegment;
        const lit = !unavailable && memory.rms > minDb && minDb + (i + 0.5) * dbPerSegment <= memory.rms;
        ctx.globalAlpha = unavailable ? 0.05 : lit ? 1 : 0.1;
        ctx.fillStyle = unavailable ? COLOR.idle : zoneColor(segDb);
        ctx.fillRect(x, snap(segTop), barWidth, Math.max(1, segmentHeight));
      }
      ctx.globalAlpha = 1;

      if (!unavailable && memory.holdDb > minDb) {
        // 峰值保持线：比柱宽两边各多 2 px，颜色跟分区走
        const holdY = snap(yOf(memory.holdDb));
        ctx.fillStyle = zoneColor(memory.holdDb);
        ctx.fillRect(x - 2, holdY - 1, barWidth + 4, 2);
      }

      // 通道名
      ctx.font = '600 11px system-ui, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = COLOR.label;
      ctx.fillText(channel.label, centerX, top - 10);

      // 读数：RMS 用瞬时包络，PK 用保持值，避免 50Hz 数字跳动
      ctx.font = '10.5px ui-monospace, "Cascadia Mono", Consolas, monospace';
      ctx.fillStyle = COLOR.readout;
      ctx.fillText(`${this.rmsLabel} ${meterText(memory.rms, channel.state, minDb)}`, centerX, bottom + 19);
      const hot = !unavailable && channel.state !== 'muted' && memory.holdDb > CLIP_WARN_DB;
      ctx.fillStyle = hot ? COLOR.hot : COLOR.readoutStrong;
      ctx.fillText(`${this.peakLabel} ${meterText(memory.holdDb, channel.state, minDb)}`, centerX, bottom + 35);
    });
  }

  destroy(): void {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.memory.clear();
  }

  private drawScale(ctx: CanvasRenderingContext2D, yOf: (db: number) => number): void {
    const { minDb } = this;
    ctx.font = '10px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (const db of TICKS) {
      if (db < minDb) continue;
      const y = Math.round(yOf(db) * this.dpr) / this.dpr;
      ctx.fillStyle = db === 0 ? COLOR.scaleZero : COLOR.scale;
      ctx.fillRect(SCALE_WIDTH - 7, y - 0.5, 4, 1);
      ctx.fillText(db === 0 ? '0' : String(db), SCALE_WIDTH - 11, y);
    }
  }

  /** 包络平滑 + 峰值保持：快起慢放，保持 1.2s 后按 20 dB/s 回落 */
  private memorize(channel: MeterChannel, now: number, dt: number): ChannelMemory {
    const key = channel.label;
    if (channel.state === 'unavailable') {
      // 不可用：峰值保持清零且不参与包络积分，否则恢复首帧会先跳到断线前的旧值
      const cleared: ChannelMemory = { rms: this.minDb, holdDb: this.minDb, holdAt: now };
      this.memory.set(key, cleared);
      return cleared;
    }
    // 有效静音：把输入压到表底，柱为空、读数走 −∞
    const muted = channel.state === 'muted';
    const rms = muted ? this.minDb : clampDb(channel.rms, this.minDb);
    const peak = muted ? this.minDb : clampDb(channel.peak, this.minDb);
    let memory = this.memory.get(key);
    if (!memory) {
      memory = { rms, holdDb: peak, holdAt: now };
      this.memory.set(key, memory);
      return memory;
    }

    const coef = rms > memory.rms ? ATTACK_COEF : RELEASE_COEF;
    memory.rms = memory.rms + (rms - memory.rms) * (dt === 0 ? 1 : coef);

    if (peak >= memory.holdDb) {
      memory.holdDb = peak;
      memory.holdAt = now;
    } else if (now - memory.holdAt > HOLD_MS) {
      memory.holdDb = Math.max(peak, memory.holdDb - HOLD_DECAY_DB_PER_SEC * dt);
    }
    return memory;
  }

  private syncSize(): void {
    // 位图尺寸必须等于 CSS 尺寸：按最小值放大位图会被浏览器再缩回去，字和柱都会被压扁
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = rect.width > 0 ? Math.max(120, rect.width) : 320;
    const cssHeight = rect.height > 0 ? Math.max(120, rect.height) : 360;
    const dpr = window.devicePixelRatio || 1;

    if (this.width !== cssWidth || this.height !== cssHeight || this.dpr !== dpr) {
      this.canvas.width = Math.round(cssWidth * dpr);
      this.canvas.height = Math.round(cssHeight * dpr);
      this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.width = cssWidth;
      this.height = cssHeight;
      this.dpr = dpr;
    }
  }
}
