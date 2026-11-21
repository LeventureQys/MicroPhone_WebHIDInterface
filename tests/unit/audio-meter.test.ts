/**
 * 音频电平表：固件不上报 0x2057，电平改由同一台设备的音频输入算。
 *
 * 用假的 `AudioMedia` / `AudioCapture` / `Timers` 驱动，happy-dom 里不需要真声卡。
 */
import { describe, expect, it } from 'vitest';
import {
  AudioLevelMeter,
  amplitudeToDb,
  audioErrorKind,
  measureLevel,
  pickAudioInput,
  type AudioCapture,
  type AudioInputDevice,
  type AudioMedia,
} from '../../src/renderer/src/device/audio-meter';
import type { Clock, Timers } from '../../src/renderer/src/device/proto/timing';
import type { LevelFrame } from '../../src/renderer/src/device/transport';

class ManualClock implements Clock {
  private t = 0;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** 只跑"当前这一拍"的定时器：电平循环是自排程的，run() 一次推进一帧 */
class ManualTimers implements Timers {
  private seq = 0;
  private readonly tasks = new Map<number, () => void>();

  setTimeout(fn: () => void): unknown {
    this.seq += 1;
    this.tasks.set(this.seq, fn);
    return this.seq;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  run(): void {
    const pending = [...this.tasks.entries()];
    this.tasks.clear();
    for (const [, fn] of pending) fn();
  }

  get pending(): number {
    return this.tasks.size;
  }
}

class FakeMedia implements AudioMedia {
  inputs: AudioInputDevice[] = [];
  readonly openCalls: Array<string | null> = [];
  readonly opened: FakeCapture[] = [];
  /** 每次 read() 都现取这段样本，测试可以在 open() 之后再改 */
  sample = Float32Array.from([0.5, -0.5, 0.5, -0.5]);
  failure: unknown = null;
  private readonly watchers = new Set<() => void>();

  async listInputs(): Promise<readonly AudioInputDevice[]> {
    return this.inputs;
  }

  async open(inputId: string | null): Promise<AudioCapture> {
    this.openCalls.push(inputId);
    if (this.failure !== null) throw this.failure;
    const label = this.inputs.find((item) => item.id === inputId)?.label ?? '默认麦克风';
    const capture = new FakeCapture(label, this);
    this.opened.push(capture);
    return capture;
  }

  watch(cb: () => void): () => void {
    this.watchers.add(cb);
    return () => {
      this.watchers.delete(cb);
    };
  }

  /** 模拟系统音频设备表变化（插拔 / 驱动重载） */
  emitDeviceChange(): void {
    for (const cb of [...this.watchers]) cb();
  }
}

class FakeCapture implements AudioCapture {
  closed = 0;
  private aliveFlag = true;
  private readonly endedListeners = new Set<() => void>();

  constructor(
    readonly label: string,
    private readonly media: FakeMedia,
  ) {}

  read(): Float32Array | null {
    return Float32Array.from(this.media.sample);
  }

  close(): void {
    this.closed += 1;
  }

  alive(): boolean {
    return this.aliveFlag;
  }

  onEnded(cb: () => void): () => void {
    this.endedListeners.add(cb);
    return () => {
      this.endedListeners.delete(cb);
    };
  }

  /** 模拟系统把这条采集断掉：track ended + 回调（真实实现的行为） */
  kill(): void {
    this.aliveFlag = false;
    for (const cb of [...this.endedListeners]) cb();
  }

