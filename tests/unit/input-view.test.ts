import { describe, expect, it } from 'vitest';
import { MockTransport } from '../../src/renderer/src/device/mock-transport';
import { paramsOf } from '../../src/renderer/src/domain/params';
import { AppStore } from '../../src/renderer/src/domain/state';
import { setLang } from '../../src/renderer/src/i18n';
import { createInputView } from '../../src/renderer/src/ui/views/input-view';

function mount() {
  setLang('zh');
  const transport = new MockTransport();
  const store = new AppStore(transport, { lang: 'zh' });
  const view = createInputView(store);
  document.body.append(view);
  const destroy = (view as HTMLElement & { destroy?: () => void }).destroy;
  return { store, view, destroy };
}

describe('input view', () => {
  it('renders noise-gate and ENC controls but no gain card or EQ mode', () => {
    const { view, destroy } = mount();
    for (const spec of [...paramsOf('noisegate'), ...paramsOf('enc')]) {
      expect(view.querySelector(`[data-param="${spec.id}"]`), `missing control for ${spec.id}`).not.toBeNull();
    }
    // 增益卡与均衡器模式卡已按 2026-11-13 需求移除
    expect(view.querySelector('[data-param="gain.Mic"]')).toBeNull();
    expect(view.querySelector('[data-param="eq.mode"]')).toBeNull();
    destroy?.();
  });

  it('renders the noise-gate enable bit as a real switch, keeping the threshold untouched', () => {
    const { store, view, destroy } = mount();
    store.setParam('noisegate.threshold_db', -40);
    const enable = view.querySelector<HTMLInputElement>('[data-enable="noisegate"] input[type="checkbox"]');
    expect(enable).not.toBeNull();
    expect(enable?.checked).toBe(true);

    enable?.click();
    // 参数表 V0.3：关开关就是真正的旁通，阈值不动
    expect(store.get().params['noisegate.Enable']).toBe(0);
    expect(store.get().params['noisegate.threshold_db']).toBe(-40);

    enable?.click();
    expect(store.get().params['noisegate.Enable']).toBe(1);
    destroy?.();
  });

  it('turns ENC off and disables the level selector', () => {
    const { store, view, destroy } = mount();
    store.setParam('enc.OnOff', 1);
    const toggle = view.querySelector<HTMLInputElement>('[data-param="enc.OnOff"] input[type="checkbox"]');
    expect(toggle?.checked).toBe(true);

    toggle?.click();
    expect(store.get().params['enc.OnOff']).toBe(0);
    const level = view.querySelector<HTMLElement>('[data-param="enc.Level"]');
    expect(level?.querySelector<HTMLButtonElement>('.seg-btn')?.disabled).toBe(true);
    destroy?.();
  });

  it('exposes the noise-gate ratio as 压缩比 with a hint (buglist 2026-11-21 #11)', () => {
    const { store, view, destroy } = mount();
    const ratio = view.querySelector<HTMLElement>('[data-param="noisegate.ratio"]');
    expect(ratio).not.toBeNull();
    expect(ratio?.querySelector('.pfield-label')?.textContent).toBe('压缩比');
    // 0x205C 一直在参数表里：默认 50 → 0.05
    expect(ratio?.querySelector<HTMLInputElement>('input.pfield-number')?.value).toBe('0.05');

    const hints = Array.from(view.querySelectorAll('.macro-hint')).map((node) => node.textContent ?? '');
    expect(hints.some((text) => text.includes('压缩比') && text.includes('开关打开'))).toBe(true);

    // 写进去的是同一个参数 id（与主界面/高级参数联动，不需要额外映射）
    store.setParam('noisegate.ratio', 0.2);
    expect(store.get().params['noisegate.ratio']).toBe(0.2);
    destroy?.();
  });
});
