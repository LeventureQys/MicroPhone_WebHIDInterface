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
const DANGER_DB = -3;
const MIN_DB = -60;
/** 无数据的读数占位：静音用 −∞，无数据用 —（R5-5：两者外观必须不同） */
const UNAVAILABLE_TEXT = '—';
const MUTED_TEXT = '−∞';
const PAD_TOP = 30;
const PAD_BOTTOM = 44;
const SCALE_WIDTH = 46;
const PAD_RIGHT = 16;
const MAX_BAR_WIDTH = 110;
const MIN_BAR_WIDTH = 28;

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
    const barWidth = Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, slotWidth * 0.46));

    const yOf = (db: number): number => top + plotHeight * (1 - (clampDb(db, minDb) - minDb) / (0 - minDb));

    this.drawScale(ctx, top, yOf);

    channels.forEach((channel, index) => {
      const centerX = SCALE_WIDTH + slotWidth * index + slotWidth / 2;
      const x = centerX - barWidth / 2;
      const unavailable = channel.state === 'unavailable';
      const memory = this.memorize(channel, now, dt);

      // 轨道（不可用时只留空槽，柱与峰值线都不画）
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      this.roundRect(ctx, x, top, barWidth, plotHeight, 4);
      ctx.fill();

      if (!unavailable) {
        // RMS 柱：渐变按 dB 位置着色，越响越亮
        const rmsY = yOf(memory.rms);
        if (bottom - rmsY > 0.5) {
          const gradient = ctx.createLinearGradient(0, bottom, 0, top);
          gradient.addColorStop(0, '#6b4c33');
          gradient.addColorStop(0.55, '#c98a4d');
          gradient.addColorStop(0.85, '#f0a65b');
          gradient.addColorStop(1, '#f4aa5f');
          ctx.fillStyle = gradient;
          this.roundRect(ctx, x, rmsY, barWidth, bottom - rmsY, 4);
          ctx.fill();

          // 过 -3 dBFS 的顶端段转危险色
          if (memory.rms > DANGER_DB) {
            ctx.fillStyle = 'rgba(246, 154, 154, 0.92)';
            this.roundRect(ctx, x, yOf(memory.rms), barWidth, yOf(DANGER_DB) - yOf(memory.rms), 4);
            ctx.fill();
          }
        }

        // 峰值保持线
        const holdY = yOf(memory.holdDb);
        ctx.fillStyle = '#e7ebf2';
        ctx.fillRect(x - 3, holdY - 1, barWidth + 6, 2);
      }

      // 通道名
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#b8c5d3';
      ctx.fillText(channel.label, centerX, top - 10);

      // 读数：RMS 用瞬时包络，PK 用保持值，避免 50Hz 数字跳动
      ctx.font = '10px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#8592a7';
      ctx.fillText(`${this.rmsLabel} ${meterText(memory.rms, channel.state, minDb)}`, centerX, bottom + 18);
      ctx.fillStyle = '#b8c5d3';
      ctx.fillText(`${this.peakLabel} ${meterText(memory.holdDb, channel.state, minDb)}`, centerX, bottom + 32);
    });
  }

  destroy(): void {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.memory.clear();
  }

  private drawScale(
    ctx: CanvasRenderingContext2D,
    top: number,
    yOf: (db: number) => number,
  ): void {
    const { width, minDb } = this;
    const right = width - PAD_RIGHT;
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (const db of TICKS) {
      if (db < minDb) continue;
      const y = yOf(db);
      ctx.strokeStyle = db === 0 ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.07)';
      ctx.beginPath();
      ctx.moveTo(SCALE_WIDTH - 6, y);
      ctx.lineTo(right, y);
      ctx.stroke();

      ctx.fillStyle = db === 0 ? '#e7ebf2' : '#8592a7';
      ctx.fillText(db === 0 ? '0' : String(db), SCALE_WIDTH - 12, y);
    }

    // 刻度线之外再压一条顶端基准，强调 0 dBFS 上限
    ctx.strokeStyle = 'rgba(240, 166, 91, 0.25)';
    ctx.beginPath();
    ctx.moveTo(SCALE_WIDTH - 6, top);
    ctx.lineTo(right, top);
    ctx.stroke();
    ctx.fillStyle = 'rgba(240, 166, 91, 0.45)';
    ctx.fillRect(SCALE_WIDTH - 6, top, 2, Math.max(0, yOf(this.minDb) - top));
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
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(320, rect.width || 640);
    const cssHeight = Math.max(220, rect.height || 360);
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

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }
}
