import { findParam } from '../../domain/params';
import type { AppStore } from '../../domain/state';
import { t } from '../../i18n';
import { card, paramSlider, setSliderValue } from '../controls';

const BANDS = ['low', 'mid', 'high'] as const;
type DrcBand = (typeof BANDS)[number];

const FIELDS = ['preGain', 'threshold', 'attackTime', 'releaseTime', 'ratio'] as const;

export function createDrcView(store: AppStore): HTMLElement {
  const root = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'panel-grid';

  const state = store.get();
  const fieldMap = new Map<string, HTMLElement>();
  const condNodes = new Map<DrcBand, HTMLElement>();
  const bandCards = new Map<DrcBand, HTMLElement>();

  const readNumber = (id: string): number => state.params[id] ?? findParam(id)?.default ?? 0;

  const crossover = card({
    eyebrow: 'DRC / CROSSOVER',
    title: t('module.drc3'),
    tag: '2 PARAMS',
    desc: t('module.drc3.desc'),
  });
  for (const id of ['drc3.fc1', 'drc3.fc2']) {
    const spec = findParam(id);
    if (!spec) continue;
    const node = paramSlider(spec, {
      value: readNumber(id),
      onInput: (value) => {
        store.setParam(id, value);
        refreshConditionText();
        refreshConflict();
      },
    });
    fieldMap.set(id, node);
    crossover.body.append(node);
  }

  const refreshConditionText = (): void => {
    const current = store.get().params;
    const fc1 = current['drc3.fc1'] ?? 1000;
    const fc2 = current['drc3.fc2'] ?? 3000;
    const vars = { fc1: String(fc1), fc2: String(fc2) };
    for (const band of BANDS) {
      const node = condNodes.get(band);
      if (!node) continue;
      const base = t(`drc.cond.${band}`, vars);
      node.textContent = store.get().params['drc3.fc1'] > store.get().params['drc3.fc2']
        ? `${base} · ${t('drc.conflict')}`
        : base;
    }
  };

  const refreshConflict = (): void => {
    const current = store.get().params;
    const conflict = (current['drc3.fc1'] ?? 0) > (current['drc3.fc2'] ?? 0);
    for (const band of BANDS) {
      bandCards.get(band)?.classList.toggle('is-conflict', conflict);
    }
  };

  for (const band of BANDS) {
    const bandCard = card({
      eyebrow: `DRC / ${band.toUpperCase()}`,
      title: t(`drc.band.${band}`),
      tag: '5 PARAMS',
    });
    const cond = document.createElement('p');
    cond.className = 'card-desc';
    cond.textContent = t(`drc.cond.${band}`);
    bandCard.body.append(cond);
    condNodes.set(band, cond);
    bandCards.set(band, bandCard.root);

    for (const field of FIELDS) {
      const id = `drc3.${band}.${field}`;
      const spec = findParam(id);
      if (!spec) continue;
      const node = paramSlider(spec, {
        value: readNumber(id),
        onInput: (value) => store.setParam(id, value),
      });
      fieldMap.set(id, node);
      bandCard.body.append(node);
    }
    grid.append(bandCard.root);
  }

  grid.prepend(crossover.root);
  root.append(grid);

  refreshConditionText();
  refreshConflict();

  store.onChange((next) => {
    for (const [id, node] of fieldMap) {
      const spec = findParam(id);
      if (!spec) continue;
      setSliderValue(node, spec, next.params[id] ?? spec.default);
    }
    refreshConditionText();
    refreshConflict();
  });

  return root;
}
