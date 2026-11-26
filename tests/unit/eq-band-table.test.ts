import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStore } from '../../src/renderer/src/domain/state';
import { setLang } from '../../src/renderer/src/i18n';
import { createEqBandTable } from '../../src/renderer/src/ui/views/eq-band-table';
import { FakeTransport } from './helpers/fake-transport';

class FakeResizeObserver {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

describe('eq band table', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    localStorage.clear();
    setLang('zh');
    document.body.innerHTML = '';
  });

  const mountTable = () => {
    const transport = new FakeTransport('mock');
    const store = new AppStore(transport, { lang: 'zh' });
    const table = createEqBandTable(store);
    document.body.append(table);
    const row = (index: number): HTMLElement | null =>
      table.querySelector<HTMLElement>(`.eq-row[data-band="${index}"]`);
    const gainInput = (index: number): HTMLInputElement | undefined =>
      row(index)?.querySelectorAll<HTMLInputElement>('input')[1];
    const select = (index: number): HTMLSelectElement | null | undefined =>
      row(index)?.querySelector<HTMLSelectElement>('.eq-select');
    const destroy = (table as HTMLElement & { destroy?: () => void }).destroy;
    return { store, table, row, gainInput, select, destroy };
  };

  it('disables the gain input of HPF / LPF rows and re-enables it for PEAK', () => {
    const { store, gainInput, select, destroy } = mountTable();

    // 第 1 段默认 HPF、第 2 段 LPF：增益框禁用且值是 0
    expect(gainInput(0)?.disabled).toBe(true);
    expect(gainInput(0)?.value).toBe('0');
    expect(gainInput(1)?.disabled).toBe(true);
    expect(gainInput(0)?.title).toContain('没有增益');
    // 第 3 段 PEAK：可编辑
    expect(gainInput(2)?.disabled).toBe(false);

    // 把第 3 段切成 LPF：增益被清零、输入框禁用
    select(2)!.value = '3';
    select(2)!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(gainInput(2)?.disabled).toBe(true);
    expect(gainInput(2)?.value).toBe('0');
    expect(store.get().bands[2].gain).toBe(0);

    // 切回 PEAK：输入框恢复可编辑
    select(2)!.value = '0';
    select(2)!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(gainInput(2)?.disabled).toBe(false);
    destroy?.();
  });

  it('keeps the gain input disabled while the module is bypassed', () => {
    const { table, gainInput, destroy } = mountTable();
    const bypass = table.querySelector<HTMLElement>('[data-bypass="eq"] input');
    bypass!.click();
    expect(gainInput(2)?.disabled).toBe(true);
    // 取消旁通后，PEAK 恢复可编辑、HPF 仍然禁用
    bypass!.click();
    expect(gainInput(2)?.disabled).toBe(false);
    expect(gainInput(0)?.disabled).toBe(true);
    destroy?.();
  });
});
