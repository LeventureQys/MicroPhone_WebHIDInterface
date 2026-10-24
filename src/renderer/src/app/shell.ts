import type { AppStore } from '../domain/state';
import { t } from '../i18n';
import { openModal, type ModalHandle } from '../ui/modal';
import { createTopbar } from '../ui/topbar';

export type PanelId = 'advanced' | 'device' | 'firmware' | 'settings';

export interface ShellApi {
  openAdvanced: () => void;
  openDevice: () => void;
  openFirmware: () => void;
  openSettings: () => void;
}

export interface ShellOptions {
  store: AppStore;
  mock?: boolean;
  /** 一屏工作台：所有主要逻辑都在这里 */
  console: (api: ShellApi) => HTMLElement;
  advanced: () => HTMLElement;
  device: () => HTMLElement;
  firmware: () => HTMLElement;
  settings: () => HTMLElement;
}

export interface Shell {
  root: HTMLElement;
  openPanel: (id: PanelId) => void;
  closePanel: () => void;
}

const PANEL_META: Record<PanelId, { title: string; subtitle: string; size: 'narrow' | 'medium' | 'wide' }> = {
  advanced: { title: 'advanced.title', subtitle: 'advanced.desc', size: 'wide' },
  device: { title: 'device.modalTitle', subtitle: 'device.subtitle', size: 'medium' },
  firmware: { title: 'fw.title', subtitle: 'fw.subtitle', size: 'wide' },
  settings: { title: 'settings.title', subtitle: 'settings.subtitle', size: 'medium' },
};

export function createShell(opts: ShellOptions): Shell {
  const root = document.createElement('div');
  root.className = 'app-shell';

  const topbarHost = document.createElement('header');
  topbarHost.className = 'topbar';

  const consoleHost = document.createElement('main');
  consoleHost.className = 'console-host';

  root.append(topbarHost, consoleHost);

  let panel: ModalHandle | null = null;

  const closePanel = (): void => {
    panel?.close();
    panel = null;
  };

  const panelContent: Record<PanelId, () => HTMLElement> = {
    advanced: opts.advanced,
    device: opts.device,
    firmware: opts.firmware,
    settings: opts.settings,
  };

  const openPanel = (id: PanelId): void => {
    closePanel();
    const meta = PANEL_META[id];
    panel = openModal({
      title: t(meta.title),
      subtitle: t(meta.subtitle),
      size: meta.size,
      content: panelContent[id](),
    });
  };

  const api: ShellApi = {
    openAdvanced: () => openPanel('advanced'),
    openDevice: () => openPanel('device'),
    openFirmware: () => openPanel('firmware'),
    openSettings: () => openPanel('settings'),
  };

  const disposeChildren = (host: HTMLElement): void => {
    for (const child of Array.from(host.children)) {
      (child as HTMLElement & { destroy?: () => void }).destroy?.();
    }
  };

  let currentConsole: HTMLElement | null = null;

  const mountConsole = (): void => {
    if (currentConsole) {
      (currentConsole as HTMLElement & { destroy?: () => void }).destroy?.();
      currentConsole.remove();
    }
    currentConsole = opts.console(api);
    consoleHost.replaceChildren(currentConsole);
  };

  const mountChrome = (): void => {
    disposeChildren(topbarHost);
    topbarHost.replaceChildren(
      createTopbar({
        store: opts.store,
        mock: opts.mock,
        onAdvanced: api.openAdvanced,
        onDevice: api.openDevice,
        onSettings: api.openSettings,
      }),
    );
  };

  mountChrome();
  mountConsole();

  let lastLang = opts.store.get().lang;
  opts.store.onChange((state) => {
    if (state.lang === lastLang) return;
    lastLang = state.lang;
    // 文案在构建时求值：重建顶栏与工作台，并关掉正在看的抽屉
    closePanel();
    mountChrome();
    mountConsole();
  });

  return {
    root,
    openPanel,
    closePanel,
  };
}
