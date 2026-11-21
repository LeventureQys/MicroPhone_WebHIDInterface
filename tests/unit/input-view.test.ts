import { describe, expect, it } from 'vitest';
import { MockTransport } from '../../src/renderer/src/device/mock-transport';
import { paramsOf } from '../../src/renderer/src/domain/params';
import { AppStore } from '../../src/renderer/src/domain/state';
import { createInputView } from '../../src/renderer/src/ui/views/input-view';

function mount() {
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
});
