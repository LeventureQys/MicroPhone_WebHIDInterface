import { describe, expect, it, vi } from 'vitest';
import { drawEq, DEFAULT_EQ_THEME } from '../../src/renderer/src/eq/render';
import { FreqMapper } from '../../src/renderer/src/eq/mapper';
import { DEFAULT_BANDS } from '../../src/renderer/src/domain/defaults';

interface MockContext {
  ctx: CanvasRenderingContext2D;
  calls: { arc: Array<[number, number, number]>; lineTo: Array<[number, number]>; stroke: number };
}

function createMockContext(): MockContext {
  const calls = { arc: [] as Array<[number, number, number]>, lineTo: [] as Array<[number, number]>, stroke: 0 };
  const ctx = {
    save: () => {},
    restore: () => {},
    clearRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: (x: number, y: number) => calls.lineTo.push([x, y]),
    closePath: () => {},
    fill: () => {},
    stroke: () => {
      calls.stroke += 1;
    },
    arc: (x: number, y: number, r: number) => calls.arc.push([x, y, r]),
    fillText: () => {},
    setTransform: () => {},
    quadraticCurveTo: () => {},
    lineWidth: 1,
    lineJoin: 'round',
    lineCap: 'round',
    strokeStyle: '',
    fillStyle: '',
    font: '',
    textAlign: 'center',
    textBaseline: 'middle',
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const mapper = new FreqMapper({ x: 46, y: 16, width: 800, height: 320 });

describe('eq render', () => {
  it('draws one handle per editable band and strokes the curve', () => {
    const { ctx, calls } = createMockContext();
    drawEq(ctx, {
      width: 900,
      height: 380,
      freqTicks: FreqMapper.freqTicks(20, 20000),
      gainTicks: FreqMapper.gainTicks(-24, 12, 6),
      bands: DEFAULT_BANDS,
      visibleCount: 7,
      focusedIndex: 1,
      curve: [
        { freq: 20, gainDb: 0 },
        { freq: 1000, gainDb: 3 },
        { freq: 20000, gainDb: 0 },
      ],
      freqToX: (f) => mapper.freqToX(f),
      gainToY: (g) => mapper.gainToY(g),
      xToFreq: (x) => mapper.xToFreq(x),
      yToGain: (y) => mapper.yToGain(y),
    });

    expect(calls.arc).toHaveLength(7);
    expect(calls.stroke).toBeGreaterThan(1);
    expect(calls.arc.every(([, , r]) => r === DEFAULT_EQ_THEME.bandRadius)).toBe(true);
  });

  it('never emits NaN coordinates even when the mapper misbehaves', () => {
    const { ctx, calls } = createMockContext();
    drawEq(ctx, {
      width: 900,
      height: 380,
      freqTicks: [20, 1000, 20000],
      gainTicks: [-24, 0, 12],
      bands: DEFAULT_BANDS,
      visibleCount: 7,
      focusedIndex: -1,
      curve: [
        { freq: 20, gainDb: 0 },
        { freq: 500, gainDb: -12 },
      ],
      freqToX: () => Number.NaN,
      gainToY: () => Number.NaN,
      xToFreq: (x) => x,
      yToGain: (y) => y,
    });
    const all = [...calls.lineTo.flat(), ...calls.arc.flatMap(([x, y]) => [x, y])];
    expect(all.length).toBeGreaterThan(0);
    expect(all.some((value) => !Number.isFinite(value))).toBe(false);
  });

  it('skips drawing when the canvas has no size', () => {
    const { ctx, calls } = createMockContext();
    const clearRect = vi.fn();
    (ctx as unknown as { clearRect: () => void }).clearRect = clearRect;
    drawEq(ctx, {
      width: 0,
      height: 0,
      freqTicks: [],
      gainTicks: [],
      bands: DEFAULT_BANDS,
      visibleCount: 7,
      focusedIndex: -1,
      curve: [],
      freqToX: (f) => mapper.freqToX(f),
      gainToY: (g) => mapper.gainToY(g),
      xToFreq: (x) => mapper.xToFreq(x),
      yToGain: (y) => mapper.yToGain(y),
    });
    expect(clearRect).not.toHaveBeenCalled();
    expect(calls.arc).toHaveLength(0);
  });
});
