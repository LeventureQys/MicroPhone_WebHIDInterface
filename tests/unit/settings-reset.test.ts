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

function mount(channel: 'mock' | 'webhid', resetDevice?: () => Promise<void>) {
  const transport = new FakeTransport(channel);
  const store = new AppStore(transport, { lang: 'zh' });
  if (channel === 'webhid') transport.emitSync('ready');
  const view = createSettingsView(store, { configStore: fakeConfigStore(), resetDevice });
  document.body.append(view);
  return { store, transport, view };
}

function armAndConfirm(view: HTMLElement): void {
  resetButton(view).click();
  resetButton(view).click();
}

describe('settings view — 恢复出厂设置', () => {
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

  it('waits for the confirmed device reset without writing individual defaults', async () => {
    vi.useFakeTimers();
    let finishReset!: () => void;
    const resetDevice = vi.fn(() => new Promise<void>((resolve) => { finishReset = resolve; }));
    const { store, transport, view } = mount('webhid', resetDevice);
    store.applyEcho('rgb.Mode', 5);

    resetButton(view).click();
    expect(resetDevice).not.toHaveBeenCalled();
    resetButton(view).click();
    expect(resetDevice).toHaveBeenCalledTimes(1);
    expect(store.get().params['rgb.Mode']).toBe(5);
    expect(text(resetButton(view))).toBe('正在复位…');

    store.applyEcho('rgb.Mode', 2);
    finishReset();
    await vi.advanceTimersByTimeAsync(0);
    expect(text(resetButton(view))).toBe('已复位');
    expect(store.get().params['rgb.Mode']).toBe(2);
    expect(transport.writes).toHaveLength(0);
    expect(transport.bandWrites).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1500);
    expect(text(resetButton(view))).toBe('恢复出厂设置');
    expect(resetButton(view).disabled).toBe(false);
  });

  it('keeps local settings and reports failure when the device reset rejects', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { store, transport, view } = mount('webhid', async () => { throw new Error('no ACK'); });
      store.setCustomEq([1, 2, 3, 4, 5, 6, 7]);
      armAndConfirm(view);
      await vi.advanceTimersByTimeAsync(0);
      expect(text(resetButton(view))).toBe('未能确认复位结果');
      expect(store.get().customEq).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(transport.writes).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});
