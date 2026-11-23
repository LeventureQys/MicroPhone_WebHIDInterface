import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createShell } from '../../src/renderer/src/app/shell';
import { MockTransport } from '../../src/renderer/src/device/mock-transport';
import { AppStore } from '../../src/renderer/src/domain/state';

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function fakeView(name: string): HTMLElement {
  const node = document.createElement('div');
  node.className = `fake-${name}`;
  node.textContent = name;
  return node;
}

describe('shell', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    document.body.innerHTML = '<div id="app"></div>';
  });

  it('mounts the single-screen console and opens the three panels', async () => {
    const transport = new MockTransport({ hz: 1000 });
    const store = new AppStore(transport, { lang: 'zh' });
    await transport.open();

    const shell = createShell({
      store,
      mock: true,
      console: () => fakeView('console'),
      advanced: () => fakeView('advanced'),
      device: () => fakeView('device'),
      firmware: () => fakeView('firmware'),
      settings: () => fakeView('settings'),
    });
    (document.getElementById('app') as HTMLElement).append(shell.root);

    expect(shell.root.querySelector('.fake-console')).not.toBeNull();
    expect(shell.root.querySelector('.topbar')).not.toBeNull();

    (shell.root.querySelector('#advanced-btn') as HTMLElement).click();
    expect(document.querySelector('.modal .fake-advanced')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.modal')).toBeNull();

    (shell.root.querySelector('#connect-btn') as HTMLElement).click();
    expect(document.querySelector('.modal .fake-device')).not.toBeNull();
    shell.closePanel();

    (shell.root.querySelector('#settings-btn') as HTMLElement).click();
    expect(document.querySelector('.modal .fake-settings')).not.toBeNull();
    shell.closePanel();

    transport.close();
  });

  it('rebuilds the console when the language changes', async () => {
    const transport = new MockTransport({ hz: 1000 });
    const store = new AppStore(transport, { lang: 'zh' });
    await transport.open();

    const shell = createShell({
      store,
      console: () => fakeView('console'),
      advanced: () => fakeView('advanced'),
      device: () => fakeView('device'),
      firmware: () => fakeView('firmware'),
      settings: () => fakeView('settings'),
    });
    (document.getElementById('app') as HTMLElement).append(shell.root);

    const before = shell.root.querySelector('.fake-console');
    store.setLang('en');
    const after = shell.root.querySelector('.fake-console');
    expect(after).not.toBe(before);
    expect(shell.root.querySelector('.topbar')).not.toBeNull();

    transport.close();
  });

  it('keeps parameter writes flowing to the transport', async () => {
    const transport = new MockTransport({ hz: 1000 });
    const store = new AppStore(transport, { lang: 'zh' });
    await transport.open();

    const before = transport.writtenBuffer().length;
    store.setParam('noisegate.threshold_db', -50);
    expect(transport.writtenBuffer().length).toBe(before + 1);
    expect(store.get().params['noisegate.threshold_db']).toBe(-50);

    const afterWrite = transport.writtenBuffer().length;
    store.setParam('gain.Mic', 12);
    expect(transport.writtenBuffer().length).toBe(afterWrite);
    transport.close();
  });

  it('scrolls the advanced drawer to the requested section (buglist 2026-11-21 #5)', async () => {
    const transport = new MockTransport({ hz: 1000 });
    const store = new AppStore(transport, { lang: 'zh' });
    await transport.open();

    // openPanel 把滚动放到下一帧（抽屉刚插入时还没有尺寸），单测里同步执行即可
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push((this as HTMLElement).dataset.section ?? (this as HTMLElement).className);
    } as Element['scrollIntoView'];

    const shell = createShell({
      store,
      console: () => fakeView('console'),
      advanced: () => {
        const view = document.createElement('div');
        for (const section of ['input', 'dynamics', 'eq', 'drc', 'lighting']) {
          const node = document.createElement('section');
          node.className = 'advanced-section';
          node.dataset.section = section;
          view.append(node);
        }
        return view;
      },
      device: () => fakeView('device'),
      firmware: () => fakeView('firmware'),
      settings: () => fakeView('settings'),
    });
    (document.getElementById('app') as HTMLElement).append(shell.root);

    shell.openPanel('advanced', { section: 'eq' });
    expect(scrolled).toEqual(['eq']);

    scrolled.length = 0;
    shell.openPanel('advanced');
    expect(scrolled).toEqual([]);
    shell.closePanel();

    vi.unstubAllGlobals();
    transport.close();
  });
});
