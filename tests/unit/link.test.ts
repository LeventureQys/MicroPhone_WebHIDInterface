import { describe, expect, it } from 'vitest';
import { ChannelTransport } from '../../src/renderer/src/device/channel-transport';
import { DeviceLink } from '../../src/renderer/src/device/link';
import { MockTransport } from '../../src/renderer/src/device/mock-transport';
import type { DeviceSnapshot, ParamReadResult } from '../../src/renderer/src/device/transport';
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

/** WebHidSession 替身：只实现 DeviceLink 用到的那几个方法 */
class FakeSession {
  readonly handle = new FakeHidDevice({ deviceId: 'vdevice', productName: 'Virtual M001' });
  readonly opened: string[] = [];
  readonly closed: string[] = [];
  readonly requestedFilters: Array<readonly WebHidUsageFilter[] | undefined> = [];
  readonly changeListeners = new Set<(state: WebHidSessionState) => void>();

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
    this.handle.opened = true;
  }

  async closeDevice(id: string): Promise<void> {
    this.closed.push(id);
    this.handle.opened = false;
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

  it('warns about a missing model code when the info area is blank', async () => {
    // 真机 V0.0.2 的信息区全 0，modelCode 读出来是空串；不能显示成「设备型号不匹配：」加空值
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
});
