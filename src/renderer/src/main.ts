import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';

import { createShell } from './app/shell';
import type { RouteId } from './app/router';
import { MockTransport } from './device/mock-transport';
import { createWebHidSession } from './device/webhid';
import { AppStore } from './domain/state';
import { currentLang } from './i18n';
import { createDeviceView } from './ui/views/device-view';
import { createDrcView } from './ui/views/drc-view';
import { createDynamicsView } from './ui/views/dynamics-view';
import { createEqView } from './ui/views/eq-view';
import { createInputView } from './ui/views/input-view';
import { createMeterView } from './ui/views/meter-view';
import { createSettingsView } from './ui/views/settings-view';

async function boot(): Promise<void> {
  const mount = document.getElementById('app');
  if (!mount) throw new Error('#app not found');

  const transport = new MockTransport({ scene: 'speech', hz: 50 });
  const store = new AppStore(transport, { lang: currentLang() });
  // HID 会话比视图活得久：切路由 / 切语言重建视图时连接不断
  const hidSession = createWebHidSession();
  await transport.open();

  const views: Record<RouteId, () => HTMLElement> = {
    meter: () => createMeterView(store, transport),
    input: () => createInputView(store),
    eq: () => createEqView(store),
    dynamics: () => createDynamicsView(store),
    drc: () => createDrcView(store),
    device: () => createDeviceView(hidSession),
    settings: () => createSettingsView(store),
  };

  const { root, router } = createShell({ store, views });
  mount.replaceChildren(root);
  router.go(store.get().module);

  // 验收截图脚本靠它切路由
  (window as Window & { __micstudioGo?: (route: string) => void }).__micstudioGo = (route) => {
    store.setModule(route as never);
  };

  console.log('[boot] renderer ready');
}

void boot().catch((error) => {
  console.error('[boot] failed', error);
});
