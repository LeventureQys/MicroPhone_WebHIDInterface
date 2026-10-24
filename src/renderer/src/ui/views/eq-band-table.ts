import { DEFAULT_BANDS } from '../../domain/defaults';
import type { AppStore } from '../../domain/state';
import { EqModel } from '../../eq/model';
import { EQ_TYPE_LABEL, type EqBand, type EqFilterType } from '../../eq/types';
import { t } from '../../i18n';
import { card } from '../controls';

const TYPE_VALUES: EqFilterType[] = [0, 1, 2, 3, 4];

/**
 * 7 段可调 EQ 的逐段编辑表：曲线在控制台，表格只出现在高级参数抽屉里，
 * 用数字输入做精确调整。
 */
export function createEqBandTable(store: AppStore): HTMLElement {
  const model = new EqModel(store.get().bands);

  const built = card({ eyebrow: 'EQ / BANDS', title: t('eq.bandTitle'), tag: '1-7' });

  const toolbar = document.createElement('div');
  toolbar.className = 'eq-table-toolbar';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn btn--ghost';
  reset.textContent = t('eq.resetAll');
  reset.addEventListener('click', () => {
    for (let index = 0; index < model.visibleCount(); index += 1) {
      const band = DEFAULT_BANDS[index];
      if (!band) continue;
      model.setBand(index, { type: band.type, freq: band.freq, gain: band.gain, q: band.q });
    }
    commit();
  });
  toolbar.append(reset);

  const list = document.createElement('div');
  list.className = 'eq-list';

  const header = document.createElement('div');
  header.className = 'eq-row eq-row--head';
  for (const key of ['index', 'type', 'freq', 'gain', 'q'] as const) {
    const cell = document.createElement('span');
    cell.textContent = t(`eq.column.${key}`);
    header.append(cell);
  }
  list.append(header);

  const rows = new Map<number, HTMLElement>();
  const inputs = new Map<
    number,
    { freq: HTMLInputElement; gain: HTMLInputElement; q: HTMLInputElement }
  >();

  for (let index = 0; index < model.visibleCount(); index += 1) {
    const band = model.bandAt(index);
    if (!band) continue;

    const row = document.createElement('div');
    row.className = 'eq-row';
    row.dataset.band = String(index);

    const num = document.createElement('span');
    num.className = 'eq-band-no';
    num.textContent = String(index + 1);

    const select = document.createElement('select');
    select.className = 'eq-select';
    for (const type of TYPE_VALUES) {
      const option = document.createElement('option');
      option.value = String(type);
      option.textContent = EQ_TYPE_LABEL[type];
      select.append(option);
    }
    select.value = String(band.type);
    select.addEventListener('change', () => {
      model.setBand(index, { type: Number(select.value) as EqFilterType });
      commit();
    });

    const makeNumber = (
      value: number,
      min: number,
      max: number,
      step: number,
      apply: (value: number) => void,
      fallback: () => number,
    ): HTMLInputElement => {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'eq-input';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      input.addEventListener('change', () => {
        const parsed = Number(input.value);
        if (!Number.isFinite(parsed)) {
          input.value = String(fallback());
          return;
        }
        apply(parsed);
        commit();
      });
      return input;
    };

    const freqInput = makeNumber(
      band.freq,
      20,
      20000,
      1,
      (value) => model.setBand(index, { freq: Math.round(value) }),
      () => model.bandAt(index)?.freq ?? 1000,
    );
    const gainInput = makeNumber(
      band.gain,
      -32,
      12,
      0.1,
      (value) => model.setBand(index, { gain: Math.round(value * 10) / 10 }),
      () => model.bandAt(index)?.gain ?? 0,
    );
    const qInput = makeNumber(
      band.q,
      0.1,
      12,
      0.1,
      (value) => model.setBand(index, { q: Math.round(value * 10) / 10 }),
      () => model.bandAt(index)?.q ?? 0.7,
    );

    inputs.set(index, { freq: freqInput, gain: gainInput, q: qInput });
    rows.set(index, row);
    row.append(num, select, freqInput, gainInput, qInput);
    list.append(row);
  }

  const internal = document.createElement('details');
  internal.className = 'eq-internal';
  const summary = document.createElement('summary');
  summary.textContent = t('eq.internal.title');
  const internalDesc = document.createElement('p');
  internalDesc.className = 'card-desc';
  internalDesc.textContent = t('eq.internal.desc');
  const internalList = document.createElement('div');
  internalList.className = 'eq-internal-list';
  for (const band of model.allBands()) {
    if (band.index < model.visibleCount()) continue;
    const item = document.createElement('div');
    item.className = 'eq-internal-row';
    item.textContent = `#${band.index + 1} · ${EQ_TYPE_LABEL[band.type]} · ${band.freq} Hz · ${band.gain} dB · Q ${band.q}`;
    internalList.append(item);
  }
  internal.append(summary, internalDesc, internalList);

  built.body.append(toolbar, list, internal);

  function syncRows(): void {
    for (const [index, rowInputs] of inputs) {
      const band = model.bandAt(index);
      if (!band) continue;
      rowInputs.freq.value = String(band.freq);
      rowInputs.gain.value = String(band.gain);
      rowInputs.q.value = String(band.q);
      const select = rows.get(index)?.querySelector<HTMLSelectElement>('.eq-select');
      if (select) select.value = String(band.type);
    }
  }

  function commit(): void {
    store.setBands(model.allBands());
    syncRows();
  }

  const unsubscribe = store.onChange((next) => {
    const current = model.allBands();
    const changed = next.bands.some((band: EqBand, index: number) => {
      const mine = current[index];
      return (
        !mine ||
        mine.freq !== band.freq ||
        mine.gain !== band.gain ||
        mine.q !== band.q ||
        mine.type !== band.type
      );
    });
    if (!changed) return;
    for (const band of next.bands) {
      model.setBand(band.index, { freq: band.freq, gain: band.gain, q: band.q, type: band.type });
    }
    syncRows();
  });

  (built.root as HTMLElement & { destroy?: () => void }).destroy = () => unsubscribe();

  return built.root;
}
