import { findParam } from '../../domain/params';
import type { AppState, AppStore } from '../../domain/state';
import { t } from '../../i18n';
import { card, paramSlider, setSliderValue, setSwitchChecked, switchControl } from '../controls';

const BANDS = ['low', 'mid', 'high'] as const;
type DrcBand = (typeof BANDS)[number];

const FIELDS = ['preGain', 'threshold', 'attackTime', 'releaseTime', 'ratio'] as const;

/**
 * 推荐分频点 = 参数表 V0.3 的默认值（`0x2061` / `0x2062`）。
 * V0.3 之前表默认是 50/50，中频段宽度为 0，厂商已把默认改到 1000/3000；
 * 按钮保留给被改坏的老设备一键回位。
 */
const RECOMMENDED_FC1 = 1000;
const RECOMMENDED_FC2 = 3000;

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
    title: t('module.drc3'),
    desc: t('module.drc3.desc'),
  });
  // 参数表 V0.3 新增 0x2075：真正的模块使能位，关掉即直通（不再靠 preGain=0 + ratio=1 近似）
  const enable = switchControl({
    checked: (state.params['drc3.Enable'] ?? 0) === 1,
    label: t('param.drc3.Enable.label'),
    onChange: (checked) => store.setParam('drc3.Enable', checked ? 1 : 0),
  });
  enable.classList.add('module-bypass');
  enable.dataset.enable = 'drc3';
  enable.dataset.param = 'drc3.Enable';
  const enableHint = document.createElement('p');
  enableHint.className = 'macro-hint module-bypass-note';
  enableHint.textContent = t('module.drc3.bypassHint');

  const recommend = document.createElement('button');
  recommend.type = 'button';
  recommend.className = 'btn btn--ghost btn--small drc-recommend';
  recommend.textContent = t('drc.recommend');
  recommend.addEventListener('click', () => {
    store.setParam('drc3.fc1', RECOMMENDED_FC1);
    store.setParam('drc3.fc2', RECOMMENDED_FC2);
  });
  const recommendRow = document.createElement('div');
  recommendRow.className = 'drc-recommend-row';
  recommendRow.append(recommend);

  crossover.body.append(enable, enableHint, recommendRow);

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
    const fc1 = current['drc3.fc1'] ?? 50;
    const fc2 = current['drc3.fc2'] ?? 50;
    const vars = { fc1: String(fc1), fc2: String(fc2) };
    for (const band of BANDS) {
      const node = condNodes.get(band);
      if (!node) continue;
      const base = t(`drc.cond.${band}`, vars);
      node.textContent = fc1 >= fc2 ? `${base} · ${t('drc.conflict')}` : base;
    }
  };

  const refreshConflict = (): void => {
    const current = store.get().params;
    const conflict = (current['drc3.fc1'] ?? 0) >= (current['drc3.fc2'] ?? 0);
    for (const band of BANDS) {
      bandCards.get(band)?.classList.toggle('is-conflict', conflict);
    }
  };

  for (const band of BANDS) {
    const bandCard = card({
      title: t(`drc.band.${band}`),
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

  const unsubscribe = store.onChange((next: AppState) => {
    for (const [id, node] of fieldMap) {
      const spec = findParam(id);
      if (!spec) continue;
      setSliderValue(node, spec, next.params[id] ?? spec.default);
    }
    setSwitchChecked(enable, (next.params['drc3.Enable'] ?? 0) === 1);
    refreshConditionText();
    refreshConflict();
  });

  (root as HTMLElement & { destroy?: () => void }).destroy = () => unsubscribe();

  return root;
}
