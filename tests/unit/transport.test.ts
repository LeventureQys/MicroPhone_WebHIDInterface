import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockTransport } from '../../src/renderer/src/device/mock-transport';
import type { LevelFrame } from '../../src/renderer/src/device/transport';
import { WebHidTransport } from '../../src/renderer/src/device/webhid-transport';

function dbValues(frame: LevelFrame): number[] {
  return [frame.inputRms, frame.inputPeak, frame.outputRms, frame.outputPeak];
}

describe('MockTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reaches ready on open', async () => {
    const transport = new MockTransport();
    expect(transport.state()).toBe('idle');
    await transport.open();
    expect(transport.state()).toBe('ready');
    await transport.close();
  });

  it('emits frames at the configured rate and keeps them inside dBFS range', async () => {
    const transport = new MockTransport();
    const frames: LevelFrame[] = [];
    transport.onLevels((frame) => frames.push(frame));
    await transport.open();

    vi.advanceTimersByTime(100);

    expect(frames.length).toBeGreaterThanOrEqual(3);
    const last = transport.lastFrame();
    expect(last).not.toBeNull();
    for (const value of dbValues(last as LevelFrame)) {
      expect(value).toBeGreaterThanOrEqual(-96);
      expect(value).toBeLessThanOrEqual(0);
    }
    await transport.close();
  });

  it('keeps the output 3dB below the input', async () => {
    const transport = new MockTransport();
    await transport.open();
    vi.advanceTimersByTime(40);
    const frame = transport.lastFrame() as LevelFrame;
    expect(frame.inputRms - frame.outputRms).toBeCloseTo(3, 5);
    expect(frame.inputPeak - frame.outputPeak).toBeCloseTo(3, 5);
    await transport.close();
  });

  it('settles onto the silence floor for the silence scene', async () => {
    const transport = new MockTransport();
    await transport.open();
    // 先跑一段 speech，确认切换场景会重置平滑状态
    vi.advanceTimersByTime(100);

    transport.setScene('silence');
    vi.advanceTimersByTime(200);

    const last = transport.lastFrame() as LevelFrame;
    expect(last).not.toBeNull();
    expect(last.inputRms).toBeGreaterThanOrEqual(-75);
    expect(last.inputRms).toBeLessThanOrEqual(-69);
    await transport.close();
  });

  it('buffers writes', async () => {
    const transport = new MockTransport();
    await transport.open();

    transport.write([{ id: 'comp.Rate', value: 6 }]);
    transport.write([{ id: 'enc.Level', value: 2 }]);

    expect(transport.writtenBuffer()).toHaveLength(2);
    expect(transport.writtenBuffer()[0]).toEqual({ id: 'comp.Rate', value: 6 });
    expect(transport.writtenBuffer()[1]).toEqual({ id: 'enc.Level', value: 2 });
    await transport.close();
  });

  it('never throws from write', () => {
    const transport = new MockTransport();
    expect(() => transport.write([])).not.toThrow();
    expect(() => transport.write(null as unknown as [])).not.toThrow();
    expect(transport.writtenBuffer()).toHaveLength(0);
  });

  it('stops emitting frames after close', async () => {
    const transport = new MockTransport();
    let count = 0;
    transport.onLevels(() => {
      count += 1;
    });
    await transport.open();
    vi.advanceTimersByTime(100);
    const during = count;
    expect(during).toBeGreaterThan(0);

    await transport.close();
    expect(transport.state()).toBe('idle');

    vi.advanceTimersByTime(200);
    expect(count).toBe(during);
  });

  it('notifies state subscribers and honours unsubscribe', async () => {
    const transport = new MockTransport();
    const seen: string[] = [];
    const off = transport.onStateChange((state) => seen.push(state));

    await transport.open();
    expect(seen).toEqual(['connecting', 'ready']);

    off();
    await transport.close();
    expect(seen).toEqual(['connecting', 'ready']);
    expect(transport.state()).toBe('idle');
  });

  it('stops delivering levels after the unsubscribe call', async () => {
    const transport = new MockTransport();
    let count = 0;
    const off = transport.onLevels(() => {
      count += 1;
    });
    await transport.open();
    vi.advanceTimersByTime(40);
    const during = count;
    off();
    vi.advanceTimersByTime(200);
    expect(count).toBe(during);
    await transport.close();
  });
});

describe('WebHidTransport', () => {
  it('rejects from the alpha skeleton', async () => {
    const transport = new WebHidTransport();
    expect(transport.kind).toBe('webhid');
    await expect(transport.open()).rejects.toThrow('webhid transport not implemented in alpha');
  });
});
