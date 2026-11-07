import { describe, expect, it } from 'vitest';
import { AudioMeterError } from '../../src/renderer/src/device/audio-meter';
import { ChannelTransport } from '../../src/renderer/src/device/channel-transport';
import { DeviceLink, type AudioLevelSource } from '../../src/renderer/src/device/link';
import { MockTransport } from '../../src/renderer/src/device/mock-transport';
import type { DeviceSnapshot, LevelFrame, ParamReadResult } from '../../src/renderer/src/device/transport';
import { WebHidTransport } from '../../src/renderer/src/device/webhid-transport';
import type { WebHidSession } from '../../src/renderer/src/device/webhid/session';
import type {
  WebHidDeviceHandle,
  WebHidMode,
  WebHidSessionState,
  WebHidUsageFilter,
} from '../../src/renderer/src/device/webhid/types';
import { DEFAULT_BANDS } from '../../src/renderer/src/domain/defaults';
import { AppStore } from '../../src/renderer/src/domain/state';
import { FakeTransport } from './helpers/fake-transport';
import { FakeHidDevice, bindRegisterDevice, createFakeRegisters } from './helpers/webhid-fakes';

const SNAPSHOT: DeviceSnapshot = {
  modelCode: 'JYM001',
  deviceName: 'M001',
  firmware: { x: 1, y: 2, z: 3, build: 45 },
  firmwareType: 1,
  vid: 0x0a67,
  pid: 0x0010,
  serial: 'AB',
  comErrAck: 3,
};

/** 回读值刻意与默认值不同：断言 store 拿到的是设备值而不是 `DEFAULT_PARAMS` */
const READBACK: ParamReadResult = {
  preset: {
    'noisegate.threshold_db': -55,
    'enc.Level': 3,
    'gain.Mic': 88,
    'limit.Enable': 1,
  },
  device: SNAPSHOT,
  bands: {
    'band1.type': 1,
    'band1.freq': 100,
    'band1.gain': 3,
    'band1.q': 1.2,
  },
};

/** 旧句柄（设备已拔掉）：真机上 `open()` 会抛，会话侧吞掉错误、句柄保持未打开 */
class DeadHandle extends FakeHidDevice {
  async open(): Promise<void> {
    throw new Error('The device must be opened first.');
  }
}

/** WebHidSession 替身：只实现 DeviceLink 用到的那几个方法 */
class FakeSession {
  handle: FakeHidDevice = new FakeHidDevice({ deviceId: 'vdevice', productName: 'Virtual M001' });
  readonly opened: string[] = [];
  readonly closed: string[] = [];
  readonly requestedFilters: Array<readonly WebHidUsageFilter[] | undefined> = [];
  readonly changeListeners = new Set<(state: WebHidSessionState) => void>();
  refreshCount = 0;
  /** 模拟"设备的 open() 失败"（拔线后旧句柄打不开） */
  failOpen = false;
  /** 下一次 refresh() 时换成这根新句柄（模拟真机拔插后系统给出的新 HIDDevice） */
  pendingHandle: FakeHidDevice | null = null;

  private _state: WebHidSessionState;

  constructor(mode: WebHidMode = 'virtual') {
    this._state = {
      status: 'ready',
      mode,
      bridgeUrl: 'ws://127.0.0.1:8765/ws',
      error: null,
      errorCode: null,
      devices: [
        {
          id: 'vdevice',
          mode,
          productName: 'Virtual M001',
          vendorId: 0x0a67,
          productId: 0x0010,
          opened: false,
        },
      ],
      lastReport: null,
    };
  }

  getState(): WebHidSessionState {
    return this._state;
  }

  handleOf(id: string): WebHidDeviceHandle | null {
    return id === 'vdevice' ? this.handle : null;
  }

  async openDevice(id: string): Promise<void> {
    this.opened.push(id);
    // 真实会话在 open 失败时只记 error，句柄保持未打开
    if (this.failOpen) return;
    try {
      await this.handle.open();
    } catch {
      // 与 WebHidSession.openDevice 一致：打开失败不抛，只把错误记进会话状态
    }
  }

  async closeDevice(id: string): Promise<void> {
    this.closed.push(id);
    this.handle.opened = false;
  }

