import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStore } from '../../src/renderer/src/domain/state';
import { setLang } from '../../src/renderer/src/i18n';
import { createConsoleView, type ConsoleApi } from '../../src/renderer/src/ui/views/console-view';
import { FakeTransport } from './helpers/fake-transport';

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const NO_API: ConsoleApi = { openDevice: () => undefined, openAdvanced: () => undefined };

function mount(api: ConsoleApi = NO_API) {
  const transport = new FakeTransport('mock');
  const store = new AppStore(transport, { lang: 'zh' });
  const view = createConsoleView(store, transport, api);
  document.body.append(view);
  const destroy = (view as HTMLElement & { destroy?: () => void }).destroy;
  return { store, view, destroy };
}

const text = (node: Element | null): string => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('console view', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    // 场景与自定义曲线会落到 localStorage：用例之间不能互相污染
    localStorage.clear();
    setLang('zh');
    document.body.innerHTML = '';
  });

  it('orders the five scenes and hides the old music tone', () => {
    const { view, destroy } = mount();
    expect(Array.from(view.querySelectorAll('.scene-btn')).map((node) => node.getAttribute('data-scene'))).toEqual([
      'quiet',
      'game',
      'podcast',
      'sing',
      'custom',
    ]);
    const tones = Array.from(view.querySelectorAll('.tone-chip')).map((node) => text(node));
    expect(tones).toEqual(['原声', '人声增强', '温暖', '明亮', '自定义']);
    expect(tones).not.toContain('音乐');
    destroy?.();
  });

  it('starts in the custom tone and highlights the custom scene (buglist 2026-11-22 #8)', () => {
    const { store, view, destroy } = mount();
    expect(store.get().tone).toBe('custom');
    expect(view.querySelector('.tone-chip[data-tone="custom"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(view.querySelector('.scene-btn[data-scene="custom"]')?.getAttribute('aria-pressed')).toBe('true');
    // 「自定义」是唯一能拖曲线的音色，一进来就该可用
    expect(view.querySelector<HTMLButtonElement>('.console-eq-reset')?.disabled).toBe(false);
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

  it('keeps the selected scene as a restore context and confirms the total restore', () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { store, view, destroy } = mount({ ...NO_API, confirm });

    view.querySelector<HTMLElement>('.scene-btn[data-scene="game"]')?.click();
    const sceneButton = view.querySelector<HTMLElement>('.scene-btn[data-scene="game"]');
    const sceneRestore = view.querySelector<HTMLButtonElement>('.scene-reset');
    expect(sceneButton?.getAttribute('aria-pressed')).toBe('true');
    expect(sceneRestore?.disabled).toBe(true);

    store.setParam('noisegate.threshold_db', -20);
    expect(sceneButton?.classList.contains('is-dirty')).toBe(true);
    expect(sceneRestore?.disabled).toBe(false);

    // 每个参数自己的恢复动作不需要确认，并回到当前场景的出厂值。
    const fieldRestore = view.querySelector<HTMLButtonElement>(
      '[data-reset-param="noisegate.threshold_db"]',
    );
    expect(fieldRestore?.disabled).toBe(false);
    fieldRestore?.click();
    expect(store.get().params['noisegate.threshold_db']).toBe(-41);
    expect(sceneRestore?.disabled).toBe(true);

    // 总复位先询问；取消不会覆盖用户修改，确认后才清掉这个场景保存的值。
    store.setParam('noisegate.threshold_db', -20);
    sceneRestore?.click();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(store.get().params['noisegate.threshold_db']).toBe(-20);
    sceneRestore?.click();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(store.get().params['noisegate.threshold_db']).toBe(-41);
    expect(sceneRestore?.disabled).toBe(true);
    destroy?.();
  });

  it('gives every quick-tuning threshold its own module switch (buglist 2026-11-21 #3/#4)', () => {
    const { view, destroy } = mount();
    const rows = [
      { key: 'denoise', label: '噪声门阈值', enable: 'noisegate.Enable' },
      { key: 'evenness', label: '压缩器阈值', enable: 'comp.Enable' },
      // 主界面沿用产品叫法「防爆音」（高级参数里才是「限幅器」），别改回「限幅器阈值」
      { key: 'limiter', label: '防爆音', enable: 'limit.Enable' },
    ];
    for (const row of rows) {
      const node = view.querySelector<HTMLElement>(`[data-macro="${row.key}"]`);
      expect(node).not.toBeNull();
      expect(text(node?.querySelector('.pfield-label') ?? null)).toBe(row.label);
      expect(text(node?.querySelector('.pfield-value') ?? null)).toMatch(/dB$/);
      const toggle = node?.querySelector<HTMLElement>(`.macro-toggle[data-param="${row.enable}"]`);
      expect(toggle).not.toBeNull();
      // 开关本体在标题行里，视觉上跟读数同一排
      expect(toggle?.closest('.pfield-head')).not.toBeNull();
      expect(node?.querySelector('.macro-toggle input[type="checkbox"]')).not.toBeNull();
    }
    // 一个模块只有一个开关：限幅器不再同时出现在「快捷开关」里
    expect(view.querySelectorAll('[data-param="limit.Enable"]')).toHaveLength(1);
    destroy?.();
  });

  it('writes the module enable bit from the quick-tuning switch', () => {
    const { store, view, destroy } = mount();
    const gate = view.querySelector<HTMLInputElement>('[data-param="noisegate.Enable"] input');
    const before = store.get().params['noisegate.Enable'];
    gate?.click();
    expect(store.get().params['noisegate.Enable']).toBe(before === 1 ? 0 : 1);
    const comp = view.querySelector<HTMLInputElement>('[data-param="comp.Enable"] input');
    comp?.click();
    expect(store.get().params['comp.Enable']).toBe(1);
    destroy?.();
  });

  it('reflects enable-bit changes coming from the advanced drawer (same parameter)', () => {
    const { store, view, destroy } = mount();
    store.setParam('comp.Enable', 1);
    const comp = view.querySelector<HTMLInputElement>('[data-param="comp.Enable"] input');
    expect(comp?.checked).toBe(true);
    store.setParam('comp.Enable', 0);
    expect(comp?.checked).toBe(false);
    destroy?.();
  });

  it('keeps every threshold toggle right after the label so it never jumps (buglist 2026-11-22 #1)', () => {
    const { view, destroy } = mount();
    for (const key of ['denoise', 'evenness', 'limiter']) {
      const head = view.querySelector(`[data-macro="${key}"] .pfield-head`);
      const order = Array.from(head?.children ?? []).map((node) => node.className);
      // 标题 → 开关 → 读数：开关宽度固定、读数靠右，读数变宽也不会把开关推走
      expect(order[0]).toContain('pfield-label');
      expect(order[1]).toContain('macro-toggle');
      expect(order[2]).toContain('pfield-value');
    }
    destroy?.();
  });

  it('reflects the scene value changes made from the quick switches', () => {
    const { store, view, destroy } = mount();
    // 主界面直接改压缩器阈值：改动落进 store，高级参数与场景都读同一个参数
    const range = view.querySelector<HTMLInputElement>('[data-macro="evenness"] input[type="range"]');
    range!.value = '-24';
    range!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(store.get().params['comp.Threshold']).toBe(-24);
    destroy?.();
  });

  it('keeps the limiter threshold writable and leaves one switch per module', () => {
    const { store, view, destroy } = mount();
    // 「快捷开关」卡：环境降噪 + 灯效（灯效 2026-11-22 上主页），限幅器只有一个开关（在快速调音里）
    const quickLabels = Array.from(
      view.querySelectorAll('.console-middle > .card:last-child .switch-label'),
    ).map((node) => text(node));
    expect(quickLabels).toEqual(['环境降噪', '灯效']);
    expect(view.querySelectorAll('[data-param="limit.Enable"]')).toHaveLength(1);
    const range = view.querySelector<HTMLInputElement>('[data-macro="limiter"] input[type="range"]');
    expect(range).not.toBeNull();
    range!.value = '-12';
    range!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(store.get().params['limit.Threshold']).toBe(-12);
    destroy?.();
  });

  it('puts the lighting switch and mode on the main screen (buglist 2026-11-22 #5)', () => {
    const { store, view, destroy } = mount();
    const lightSwitch = view.querySelector<HTMLElement>('.switch-item--light [data-param="rgb.OnOff"]');
    expect(text(lightSwitch?.querySelector('.switch-label') ?? null)).toBe('灯效');
    const mode = view.querySelectorAll<HTMLElement>('.switch-item--light [data-param="rgb.Mode"] .seg-btn');
    expect(Array.from(mode).map((node) => node.dataset.value)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);

    // 与高级参数里的灯效是同一个参数 id：主界面改 → store 变 → 高级参数回填
    lightSwitch?.querySelector<HTMLInputElement>('input')?.click();
    expect(store.get().params['rgb.OnOff']).toBe(0);
    mode[5].click();
    expect(store.get().params['rgb.Mode']).toBe(5);
    // 反向：外部（高级参数）改动回填主界面
    store.setParam('rgb.Mode', 2);
    expect(
      view.querySelector('.switch-item--light [data-param="rgb.Mode"] .seg-btn.is-active')?.getAttribute('data-value'),
    ).toBe('2');
    destroy?.();
  });

  it('jumps straight to the equalizer section from fine-tune (buglist 2026-11-21 #5)', () => {
    const openAdvanced = vi.fn();
    const { view, destroy } = mount({ openDevice: () => undefined, openAdvanced });
    const link = view.querySelector<HTMLElement>('.console-eq-actions .console-link:not(.console-link--plain)');
    expect(text(link)).toContain('逐段精调');
    link?.click();
    expect(openAdvanced).toHaveBeenCalledWith('eq');
    destroy?.();
  });

  it('offers the equalizer reset only for the custom tone (buglist 2026-11-21 #12/#13)', () => {
    const { store, view, destroy } = mount();
    const reset = view.querySelector<HTMLButtonElement>('.console-eq-reset');
    expect(reset).not.toBeNull();
    // 软件打开默认就是「自定义」（2026-11-22 问题单第 8 条），因此一进来就可用
    expect(reset?.disabled).toBe(false);
    expect(reset?.getAttribute('aria-disabled')).toBe('false');

    view.querySelector<HTMLElement>('.tone-chip[data-tone="flat"]')?.click();
    expect(reset?.disabled).toBe(true);

    view.querySelector<HTMLElement>('.tone-chip[data-tone="custom"]')?.click();
    expect(reset?.disabled).toBe(false);
    expect(reset?.getAttribute('aria-disabled')).toBe('false');

    // 先把曲线拖脏，再复位：频段按问题单那张表回来
    store.setBands(store.get().bands.map((band, index) => ({ ...band, gain: index === 2 ? 6 : band.gain, q: 2 })));
    expect(store.get().bands[2].gain).toBe(6);
    reset?.click();
    const bands = store.get().bands;
    for (let index = 0; index < 7; index += 1) {
      expect(bands[index].gain).toBe(0);
      expect(bands[index].q).toBe(0.7);
    }
    // 频点取产品默认（2026-11-22 问题单第 2、3 条）
    expect(bands.map((band) => band.freq).slice(0, 7)).toEqual([50, 20000, 63, 250, 1000, 4000, 12500]);
    expect(store.get().tone).toBe('custom');
    // 自定义曲线也一起被复位，下一次点「自定义」不会把脏曲线带回来
    expect(store.get().customEq).toEqual([0, 0, 0, 0, 0, 0, 0]);
    destroy?.();
  });

  it('labels the headphone readout as volume instead of gain (buglist 2026-11-21 #1)', () => {
    const { view, destroy } = mount();
    const labels = Array.from(view.querySelectorAll('.console-gain-label > span:first-child')).map((node) => text(node));
    expect(labels).toEqual(['麦克风增益', '耳机音量']);
    destroy?.();
  });

  it('saves per-scene tweaks and resets only the selected scene (buglist 2026-11-22 #9)', () => {
    const { store, view, destroy } = mount();
    const scene = (id: string): HTMLElement | null => view.querySelector<HTMLElement>(`.scene-btn[data-scene="${id}"]`);

    scene('game')?.click();
    expect(store.get().params['noisegate.threshold_db']).toBe(-41);
    expect(store.get().params['comp.Threshold']).toBe(-36);

    // 微调压缩器阈值：算「游戏」场景的改动，自动保存
    const range = view.querySelector<HTMLInputElement>('[data-macro="evenness"] input[type="range"]');
    range!.value = '-28';
    range!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(store.get().params['comp.Threshold']).toBe(-28);

    // 切别的场景再切回来：微调还在
    scene('podcast')?.click();
    expect(store.get().params['comp.Threshold']).toBe(-42);
    scene('game')?.click();
    expect(store.get().params['comp.Threshold']).toBe(-28);

    // 复位：只把当前场景恢复出厂预设
    const reset = view.querySelector<HTMLButtonElement>('.scene-reset');
    expect(reset?.disabled).toBe(false);
    reset?.click();
    expect(store.get().params['comp.Threshold']).toBe(-36);
    expect(store.get().params['noisegate.threshold_db']).toBe(-41);
    destroy?.();
  });

  it('remembers per-scene tweaks across a remount', () => {
    const first = mount();
    first.view.querySelector<HTMLElement>('.scene-btn[data-scene="sing"]')?.click();
    const range = first.view.querySelector<HTMLInputElement>('[data-macro="denoise"] input[type="range"]');
    range!.value = '-66';
    range!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(first.store.get().params['noisegate.threshold_db']).toBe(-66);
    first.destroy?.();
    document.body.innerHTML = '';

    const second = mount();
    second.view.querySelector<HTMLElement>('.scene-btn[data-scene="sing"]')?.click();
    expect(second.store.get().params['noisegate.threshold_db']).toBe(-66);
    second.destroy?.();
  });

  it('drops the scene highlight when the tone is changed by hand', () => {
    const { store, view, destroy } = mount();
    view.querySelector<HTMLElement>('.scene-btn[data-scene="quiet"]')?.click();
    expect(view.querySelector('.scene-btn[data-scene="quiet"]')?.getAttribute('aria-pressed')).toBe('true');
    view.querySelector<HTMLElement>('.tone-chip[data-tone="bright"]')?.click();
    expect(store.get().tone).toBe('bright');
    expect(view.querySelector('.scene-btn[data-scene="quiet"]')?.getAttribute('aria-pressed')).toBe('false');
    // 没有场景就不给复位（复位的是"当前场景"）
    expect(view.querySelector<HTMLButtonElement>('.scene-reset')?.disabled).toBe(true);
    destroy?.();
  });
});
