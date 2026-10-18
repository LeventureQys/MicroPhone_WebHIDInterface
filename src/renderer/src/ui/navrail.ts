import type { AppStore } from '../domain/state';
import { t } from '../i18n';
import type { RouteId } from '../app/router';

interface NavEntry {
  id: RouteId;
  icon: string;
}

const ICONS: Record<RouteId, string> = {
  meter:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 14v-4M9 17V7M13 15v-6M17 18V6M21 13v-2"/></svg>',
  input:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="9" y="3" width="6" height="10" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  eq: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 15c3 0 3-7 6-7s3 5 6 5 3-4 6-4"/><circle cx="6" cy="15" r="1.4"/><circle cx="12" cy="8" r="1.4"/></svg>',
  dynamics:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3"/></svg>',
  drc: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 7h18M3 12h12M3 17h7"/><circle cx="18" cy="12" r="1.6"/><circle cx="13" cy="17" r="1.6"/></svg>',
  device:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="18" rx="2.5"/><path d="M10 7.5h4M9.5 18h5"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
};

const ENTRIES: NavEntry[] = [
  { id: 'meter', icon: ICONS.meter },
  { id: 'input', icon: ICONS.input },
  { id: 'eq', icon: ICONS.eq },
  { id: 'dynamics', icon: ICONS.dynamics },
  { id: 'drc', icon: ICONS.drc },
  { id: 'device', icon: ICONS.device },
  { id: 'settings', icon: ICONS.settings },
];

export function createNavRail(opts: { store: AppStore }): HTMLElement {
  const container = document.createElement('div');
  container.className = 'navrail-inner';
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.gap = '6px';

  const buttons = ENTRIES.map((entry) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-item';
    button.dataset.route = entry.id;

    const icon = document.createElement('span');
    icon.className = 'nav-icon';
    icon.innerHTML = entry.icon;

    const label = document.createElement('span');
    label.className = 'nav-label';
    label.textContent = t(`nav.${entry.id}`);

    button.append(icon, label);
    button.addEventListener('click', () => opts.store.setModule(entry.id));
    return button;
  });

  container.append(...buttons);

  const sync = (): void => {
    const active = opts.store.get().module;
    for (const button of buttons) {
      button.classList.toggle('is-active', button.dataset.route === active);
    }
  };

  const unsubscribe = opts.store.onChange(() => sync());
  (container as HTMLElement & { destroy?: () => void }).destroy = () => unsubscribe();

  sync();
  return container;
}
