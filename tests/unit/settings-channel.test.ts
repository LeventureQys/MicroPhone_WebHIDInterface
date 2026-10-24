import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockTransport } from '../../src/renderer/src/device/mock-transport';
import {
  DEFAULT_CHANNEL_CONFIG,
  type ChannelConfig,
  type ChannelConfigStore,
} from '../../src/renderer/src/domain/channel-config';
import { AppStore } from '../../src/renderer/src/domain/state';
import { setLang } from '../../src/renderer/src/i18n';
import { createSettingsView } from '../../src/renderer/src/ui/views/settings-view';

interface FakeStore extends ChannelConfigStore {
  readonly calls: Partial<ChannelConfig>[];
}

function configWith(patch: Partial<ChannelConfig>): ChannelConfig {
  return { ...DEFAULT_CHANNEL_CONFIG, ...patch };
}

function fakeStore(base: ChannelConfig = DEFAULT_CHANNEL_CONFIG): FakeStore {
  const calls: Partial<ChannelConfig>[] = [];
  let config = base;
  return {
    calls,
    get: () => config,
    set: (patch) => {
      calls.push(patch);
      config = { ...config, ...patch };
    },
    subscribe: () => () => undefined,
  };
}

function mount(configStore: ChannelConfigStore): HTMLElement {
  const store = new AppStore(new MockTransport(), { lang: 'zh' });
  const view = createSettingsView(store, { configStore });
  document.body.append(view);
  return view;
}

function field<T extends HTMLElement>(view: HTMLElement, name: string): T {
  const node = view.querySelector<T>(`[data-field="${name}"]`);
  if (!node) throw new Error(`missing field: ${name}`);
  return node;
}

function change(node: HTMLElement): void {
  node.dispatchEvent(new Event('change'));
}

