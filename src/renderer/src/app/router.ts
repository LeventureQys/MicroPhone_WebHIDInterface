import type { AppStore } from '../domain/state';

export type RouteId = 'meter' | 'input' | 'eq' | 'dynamics' | 'drc' | 'device' | 'settings';

export interface Router {
  go(id: RouteId): void;
  /** 强制重建当前视图：语言切换后所有文案都要重新求值 */
  reload(): void;
  current(): RouteId;
}

interface ViewNode extends HTMLElement {
  destroy?: () => void;
}

export function createRouter(opts: {
  mount: HTMLElement;
  store: AppStore;
  views: Record<RouteId, () => HTMLElement>;
}): Router {
  let currentId: RouteId | null = null;
  let currentNode: ViewNode | null = null;

  const dispose = (): void => {
    if (!currentNode) return;
    try {
      currentNode.destroy?.();
    } catch (error) {
      console.error('[router] destroy failed', error);
    }
    currentNode.remove();
    currentNode = null;
  };

  const render = (id: RouteId): void => {
    dispose();
    const mountPoint = opts.mount;
    mountPoint.replaceChildren();
    try {
      const node = opts.views[id]() as ViewNode;
      node.classList.add('view', `view--${id}`);
      currentNode = node;
      mountPoint.append(node);
    } catch (error) {
      console.error('[router] view failed', id, error);
      const fallback = document.createElement('div');
      fallback.className = 'view-error';
      fallback.textContent = error instanceof Error ? error.message : String(error);
      currentNode = fallback;
      mountPoint.append(fallback);
    }
    currentId = id;
  };

  return {
    go(id: RouteId): void {
      if (currentId === id && currentNode) return;
      render(id);
    },
    reload(): void {
      if (!currentId) return;
      const id = currentId;
      currentId = null;
      render(id);
    },
    current(): RouteId {
      return currentId ?? opts.store.get().module;
    },
  };
}
