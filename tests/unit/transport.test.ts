import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS } from '../../src/renderer/src/domain/defaults';
import { MockTransport } from '../../src/renderer/src/device/mock-transport';
import { PAYLOAD_BYTES } from '../../src/renderer/src/device/protocol';
import { ACK_NO_ERR, encodeAck, encodeRandWrite } from '../../src/renderer/src/device/proto/codec';
import {
  FUNC_ACK,
  FUNC_RAND_READ,
  FUNC_RAND_WRITE,
  FUNC_SEQ_READ,
  FUNC_SEQ_WRITE,
  decodeStream,
  encodeFrame,
  type ParamFrame,
} from '../../src/renderer/src/device/proto/frame';
import { LEVEL_ADDR, PRESET_COUNT, PRESET_START } from '../../src/renderer/src/device/registers';
import type { LevelFrame, ParamEcho, SyncPhase, TransportError } from '../../src/renderer/src/device/transport';
import { WebHidTransport } from '../../src/renderer/src/device/webhid-transport';
import { FakeHidDevice, bindRegisterDevice, createFakeRegisters } from './helpers/webhid-fakes';

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

  it('reports syncing then ready once opened', async () => {
    const transport = new MockTransport();
    const seen: SyncPhase[] = [];
    transport.onSync((phase) => seen.push(phase));

    await transport.open();
    await Promise.resolve();
    expect(seen).toEqual(['syncing', 'ready']);

    await transport.close();
    expect(seen).toEqual(['syncing', 'ready', 'idle']);
  });

  it('echoes the last written value of a batch after 5 ms', async () => {
    const transport = new MockTransport();
    const echoes: ParamEcho[] = [];
    transport.onParamEcho((echo) => echoes.push(echo));
    await transport.open();

    transport.write([
      { id: 'enc.Level', value: 2 },
      { id: 'enc.Level', value: 3 },
    ]);
    vi.advanceTimersByTime(4);
    expect(echoes).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(echoes).toEqual([{ kind: 'param', id: 'enc.Level', value: 3 }]);
    await transport.close();
  });

  it('records one outbound diagnostic entry per batch', async () => {
    const transport = new MockTransport();
    const entries: Array<{ dir: string; hex: string; summary: string; level: string }> = [];
    transport.onDiag((entry) => entries.push({ ...entry }));
    await transport.open();

    transport.write([{ id: 'enc.OnOff', value: 1 }]);
    expect(entries).toHaveLength(1);
    expect(entries[0].dir).toBe('out');
    expect(entries[0].hex).toBe('');
    expect(entries[0].summary).toBe('mock 写 enc.OnOff=1');
    expect(entries[0].level).toBe('info');
    await transport.close();
  });

  it('returns the default preset and no device snapshot on readAll', async () => {
    const transport = new MockTransport();
    const pending = transport.readAll();
    vi.advanceTimersByTime(20);
    const result = await pending;
    expect(result.preset).toBe(DEFAULT_PARAMS);
    expect(result.device).toBeNull();
  });

  it('marks both level channels as valid', async () => {
    const transport = new MockTransport();
    await transport.open();
    vi.advanceTimersByTime(40);
    const frame = transport.lastFrame() as LevelFrame;
    expect(frame.inputValid).toBe(true);
    expect(frame.outputValid).toBe(true);
    await transport.close();
  });

  it('accepts error and diag subscriptions without ever failing', async () => {
    const transport = new MockTransport();
    const errors: TransportError[] = [];
    const offError = transport.onError((error) => errors.push(error));
    const offDiag = transport.onDiag(() => undefined);
    await transport.open();
    transport.write([{ id: 'enc.Level', value: 1 }]);
    expect(errors).toHaveLength(0);
    offError();
    offDiag();
    await transport.close();
  });
});

/** 取帧数据里第 offset 起的大端字（地址、原始值都是 16 位大端） */
function wordAt(data: Uint8Array, offset: number): number {
  return ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0);
}

/** 拼两段字节：测试侧的流式拆帧要把多包拼回去 */
function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const merged = new Uint8Array(head.length + tail.length);
  merged.set(head, 0);
  merged.set(tail, head.length);
  return merged;
}

