import type { AppStore } from '../domain/state';
import { t } from '../i18n';
import { segmented } from './controls';

const STATE_KEY: Record<string, string> = {
  idle: 'topbar.state.idle',
  connecting: 'topbar.state.connecting',
  ready: 'topbar.state.ready',
  error: 'topbar.state.error',
};

export function createTopbar(opts: { store: AppStore }): HTMLElement {
  const container = document.createElement('div');
  container.className = 'topbar-inner';
  container.style.display = 'flex';
  container.style.alignItems = 'center';
  container.style.justifyContent = 'space-between';
  container.style.width = '100%';

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

  const dot = document.createElement('i');
  dot.className = 'dot';

  const pillText = document.createElement('span');
  pillText.className = 'state-text';

  pill.append(dot, pillText);

  const lang = segmented<'zh' | 'en'>({
    options: [
      { value: 'zh', label: '中' },
      { value: 'en', label: 'EN' },
    ],
    value: opts.store.get().lang,
    onChange: (value) => opts.store.setLang(value),
  });
  lang.classList.add('segmented--lang');

  const connect = document.createElement('button');
  connect.type = 'button';
  connect.className = 'btn btn--primary';
  connect.id = 'connect-btn';
  connect.textContent = t('topbar.connect');

  connect.addEventListener('click', async () => {
    const api = window.micstudio;
    if (!api) {
      connect.disabled = true;
      connect.title = 'Electron API unavailable';
      return;
    }
    const original = t('topbar.connect');
    const result = await api.requestHidDevice();
    if (!result.ok) {
      connect.textContent = t('topbar.connectUnavailable');
      window.setTimeout(() => {
        connect.textContent = original;
      }, 2000);
    }
  });

  right.append(pill, lang, connect);
  container.append(brand, right);

  const syncState = (): void => {
    const state = opts.store.get().transport;
    pill.className = `state-pill state-pill--${state}`;
    pillText.textContent = t(STATE_KEY[state] ?? 'topbar.state.idle');
  };

  syncState();
  const unsubscribe = opts.store.onChange((next) => {
    const state = next.transport;
    pill.className = `state-pill state-pill--${state}`;
    pillText.textContent = t(STATE_KEY[state] ?? 'topbar.state.idle');
  });
  (container as HTMLElement & { destroy?: () => void }).destroy = () => unsubscribe();

  return container;
}
