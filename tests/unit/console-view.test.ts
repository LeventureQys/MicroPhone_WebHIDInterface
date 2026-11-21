import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStore } from '../../src/renderer/src/domain/state';
import { setLang } from '../../src/renderer/src/i18n';
import { createConsoleView } from '../../src/renderer/src/ui/views/console-view';
import { FakeTransport } from './helpers/fake-transport';

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const NO_API = { openDevice: () => undefined, openAdvanced: () => undefined };

function mount() {
  const transport = new FakeTransport('mock');
  const store = new AppStore(transport, { lang: 'zh' });
  const view = createConsoleView(store, transport, NO_API);
  document.body.append(view);
  const destroy = (view as HTMLElement & { destroy?: () => void }).destroy;
  return { store, view, destroy };
}

const text = (node: Element | null): string => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('console view (2026-11-13 revision)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    setLang('zh');
    document.body.innerHTML = '';
  });

  it('orders the five scenes and hides the old music tone', () => {
    const { view, destroy } = mount();
    expect(Array.from(view.querySelectorAll('.scene-btn')).map((node) => node.getAttribute('data-scene'))).toEqual([
      'quiet',
      'meeting',
      'podcast',
      'sing',
      'custom',
    ]);
    const tones = Array.from(view.querySelectorAll('.tone-chip')).map((node) => text(node));
    expect(tones).toEqual(['原声', '人声增强', '温暖', '明亮', '自定义']);
    expect(tones).not.toContain('音乐');
    destroy?.();
  });

  it('shows noise-gate and compressor thresholds directly in dB', () => {
    const { view, destroy } = mount();
    const macros = Array.from(view.querySelectorAll('[data-macro]'));
    expect(text(macros[0].querySelector('.pfield-label'))).toBe('噪声门阈值');
    expect(text(macros[0].querySelector('.pfield-value'))).toMatch(/dB$/);
    expect(text(macros[1].querySelector('.pfield-label'))).toBe('压缩器阈值');
    expect(text(macros[1].querySelector('.pfield-value'))).toMatch(/dB$/);
    destroy?.();
  });

  it('moves the three input switches onto the main screen', () => {
    const { store, view, destroy } = mount();
    const switches = view.querySelectorAll('.tune-switch-grid [data-param]');
    expect(Array.from(switches).map((node) => node.getAttribute('data-param'))).toEqual([
      'mic.mute',
      'hp.OnOff',
      'mic.sigMute',
    ]);
    const hp = view.querySelector<HTMLInputElement>('[data-param="hp.OnOff"] input');
    expect(hp?.checked).toBe(true);
    hp?.click();
    expect(store.get().params['hp.OnOff']).toBe(0);
    destroy?.();
  });

  it('keeps the explicit custom tone selected even when its curve is flat', () => {
    const { store, view, destroy } = mount();
    const custom = view.querySelector<HTMLElement>('.tone-chip[data-tone="custom"]');
    custom?.click();
    expect(store.get().tone).toBe('custom');
    expect(custom?.getAttribute('aria-pressed')).toBe('true');
    destroy?.();
  });

  it('applies the custom scene with neutral processing and highlights it', () => {
    const { store, view, destroy } = mount();
    view.querySelector<HTMLElement>('.scene-btn[data-scene="custom"]')?.click();
    expect(store.get().tone).toBe('custom');
    expect(store.get().params['noisegate.threshold_db']).toBe(-91);
    expect(store.get().params['comp.Threshold']).toBe(-60);
    expect(view.querySelector('.scene-btn[data-scene="custom"]')?.getAttribute('aria-pressed')).toBe('true');
    destroy?.();
  });
});
