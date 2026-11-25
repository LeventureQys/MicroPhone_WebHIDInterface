import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BANDS, DEFAULT_PARAMS } from '../../src/renderer/src/domain/defaults';
import { AppStore } from '../../src/renderer/src/domain/state';
import {
  DEFAULT_CHANNEL_CONFIG,
  type ChannelConfigStore,
} from '../../src/renderer/src/domain/channel-config';
import { setLang } from '../../src/renderer/src/i18n';
import { createSettingsView } from '../../src/renderer/src/ui/views/settings-view';
import { FakeTransport } from './helpers/fake-transport';

function fakeConfigStore(): ChannelConfigStore {
  let config = DEFAULT_CHANNEL_CONFIG;
  return {
    get: () => config,
    set: (patch) => {
      config = { ...config, ...patch };
    },
    subscribe: () => () => undefined,
  };
}

const resetButton = (view: HTMLElement): HTMLButtonElement => {
  const button = view.querySelector<HTMLButtonElement>('.btn--danger');
  if (!button) throw new Error('missing reset button');
  return button;
};

const text = (node: Element): string => node.textContent?.replace(/\s+/g, ' ').trim() ?? '';

function mount(channel: 'mock' | 'webhid') {
  const transport = new FakeTransport(channel);
  const store = new AppStore(transport, { lang: 'zh' });
  if (channel === 'webhid') transport.emitSync('ready');
  const view = createSettingsView(store, { configStore: fakeConfigStore() });
  document.body.append(view);
  return { store, transport, view };
}

function armAndConfirm(view: HTMLElement): void {
  resetButton(view).click();
  resetButton(view).click();
}

describe('settings view — 复位全部参数', () => {
  beforeEach(() => {
    setLang('zh');
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('restores every writable parameter, the EQ and the custom curve', () => {
    const { store, view } = mount('mock');
    store.setParam('mic.mute', 1);
    store.setParam('comp.Threshold', -30);
    store.setParam('rgb.Mode', 5);
    store.setBands(store.get().bands.map((band, index) => ({ ...band, gain: index === 2 ? 7 : band.gain })));
    store.setCustomEq([1, 2, 3, 4, 5, 6, 7]);

    armAndConfirm(view);

    for (const [id, value] of Object.entries(DEFAULT_PARAMS)) {
      expect(store.get().params[id], id).toBe(value);
    }
    expect(store.get().bands.map((band) => band.gain)).toEqual(DEFAULT_BANDS.map((band) => band.gain));
    expect(store.get().customEq).toEqual([0, 0, 0, 0, 0, 0, 0]);
    // 复位完成后按钮先显示「已复位」，1.5 s 后才恢复可点
    expect(text(resetButton(view))).toBe('已复位');
    expect(resetButton(view).disabled).toBe(true);
  });

  it('paces the writes in small batches on the real channel', async () => {
    vi.useFakeTimers();
    const { store, transport, view } = mount('webhid');
    store.setParam('mic.mute', 1);
    store.setParam('rgb.Mode', 5);
    const writesBefore = transport.writes.length;

    armAndConfirm(view);
    // 第一批（6 项）已经写出去，后面的批次要等间隔，避免把设备一口气压住
    expect(transport.writes.length - writesBefore).toBeGreaterThan(0);
    expect(store.get().params['mic.mute']).toBe(0);
    expect(store.get().params['rgb.Mode']).toBe(5);
    expect(text(resetButton(view))).toBe('正在复位…');

    await vi.advanceTimersByTimeAsync(8000);

    expect(store.get().params['rgb.Mode']).toBe(0);
    expect(store.get().bands.map((band) => band.gain)).toEqual(DEFAULT_BANDS.map((band) => band.gain));
    expect(text(resetButton(view))).toBe('复位全部参数');
    expect(resetButton(view).disabled).toBe(false);
  });
});
