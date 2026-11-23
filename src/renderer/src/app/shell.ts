import type { AppStore } from '../domain/state';
import { t } from '../i18n';
import { openModal, type ModalHandle } from '../ui/modal';
import { createTopbar } from '../ui/topbar';
import type { AdvancedSectionId } from '../ui/views/advanced-view';

export type PanelId = 'advanced' | 'device' | 'firmware' | 'settings';

export interface ShellApi {
  /** `section` 给定时打开后直接滚到该分区（高级参数专用） */
  openAdvanced: (section?: AdvancedSectionId) => void;
  openDevice: () => void;
  openFirmware: () => void;
  openSettings: () => void;
}

export interface OpenPanelOptions {
  /** 高级参数：打开后滚到哪一节（`data-section`） */
  readonly section?: AdvancedSectionId;
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
  openPanel: (id: PanelId, options?: OpenPanelOptions) => void;
  closePanel: () => void;
}

const PANEL_META: Record<PanelId, { title: string; subtitle: string; size: 'narrow' | 'medium' | 'wide' }> = {
  advanced: { title: 'advanced.title', subtitle: 'advanced.desc', size: 'wide' },
  device: { title: 'device.modalTitle', subtitle: 'device.subtitle', size: 'medium' },
  // 固件升级是一条单列流程，宽抽屉只会把它拉成一条长横线
  firmware: { title: 'fw.title', subtitle: 'fw.subtitle', size: 'narrow' },
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

  const openPanel = (id: PanelId, options?: OpenPanelOptions): void => {
    closePanel();
    const meta = PANEL_META[id];
    const opened = openModal({
      title: t(meta.title),
      subtitle: t(meta.subtitle),
      size: meta.size,
      content: panelContent[id](),
    });
    panel = opened;
    if (options?.section) scrollPanelTo(opened.root, options.section);
  };

  /**
   * 打开后滚到指定分区：抽屉刚插进 DOM 时还没有尺寸，等一帧再滚。
   * 滚动容器是 `.modal-body`，`scrollIntoView` 会自己找到它；
   * 分区的 `scroll-margin-top` 负责避开吸顶的跳转条（见 components.css）。
   * 跳转条的高亮由 advanced-view 的 scroll 捕获监听负责，这里不用另外通知它。
   */
  const scrollPanelTo = (panelRoot: HTMLElement, section: AdvancedSectionId): void => {
    window.requestAnimationFrame(() => {
      const target = panelRoot.querySelector<HTMLElement>(`.advanced-section[data-section="${section}"]`);
      target?.scrollIntoView({ block: 'start' });
    });
  };

  const api: ShellApi = {
    openAdvanced: (section) => openPanel('advanced', section ? { section } : undefined),
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
