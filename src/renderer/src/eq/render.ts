import type { CurvePoint, EqBand, Viewport } from './types';
import { EQ_TYPE_LABEL } from './types';

export interface EqTheme {
  gridColor: string;
  axisColor: string;
  zeroDbColor: string;
  curveColor: string;
  curveLineWidth: number;
  fillColor: string;
  labelColor: string;
  labelFont: string;
  bandFill: string;
  bandStroke: string;
  bandFocusFill: string;
  bandFocusStroke: string;
  bandRadius: number;
  margin: { top: number; right: number; bottom: number; left: number };
}

export const DEFAULT_EQ_THEME: EqTheme = {
  gridColor: 'rgba(168,187,205,0.11)',
  axisColor: 'rgba(255,255,255,0.45)',
  zeroDbColor: 'rgba(255,255,255,0.28)',
  curveColor: '#F0A030',
  curveLineWidth: 2.5,
  fillColor: 'rgba(240,160,48,0.15)',
  labelColor: '#8592a7',
  labelFont: '11px ui-monospace, Consolas, monospace',
  bandFill: '#171c26',
  bandStroke: 'rgba(255,255,255,0.9)',
  bandFocusFill: '#1d2430',
  bandFocusStroke: '#f0a65b',
  bandRadius: 10,
  margin: { top: 20, right: 24, bottom: 40, left: 68 },
};

interface DrawOptions {
  width: number;
  height: number;
  freqTicks: number[];
  gainTicks: number[];
  bands: readonly EqBand[];
  visibleCount: number;
  focusedIndex: number;
  curve: readonly CurvePoint[];
  freqToX: (freq: number) => number;
  gainToY: (gain: number) => number;
  xToFreq: (x: number) => number;
  yToGain: (y: number) => number;
  theme?: Partial<EqTheme>;
}

function formatFreq(freq: number): string {
  if (freq >= 1000) {
    const k = freq / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(freq);
}

export function drawEq(ctx: CanvasRenderingContext2D, options: DrawOptions): void {
  const theme: EqTheme = { ...DEFAULT_EQ_THEME, ...options.theme };
  const { width, height, margin } = { ...options, margin: theme.margin };
  if (width <= 0 || height <= 0) return;

  const vp: Viewport = {
    x: margin.left,
    y: margin.top,
    width: Math.max(10, width - margin.left - margin.right),
    height: Math.max(10, height - margin.top - margin.bottom),
  };

  const clampY = (y: number): number => Math.max(vp.y, Math.min(vp.y + vp.height, y));
  // 映射函数来自调用方，防御性处理非有限值，避免脏数据进 canvas 绘制调用
  const safeX = (freq: number): number => {
    const value = options.freqToX(freq);
    return Number.isFinite(value) ? value : vp.x;
  };
  const safeY = (gainDb: number): number => {
    const value = options.gainToY(gainDb);
    return Number.isFinite(value) ? clampY(value) : vp.y;
  };

  ctx.clearRect(0, 0, width, height);
  ctx.save();

  // 网格
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.gridColor;
  ctx.beginPath();
  for (const freq of options.freqTicks) {
    const raw = options.freqToX(freq);
    if (!Number.isFinite(raw)) continue;
    const x = raw;
    if (x < vp.x - 1 || x > vp.x + vp.width + 1) continue;
    ctx.moveTo(x, vp.y);
    ctx.lineTo(x, vp.y + vp.height);
  }
  for (const gain of options.gainTicks) {
    const raw = options.gainToY(gain);
    if (!Number.isFinite(raw)) continue;
    const y = raw;
    ctx.moveTo(vp.x, y);
    ctx.lineTo(vp.x + vp.width, y);
  }
  ctx.stroke();

  // 0 dB 线
  const zeroY = safeY(0);
  ctx.strokeStyle = theme.zeroDbColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(vp.x, zeroY);
  ctx.lineTo(vp.x + vp.width, zeroY);
  ctx.stroke();

  // 轴标签
  ctx.font = theme.labelFont;
  ctx.fillStyle = theme.labelColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const freq of options.freqTicks) {
    const x = options.freqToX(freq);
    if (!Number.isFinite(x)) continue;
    if (x < vp.x - 6 || x > vp.x + vp.width + 6) continue;
    // 下移让出节点半径，避免极端增益时节点压住频率标签
    ctx.fillText(`${formatFreq(freq)}Hz`, x, vp.y + vp.height + 22);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const gain of options.gainTicks) {
    const y = options.gainToY(gain);
    if (!Number.isFinite(y)) continue;
    ctx.fillText(String(gain), vp.x - 14, y);
  }

  // 曲线填充 + 描边
  const points = options.curve;
  if (points.length > 0) {
    ctx.beginPath();
    const firstX = safeX(points[0].freq);
    ctx.moveTo(firstX, safeY(points[0].gainDb));
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(safeX(points[i].freq), safeY(points[i].gainDb));
    }
    const lastX = safeX(points[points.length - 1].freq);
    ctx.lineTo(lastX, zeroY);
    ctx.lineTo(firstX, zeroY);
    ctx.closePath();
    ctx.fillStyle = theme.fillColor;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(firstX, safeY(points[0].gainDb));
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(safeX(points[i].freq), safeY(points[i].gainDb));
    }
    ctx.strokeStyle = theme.curveColor;
    ctx.lineWidth = theme.curveLineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // 节点
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '11px ui-monospace, Consolas, monospace';
  for (const band of options.bands) {
    if (band.index >= options.visibleCount) continue;
    const x = safeX(band.freq);
    const y = safeY(band.gain);
    const focused = band.index === options.focusedIndex;

    ctx.beginPath();
    ctx.arc(x, y, theme.bandRadius, 0, Math.PI * 2);
    ctx.fillStyle = focused ? theme.bandFocusFill : theme.bandFill;
    ctx.fill();
    ctx.strokeStyle = focused ? theme.bandFocusStroke : theme.bandStroke;
    ctx.lineWidth = focused ? 2 : 1.2;
    ctx.stroke();

    ctx.fillStyle = focused ? theme.bandFocusStroke : '#e7ebf2';
    ctx.fillText(String(band.index + 1), x, y);
  }

  ctx.restore();
}

export function describeBandType(band: EqBand): string {
  return EQ_TYPE_LABEL[band.type] ?? 'PEAK';
}

export function freqLabelForAxis(freq: number): string {
  return formatFreq(freq);
}
