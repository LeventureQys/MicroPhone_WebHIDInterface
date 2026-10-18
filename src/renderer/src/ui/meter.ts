export interface MeterChannel {
  label: string;
  rms: number;
  peak: number;
}

interface MeterOptions {
  minDb?: number;
  rowHeight?: number;
  labelWidth?: number;
  valueWidth?: number;
}

const TRACK_HEIGHT = 10;

function clampDb(value: number, minDb: number): number {
  if (!Number.isFinite(value)) return minDb;
  return Math.max(minDb, Math.min(0, value));
}

function barColor(db: number): string {
  // 与品牌琥珀色统一：越响越亮，临界转红
  if (db > -3) return '#f69a9a';
  if (db > -9) return '#f4aa5f';
  if (db > -18) return '#f0a65b';
  return '#8a6a45';
}

export class MeterCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly minDb: number;
  private readonly rowHeight: number;
  private readonly labelWidth: number;
  private readonly valueWidth: number;
  private width = 0;
  private height = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement, options: MeterOptions = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.minDb = options.minDb ?? -60;
    this.rowHeight = options.rowHeight ?? 40;
    this.labelWidth = options.labelWidth ?? 88;
    this.valueWidth = options.valueWidth ?? 112;
  }

  render(channels: MeterChannel[]): void {
    if (!this.ctx) return;
    this.syncSize(channels.length);
    const ctx = this.ctx;
    const { width, height, rowHeight, labelWidth, valueWidth, minDb } = this;

    ctx.clearRect(0, 0, width, height);

    const trackX = labelWidth;
    const trackW = Math.max(10, width - labelWidth - valueWidth);

    channels.forEach((channel, index) => {
      const rowY = index * rowHeight;
      const centerY = rowY + rowHeight / 2;
      const rms = clampDb(channel.rms, minDb);
      const peak = clampDb(channel.peak, minDb);
      const toRatio = (db: number): number => (db - minDb) / (0 - minDb);

      // 标签
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillStyle = '#b8c5d3';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(channel.label, 0, centerY);

      // 轨道
      const trackY = centerY - TRACK_HEIGHT / 2;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      this.roundRect(trackX, trackY, trackW, TRACK_HEIGHT, TRACK_HEIGHT / 2);
      ctx.fill();

      // RMS 条
      const rmsW = Math.max(0, trackW * toRatio(rms));
      if (rmsW > 0) {
        ctx.fillStyle = barColor(rms);
        this.roundRect(trackX, trackY, Math.max(rmsW, 3), TRACK_HEIGHT, TRACK_HEIGHT / 2);
        ctx.fill();
      }

      // 峰值线
      const peakX = trackX + trackW * toRatio(peak);
      ctx.strokeStyle = 'rgba(231,235,242,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(peakX, trackY - 2);
      ctx.lineTo(peakX, trackY + TRACK_HEIGHT + 2);
      ctx.stroke();

      // 刻度
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      for (let db = minDb; db <= 0; db += 12) {
        const x = trackX + trackW * toRatio(db);
        ctx.beginPath();
        ctx.moveTo(x, trackY - 3);
        ctx.lineTo(x, trackY + TRACK_HEIGHT + 3);
        ctx.stroke();
      }

      // 数值
      ctx.font = '11px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = '#8592a7';
      ctx.fillText(`RMS ${rms.toFixed(1)}`, width - 4, centerY - 7);
      ctx.fillStyle = '#b8c5d3';
      ctx.fillText(`PK ${peak.toFixed(1)}`, width - 4, centerY + 7);
    });
  }

  destroy(): void {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  private syncSize(rows: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(rect.width, 240);
    const cssHeight = Math.max(rows * this.rowHeight, this.rowHeight);
    const dpr = window.devicePixelRatio || 1;

    if (this.width !== cssWidth || this.height !== cssHeight || this.dpr !== dpr) {
      this.canvas.width = Math.round(cssWidth * dpr);
      this.canvas.height = Math.round(cssHeight * dpr);
      this.canvas.style.height = `${cssHeight}px`;
      this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.width = cssWidth;
      this.height = cssHeight;
      this.dpr = dpr;
    }
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    if (!this.ctx) return;
    const radius = Math.min(r, h / 2, w / 2);
    this.ctx.beginPath();
    this.ctx.moveTo(x + radius, y);
    this.ctx.lineTo(x + w - radius, y);
    this.ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    this.ctx.lineTo(x + w, y + h - radius);
    this.ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    this.ctx.lineTo(x + radius, y + h);
    this.ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    this.ctx.lineTo(x, y + radius);
    this.ctx.quadraticCurveTo(x, y, x + radius, y);
    this.ctx.closePath();
  }
}
