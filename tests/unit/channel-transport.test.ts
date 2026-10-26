import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelTransport } from '../../src/renderer/src/device/channel-transport';
import { MockTransport } from '../../src/renderer/src/device/mock-transport';
import type { LevelFrame } from '../../src/renderer/src/device/transport';
import { FakeTransport } from './helpers/fake-transport';

function frame(rms: number): LevelFrame {
  return {
    t: 0,
    inputRms: rms,
    inputPeak: rms,
    outputRms: rms,
    outputPeak: rms,
    inputValid: true,
    outputValid: true,
  };
}

describe('ChannelTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts on the given channel and forwards its events', async () => {
    const mock = new MockTransport();
    const channel = new ChannelTransport(mock);
    const frames: LevelFrame[] = [];
    const states: string[] = [];
    channel.onLevels((item) => frames.push(item));
    channel.onStateChange((state) => states.push(state));

    expect(channel.kind).toBe('mock');
    expect(channel.active()).toBe(mock);

    await channel.open();
    vi.advanceTimersByTime(60);

    expect(channel.state()).toBe('ready');
    expect(states).toEqual(['connecting', 'ready']);
    expect(frames.length).toBeGreaterThan(0);
    await channel.close();
  });

  it('switches to the device channel without re-subscribing', async () => {
    const mock = new MockTransport();
    const device = new FakeTransport('webhid');
    const channel = new ChannelTransport(mock);
    const frames: LevelFrame[] = [];
    channel.onLevels((item) => frames.push(item));
    await channel.open();
    vi.advanceTimersByTime(20);

    const before = frames.length;
    channel.use(device);
    expect(channel.kind).toBe('webhid');
    expect(channel.active()).toBe(device);

    device.emitLevels(frame(-12));
    expect(frames.length).toBe(before + 1);
    expect(frames[frames.length - 1].inputRms).toBe(-12);

    // 旧通道的转发监听已摘掉：Mock 再出帧不会到订阅者手上
    vi.advanceTimersByTime(60);
    expect(frames.length).toBe(before + 1);
  });

  it('aligns the state with the new channel on use()', () => {
    const mock = new MockTransport();
    const device = new FakeTransport('webhid');
    const channel = new ChannelTransport(mock);
    const states: string[] = [];
    channel.onStateChange((state) => states.push(state));

    device.emitState('ready');
    channel.use(device);

    expect(channel.state()).toBe('ready');
    expect(states).toEqual(['ready']);

    // 状态没变就不重复派发
    channel.use(device);
    expect(states).toEqual(['ready']);
  });

  it('forwards readAll to the active channel', async () => {
    const mock = new MockTransport();
    const device = new FakeTransport('webhid');
    const channel = new ChannelTransport(mock);
    channel.use(device);

    const readAll = vi.spyOn(device, 'readAll');
    await channel.readAll();
    expect(readAll).toHaveBeenCalledTimes(1);
  });

  it('switches back to the mock channel', async () => {
    const mock = new MockTransport();
    const device = new FakeTransport('webhid');
    const channel = new ChannelTransport(mock);
    channel.use(device);
    expect(channel.kind).toBe('webhid');

    channel.use(mock);
    expect(channel.kind).toBe('mock');

    const frames: LevelFrame[] = [];
    channel.onLevels((item) => frames.push(item));
    await channel.open();
    vi.advanceTimersByTime(60);
    expect(frames.length).toBeGreaterThan(0);
    await channel.close();
  });

  it('forwards writes and the remaining channels on the active transport', async () => {
    const device = new FakeTransport('webhid');
    const channel = new ChannelTransport(device);
    const syncs: string[] = [];
    const echoes: string[] = [];
    const errors: string[] = [];
    const diags: string[] = [];
    channel.onSync((phase) => syncs.push(phase));
    channel.onParamEcho((echo) =>
      echoes.push(
        echo.kind === 'param'
          ? `${echo.id}=${echo.value}`
          : `band${echo.band}.${echo.field}=${echo.value}`,
      ),
    );
    channel.onError((error) => errors.push(error.kind));
    channel.onDiag((entry) => diags.push(entry.summary));

    channel.write([{ id: 'enc.Level', value: 2 }]);
    device.emitSync('syncing');
    device.emitEcho({ kind: 'param', id: 'enc.Level', value: 2 });
    device.emitError({ kind: 'readOnly', message: '只读' });
    device.emitDiag({ at: 1, dir: 'out', hex: '', summary: '写 0x2025', level: 'info' });

    expect(device.writes).toEqual([[{ id: 'enc.Level', value: 2 }]]);
    expect(syncs).toEqual(['syncing']);
    expect(echoes).toEqual(['enc.Level=2']);
    expect(errors).toEqual(['readOnly']);
    expect(diags).toEqual(['写 0x2025']);
  });

  it('forwards EQ band writes to the active channel', () => {
    const device = new FakeTransport('webhid');
    const channel = new ChannelTransport(device);

    channel.writeBands?.([
      { band: 1, field: 'gain', value: -3.5 },
      { band: 2, field: 'type', value: 1 },
    ]);

    // 门面漏转发的话，EQ 改动永远到不了设备（R2-5 的写半边）
    expect(device.bandWrites).toEqual([
      [
        { band: 1, field: 'gain', value: -3.5 },
        { band: 2, field: 'type', value: 1 },
      ],
    ]);
  });
});
