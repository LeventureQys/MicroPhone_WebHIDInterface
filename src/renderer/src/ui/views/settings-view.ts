import { DEFAULT_BANDS, DEFAULT_PARAMS } from '../../domain/defaults';
import { PARAMS } from '../../domain/params';
import type { AppStore } from '../../domain/state';
import { t } from '../../i18n';
import { card, segmented } from '../controls';

export function createSettingsView(store: AppStore): HTMLElement {
  const root = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'panel-grid';

  const state = store.get();

  const uiCard = card({ eyebrow: 'SETTINGS', title: t('settings.language'), tag: 'UI' });

  const langRow = document.createElement('div');
  langRow.className = 'pfield';
  langRow.append(
    segmented<'zh' | 'en'>({
      options: [
        { value: 'zh', label: '中文' },
        { value: 'en', label: 'English' },
      ],
      value: state.lang,
      onChange: (value) => store.setLang(value),
    }),
  );

  const sceneRow = document.createElement('div');
  sceneRow.className = 'pfield';
  const sceneHead = document.createElement('div');
  sceneHead.className = 'pfield-head';
  const sceneLabel = document.createElement('span');
  sceneLabel.className = 'pfield-label';
  sceneLabel.textContent = t('settings.scene');
  sceneHead.append(sceneLabel);
  sceneRow.append(
    sceneHead,
    segmented<string>({
      options: [
        { value: 'silence', label: t('meter.scene.silence') },
        { value: 'speech', label: t('meter.scene.speech') },
        { value: 'music', label: t('meter.scene.music') },
      ],
      value: state.scene,
      onChange: (value) => store.setScene(value as typeof state.scene),
    }),
  );

  uiCard.body.append(langRow, sceneRow);

  const dataCard = card({ eyebrow: 'SETTINGS', title: t('settings.resetAll'), tag: 'DATA' });
  const resetButton = document.createElement('button');
  resetButton.type = 'button';
  resetButton.className = 'btn btn--ghost';
  resetButton.textContent = t('settings.resetAll');
  resetButton.style.width = '100%';
  resetButton.addEventListener('click', () => {
    for (const spec of PARAMS) {
      if (spec.readonly) continue;
      const value = DEFAULT_PARAMS[spec.id];
      if (value === undefined) {
        console.warn('[settings] missing default for', spec.id);
        continue;
      }
      store.setParam(spec.id, value);
    }
    store.setBands(DEFAULT_BANDS);
    resetButton.textContent = t('common.default');
    window.setTimeout(() => {
      resetButton.textContent = t('settings.resetAll');
    }, 1500);
  });
  dataCard.body.append(resetButton);

  const aboutCard = card({ eyebrow: 'SETTINGS', title: t('settings.about'), tag: 'ALPHA' });
  const api = window.micstudio;
  const rows: Array<[string, string]> = [
    [t('settings.version'), api?.appVersion ?? '1.0.0-alpha.0'],
    [t('settings.platform'), api?.platform ?? 'browser'],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'pfield';
    const head = document.createElement('div');
    head.className = 'pfield-head';
    const name = document.createElement('span');
    name.className = 'pfield-label';
    name.textContent = label;
    const readout = document.createElement('span');
    readout.className = 'pfield-value';
    readout.textContent = value;
    head.append(name, readout);
    row.append(head);
    aboutCard.body.append(row);
  }
  const notice = document.createElement('p');
  notice.className = 'card-desc';
  notice.textContent = t('settings.alphaNotice');
  aboutCard.body.append(notice);

  grid.append(uiCard.root, dataCard.root, aboutCard.root);
  root.append(grid);
  return root;
}