  /** 只让健康度变 false、不回调：验证出帧时的兜底检查 */
  expire(): void {
    this.aliveFlag = false;
  }
}

function build() {
  const media = new FakeMedia();
  const clock = new ManualClock();
  const timers = new ManualTimers();
  const meter = new AudioLevelMeter({ media, clock, timers, windowMs: 33 });
  const frames: LevelFrame[] = [];
  meter.onLevels((frame) => frames.push(frame));
  return { media, clock, timers, meter, frames };
}

describe('pickAudioInput', () => {
  it('按提示词匹配到同一台声卡，越靠前的提示词优先', () => {
    const inputs: AudioInputDevice[] = [
      { id: 'laptop', label: '麦克风阵列 (Realtek Audio)' },
      { id: 'm001', label: '麦克风 (USB Audio Device)' },
    ];
    expect(pickAudioInput(inputs, ['USB Audio Device', 'JYM001'])?.id).toBe('m001');
    expect(pickAudioInput(inputs, ['Realtek Audio', 'USB Audio Device'])?.id).toBe('laptop');
  });

  it('匹配不到、提示词太短或 label 为空时返回 null（由调用方退回默认输入）', () => {
    expect(pickAudioInput([{ id: 'x', label: '麦克风 (Realtek Audio)' }], ['USB Audio'])).toBeNull();
    expect(pickAudioInput([{ id: 'x', label: 'USB Audio Device' }], ['US'])).toBeNull();
    expect(pickAudioInput([{ id: 'x', label: '' }], ['USB Audio Device'])).toBeNull();
  });

  it('同分时优先具体端点，不选 "Default - " 别名（别名会跟着系统默认走）', () => {
    const inputs: AudioInputDevice[] = [
      { id: 'default', label: 'Default - 麦克风 (USB Audio Device)' },
      { id: 'comms', label: 'Communications - 麦克风 (USB Audio Device)' },
      { id: 'real', label: '麦克风 (USB Audio Device) (0a67:0010)' },
    ];
    expect(pickAudioInput(inputs, ['USB Audio Device'])?.id).toBe('real');
  });
});

describe('measureLevel / amplitudeToDb', () => {
  it('RMS 与峰值都按 20log10 换算并夹到 -96..0', () => {
    const { rms, peak } = measureLevel(Float32Array.from([0.5, -0.5, 0.5, -0.5]));
    expect(rms).toBeCloseTo(0.5, 5);
    expect(peak).toBeCloseTo(0.5, 5);
    expect(amplitudeToDb(rms)).toBeCloseTo(-6.02, 1);
    expect(amplitudeToDb(1)).toBe(0);
    expect(amplitudeToDb(0)).toBe(-96);
    expect(amplitudeToDb(0.00001)).toBe(-96);
  });
});

describe('AudioLevelMeter', () => {
  it('按提示词打开同一台音频输入并出电平帧（输出通道恒 -96）', async () => {
    const { media, timers, meter, frames } = build();
    media.inputs = [
      { id: 'laptop', label: '麦克风阵列 (Realtek Audio)' },
      { id: 'm001', label: '麦克风 (USB Audio Device)' },
    ];

    const info = await meter.start(['USB Audio Device', 'JYM001']);
    expect(info).toEqual({ label: '麦克风 (USB Audio Device)', id: 'm001', matched: true });
    expect(media.openCalls).toEqual(['m001']);

    timers.run();
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame.inputRms).toBeCloseTo(-6.02, 1);
    expect(frame.inputPeak).toBeCloseTo(-6.02, 1);
    expect(frame.inputValid).toBe(true);
    expect(frame.outputRms).toBe(-96);
    expect(frame.outputPeak).toBe(-96);
    expect(frame.outputValid).toBe(false);

    meter.stop();
  });

  it('匹配不到时退回系统默认输入，并标记 matched=false', async () => {
    const { media, meter } = build();
    media.inputs = [{ id: 'laptop', label: '麦克风阵列 (Realtek Audio)' }];

    const info = await meter.start(['USB Audio Device']);

    expect(info.matched).toBe(false);
    expect(info.id).toBeNull();
    expect(media.openCalls).toEqual([null]);
    meter.stop();
  });

  it('首次授权前 label 为空：先开一次默认输入拿权限，再按型号重挑', async () => {
    const { media, meter } = build();
    media.inputs = [
      { id: 'a', label: '' },
      { id: 'b', label: '' },
    ];
    // 打开默认设备之后 label 才会有名字：模拟"授权后重列"的结果
    const originalOpen = media.open.bind(media);
    media.open = async (inputId: string | null): Promise<AudioCapture> => {
      const capture = await originalOpen(inputId);
      if (inputId === null) {
        media.inputs = [
          { id: 'laptop', label: '麦克风阵列 (Realtek Audio)' },
          { id: 'm001', label: '麦克风 (USB Audio Device)' },
        ];
      }
      return capture;
    };

    const info = await meter.start(['USB Audio Device']);

    expect(info.matched).toBe(true);
    expect(media.openCalls).toEqual([null, 'm001']);
    // 探路那一路要关掉，不能一直占着麦克风
    expect(media.opened[0].closed).toBe(1);
    expect(media.opened[1].closed).toBe(0);
    meter.stop();
  });

  it('权限被拒绝时抛 AudioMeterError(denied)', async () => {
    const { media, meter } = build();
    media.inputs = [{ id: 'm001', label: '麦克风 (USB Audio Device)' }];
    const denied = new Error('Permission denied');
    denied.name = 'NotAllowedError';
    media.failure = denied;

    await expect(meter.start(['USB Audio Device'])).rejects.toMatchObject({ kind: 'denied' });
    expect(meter.active()).toBeNull();
    expect(audioErrorKind(denied)).toBe('denied');
  });

  it('stop() 关闭采集并停止出帧', async () => {
    const { media, timers, meter, frames } = build();
    media.inputs = [{ id: 'm001', label: '麦克风 (USB Audio Device)' }];
    await meter.start(['USB Audio Device']);
    timers.run();
    expect(frames).toHaveLength(1);

    meter.stop();

    expect(media.opened[0].closed).toBe(1);
    expect(timers.pending).toBe(0);
    timers.run();
    expect(frames).toHaveLength(1);
  });

  it('峰值按 300 ms 线性回落，静音后不会一直顶在最高点', async () => {
    const { media, timers, clock, meter, frames } = build();
    media.inputs = [{ id: 'm001', label: '麦克风 (USB Audio Device)' }];
    await meter.start(['USB Audio Device']);

    timers.run();
    const loud = frames[0];
    expect(loud.inputPeak).toBeCloseTo(-6.02, 1);

    media.sample = Float32Array.from([0, 0, 0, 0]);
    clock.advance(100);
    timers.run();

    const quiet = frames[1];
    expect(quiet.inputRms).toBe(-96);
    expect(quiet.inputPeak).toBeLessThan(loud.inputPeak);
    expect(quiet.inputPeak).toBeGreaterThan(-96);
    meter.stop();
  });

  it('采集被系统断开时通知 onLost、healthy() 转 false，并且不再出帧', async () => {
    const { media, timers, meter, frames } = build();
    media.inputs = [{ id: 'm001', label: '麦克风 (USB Audio Device)' }];
    let lost = 0;
    meter.onLost(() => {
      lost += 1;
    });

    await meter.start(['USB Audio Device']);
    expect(meter.healthy()).toBe(true);
    timers.run();
    expect(frames).toHaveLength(1);

    media.opened[0].kill();

    expect(meter.healthy()).toBe(false);
    expect(meter.active()).toBeNull();
    expect(lost).toBe(1);
    expect(media.opened[0].closed).toBe(1);
    timers.run();
    expect(frames).toHaveLength(1);
  });

  it('track 没发 ended、只是不再活时，出帧前的健康检查也能发现并通知', async () => {
    const { media, timers, meter } = build();
    media.inputs = [{ id: 'm001', label: '麦克风 (USB Audio Device)' }];
    let lost = 0;
    meter.onLost(() => {
      lost += 1;
    });
    await meter.start(['USB Audio Device']);

    media.opened[0].expire();
    expect(meter.healthy()).toBe(false);

    timers.run();
    expect(lost).toBe(1);
    expect(meter.active()).toBeNull();
    expect(timers.pending).toBe(0);
  });

  it('strict 模式匹配不到设备端点时报 unavailable，不退回系统默认输入', async () => {
    const { media, meter } = build();
    media.inputs = [{ id: 'laptop', label: '麦克风阵列 (Realtek Audio)' }];

    await expect(meter.start(['USB Audio Device'], { strict: true })).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(media.openCalls).toEqual([]);
    expect(meter.active()).toBeNull();
  });

  it('find() 只读枚举按提示词挑端点，watchDevices 透传系统设备表变化', async () => {
    const { media, meter } = build();
    media.inputs = [{ id: 'm001', label: '麦克风 (USB Audio Device)' }];

    expect(await meter.find(['USB Audio Device'])).toEqual({
      id: 'm001',
      label: '麦克风 (USB Audio Device)',
    });
    expect(await meter.find(['JYM001'])).toBeNull();
    // 只读探测不能打开采集
    expect(media.openCalls).toEqual([]);

    let changes = 0;
    const off = meter.watchDevices(() => {
      changes += 1;
    });
    media.emitDeviceChange();
    expect(changes).toBe(1);
    off();
    media.emitDeviceChange();
    expect(changes).toBe(1);
  });
});
