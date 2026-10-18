import { describe, expect, it, vi } from 'vitest';
import { MockTransport } from '../../src/renderer/src/device/mock-transport';
import type { EqBand } from '../../src/renderer/src/eq/types';
import type { AppState } from '../../src/renderer/src/domain/state';
import { AppStore } from '../../src/renderer/src/domain/state';

function setup(initial?: Partial<AppState>) {
  const transport = new MockTransport();
  const write = vi.spyOn(transport, 'write');
  const store = new AppStore(transport, initial);
  let events = 0;
  store.onChange(() => {
    events += 1;
  });
  return {
    transport,
    store,
    write,
    events: () => events,
  };
}

describe('AppStore', () => {
  it('boots with 36 params and 14 bands', () => {
    const { store } = setup();
    const state = store.get();
    expect(Object.keys(state.params)).toHaveLength(36);
    expect(state.bands).toHaveLength(14);
    expect(state.module).toBe('meter');
    expect(state.focusedBand).toBe(-1);
    expect(state.scene).toBe('speech');
    expect(state.transport).toBe('idle');
    expect(state.params['gain.Mic']).toBe(5);
  });

  it('ignores readonly params', () => {
    const { store, write, events } = setup();
    store.setParam('gain.Mic', 99);
    expect(store.get().params['gain.Mic']).toBe(5);
    expect(write).not.toHaveBeenCalled();
    expect(events()).toBe(0);
  });

  it('ignores unknown ids', () => {
    const { store, write, events } = setup();
    store.setParam('no.such.param', 1);
    expect(write).not.toHaveBeenCalled();
    expect(events()).toBe(0);
    expect(Object.keys(store.get().params)).toHaveLength(36);
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
    store.setParam('noisegate.threshold_db', -70);
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

  it('dispatches once on module change and not on repeated set', () => {
    const { store, events } = setup();
    store.setModule('eq');
    expect(store.get().module).toBe('eq');
    expect(events()).toBe(1);
    store.setModule('eq');
    expect(events()).toBe(1);
  });

  it('tracks the focused band inside the editable range', () => {
    const { store, events } = setup();
    store.setFocus(3);
    expect(store.get().focusedBand).toBe(3);
    expect(events()).toBe(1);
    store.setFocus(3);
    expect(events()).toBe(1);

    store.setFocus(99);
    expect(store.get().focusedBand).toBe(6);
    store.setFocus(-9);
    expect(store.get().focusedBand).toBe(-1);
    store.setFocus(Number.NaN);
    expect(store.get().focusedBand).toBe(-1);
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
    store.setModule('drc');
    expect(seen).toHaveLength(1);
    expect(seen[0].module).toBe('drc');
    off();
    store.setModule('settings');
    expect(seen).toHaveLength(1);
  });
});
