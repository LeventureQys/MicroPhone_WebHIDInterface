import { describe, expect, it, vi } from 'vitest';
import { MeterCanvas, formatDb, meterText, type MeterChannel } from '../../src/renderer/src/ui/meter';

interface MockContext {
  readonly ctx: CanvasRenderingContext2D;
  /** 每次 fillText 的文案，按绘制顺序 */
  readonly texts: string[];
  /** fill / fillRect 的调用次数（柱、峰值线、刻度） */
  readonly fillCount: () => number;
}

function createMockContext(): MockContext {
  const texts: string[] = [];
  let fills = 0;
  const ctx = {
    clearRect: () => undefined,
    fillRect: () => {
      fills += 1;
    },
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    quadraticCurveTo: () => undefined,
    closePath: () => undefined,
    fill: () => {
      fills += 1;
    },
    stroke: () => undefined,
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    fillText: (text: string) => {
      texts.push(text);
    },
    setTransform: () => undefined,
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textAlign: 'center',
    textBaseline: 'alphabetic',
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, fillCount: () => fills };
}

function createCanvas(context: CanvasRenderingContext2D | null): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.getContext = (() => context) as HTMLCanvasElement['getContext'];
  return canvas;
}

function channel(label: string, rms: number, peak: number, state?: MeterChannel['state']): MeterChannel {
  return { label, rms, peak, state };
}

describe('meter', () => {
  it('renders three live channels without throwing', () => {
    const mock = createMockContext();
    const meter = new MeterCanvas(createCanvas(mock.ctx), { minDb: -60 });

    expect(() =>
      meter.render([channel('IN', -20, -12), channel('OUT', -24, -16), channel('AUX', -60, -60)]),
    ).not.toThrow();
    expect(mock.texts).toContain('RMS -20.0');
    expect(mock.fillCount()).toBeGreaterThan(0);
  });

  it('draws an em dash for unavailable channels and clears their peak hold', () => {
    const mock = createMockContext();
    const meter = new MeterCanvas(createCanvas(mock.ctx), { minDb: -60, rmsLabel: 'RMS', peakLabel: 'PK' });

    // 先画一帧很响的，让峰值保持停在 0 dB
    meter.render([channel('IN', 0, 0, 'live')]);
    expect(mock.texts).toContain('PK 0.0');

    mock.texts.length = 0;
    meter.render([channel('IN', 0, 0, 'unavailable')]);
    expect(mock.texts).toContain('RMS —');
    expect(mock.texts).toContain('PK —');

    // 恢复可用后必须从表底重新起算：若保持没被清零，这里会仍读 0.0
    mock.texts.length = 0;
    meter.render([channel('IN', -60, -60, 'live')]);
    expect(mock.texts).toContain('RMS −∞');
    expect(mock.texts).toContain('PK −∞');
  });

  it('keeps muted channels empty with an infinite reading', () => {
    const mock = createMockContext();
    const meter = new MeterCanvas(createCanvas(mock.ctx), { minDb: -60 });

    // 有效静音：即使传进来一个很响的值，也按空柱 + −∞ 处理
    meter.render([channel('IN', 0, 0, 'muted')]);
    expect(mock.texts).toContain('RMS −∞');
    expect(mock.texts).toContain('PK −∞');
  });

  it('maps channel state to the readout text', () => {
    expect(meterText(-30, 'unavailable')).toBe('—');
    expect(meterText(-30, 'muted')).toBe('−∞');
    expect(meterText(-96, 'unavailable')).toBe('—');
    expect(meterText(-30.04, 'live')).toBe('-30.0');
    expect(meterText(-12, undefined)).toBe('-12.0');
    expect(formatDb(-70, -60)).toBe('−∞');
    expect(formatDb(-30, -60)).toBe('-30.0');
  });

  it('leaves existing visuals unchanged when the state is omitted', () => {
    const mock = createMockContext();
    const meter = new MeterCanvas(createCanvas(mock.ctx), { minDb: -60 });

    meter.render([channel('IN', -12, -6), channel('OUT', -15, -9)]);
    const withoutState = [...mock.texts];

    mock.texts.length = 0;
    meter.render([channel('IN', -12, -6, 'live'), channel('OUT', -15, -9, 'live')]);
    expect(mock.texts).toEqual(withoutState);
    expect(mock.fillCount()).toBeGreaterThan(0);
  });

  it('ignores a missing 2d context', () => {
    const meter = new MeterCanvas(createCanvas(null));
    expect(() => meter.render([channel('IN', -20, -12)])).not.toThrow();
    expect(() => meter.destroy()).not.toThrow();
  });

  it('clears the canvas on every frame', () => {
    const mock = createMockContext();
    const clearRect = vi.fn();
    (mock.ctx as unknown as { clearRect: () => void }).clearRect = clearRect;
    const meter = new MeterCanvas(createCanvas(mock.ctx));

    meter.render([]);
    expect(clearRect).toHaveBeenCalled();
  });
});
