import { describe, expect, it, vi } from 'vitest';
import { MockTransport } from '../../src/renderer/src/device/mock-transport';
import type { EqBand } from '../../src/renderer/src/eq/types';
import type { AppState, LocalErrorDetail } from '../../src/renderer/src/domain/state';
import { AppStore, LOCAL_ERROR_EVENT } from '../../src/renderer/src/domain/state';
import { FakeTransport } from './helpers/fake-transport';

function setup(initial?: Partial<AppState>) {
  const transport = new MockTransport();
  const write = vi.spyOn(transport, 'write');
  const store = new AppStore(transport, initial);
  let events = 0;
  store.onChange(() => {
    events += 1;
  });
  const localErrors: LocalErrorDetail[] = [];
  store.addEventListener(LOCAL_ERROR_EVENT, (event) => {
    localErrors.push((event as CustomEvent<LocalErrorDetail>).detail);
  });
  return {
    transport,
    store,
    write,
    events: () => events,
    localErrors,
  };
}

describe('AppStore', () => {
  it('boots with 42 params and 14 bands', () => {
    const { store } = setup();
    const state = store.get();
    expect(Object.keys(state.params)).toHaveLength(42);
    expect(state.bands).toHaveLength(14);
    expect(state.scene).toBe('speech');
    expect(state.transport).toBe('idle');
    expect(state.sync).toBe('idle');
    expect(store.channelKind()).toBe('mock');
    expect(state.params['gain.Mic']).toBe(100);
  });

  it('refuses readonly params with a local error', () => {
    const { store, write, events, localErrors } = setup();
    store.setParam('gain.Mic', 99);
    expect(store.get().params['gain.Mic']).toBe(100);
    expect(write).not.toHaveBeenCalled();
    expect(events()).toBe(0);
    expect(localErrors).toEqual([{ kind: 'readOnly', id: 'gain.Mic' }]);
  });

  it('refuses unknown ids with the same local error', () => {
    const { store, write, events, localErrors } = setup();
    store.setParam('no.such.param', 1);
    expect(write).not.toHaveBeenCalled();
    expect(events()).toBe(0);
    expect(Object.keys(store.get().params)).toHaveLength(42);
    expect(localErrors).toEqual([{ kind: 'readOnly', id: 'no.such.param' }]);
  });

  it('quantizes values to the parameter step', () => {
    const { store } = setup();
    store.setParam('noisegate.threshold_db', -70.4);
    expect(store.get().params['noisegate.threshold_db']).toBe(-70);

    store.setParam('drc3.fc1', 1234.6);
    expect(store.get().params['drc3.fc1']).toBe(1235);

    store.setParam('drc3.low.ratio', 3.34);
    expect(store.get().params['drc3.low.ratio']).toBe(3.3);
  });

  it('writes accepted changes to the transport', () => {
    const { store, write } = setup();
    store.setParam('noisegate.threshold_db', -60);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith([{ id: 'noisegate.threshold_db', value: -60 }]);
  });

  it('skips events and writes when the quantized value is unchanged', () => {
    const { store, write, events } = setup();
    // -91 是寄存器表的 NoiseGate 默认值，写同值等于无变化
    store.setParam('noisegate.threshold_db', -91);
    expect(write).not.toHaveBeenCalled();
    expect(events()).toBe(0);

    store.setParam('noisegate.threshold_db', -60.2);
    expect(write).toHaveBeenCalledTimes(1);
    const afterFirst = events();

    // -60.4 与 -60.2 都量化到 -60，属于无变化
    store.setParam('noisegate.threshold_db', -60.4);
    expect(write).toHaveBeenCalledTimes(1);
    expect(events()).toBe(afterFirst);
  });

  it('gates outbound writes while a webhid channel is still syncing', () => {
    const transport = new FakeTransport('webhid');
    const store = new AppStore(transport, { lang: 'zh' });
    const localErrors: LocalErrorDetail[] = [];
    store.addEventListener(LOCAL_ERROR_EVENT, (event) => {
      localErrors.push((event as CustomEvent<LocalErrorDetail>).detail);
    });
    transport.emitSync('syncing');

    store.setParam('noisegate.threshold_db', -50);
    // 本地值先落地，但不发帧（C4）
    expect(store.get().params['noisegate.threshold_db']).toBe(-50);
    expect(transport.writes).toHaveLength(0);
    expect(localErrors).toEqual([{ kind: 'notSynced', id: 'noisegate.threshold_db' }]);

    transport.emitSync('ready');
    store.setParam('noisegate.threshold_db', -40);
    expect(transport.writes).toEqual([[{ id: 'noisegate.threshold_db', value: -40 }]]);
    expect(localErrors).toHaveLength(1);
  });

  it('keeps writing on a mock channel even before the sync phase settles', () => {
    const transport = new FakeTransport('mock');
    const store = new AppStore(transport, { lang: 'zh' });
    store.setParam('noisegate.threshold_db', -50);
    expect(transport.writes).toHaveLength(1);
  });

  it('sends only the changed EQ field of the touched band', () => {
    const transport = new FakeTransport('webhid');
    const store = new AppStore(transport, { lang: 'zh' });
    transport.emitSync('ready');

    // 只动第 3 段（数组下标 2）的 gain：其余段、其余字段都不该出站
    const bands = store.get().bands.map((band) => ({ ...band }));
    bands[2] = { ...bands[2], gain: 6 };
    store.setBands(bands);

    expect(transport.bandWrites).toHaveLength(1);
    expect(transport.bandWrites[0]).toEqual([{ band: 3, field: 'gain', value: 6 }]);
    expect(store.get().bands[2].gain).toBe(6);
    // 标量通道零调用：EQ 段不走 ParamWrite
    expect(transport.writes).toHaveLength(0);
  });

  it('quantizes EQ fields through the register table before sending', () => {
    const transport = new FakeTransport('webhid');
    const store = new AppStore(transport, { lang: 'zh' });
    transport.emitSync('ready');

    const bands = store.get().bands.map((band) => ({ ...band }));
    bands[0] = { ...bands[0], gain: 3.44, q: 1.23 };
    store.setBands(bands);

    // gain 步进 0.1 → 3.4；Q 步进 0.1 → 1.2
    expect(transport.bandWrites[0]).toEqual([
      { band: 1, field: 'gain', value: 3.4 },
      { band: 1, field: 'q', value: 1.2 },
    ]);
    expect(store.get().bands[0].gain).toBe(3.4);
    expect(store.get().bands[0].q).toBe(1.2);
  });

  it('holds EQ writes back while the webhid channel is not synced', () => {
    const transport = new FakeTransport('webhid');
    const store = new AppStore(transport, { lang: 'zh' });
    transport.emitSync('syncing');

    const bands = store.get().bands.map((band) => ({ ...band }));
    bands[4] = { ...bands[4], freq: 1234 };
    store.setBands(bands);

    expect(transport.bandWrites).toHaveLength(0);
    expect(store.get().bands[4].freq).toBe(1234);

    transport.emitSync('ready');
    const after = store.get().bands.map((band) => ({ ...band }));
    after[4] = { ...after[4], freq: 4321 };
    store.setBands(after);
    expect(transport.bandWrites).toEqual([[{ band: 5, field: 'freq', value: 4321 }]]);
  });

  it('never sends the internal bands 8..14 to the device', () => {
    const transport = new FakeTransport('webhid');
    const store = new AppStore(transport, { lang: 'zh' });
    transport.emitSync('ready');

    const bands = store.get().bands.map((band) => ({ ...band }));
    bands[9] = { ...bands[9], gain: 2 };
    store.setBands(bands);

    expect(transport.bandWrites).toHaveLength(0);
    expect(store.get().bands[9].gain).toBe(2);
  });

  it('applies readback bands without writing them back', () => {
    const transport = new FakeTransport('webhid');
    const store = new AppStore(transport, { lang: 'zh' });
    transport.emitSync('ready');

    // 设备回读：把第 3 段 gain 改成 0 dB（与本地 -3.5 不同）
    const bands = store.get().bands.map((band) => ({ ...band }));
    bands[2] = { ...bands[2], gain: 0 };
    store.applyBands(bands);

    expect(store.get().bands[2].gain).toBe(0);
    // 回填不是用户操作：连接动作不该把本地值写回设备
    expect(transport.bandWrites).toHaveLength(0);
  });

  it('applies device echoes without writing back', () => {
    const transport = new FakeTransport('webhid');
    const store = new AppStore(transport, { lang: 'zh' });
    let events = 0;
    store.onChange(() => {
      events += 1;
    });

    store.applyEcho('noisegate.threshold_db', -66);
    expect(store.get().params['noisegate.threshold_db']).toBe(-66);
    expect(transport.writes).toHaveLength(0);
    expect(events).toBe(1);

    // 同值回填不派发
    store.applyEcho('noisegate.threshold_db', -66);
    expect(events).toBe(1);

    // 未知 id 与未量化的值都按既有规则处理
    store.applyEcho('no.such.param', 1);
    expect(events).toBe(1);
    expect(Object.keys(store.get().params)).toHaveLength(42);
  });

  it('mirrors the sync phase from the transport', () => {
    const transport = new FakeTransport('webhid');
    const store = new AppStore(transport, { lang: 'zh' });
    const seen: string[] = [];
    store.onChange((state) => seen.push(state.sync));

    transport.emitSync('syncing');
    transport.emitSync('ready');
    transport.emitSync('idle');

    expect(store.get().sync).toBe('idle');
    expect(seen).toEqual(['syncing', 'ready', 'idle']);
  });

  it('copies bands and skips structurally identical updates', () => {
    const { store, events } = setup();
    const bands: EqBand[] = store.get().bands.map((band) => ({ ...band }));
    bands[0] = { ...bands[0], gain: 6 };
    store.setBands(bands);
    expect(store.get().bands[0].gain).toBe(6);
    expect(events()).toBe(1);

    bands[0].gain = 9;
    expect(store.get().bands[0].gain).toBe(6);

    store.setBands(store.get().bands.map((band) => ({ ...band })));
    expect(events()).toBe(1);
  });

  it('returns a frozen snapshot', () => {
    const { store } = setup();
    const state = store.get();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.params)).toBe(true);
    expect(Object.isFrozen(state.bands)).toBe(true);
    expect(store.get()).toBe(state);
  });

  it('keeps i18n and localStorage in sync on language change', () => {
    const { store, events } = setup();
    store.setLang('zh');
    const baseline = events();

    store.setLang('en');
    expect(store.get().lang).toBe('en');
    expect(localStorage.getItem('micstudio.lang')).toBe('en');
    expect(events()).toBe(baseline + 1);

    store.setLang('en');
    expect(events()).toBe(baseline + 1);
  });

  it('forwards the scene to the mock transport', () => {
    const { store, transport, events } = setup();
    const setScene = vi.spyOn(transport, 'setScene');

    store.setScene('music');
    expect(setScene).toHaveBeenCalledWith('music');
    expect(store.get().scene).toBe('music');
    expect(events()).toBe(1);

    store.setScene('music');
    expect(setScene).toHaveBeenCalledTimes(1);
    expect(events()).toBe(1);
  });

  it('mirrors transport state changes', async () => {
    const { store, transport } = setup();
    await transport.open();
    expect(store.get().transport).toBe('ready');
    await transport.close();
    expect(store.get().transport).toBe('idle');
  });

  it('notifies subscribers with the latest snapshot and unsubscribes cleanly', () => {
    const { store } = setup();
    const seen: AppState[] = [];
    const off = store.onChange((state) => seen.push(state));
    store.setScene('music');
    expect(seen).toHaveLength(1);
    expect(seen[0].scene).toBe('music');
    off();
    store.setScene('silence');
    expect(seen).toHaveLength(1);
  });
});
