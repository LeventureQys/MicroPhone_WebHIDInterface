import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createShell } from '../../src/renderer/src/app/shell';
import type { RouteId } from '../../src/renderer/src/app/router';
import { MockTransport } from '../../src/renderer/src/device/mock-transport';
import { AppStore } from '../../src/renderer/src/domain/state';

const ROUTES: RouteId[] = ['meter', 'input', 'eq', 'dynamics', 'drc', 'device', 'settings'];

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('shell integration', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    document.body.innerHTML = '<div id="app"></div>';
  });

  it('mounts the shell and switches through all seven routes', async () => {
    const transport = new MockTransport({ hz: 1000 });
    const store = new AppStore(transport, { lang: 'zh' });
    await transport.open();

    const built: string[] = [];
    const views = {} as Record<RouteId, () => HTMLElement>;
    for (const route of ROUTES) {
      views[route] = () => {
        built.push(route);
        const node = document.createElement('div');
        node.textContent = route;
        return node;
      };
    }

    const { root, router } = createShell({ store, views });
    const mount = document.getElementById('app') as HTMLElement;
    mount.append(root);

    expect(root.querySelector('.topbar')).not.toBeNull();
    expect(root.querySelector('.navrail')).not.toBeNull();

    router.go('meter');
    expect(root.querySelector('.view--meter')).not.toBeNull();

    for (const route of ROUTES) {
      store.setModule(route);
      expect(root.querySelector(`.view--${route}`)).not.toBeNull();
    }

    expect(built).toContain('settings');
    expect(store.get().module).toBe('settings');
    store.get();
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
});