describe('settings view — 通道卡', () => {
  beforeEach(() => {
    setLang('zh');
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('渲染 6 个控件，初始值来自 configStore.get()', () => {
    const store = fakeStore(
      configWith({
        kind: 'virtual',
        bridgeUrl: 'ws://127.0.0.1:9000/ws',
        reportIdOut: 0x50,
        reportIdIn: 0x10,
        whitelist: [{ usagePage: 0xff02, usage: 3 }],
        useVidPid: true,
        vids: [0x352f],
        pids: [0x10],
        diagLimit: 300,
      }),
    );
    const view = mount(store);

    const controls = Array.from(view.querySelectorAll('[data-channel-control]')).map((node) =>
      node.getAttribute('data-channel-control'),
    );
    expect(controls).toEqual(['kind', 'bridge', 'report', 'whitelist', 'vidpid', 'diagLimit']);

    expect(view.querySelector('[data-channel-control="kind"] .seg-btn.is-active')?.getAttribute('data-value')).toBe(
      'virtual',
    );
    expect(field<HTMLInputElement>(view, 'bridgeUrl').value).toBe('ws://127.0.0.1:9000/ws');
    expect(field<HTMLInputElement>(view, 'reportIdOut').value).toBe('0x50');
    expect(field<HTMLInputElement>(view, 'reportIdIn').value).toBe('0x10');
    expect(field<HTMLTextAreaElement>(view, 'whitelist').value).toContain('0xFF02');
    expect(field<HTMLInputElement>(view, 'vids').value).toBe('0x352F');
    expect(field<HTMLInputElement>(view, 'pids').value).toBe('0x0010');
    expect(field<HTMLInputElement>(view, 'diagLimit').value).toBe('300');
    expect(view.querySelector('[data-field="whitelistCount"]')?.textContent).toBe('1');

    const switchInput = view.querySelector<HTMLInputElement>(
      '[data-channel-control="vidpid"] input[type="checkbox"]',
    );
    expect(switchInput?.checked).toBe(true);

    expect(store.calls).toHaveLength(0);
  });

  it('改通道类型 → configStore.set 收到 kind: virtual', () => {
    const store = fakeStore();
    const view = mount(store);

    const button = view.querySelector<HTMLButtonElement>(
      '[data-channel-control="kind"] .seg-btn[data-value="virtual"]',
    );
    button?.click();

    expect(store.calls).toEqual([{ kind: 'virtual' }]);
    expect(view.querySelector('[data-channel-control="kind"] .seg-btn.is-active')?.getAttribute('data-value')).toBe(
      'virtual',
    );
  });

  it('非法 report ID 标红且不写配置', () => {
    const store = fakeStore();
    const view = mount(store);
    const out = field<HTMLInputElement>(view, 'reportIdOut');

    for (const text of ['0', 'abc', '256']) {
      out.value = text;
      change(out);
      expect(store.calls, `report ID ${text} 不应被保存`).toHaveLength(0);
      expect(out.classList.contains('is-error')).toBe(true);
      expect(out.getAttribute('aria-invalid')).toBe('true');
    }

    out.value = '0x50';
    change(out);

    expect(store.calls).toEqual([{ reportIdOut: 0x50 }]);
    expect(out.classList.contains('is-error')).toBe(false);
    expect(out.value).toBe('0x50');
  });

  it('诊断上限 9999 被夹到 2000 并回写输入框，配置收到 2000', () => {
    const store = fakeStore();
    const view = mount(store);
    const diag = field<HTMLInputElement>(view, 'diagLimit');

    diag.value = '9999';
    change(diag);

    expect(diag.value).toBe('2000');
    expect(store.calls).toEqual([{ diagLimit: 2000 }]);

    diag.value = '5';
    change(diag);

    expect(diag.value).toBe('100');
    expect(store.calls[1]).toEqual({ diagLimit: 100 });
  });

  it('window.micstudio.setHidWhitelist 是桩时被调用，入参按 HidWhitelist 形状', () => {
    const setHidWhitelist = vi.fn(() => Promise.resolve());
    vi.stubGlobal('micstudio', { platform: 'win32', appVersion: '1.1.0', setHidWhitelist });

    const store = fakeStore(configWith({ useVidPid: true, vids: [0x352f], pids: [0x10] }));
    const view = mount(store);
    const textarea = field<HTMLTextAreaElement>(view, 'whitelist');

    textarea.value = '0xFF02:3';
    change(textarea);

    expect(setHidWhitelist).toHaveBeenCalledTimes(1);
    expect(setHidWhitelist).toHaveBeenCalledWith({
      entries: [{ usagePage: 0xff02, usage: 3 }],
      vids: [0x352f],
      pids: [0x10],
    });
  });

  it('主进程还没有 setHidWhitelist 时保存不抛错', () => {
    vi.stubGlobal('micstudio', { platform: 'win32', appVersion: '1.1.0' });
    const store = fakeStore();
    const view = mount(store);
    const textarea = field<HTMLTextAreaElement>(view, 'whitelist');

    textarea.value = '0xFF01:1';
    expect(() => change(textarea)).not.toThrow();
    expect(store.calls).toEqual([{ whitelist: [{ usagePage: 0xff01, usage: 1 }] }]);
  });

  it('桥接地址非 ws(s) 前缀时标红不保存，合法值去掉首尾空格后保存', () => {
    const store = fakeStore();
    const view = mount(store);
    const bridge = field<HTMLInputElement>(view, 'bridgeUrl');

    bridge.value = 'http://127.0.0.1:8765/ws';
    change(bridge);
    expect(store.calls).toHaveLength(0);
    expect(bridge.classList.contains('is-error')).toBe(true);

    bridge.value = '  ws://127.0.0.1:9001/ws  ';
    change(bridge);
    expect(store.calls).toEqual([{ bridgeUrl: 'ws://127.0.0.1:9001/ws' }]);
    expect(bridge.value).toBe('ws://127.0.0.1:9001/ws');
    expect(bridge.classList.contains('is-error')).toBe(false);
  });

  it('白名单整段非法不保存，部分合法只写合法项', () => {
    const store = fakeStore();
    const view = mount(store);
    const textarea = field<HTMLTextAreaElement>(view, 'whitelist');

    textarea.value = 'nonsense\n1234';
    change(textarea);
    expect(store.calls).toHaveLength(0);
    expect(textarea.classList.contains('is-error')).toBe(true);

    textarea.value = '0xFF01:1\nnonsense\n0x0001:6';
    change(textarea);
    expect(store.calls).toEqual([
      {
        whitelist: [
          { usagePage: 0xff01, usage: 1 },
          { usagePage: 1, usage: 6 },
        ],
      },
    ]);
    expect(textarea.classList.contains('is-error')).toBe(false);
    expect(textarea.value.split('\n')).toHaveLength(2);
  });

  it('版本与平台读主进程注入值，缺失时用 — 与 browser 兜底', () => {
    vi.stubGlobal('micstudio', { platform: 'win32', appVersion: '1.1.0' });
    const withApi = mount(fakeStore());
    const values = Array.from(withApi.querySelectorAll('.pfield-value')).map((node) => node.textContent);
    expect(values).toContain('1.1.0');
    expect(values).toContain('win32');

    vi.unstubAllGlobals();
    document.body.innerHTML = '';

    const withoutApi = mount(fakeStore());
    const fallbacks = Array.from(withoutApi.querySelectorAll('.pfield-value')).map((node) => node.textContent);
    expect(fallbacks).toContain('—');
    expect(fallbacks).toContain('browser');
  });
});
