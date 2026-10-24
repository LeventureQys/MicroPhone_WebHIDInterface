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
  it('renders a control for every gain-module parameter', () => {
    const { view, destroy } = mount();
    for (const spec of paramsOf('gain')) {
      expect(view.querySelector(`[data-param="${spec.id}"]`), `missing control for ${spec.id}`).not.toBeNull();
    }
    destroy?.();
  });

  it('exposes the eq.mode entry that used to have no control at all', () => {
    const { store, view, destroy } = mount();
    const mode = view.querySelector<HTMLElement>('.segmented[data-param="eq.mode"]');
    expect(mode).not.toBeNull();
    expect(mode?.querySelectorAll('.seg-btn')).toHaveLength(5);

    // 点第 4 档（index 3）→ 写进 store
    const buttons = mode?.querySelectorAll<HTMLButtonElement>('.seg-btn') ?? [];
    buttons[3]?.click();
    expect(store.get().params['eq.mode']).toBe(3);
    expect(mode?.querySelector('.seg-btn.is-active')?.textContent).toBe('3');

    destroy?.();
  });

  it('keeps the eq.mode segment in sync with store changes', () => {
    const { store, view, destroy } = mount();
    store.setParam('eq.mode', 2);
    const mode = view.querySelector<HTMLElement>('.segmented[data-param="eq.mode"]');
    expect(mode?.querySelector('.seg-btn.is-active')?.textContent).toBe('2');
    destroy?.();
  });
});
