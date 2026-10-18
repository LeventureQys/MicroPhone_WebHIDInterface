import type { AppStore } from '../domain/state';
import { createRouter, type RouteId, type Router } from './router';
import { createNavRail } from '../ui/navrail';
import { createTopbar } from '../ui/topbar';

export interface ShellOptions {
  store: AppStore;
  views: Record<RouteId, () => HTMLElement>;
}

export interface Shell {
  root: HTMLElement;
  router: Router;
}

type Disposable = HTMLElement & { destroy?: () => void };

function disposeChildren(host: HTMLElement): void {
  for (const child of Array.from(host.children)) {
    (child as Disposable).destroy?.();
  }
}

export function createShell(opts: ShellOptions): Shell {
  const root = document.createElement('div');
  root.className = 'app-shell';

  const topbar = document.createElement('header');
  topbar.className = 'topbar';
  topbar.id = 'topbar';

  const body = document.createElement('div');
  body.className = 'app-body';

  const navrail = document.createElement('nav');
  navrail.className = 'navrail';
  navrail.id = 'navrail';

  const content = document.createElement('main');
  content.className = 'content';
  content.id = 'view-root';

  body.append(navrail, content);
  root.append(topbar, body);

  const mountChrome = (): void => {
    disposeChildren(topbar);
    disposeChildren(navrail);
    topbar.replaceChildren(createTopbar({ store: opts.store }));
    navrail.replaceChildren(createNavRail({ store: opts.store }));
  };

  mountChrome();

  const router = createRouter({
    mount: content,
    store: opts.store,
    views: opts.views,
  });

  let lastLang = opts.store.get().lang;
  opts.store.onChange((state) => {
    if (state.lang !== lastLang) {
      lastLang = state.lang;
      // 语言变化需要重建顶栏、导轨与当前视图（文案由 t() 在构建时求值）
      mountChrome();
      router.reload();
      return;
    }
    if (state.module !== router.current()) {
      router.go(state.module as RouteId);
    }
  });

  (root as Disposable).destroy = () => {
    disposeChildren(topbar);
    disposeChildren(navrail);
  };

  return { root, router };
}