  async refresh(): Promise<void> {
    this.refreshCount += 1;
    if (this.pendingHandle !== null) {
      this.handle = this.pendingHandle;
      this.pendingHandle = null;
    }
  }

  /** 模拟设备复位重枚举：同一个 deviceId 换了新的句柄对象 */
  replaceHandle(next: FakeHidDevice): void {
    this.handle = next;
  }

  async requestNativeDevice(filters?: readonly WebHidUsageFilter[]): Promise<void> {
    this.requestedFilters.push(filters);
  }

  onChange(cb: (state: WebHidSessionState) => void): () => void {
    this.changeListeners.add(cb);
    return () => {
      this.changeListeners.delete(cb);
    };
  }

  /** 模拟会话整体被拆掉（用户点断开 / 桥接断线） */
  emitStatus(status: WebHidSessionState['status']): void {
    this._state = Object.freeze({ ...this._state, status });
    for (const cb of [...this.changeListeners]) cb(this._state);
  }
}

/** 音频电平源替身：记录 start/stop 与提示词，用例可手动推帧 */
class FakeAudio implements AudioLevelSource {
  hints: readonly string[] = [];
  started = 0;
  stopped = 0;
  fail: Error | null = null;
  private readonly listeners = new Set<(frame: LevelFrame) => void>();

  async start(hints: readonly string[]): Promise<{ label: string; matched: boolean }> {
    this.started += 1;
    this.hints = [...hints];
    if (this.fail !== null) throw this.fail;
    return { label: '麦克风 (USB Audio Device)', matched: true };
  }

  stop(): void {
    this.stopped += 1;
  }

