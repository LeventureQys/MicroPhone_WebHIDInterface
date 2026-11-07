import type { CurvePoint, EqBand, Viewport } from './types';
import { EQ_TYPE_LABEL } from './types';

export interface EqTheme {
  gridColor: string;
  /** 十倍频程线（100 / 1k / 10k）比普通刻度线重一档 */
  gridMajorColor: string;
  axisColor: string;
  zeroDbColor: string;
  curveColor: string;
  curveLineWidth: number;
  /** 曲线外发光：先画一道宽而淡的描边，再画实线 */
  curveGlow: string;
  /** 靠近 0 dB 处的填充浓度 */
  fillColor: string;
  /** 远离 0 dB 处的填充浓度：提升与衰减越大填得越浓 */
  fillStrongColor: string;
  labelColor: string;
  labelFont: string;
  bandFill: string;
  bandStroke: string;
  bandText: string;
  bandFocusFill: string;
  bandFocusStroke: string;
  bandFocusText: string;
  bandRadius: number;
  readoutFont: string;
  readoutColor: string;
  margin: { top: number; right: number; bottom: number; left: number };
}

export const DEFAULT_EQ_THEME: EqTheme = {
  gridColor: 'rgba(255,255,255,0.045)',
  gridMajorColor: 'rgba(255,255,255,0.09)',
  axisColor: 'rgba(255,255,255,0.45)',
  zeroDbColor: 'rgba(255,255,255,0.22)',
  curveColor: '#F3A45C',
  curveLineWidth: 2,
  curveGlow: 'rgba(243,164,92,0.16)',
  fillColor: 'rgba(243,164,92,0.03)',
  fillStrongColor: 'rgba(243,164,92,0.2)',
  labelColor: '#5d6472',
  labelFont: '10.5px ui-monospace, "Cascadia Mono", Consolas, monospace',
  bandFill: '#0d0f13',
  bandStroke: 'rgba(236,238,242,0.78)',
  bandText: '#eceef2',
  bandFocusFill: '#F3A45C',
  bandFocusStroke: '#FFB978',
  bandFocusText: '#1c1208',
  bandRadius: 10,
  readoutFont: '11px ui-monospace, "Cascadia Mono", Consolas, monospace',
  readoutColor: '#a9b0bc',
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

function formatGain(gain: number): string {
  return gain > 0 ? `+${gain}` : String(gain);
}

function isDecade(freq: number): boolean {
  const exponent = Math.log10(freq);
  return Math.abs(exponent - Math.round(exponent)) < 1e-9;
}

/** 选中节点的读数；HPF / LPF 没有增益，不写 dB */
function bandReadout(band: EqBand): string {
  const freq =
    band.freq >= 1000
      ? `${(band.freq / 1000).toFixed(band.freq % 1000 === 0 ? 0 : 2)} kHz`
      : `${band.freq} Hz`;
  const parts = [`#${band.index + 1}`, EQ_TYPE_LABEL[band.type] ?? 'PEAK', freq];
  if (band.type !== 3 && band.type !== 4) parts.push(`${band.gain > 0 ? '+' : ''}${band.gain.toFixed(1)} dB`);
  parts.push(`Q ${band.q.toFixed(1)}`);
  return parts.join('   ');
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
  // 1 px 线落在半像素上才不会糊成 2 px
  const crisp = (value: number): number => Math.round(value) + 0.5;

  ctx.clearRect(0, 0, width, height);
  ctx.save();

  // 网格：普通刻度一档，十倍频程一档；0 dB 单独画
  ctx.lineWidth = 1;
  for (const major of [false, true]) {
    ctx.strokeStyle = major ? theme.gridMajorColor : theme.gridColor;
    ctx.beginPath();
    for (const freq of options.freqTicks) {
      if (isDecade(freq) !== major) continue;
      const raw = options.freqToX(freq);
      if (!Number.isFinite(raw)) continue;
      if (raw < vp.x - 1 || raw > vp.x + vp.width + 1) continue;
      ctx.moveTo(crisp(raw), vp.y);
      ctx.lineTo(crisp(raw), vp.y + vp.height);
    }
    if (!major) {
      for (const gain of options.gainTicks) {
        if (gain === 0) continue;
        const raw = options.gainToY(gain);
        if (!Number.isFinite(raw)) continue;
        ctx.moveTo(vp.x, crisp(raw));
        ctx.lineTo(vp.x + vp.width, crisp(raw));
      }
    }
    ctx.stroke();
  }

  const zeroY = safeY(0);
  ctx.strokeStyle = theme.zeroDbColor;
  ctx.beginPath();
  ctx.moveTo(vp.x, crisp(zeroY));
  ctx.lineTo(vp.x + vp.width, crisp(zeroY));
  ctx.stroke();

  // 轴标签：频率不带单位（右下角统一标 Hz），增益带正负号（左上角标 dB）
  ctx.font = theme.labelFont;
  ctx.fillStyle = theme.labelColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const freq of options.freqTicks) {
    const x = options.freqToX(freq);
    if (!Number.isFinite(x)) continue;
    if (x < vp.x - 6 || x > vp.x + vp.width + 6) continue;
    // 下移让出节点半径，避免极端增益时节点压住频率标签
    ctx.fillText(formatFreq(freq), x, vp.y + vp.height + 12);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const gain of options.gainTicks) {
    const y = options.gainToY(gain);
    if (!Number.isFinite(y)) continue;
    ctx.fillText(formatGain(gain), vp.x - 12, y);
  }
  ctx.textBaseline = 'top';
  ctx.fillText('Hz', width - 6, vp.y + vp.height + 12);
  ctx.textAlign = 'left';
  ctx.fillText('dB', 8, 4);

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
    const zeroStop = Math.max(0, Math.min(1, (zeroY - vp.y) / vp.height));
    const gradient = ctx.createLinearGradient(0, vp.y, 0, vp.y + vp.height);
    gradient.addColorStop(0, theme.fillStrongColor);
    gradient.addColorStop(zeroStop, theme.fillColor);
    gradient.addColorStop(1, theme.fillStrongColor);
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(firstX, safeY(points[0].gainDb));
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(safeX(points[i].freq), safeY(points[i].gainDb));
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = theme.curveGlow;
    ctx.lineWidth = theme.curveLineWidth + 5;
    ctx.stroke();
    ctx.strokeStyle = theme.curveColor;
    ctx.lineWidth = theme.curveLineWidth;
    ctx.stroke();
  }

  // 节点：普通节点"屏幕底色 + 浅描边"，选中节点实心橙 + 发光
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 10.5px system-ui, "Segoe UI", sans-serif';
  let focusedBand: EqBand | null = null;
  for (const band of options.bands) {
    if (band.index >= options.visibleCount) continue;
    const x = safeX(band.freq);
    const y = safeY(band.gain);
    const focused = band.index === options.focusedIndex;
    if (focused) focusedBand = band;

    ctx.beginPath();
    ctx.arc(x, y, theme.bandRadius, 0, Math.PI * 2);
    ctx.shadowColor = focused ? 'rgba(243,164,92,0.55)' : 'transparent';
    ctx.shadowBlur = focused ? 14 : 0;
    ctx.fillStyle = focused ? theme.bandFocusFill : theme.bandFill;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = focused ? theme.bandFocusStroke : theme.bandStroke;
    ctx.lineWidth = focused ? 1.5 : 1.25;
    ctx.stroke();

    ctx.fillStyle = focused ? theme.bandFocusText : theme.bandText;
    ctx.fillText(String(band.index + 1), x, y + 0.5);
  }

  // 拖动时看得到精确值，不用再去高级参数里对表
  if (focusedBand) {
    ctx.font = theme.readoutFont;
    ctx.fillStyle = theme.readoutColor;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(bandReadout(focusedBand), width - 10, 4);
  }

  ctx.restore();
}

export function describeBandType(band: EqBand): string {
  return EQ_TYPE_LABEL[band.type] ?? 'PEAK';
}

export function freqLabelForAxis(freq: number): string {
  return formatFreq(freq);
}
