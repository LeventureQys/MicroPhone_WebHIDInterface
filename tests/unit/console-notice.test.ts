import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStore } from '../../src/renderer/src/domain/state';
import { setLang } from '../../src/renderer/src/i18n';
import { createConsoleView } from '../../src/renderer/src/ui/views/console-view';
import { FakeTransport } from './helpers/fake-transport';

/** happy-dom 没有 ResizeObserver；EQ 曲线观察器只需要能 observe/disconnect */
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const NO_API = { openDevice: () => undefined, openAdvanced: () => undefined };

function mount(kind: 'mock' | 'webhid' = 'webhid') {
  const transport = new FakeTransport(kind);
  const store = new AppStore(transport, { lang: 'zh' });
  const view = createConsoleView(store, transport, NO_API);
  document.body.append(view);
  const notice = view.querySelector<HTMLElement>('.console-notice');
  const destroy = (view as HTMLElement & { destroy?: () => void }).destroy;
  return { transport, store, view, notice, destroy };
}

describe('console notice bar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    // 文案断言按中文走：i18n 的当前语言是全局的，别让它被别的测试文件带跑
    setLang('zh');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('shows the read-only notice and hides it after three seconds', async () => {
    const { store, notice, destroy } = mount();
    expect(notice).not.toBeNull();
    expect(notice?.hidden).toBe(true);

    // 只读参数被本地拦下：LOCAL_ERROR_EVENT 必须有可见出口（A15）
    store.setParam('gain.Mic', 12);
    expect(notice?.hidden).toBe(false);
    expect(notice?.textContent).toContain('只读参数');
    expect(notice?.textContent).toContain('麦克风增益');

    await vi.advanceTimersByTimeAsync(2900);
    expect(notice?.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(notice?.hidden).toBe(true);
    destroy?.();
  });

  it('keeps the timeout notice until the link recovers', async () => {
    const { transport, notice, destroy } = mount();
    transport.emitError({ kind: 'timeout', message: '请求超时' });

    expect(notice?.hidden).toBe(false);
    expect(notice?.textContent).toContain('没有应答');

    await vi.advanceTimersByTimeAsync(5000);
    // 链路类提示常驻：用户必须知道"参数没写进去"
    expect(notice?.hidden).toBe(false);

    transport.emitSync('ready');
    await vi.advanceTimersByTimeAsync(10);
    expect(notice?.hidden).toBe(true);
    destroy?.();
  });

  it('does not show a notice on the mock channel for a normal write', async () => {
    const { store, notice, destroy } = mount('mock');
    await Promise.resolve();
    store.setParam('noisegate.threshold_db', -50);
    expect(notice?.hidden).toBe(true);
    destroy?.();
  });
});
