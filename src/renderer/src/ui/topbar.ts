import type { AppStore } from '../domain/state';
import { t } from '../i18n';
import { segmented } from './controls';
import { icon } from './icons';

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

/** 状态灯的颜色档：错误 > 进行中 > 演示 > 正常 */
type Tone = 'ok' | 'busy' | 'demo' | 'error' | 'idle';

function toolButton(id: string, label: string, glyph: HTMLElement, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn--ghost btn--tool';
  button.id = id;
  const text = document.createElement('span');
  text.textContent = label;
  button.append(glyph, text);
  button.addEventListener('click', onClick);
  return button;
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
      <small>ALPHA</small>
    </div>`;

  const right = document.createElement('div');
  right.className = 'topbar-right';

  // 设备状态胶囊：传输态 / 数据来源 / 同步相位合在一个按钮里，点开就是设备抽屉。
  // 三段各自保留原来的节点与 id（`#source-pill` / `#sync-pill`），联调探针按它们取文案
  const device = document.createElement('button');
  device.type = 'button';
  device.className = 'status-chip';
  device.id = 'connect-btn';
  device.title = t('topbar.connectHint');
  device.addEventListener('click', () => opts.onDevice());

  const pill = document.createElement('span');
  pill.className = 'state-pill';
  pill.setAttribute('role', 'status');
  // 状态灯挂在胶囊最前面，颜色由 data-tone 决定（不再跟着某一段走）
  const dot = document.createElement('i');
  dot.className = 'dot';
  const pillText = document.createElement('span');
  pillText.className = 'state-text';
  pill.append(pillText);

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

  const caret = icon('chevronDown', 14);
  caret.classList.add('status-chip-caret');
  device.append(dot, sourcePill, pill, syncPill, caret);

  const advanced = toolButton('advanced-btn', t('topbar.advanced'), icon('sliders', 16), () => opts.onAdvanced());
  advanced.title = t('topbar.advancedHint');
  const settings = toolButton('settings-btn', t('topbar.settings'), icon('gear', 16), () => opts.onSettings());

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

  const divider = document.createElement('span');
  divider.className = 'topbar-divider';
  divider.setAttribute('aria-hidden', 'true');

  right.append(device, divider, advanced, settings, lang);
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

    // 胶囊里只露"来源 · 同步"两段；传输态只在出问题或进行中时露出来，
    // 正常就绪时它和"已连接"说的是同一件事
    const tone: Tone =
      state.transport === 'error' || state.sync === 'error'
        ? 'error'
        : state.transport === 'connecting' || state.sync === 'syncing'
          ? 'busy'
          : kind === 'mock'
            ? 'demo'
            : connected
              ? 'ok'
              : 'idle';
    device.dataset.tone = tone;
    pill.hidden = !(state.transport === 'error' || state.transport === 'connecting');
    syncPill.hidden = kind === 'mock' && state.sync === 'idle';
    device.setAttribute(
      'aria-label',
      `${t('topbar.connect')}: ${sourceText.textContent} · ${pillText.textContent} · ${syncText.textContent}`,
    );
  };
  syncState();
  const unsubscribe = opts.store.onChange(() => syncState());

  (container as HTMLElement & { destroy?: () => void }).destroy = () => unsubscribe();

  return container;
}