  onLevels(cb: (frame: LevelFrame) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  emit(frame: LevelFrame): void {
    for (const cb of [...this.listeners]) cb(frame);
  }
}

function levelFrame(inputRms: number): LevelFrame {
  return {
    t: 0,
    inputRms,
    inputPeak: inputRms,
    outputRms: -96,
    outputPeak: -96,
    inputValid: true,
    outputValid: false,
  };
}

function setup(options: { readResult?: ParamReadResult; failOpen?: boolean } = {}) {
  const session = new FakeSession();
  const mock = new MockTransport();
  const channel = new ChannelTransport(mock);
  const store = new AppStore(channel, { lang: 'zh' });
  const transport = new FakeTransport('webhid');
  transport.readResult = options.readResult ?? READBACK;
  transport.failOpen = options.failOpen ?? false;
  const link = new DeviceLink({
    session: session as unknown as WebHidSession,
    channel,
    mock,
    store,
    createTransport: () => transport,
  });
  return { session, mock, channel, store, transport, link };
}

describe('DeviceLink', () => {
  it('attaches, switches the channel and fills the store with readback values', async () => {
    const { link, channel, store, session } = setup();

    await link.attach('vdevice');

    expect(session.opened).toEqual(['vdevice']);
    expect(channel.kind).toBe('webhid');
    expect(store.get().sync).toBe('ready');
    expect(link.getState().status).toBe('ready');
    expect(link.getState().deviceId).toBe('vdevice');
    expect(link.getState().device?.modelCode).toBe('JYM001');
    expect(link.getState().warning).toBeNull();
    // 回读值覆盖界面（R4-1）
    expect(store.get().params['noisegate.threshold_db']).toBe(-55);
    expect(store.get().params['enc.Level']).toBe(3);
    expect(store.get().params['gain.Mic']).toBe(88);
    expect(store.get().params['limit.Enable']).toBe(1);
  });

  it('keeps the link ready but warns when the model code does not match', async () => {
    const { link } = setup({
      readResult: { ...READBACK, device: { ...SNAPSHOT, modelCode: 'ABC123' } },
    });

    await link.attach('vdevice');

    const state = link.getState();
    expect(state.status).toBe('ready');
    // 只存键与变量：切语言后视图层调 t() 重新渲染，不会停在旧语言
    expect(state.warning).toEqual({ key: 'device.warn.modelMismatch', vars: { code: 'ABC123' } });
  });

  it('treats an empty model code as missing instead of a mismatch', async () => {
    const { link } = setup({
      readResult: { ...READBACK, device: { ...SNAPSHOT, modelCode: '' } },
    });

    await link.attach('vdevice');

    expect(link.getState().status).toBe('ready');
    expect(link.getState().warning).toEqual({ key: 'device.warn.modelMissing' });
  });

  it('falls back to the mock channel and reports error when attach fails', async () => {
    const { link, channel, store } = setup({ failOpen: true });

    await link.attach('vdevice');

    expect(link.getState().status).toBe('error');
    expect(link.getState().errorCode).toBe('device');
    expect(link.getState().error).toEqual({ key: 'device.error.device' });
    expect(channel.kind).toBe('mock');
    expect(store.get().sync).toBe('error');
  });

  it('switches back to the mock channel when the device reports a disconnect', async () => {
    const { link, channel, store, transport, session } = setup();
    await link.attach('vdevice');
    expect(channel.kind).toBe('webhid');

    transport.emitError({ kind: 'disconnected', message: '设备已断开' });

    expect(link.getState().status).toBe('error');
    expect(channel.kind).toBe('mock');
    expect(store.get().sync).toBe('error');
    expect(session.closed).toEqual([]);
  });

  it('switches back to the mock channel when the session is torn down', async () => {
    const { link, channel, store, session } = setup();
    await link.attach('vdevice');

    // 用户点「断开」/ 桥接失败：会话整体回到 idle，句柄已不可用
    session.emitStatus('idle');

    expect(link.getState().status).toBe('error');
    expect(channel.kind).toBe('mock');
    expect(store.get().sync).toBe('error');
    expect(link.transport()).toBeNull();
  });

  it('suspends for DFU and re-reads after resuming', async () => {
    const { link, store, transport } = setup();
    await link.attach('vdevice');
    expect(transport.readAllCalls).toBe(1);

    await link.suspendForDfu();
    expect(link.getState().status).toBe('dfu');

    await link.resumeAfterDfu();
    expect(link.getState().status).toBe('ready');
    expect(transport.readAllCalls).toBe(2);
    expect(store.get().sync).toBe('ready');
  });

  it('warns when the firmware version did not change after an upgrade', async () => {
    const { link } = setup();
    await link.attach('vdevice');
    await link.suspendForDfu();
    await link.resumeAfterDfu();

    expect(link.getState().warning).toEqual({ key: 'fw.warn.versionUnchanged' });
  });

  it('overwrites bands 0..6 from the readback and keeps the internal bands', async () => {
    const { link, store } = setup();

    await link.attach('vdevice');

    const bands = store.get().bands;
    expect(bands[0].type).toBe(1);
    expect(bands[0].freq).toBe(100);
    expect(bands[0].gain).toBe(3);
    expect(bands[0].q).toBe(1.2);
    // 7–13 是设备内部段，回读不覆盖
    expect(bands.slice(7, 14)).toEqual(DEFAULT_BANDS.slice(7, 14));
  });

  it('applies device-pushed params and EQ bands without writing them back', async () => {
    const { link, store, transport } = setup();
    await link.attach('vdevice');
    expect(store.get().params['enc.Level']).toBe(3);

    // 协议 1026 §4：设备→主机的 0x10 上报，上位机只更新本地镜像、不回 ACK、不发帧
    transport.emitEcho({ kind: 'param', id: 'enc.Level', value: 1 });
    transport.emitEcho({ kind: 'band', band: 2, field: 'gain', value: 4.5 });

    expect(store.get().params['enc.Level']).toBe(1);
    expect(store.get().bands[1].gain).toBe(4.5);
    // 回填走 applyEcho / applyBands，绝不能反过来触发写帧（否则设备上报会变成写环）
    expect(transport.writes).toHaveLength(0);
    expect(transport.bandWrites).toHaveLength(0);
  });

  it('detaches back to the mock channel', async () => {
    const { link, channel, store, session } = setup();
    await link.attach('vdevice');

    await link.detach();

    expect(channel.kind).toBe('mock');
    expect(store.get().sync).toBe('idle');
    expect(link.getState().status).toBe('idle');
    expect(link.getState().deviceId).toBeNull();
    expect(session.closed).toEqual(['vdevice']);
  });

  it('reports a device error when the device id is unknown', async () => {
    const { link, channel } = setup();

    await link.attach('missing');

    expect(link.getState().status).toBe('error');
    expect(channel.kind).toBe('mock');
  });

  it('passes the configured whitelist to the native device picker', async () => {
    const { link, session } = setup();

    await link.requestNativeDevice();

    expect(session.requestedFilters).toHaveLength(1);
    const filters = session.requestedFilters[0];
    expect(filters?.[0]).toEqual({ usagePage: 0xff01, usage: 1 });
  });

  it('notifies state subscribers and honours unsubscribe', async () => {
    const { link } = setup();
    const seen: string[] = [];
    const off = link.onChange((state) => seen.push(state.status));

    await link.attach('vdevice');
    expect(seen).toEqual(['connecting', 'ready']);

    off();
    await link.detach();
    expect(seen).toEqual(['connecting', 'ready']);
  });

  it('keeps the raw channel when parameter sync fails (device may be in Bootloader)', async () => {
    const session = new FakeSession('native');
    const mock = new MockTransport();
    const channel = new ChannelTransport(mock);
    const store = new AppStore(channel, { lang: 'zh' });
    const transport = new WebHidTransport({
      device: session.handle,
      // 设备只说 Bootloader 的 SigmaBus，参数帧没人答：把超时压到毫秒级
      timing: { requestTimeoutMs: 5, requestRetries: 0 },
    });
    const link = new DeviceLink({
      session: session as unknown as WebHidSession,
      channel,
      mock,
      store,
      createTransport: () => transport,
    });

    await link.attach('vdevice');

    expect(link.getState().status).toBe('error');
    expect(link.getState().errorCode).toBe('sync');
    expect(channel.kind).toBe('webhid');
    expect(store.get().sync).toBe('error');
    // 句柄仍开着：固件抽屉还能通过 link.transport() 继续刷
    expect(link.transport()).toBe(transport);
    expect(transport.device.opened).toBe(true);

    // 参数会话失败后入站监听不能摘：DFU 的状态帧就是走 onInputBytes 进来的
    const inbound: Uint8Array[] = [];
    transport.onInputBytes((bytes) => inbound.push(bytes));
    session.handle.emitInputReport(0x11, [0xc4, 0x0a, 0x00, 0x00, 0x0b, 0x01, 0x00, 0x03, 0x00, 0x00]);
    expect(inbound).toHaveLength(1);
  });

  it('swaps to the newly enumerated handle after DFU entry', async () => {
    const session = new FakeSession('native');
    bindRegisterDevice(session.handle, createFakeRegisters());
    const mock = new MockTransport();
    const channel = new ChannelTransport(mock);
    const store = new AppStore(channel, { lang: 'zh' });
    const transport = new WebHidTransport({ device: session.handle });
    const link = new DeviceLink({
      session: session as unknown as WebHidSession,
      channel,
      mock,
      store,
      createTransport: () => transport,
      timers: {
        setTimeout: (fn: () => void): unknown => {
          fn();
          return 0;
        },
        clearTimeout: (): void => undefined,
      },
    });
    await link.attach('vdevice');
    await link.suspendForDfu();

    const next = new FakeHidDevice({ deviceId: 'vdevice', productName: 'Maono PD100 Mic' });
    bindRegisterDevice(next, createFakeRegisters());
    session.replaceHandle(next);

    await link.awaitReenumeration();

    expect(session.refreshCount).toBeGreaterThan(0);
    expect(transport.device).toBe(next);
    expect(next.opened).toBe(true);
    expect(link.getState().status).toBe('dfu');
  });

  it('ignores a transport disconnect while the DFU flow is running', async () => {
    const { link, transport } = setup();
    await link.attach('vdevice');
    await link.suspendForDfu();

    transport.emitError({ kind: 'disconnected', message: '设备复位重枚举' });

    expect(link.getState().status).toBe('dfu');
  });

  it('reuses the same transport when re-attaching the same live handle', async () => {
    const session = new FakeSession('native');
    bindRegisterDevice(session.handle, createFakeRegisters());
    const mock = new MockTransport();
    const channel = new ChannelTransport(mock);
    const store = new AppStore(channel, { lang: 'zh' });
    const transport = new WebHidTransport({ device: session.handle });
    const link = new DeviceLink({
      session: session as unknown as WebHidSession,
      channel,
      mock,
      store,
      createTransport: () => transport,
    });

    await link.attach('vdevice');
    expect(link.transport()).toBe(transport);
    expect(channel.kind).toBe('webhid');

    await link.attach('vdevice');

    // 同一句柄复用旧 transport：不再包一层监听，也不会先 close 再 open 掉正在用的设备
    expect(link.transport()).toBe(transport);
    expect(transport.device).toBe(session.handle);
    expect(transport.state()).toBe('ready');
    expect(link.getState().status).toBe('ready');
  });

  it('exposes the bound device channel only while a device is attached', async () => {
    const session = new FakeSession();
    bindRegisterDevice(session.handle, createFakeRegisters());
    const mock = new MockTransport();
    const channel = new ChannelTransport(mock);
    const store = new AppStore(channel, { lang: 'zh' });
    const transport = new WebHidTransport({ device: session.handle });
    const link = new DeviceLink({
      session: session as unknown as WebHidSession,
      channel,
      mock,
      store,
      createTransport: () => transport,
    });

    expect(link.transport()).toBeNull();

    await link.attach('vdevice');
    const bound = link.transport();
    expect(bound).not.toBeNull();
    expect(bound?.device).toBe(session.handle);
    expect(bound?.reportIds).toEqual({ out: 0x51, in: 0x11 });
    expect(typeof bound?.onInputBytes).toBe('function');

    await link.detach();
    expect(link.transport()).toBeNull();
  });

  // ---- DFU 失败 / 拔线后的恢复（真机 2026-11 反馈：升级失败后只能重开 app）----------

  function setupReal(options: { readonly audio?: AudioLevelSource } = {}) {
    const session = new FakeSession('native');
    bindRegisterDevice(session.handle, createFakeRegisters());
    const mock = new MockTransport();
    const channel = new ChannelTransport(mock);
    const store = new AppStore(channel, { lang: 'zh' });
    const transport = new WebHidTransport({
      device: session.handle,
      // 超时压到毫秒级：这些用例只关心"挂起有没有被清掉"，不关心真实请求时长
      timing: { requestTimeoutMs: 15, requestRetries: 0, writeThrottleMs: 5 },
    });
    const link = new DeviceLink({
      session: session as unknown as WebHidSession,
      channel,
      mock,
      store,
      createTransport: () => transport,
      audioLevels: options.audio,
    });
    return { session, channel, store, transport, link };
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  it('recovers the parameter channel after a failed upgrade instead of staying suspended', async () => {
    const { link, store, transport, session } = setupReal();
    await link.attach('vdevice');
    await link.suspendForDfu();

    await link.recoverAfterDfuFailure();

    expect(link.getState().status).toBe('ready');
    expect(store.get().sync).toBe('ready');
    // 挂起没清掉时这里一帧都发不出去（write() 被 `_suspended` 静默丢弃）
    const before = session.handle.sent.length;
    transport.write([{ id: 'enc.Level', value: 1 }]);
    await delay(40);
    expect(session.handle.sent.length).toBeGreaterThan(before);
  });

  it('re-attaching in the device page recovers instead of failing the sync', async () => {
    const { link, store } = setupReal();
    await link.attach('vdevice');
    await link.suspendForDfu();

    // 升级失败后用户回设备页点「打开」：以前 open() 直接返回，回读必然超时
    await link.attach('vdevice');

    expect(link.getState().status).toBe('ready');
    expect(store.get().sync).toBe('ready');
  });

  it('keeps the raw channel but reports a sync error when the device vanished during the upgrade', async () => {
    const { link, store, transport, session } = setupReal();
    await link.attach('vdevice');
    await link.suspendForDfu();
    session.handle.opened = false;
    session.handle.dispatchEvent(new Event('disconnect'));

    await link.recoverAfterDfuFailure();

    expect(link.getState().status).toBe('error');
    expect(link.getState().errorCode).toBe('sync');
    // 设备可能停在 Bootloader：通道要留着让固件抽屉接着刷
    expect(link.transport()).toBe(transport);
    expect(link.getState().warning).toEqual({ key: 'device.warn.bootloader' });
    expect(store.get().sync).toBe('error');
  });

  it('reacquires the newly enumerated handle before a retry', async () => {
    const { link, transport, session } = setupReal();
    await link.attach('vdevice');
    await link.suspendForDfu();
    // 复位重枚举：旧句柄随断开失效，系统给出一根新句柄
    session.handle.opened = false;
    session.handle.dispatchEvent(new Event('disconnect'));
    const next = new FakeHidDevice({ deviceId: 'vdevice', productName: 'Virtual M001 Bootloader' });
    bindRegisterDevice(next, createFakeRegisters());
    session.replaceHandle(next);

    const ok = await link.reacquire();

    expect(ok).toBe(true);
    expect(session.refreshCount).toBe(1);
    expect(transport.device).toBe(next);
    expect(next.opened).toBe(true);
    expect(transport.handleLost()).toBe(false);
    // reacquire 只补通道，不改"升级中 / 出错"这类业务状态
    expect(link.getState().status).toBe('dfu');
  });

  it('reports failure when the device cannot be reopened', async () => {
    const { link, session } = setupReal();
    await link.attach('vdevice');
    await link.suspendForDfu();
    session.handle.opened = false;
    session.handle.dispatchEvent(new Event('disconnect'));
    const next = new FakeHidDevice({ deviceId: 'vdevice' });
    session.replaceHandle(next);
    session.failOpen = true;

    expect(await link.reacquire()).toBe(false);
    expect(next.opened).toBe(false);
  });

  it('opens the re-enumerated handle when re-attaching after a replug', async () => {
    const { link, store, session } = setupReal();
    await link.attach('vdevice');

    // 拔线：旧句柄随设备销毁，但会话表里还留着它；插回后系统给出一根新句柄
    const dead = new DeadHandle({ deviceId: 'vdevice', productName: 'Virtual M001' });
    const next = new FakeHidDevice({ deviceId: 'vdevice', productName: 'Virtual M001' });
    bindRegisterDevice(next, createFakeRegisters());
    session.handle = dead;
    session.pendingHandle = next;

    // 用户回设备页直接点「打开」：不能要求他先手动点「刷新」
    await link.attach('vdevice');

    expect(link.getState().status).toBe('ready');
    expect(store.get().sync).toBe('ready');
    expect(session.refreshCount).toBe(1);
    expect(next.opened).toBe(true);
  });

  // ---- 电平来源：真机固件不上报 0x2057，改采同一台设备的音频输入 -------------------

  it('starts the audio meter with the device identity hints after attaching', async () => {
    const audio = new FakeAudio();
    const { link, channel } = setupReal({ audio });
    const frames: LevelFrame[] = [];
    channel.onLevels((frame) => frames.push(frame));

    await link.attach('vdevice');
    await delay(0);

    expect(audio.started).toBe(1);
    expect(audio.hints).toEqual(['Virtual M001', 'JYM001', 'M001']);
    expect(link.getState().audio).toEqual({
      label: '麦克风 (USB Audio Device)',
      source: 'audio',
      matched: true,
    });
    expect(channel.levelSource()).toBe(audio);

    audio.emit(levelFrame(-9));
    expect(frames.at(-1)?.inputRms).toBe(-9);
  });

  it('falls back to the device-reported level when the microphone is unavailable', async () => {
    const audio = new FakeAudio();
    audio.fail = new AudioMeterError('denied', 'Permission denied');
    const { link, channel } = setupReal({ audio });

    await link.attach('vdevice');
    await delay(0);

    expect(link.getState().audio).toEqual({ label: null, source: 'device', error: 'denied' });
    expect(channel.levelSource()).toBeNull();
  });

  it('stops the audio meter when the device is detached', async () => {
    const audio = new FakeAudio();
    const { link, channel } = setupReal({ audio });
    await link.attach('vdevice');
    await delay(0);
    expect(channel.levelSource()).toBe(audio);

    await link.detach();

    expect(audio.stopped).toBeGreaterThan(0);
    expect(channel.levelSource()).toBeNull();
    expect(link.getState().audio).toBeNull();
  });
});
