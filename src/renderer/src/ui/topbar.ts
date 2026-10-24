import type { AppStore } from '../domain/state';
import { t } from '../i18n';
import { segmented } from './controls';

const STATE_KEY: Record<string, string> = {
  idle: 'topbar.state.idle',
  connecting: 'topbar.state.connecting',
  ready: 'topbar.state.ready',
  error: 'topbar.state.error',
};

const SYNC_KEY: Record<string, string> = {
  idle: 'sync.phase.idle',
  syncing: 'sync.phase.syncing',
  ready: 'sync.phase.ready',
  error: 'sync.phase.error',
};

export interface TopbarOptions {
  store: AppStore;
  /** Alpha 的数据源是 Mock：状态 pill 加标识，避免被读成真机已连接 */
  mock?: boolean;
  onAdvanced: () => void;
  onDevice: () => void;
  onSettings: () => void;
}

export function createTopbar(opts: TopbarOptions): HTMLElement {
  const container = document.createElement('div');
  container.className = 'topbar-inner';

  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.innerHTML = `
    <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
    <div class="brand-text">
      <strong>MIC <span class="brand-accent">STUDIO</span></strong>
      <small>MIC CONSOLE / ALPHA</small>
    </div>`;

  const right = document.createElement('div');
  right.className = 'topbar-right';

  const pill = document.createElement('span');
  pill.className = 'state-pill';
  pill.setAttribute('role', 'status');

  const dot = document.createElement('i');
  dot.className = 'dot';
  const pillText = document.createElement('span');
  pillText.className = 'state-text';
  pill.append(dot, pillText);

  let mockTag: HTMLElement | null = null;
  if (opts.mock) {
    mockTag = document.createElement('span');
    mockTag.className = 'state-tag';
    mockTag.textContent = t('topbar.mockTag');
    pill.append(mockTag);
  }

  // 数据来源：演示数据 / 已连接（Q3：Mock 下必须显式标记，不能读成真机）
  const sourcePill = document.createElement('span');
  sourcePill.className = 'state-pill state-pill--source';
  sourcePill.id = 'source-pill';
  sourcePill.setAttribute('role', 'status');
  const sourceText = document.createElement('span');
  sourceText.className = 'state-text';
  sourcePill.append(sourceText);

  // 同步相位：idle / syncing / ready / error
  const syncPill = document.createElement('span');
  syncPill.className = 'state-pill state-pill--sync';
  syncPill.id = 'sync-pill';
  syncPill.setAttribute('role', 'status');
  const syncText = document.createElement('span');
  syncText.className = 'state-text';
  syncPill.append(syncText);

  const advanced = document.createElement('button');
  advanced.type = 'button';
  advanced.className = 'btn btn--ghost';
  advanced.id = 'advanced-btn';
  advanced.textContent = t('topbar.advanced');
  advanced.title = t('topbar.advancedHint');
  advanced.addEventListener('click', () => opts.onAdvanced());

  const settings = document.createElement('button');
  settings.type = 'button';
  settings.className = 'btn btn--ghost';
  settings.id = 'settings-btn';
  settings.textContent = t('topbar.settings');
  settings.addEventListener('click', () => opts.onSettings());

  const lang = segmented<'zh' | 'en'>({
    options: [
      { value: 'zh', label: '中' },
      { value: 'en', label: 'EN' },
    ],
    value: opts.store.get().lang,
    onChange: (value) => opts.store.setLang(value),
  });
  lang.classList.add('segmented--lang');
  lang.setAttribute('aria-label', t('topbar.lang'));

  const device = document.createElement('button');
  device.type = 'button';
  device.className = 'btn btn--primary';
  device.id = 'connect-btn';
  device.textContent = t('topbar.connect');
  device.addEventListener('click', () => opts.onDevice());

  right.append(pill, sourcePill, syncPill, advanced, settings, lang, device);
  container.append(brand, right);

  const syncState = (): void => {
    const state = opts.store.get();
    const kind = opts.store.channelKind();
    pill.className = `state-pill state-pill--${state.transport}`;
    pillText.textContent = t(STATE_KEY[state.transport] ?? 'topbar.state.idle');
    // 「演示」小标只属于 Mock 通道：连上真机后必须消失，否则和「已连接」胶囊自相矛盾
    if (mockTag) mockTag.hidden = kind !== 'mock';

    // 数据来源：只有真机通道且已就绪才算"已连接"，其余一律按演示数据标注
    const connected = kind === 'webhid' && state.transport === 'ready';
    sourcePill.classList.toggle('is-demo', !connected);
    sourceText.textContent = connected ? t('sync.source.device') : t('sync.source.demo');

    syncPill.className = `state-pill state-pill--sync state-pill--${state.sync}`;
    syncText.textContent = t(SYNC_KEY[state.sync] ?? 'sync.phase.idle');
  };
  syncState();
  const unsubscribe = opts.store.onChange(() => syncState());

  (container as HTMLElement & { destroy?: () => void }).destroy = () => unsubscribe();

  return container;
}
