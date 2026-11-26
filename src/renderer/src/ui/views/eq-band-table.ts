import { eqResetBands } from '../../domain/eq-reset';
import { gainsOf } from '../../domain/quick-controls';
import type { AppState, AppStore } from '../../domain/state';
import { EqModel } from '../../eq/model';
import { bandHasGain, EQ_TYPE_LABEL, type EqBand, type EqFilterType } from '../../eq/types';
import { t } from '../../i18n';
import { card, resetControl, setResetDisabled, setSwitchChecked, switchControl } from '../controls';

const TYPE_VALUES: EqFilterType[] = [0, 1, 2, 3, 4];

/**
 * 7 段可调 EQ 的逐段编辑表：曲线在控制台，表格只出现在高级参数抽屉里，
 * 用数字输入做精确调整。
 */
export function createEqBandTable(store: AppStore): HTMLElement {
  const model = new EqModel(store.get().bands);
  const state = store.get();
  /** 旁通态跟随 store：高通 / 低通增益框的可用态 = 非旁通 && 有增益 */
  let eqBypassed = state.bypass.eq;

  const built = card({ title: t('eq.bandTitle') });

  const toolbar = document.createElement('div');
  toolbar.className = 'eq-table-toolbar';
  const bypass = switchControl({
    checked: state.bypass.eq,
    label: t('module.bypass'),
    onChange: (checked) => store.setBypass('eq', checked),
    reset: {
      onClick: () => store.setBypass('eq', false),
      disabled: !state.bypass.eq,
    },
  });
  bypass.classList.add('module-bypass');
  bypass.dataset.bypass = 'eq';
  bypass.querySelector<HTMLButtonElement>('.param-reset')?.setAttribute('data-reset-param', 'bypass.eq');
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn btn--ghost btn--small';
  reset.textContent = t('eq.resetAll');
  reset.addEventListener('click', () => {
    // 复位值 = 问题单 2026-11-21 第 12 条那张表（7 段增益 0、Q 0.7），
    // 与主界面音色曲线卡上的「复位」用同一个 preset
    for (const band of eqResetBands()) {
      model.setBand(band.index, { type: band.type, freq: band.freq, gain: band.gain, q: band.q });
    }
    commit();
  });
  toolbar.append(bypass, reset);

  const bypassNote = document.createElement('p');
  bypassNote.className = 'macro-hint module-bypass-note';
  bypassNote.textContent = t('module.bypass.eq');
  bypassNote.hidden = !state.bypass.eq;

  const list = document.createElement('div');
  list.className = 'eq-list';

  const header = document.createElement('div');
  header.className = 'eq-row eq-row--head';
  for (const key of ['index', 'type', 'freq', 'gain', 'q', 'reset'] as const) {
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
    const rowReset = resetControl({
      onClick: () => {
        store.restoreBand(index);
        syncRows();
      },
      disabled: store.isBandAtSceneTarget(index),
      label: t('common.restore'),
    });
    rowReset.dataset.resetBand = String(index);
    row.append(num, select, freqInput, gainInput, qInput, rowReset);
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

  // 复位按钮放卡头右侧，和标题同一行
  built.root.querySelector('.card-head')?.append(toolbar);
  built.body.append(bypassNote, list, internal);

  function syncRows(): void {
    for (const [index, rowInputs] of inputs) {
      const band = model.bandAt(index);
      if (!band) continue;
      rowInputs.freq.value = String(band.freq);
      rowInputs.gain.value = String(band.gain);
      rowInputs.q.value = String(band.q);
      const select = rows.get(index)?.querySelector<HTMLSelectElement>('.eq-select');
      if (select) select.value = String(band.type);
      // 高通 / 低通没有增益：输入框置灰并说明原因（模型里这一段已经被归零）
      const gainless = !bandHasGain(band.type);
      rowInputs.gain.disabled = eqBypassed || gainless;
      rowInputs.gain.title = gainless ? t('eq.gain.na') : '';
      rowInputs.gain.setAttribute('aria-label', gainless ? t('eq.gain.na') : t('eq.column.gain'));
      setResetDisabled(rows.get(index) ?? rowInputs.freq, store.isBandAtSceneTarget(index));
    }
  }

  function commit(): void {
    // 手改具体段值后不再属于任何固定音色：主界面按「自定义」显示，且曲线重新可拖
    store.setTone('custom');
    store.setBands(model.allBands());
    store.setCustomEq(gainsOf(model.allBands()));
    syncRows();
  }

  const applyBypass = (bypassed: boolean): void => {
    eqBypassed = bypassed;
    setSwitchChecked(bypass, bypassed);
    setResetDisabled(bypass, !bypassed);
    bypassNote.hidden = !bypassed;
    for (const input of list.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) {
      input.disabled = bypassed;
    }
    reset.disabled = bypassed;
    for (const row of rows.values()) {
      setResetDisabled(row, bypassed || store.isBandAtSceneTarget(Number(row.dataset.band ?? -1)));
    }
    list.classList.toggle('is-bypassed', bypassed);
    // 上面那圈会把所有输入框重新打开：高通 / 低通的增益框要按类型再压回去
    syncRows();
  };
  applyBypass(state.bypass.eq);

  const unsubscribe = store.onChange((next: AppState) => {
    applyBypass(next.bypass.eq);

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