/** 把假设备收到过的全部载荷拼成一条流再拆帧（跨包的长帧只有拼起来才完整） */
function decodeSent(device: FakeHidDevice): ParamFrame[] {
  const frames: ParamFrame[] = [];
  let inbound = new Uint8Array(0);
  for (const sent of device.sent) {
    const merged = concat(inbound, sent.data);
    const result = decodeStream(merged);
    inbound = result.rest;
    frames.push(...result.frames);
  }
  return frames;
}

/** 只统计参数写帧（0x10 / 0x11），电平轮询的读帧不计 */
function writeFrames(device: FakeHidDevice): ParamFrame[] {
  return decodeSent(device).filter(
    (frame) => frame.func === FUNC_RAND_WRITE || frame.func === FUNC_SEQ_WRITE,
  );
}

describe('WebHidTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(): { device: FakeHidDevice; registers: Map<number, number>; transport: WebHidTransport } {
    const device = new FakeHidDevice({ deviceId: 'vdevice', productName: 'Virtual M001' });
    const registers = createFakeRegisters();
    bindRegisterDevice(device, registers);
    return { device, registers, transport: new WebHidTransport({ device }) };
  }

  it('opens the device, syncs and reaches ready', async () => {
    const { device, transport } = setup();
    const phases: SyncPhase[] = [];
    transport.onSync((phase) => phases.push(phase));

    await transport.open();

    expect(device.openCount).toBe(1);
    expect(transport.state()).toBe('ready');
    expect(transport.kind).toBe('webhid');
    expect(phases).toEqual(['syncing', 'ready']);
  });

  it('writes a single EQ field as 0x10 with address 0x202A and raw 285', async () => {
    const { device, transport } = setup();
    await transport.open();

    // 段 1 gain -3.5 dB → EQ_GAIN_SCALE(0.1, -32) → raw 285（0x011D）
    transport.writeBands([{ band: 1, field: 'gain', value: -3.5 }]);
    await vi.advanceTimersByTimeAsync(150);

    const frames = writeFrames(device);
    expect(frames).toHaveLength(1);
    expect(frames[0].func).toBe(FUNC_RAND_WRITE);
    expect(wordAt(frames[0].data, 0)).toBe(0x202a);
    expect(wordAt(frames[0].data, 2)).toBe(285);

    // 逐字节对齐协议编码：帧头 + 地址 + 原始值 + CRC（轮询读帧也在 sent 里，按前缀找写帧）
    const expected = encodeFrame(FUNC_RAND_WRITE, encodeRandWrite([{ addr: 0x202a, raw: 285 }]));
    const match = device.sent.find((report) =>
      [...expected].every((byte, index) => report.data[index] === byte),
    );
    expect(match).toBeDefined();
    expect([
      ...(match as { data: Uint8Array }).data.subarray(0, expected.length),
    ]).toEqual([...expected]);
  });

  it('merges the four writable fields of one EQ band into a single 0x11 frame', async () => {
    const { device, transport } = setup();
    await transport.open();

    // 段 1 的可写字段地址是 0x2028–0x202B（相邻 → 合成一条连续写）；enable(0x2027) 按 B7 不写
    transport.writeBands([
      { band: 1, field: 'type', value: 1 },
      { band: 1, field: 'freq', value: 100 },
      { band: 1, field: 'gain', value: -3.5 },
      { band: 1, field: 'q', value: 1.2 },
    ]);
    await vi.advanceTimersByTimeAsync(150);

    const frames = writeFrames(device);
    expect(frames).toHaveLength(1);
    expect(frames[0].func).toBe(FUNC_SEQ_WRITE);
    expect(wordAt(frames[0].data, 0)).toBe(0x2028);
    expect(wordAt(frames[0].data, 2)).toBe(4);
    expect([
      wordAt(frames[0].data, 4),
      wordAt(frames[0].data, 6),
      wordAt(frames[0].data, 8),
      wordAt(frames[0].data, 10),
    ]).toEqual([1, 100, 285, 12]);
  });

  it('rejects an out-of-range EQ band without sending a frame', async () => {
    const { device, transport } = setup();
    const errors: TransportError[] = [];
    transport.onError((error) => errors.push(error));
    await transport.open();

    transport.writeBands([{ band: 9, field: 'gain', value: 1 }]);
    await vi.advanceTimersByTimeAsync(150);

    expect(writeFrames(device)).toHaveLength(0);
    expect(errors.map((error) => error.kind)).toEqual(['range']);
  });

  it('flags the channel as disconnected after two seconds of inbound silence', async () => {
    const { device, transport } = setup();
    const errors: TransportError[] = [];
    transport.onError((error) => errors.push(error));
    await transport.open();

    // 设备不再应答：轮询仍然在发，但一条 IN 报告都没有
    device.responder = null;
    await vi.advanceTimersByTimeAsync(1500);
    expect(transport.state()).toBe('ready');
    expect(errors).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1200);
    expect(transport.state()).toBe('error');
    expect(errors.some((error) => error.kind === 'disconnected')).toBe(true);
  });

  it('never trips the watchdog while the device keeps answering', async () => {
    const { transport } = setup();
    const errors: TransportError[] = [];
    transport.onError((error) => errors.push(error));
    await transport.open();

    await vi.advanceTimersByTimeAsync(4000);
    expect(transport.state()).toBe('ready');
    expect(errors).toHaveLength(0);
  });

  it('pauses the watchdog while suspended for DFU', async () => {
    const { device, transport } = setup();
    await transport.open();
    await transport.suspend();

    // DFU 期间设备不说话是正常的，不该被判成掉线
    device.responder = null;
    await vi.advanceTimersByTimeAsync(4000);
    expect(transport.state()).toBe('ready');
  });

  it('sends one 0x10 frame for a writable parameter', async () => {
    const { device, transport } = setup();
    await transport.open();

    transport.write([{ id: 'enc.OnOff', value: 1 }]);
    await vi.advanceTimersByTimeAsync(120);

    const frames = writeFrames(device);
    expect(frames).toHaveLength(1);
    expect(frames[0].func).toBe(FUNC_RAND_WRITE);
    expect((frames[0].data[0] << 8) | frames[0].data[1]).toBe(0x2024);
    expect((frames[0].data[2] << 8) | frames[0].data[3]).toBe(1);
  });

  it('never sends a frame for a read-only parameter and reports readOnly', async () => {
    const { device, transport } = setup();
    const errors: TransportError[] = [];
    transport.onError((error) => errors.push(error));
    await transport.open();

    transport.write([{ id: 'gain.Mic', value: 12 }]);
    await vi.advanceTimersByTimeAsync(120);

    expect(writeFrames(device)).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe('readOnly');
    expect(errors[0].id).toBe('gain.Mic');
    expect(errors[0].addr).toBe(0x2023);
  });

  it('reads back 42 scalar params plus the device snapshot', async () => {
    const { transport } = setup();
    await transport.open();

    const result = await transport.readAll();

    expect(Object.keys(result.preset)).toHaveLength(42);
    expect(result.preset).not.toHaveProperty('micLevel');
    expect(result.preset['noisegate.threshold_db']).toBe(-70);
    expect(result.preset['enc.Level']).toBe(2);
    expect(result.device?.modelCode).toBe('JYM001');
    expect(result.device?.firmware).toEqual({ x: 1, y: 2, z: 3, build: 45 });
    expect(result.device?.vid).toBe(0x0a67);
    expect(result.device?.comErrAck).toBe(3);
    // EQ 可调段走 bands：第 1 段 HPF / 50 Hz / -2 dB / Q 0.7
    expect(result.bands?.['band1.type']).toBe(4);
    expect(result.bands?.['band1.freq']).toBe(50);
    expect(result.bands?.['band1.gain']).toBe(-2);
    expect(result.bands?.['band1.q']).toBe(0.7);
  });

  it('requests the whole preset range and the 46 info addresses', async () => {
    const { device, transport } = setup();
    await transport.open();
    await transport.readAll();

    const requests = decodeSent(device);
    const seqRead = requests.find((frame) => frame.func === FUNC_SEQ_READ);
    expect(seqRead).toBeDefined();
    expect((seqRead?.data[0] ?? 0) * 256 + (seqRead?.data[1] ?? 0)).toBe(PRESET_START);
    expect((seqRead?.data[2] ?? 0) * 256 + (seqRead?.data[3] ?? 0)).toBe(PRESET_COUNT);

    const infoRead = requests.find(
      (frame) => frame.func === FUNC_RAND_READ && frame.data.length === 46 * 2,
    );
    expect(infoRead).toBeDefined();
  });

  it('maps level raw values 0/128/256 onto -96/-48/0 dBFS with no output channel', async () => {
    const { device, registers, transport } = setup();
    const frames: LevelFrame[] = [];
    transport.onLevels((frame) => frames.push(frame));
    await transport.open();

    for (const raw of [0, 128, 256]) {
      registers.set(LEVEL_ADDR, raw);
      await vi.advanceTimersByTimeAsync(25);
      const last = frames[frames.length - 1];
      expect(last).toBeDefined();
      expect(last.inputRms).toBeCloseTo(-96 + (raw / 256) * 96, 5);
      expect(last.outputRms).toBe(-96);
      expect(last.outputPeak).toBe(-96);
      expect(last.inputValid).toBe(true);
      expect(last.outputValid).toBe(false);
    }

    expect(device.sent.length).toBeGreaterThan(0);
  });

  it('decays the peak hold linearly within 300 ms', async () => {
    const { registers, transport } = setup();
    const frames: LevelFrame[] = [];
    transport.onLevels((frame) => frames.push(frame));
    await transport.open();

    registers.set(LEVEL_ADDR, 256);
    await vi.advanceTimersByTimeAsync(25);
    const loud = frames[frames.length - 1];
    expect(loud.inputPeak).toBeCloseTo(0, 5);

    registers.set(LEVEL_ADDR, 0);
    await vi.advanceTimersByTimeAsync(25);
    const quiet = frames[frames.length - 1];
    // 20 ms 内从 0 dB 线性回落到 -96 dB 的 1/15 位置，仍高于 -96 而低于 0
    expect(quiet.inputRms).toBeCloseTo(-96, 5);
    expect(quiet.inputPeak).toBeGreaterThan(-96);
    expect(quiet.inputPeak).toBeLessThan(0);
  });

  it('turns a device 0x10 report into param and EQ-band echoes, ignoring unknown models', async () => {
    const { device, transport } = setup();
    await transport.open();
    // open() 里的回读本身会派发一遍回显（S-e 的 onEcho），这里只关心设备主动上报那一条
    const echoes: ParamEcho[] = [];
    transport.onParamEcho((echo) => echoes.push(echo));

    // 协议 1026 §4：设备用 0x10（随机写）帧上报，数据段与随机读应答同形
    const data = encodeRandWrite([
      { addr: 0x2022, raw: 1 }, // MIC 静音 → mic.mute
      { addr: 0x202a, raw: 300 }, // Band-1 gain：raw 300 → -2 dB
      { addr: 0x2049, raw: 70 }, // Band-7 Q：raw 70 → 7
      { addr: 0x2027, raw: 1 }, // 段使能不在本地模型里（B7），忽略
      { addr: 0x2002, raw: 0x4142 }, // 预设名称：本版本没有本地模型，应忽略
    ]);
    device.emitInputReport(0x11, [...encodeFrame(FUNC_RAND_WRITE, data)]);

    expect(echoes).toEqual([
      { kind: 'param', id: 'mic.mute', value: 1 },
      { kind: 'band', band: 1, field: 'gain', value: -2 },
      { kind: 'band', band: 7, field: 'q', value: 7 },
    ]);
  });

  it('routes a device-pushed 0x2057 to the level channel instead of the echo channel', async () => {
    const { device, transport } = setup();
    await transport.open();
    const echoes: ParamEcho[] = [];
    const frames: LevelFrame[] = [];
    transport.onParamEcho((echo) => echoes.push(echo));
    transport.onLevels((frame) => frames.push(frame));

    device.emitInputReport(0x11, [
      ...encodeFrame(FUNC_RAND_WRITE, encodeRandWrite([{ addr: LEVEL_ADDR, raw: 64 }])),
    ]);

    expect(echoes).toHaveLength(0);
    expect(frames[frames.length - 1]?.inputRms).toBeCloseTo(-72, 5);
  });

  it('enters error on a device disconnect event', async () => {
    const { device, transport } = setup();
    const errors: TransportError[] = [];
    transport.onError((error) => errors.push(error));
    await transport.open();

    device.dispatchEvent(new Event('disconnect'));

    expect(transport.state()).toBe('error');
    expect(errors.some((error) => error.kind === 'disconnected')).toBe(true);
  });

  it('fails open when the device handle has no sendReport', async () => {
    const device = new FakeHidDevice({ deviceId: 'no-send' });
    (device as unknown as { sendReport?: unknown }).sendReport = undefined;
    const transport = new WebHidTransport({ device });
    const errors: TransportError[] = [];
    transport.onError((error) => errors.push(error));

    await transport.open();

    expect(transport.state()).toBe('error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('sendReport');
  });

  it('stops feeding the session after suspend and resumes with a fresh sync', async () => {
    const { device, transport } = setup();
    await transport.open();
    await transport.suspend();

    transport.write([{ id: 'enc.OnOff', value: 1 }]);
    await vi.advanceTimersByTimeAsync(120);
    expect(writeFrames(device)).toHaveLength(0);

    await transport.resume();
    expect(transport.state()).toBe('ready');

    transport.write([{ id: 'enc.OnOff', value: 1 }]);
    await vi.advanceTimersByTimeAsync(120);
    expect(writeFrames(device)).toHaveLength(1);
  });

  it('reports the payload size that the protocol expects', async () => {
    const { device, transport } = setup();
    await transport.open();
    expect(device.sent.length).toBeGreaterThan(0);
    expect(device.sent[0].reportId).toBe(0x51);
    expect(device.sent[0].data.length).toBe(PAYLOAD_BYTES);
  });

  it('exposes the device handle and the report ids for the DFU session', async () => {
    const { device, transport } = setup();
    expect(transport.device).toBe(device);
    expect(transport.reportIds).toEqual({ out: 0x51, in: 0x11 });
  });

  it('fans IN payloads out to onInputBytes and drops other report ids', async () => {
    const { device, transport } = setup();
    await transport.open();

    const seen: number[][] = [];
    const off = transport.onInputBytes((bytes) => seen.push([...bytes]));

    device.emitInputReport(0x11, [0xc4, 0x09, 0x00]);
    expect(seen).toEqual([[0xc4, 0x09, 0x00]]);

    // 不是 IN 报告号的一律丢弃（0x10 是描述符里声明但本版本不用的短报告）
    device.emitInputReport(0x10, [0x01, 0x02]);
    expect(seen).toHaveLength(1);

    // 退订后不再派发
    off();
    device.emitInputReport(0x11, [0xff]);
    expect(seen).toHaveLength(1);
  });

  it('keeps feeding onInputBytes but pauses the session while suspended', async () => {
    const { device, transport } = setup();
    const diags: string[] = [];
    transport.onDiag((entry) => diags.push(entry.summary));
    await transport.open();

    const seen: number[][] = [];
    transport.onInputBytes((bytes) => seen.push([...bytes]));
    const seenBaseline = seen.length;

    // 没有在途请求时喂一帧 ACK：会话会记一条 unexpected 诊断
    const ack = encodeFrame(FUNC_ACK, encodeAck(ACK_NO_ERR));
    const padded = [...ack, ...new Uint8Array(PAYLOAD_BYTES - ack.length)];
    device.emitInputReport(0x11, padded);
    expect(diags.some((text) => text.includes('unexpected'))).toBe(true);
    expect(seen.length).toBe(seenBaseline + 1);

    await transport.suspend();
    const framesBefore = device.sent.length;
    diags.length = 0;

    device.emitInputReport(0x11, padded);

    // 字节仍到订阅者手上，但会话既不出帧也不记诊断
    expect(seen.length).toBe(seenBaseline + 2);
    expect(device.sent.length).toBe(framesBefore);
    expect(diags.some((text) => text.includes('unexpected'))).toBe(false);

    // 恢复后重新 sync：又出现一条 0x13 读整段预设
    await transport.resume();
    const seqReads = decodeSent(device).filter((frame) => frame.func === FUNC_SEQ_READ);
    expect(seqReads.length).toBeGreaterThanOrEqual(2);
  });
});
