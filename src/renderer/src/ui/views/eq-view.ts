import { computeCurve } from '../../eq/curve';
import { attachEqInteractions } from '../../eq/interactions';
import { FreqMapper } from '../../eq/mapper';
import { EqModel } from '../../eq/model';
import { drawEq } from '../../eq/render';
import { EQ_TYPE_LABEL, type EqBand, type EqFilterType, type Viewport } from '../../eq/types';
import type { AppStore } from '../../domain/state';
import { t } from '../../i18n';
import { card } from '../controls';

const TYPE_VALUES: EqFilterType[] = [0, 1, 2, 3, 4];
const MARGIN = { top: 20, right: 24, bottom: 40, left: 68 };

export function createEqView(store: AppStore): HTMLElement {
  const model = new EqModel(store.get().bands);

  const root = document.createElement('div');
  const layout = document.createElement('div');
  layout.className = 'eq-layout';

  const canvasCard = card({
    eyebrow: 'EQ / RESPONSE',
    title: t('eq.title'),
    tag: '14 BANDS',
    desc: t('eq.subtitle'),
  });

  const toolbar = document.createElement('div');
  toolbar.className = 'eq-toolbar';

  const badge = document.createElement('span');
  badge.className = 'eq-badge';
  badge.textContent = t('eq.badge');

  const resetAll = document.createElement('button');
  resetAll.type = 'button';
  resetAll.className = 'btn btn--ghost';
  resetAll.textContent = t('eq.resetAll');
  resetAll.addEventListener('click', () => {
    for (let index = 0; index < model.visibleCount(); index += 1) {
      model.resetBandGain(index);
    }
    commitBands();
  });

  toolbar.append(badge, resetAll);

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'eq-canvas-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'eq-canvas';
  canvasWrap.append(canvas);

  const hint = document.createElement('p');
  hint.className = 'eq-hint';
  hint.textContent = t('eq.hint');

  canvasCard.body.append(toolbar, canvasWrap, hint);

  const listCard = card({ eyebrow: 'EQ / BANDS', title: t('eq.bandTitle'), tag: '1-7' });
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

    const num = document.createElement('button');
    num.type = 'button';
    num.className = 'eq-band-no';
    num.textContent = String(index + 1);
    num.addEventListener('click', () => {
      model.setFocused(model.focusedIndex() === index ? -1 : index);
      syncRowValues();
      renderCanvas();
    });

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
      commitBands();
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
        commitBands();
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

  listCard.body.append(list);

  const internal = document.createElement('details');
  internal.className = 'card eq-internal';
  const summary = document.createElement('summary');
  summary.textContent = t('eq.internal.title');
  const internalBody = document.createElement('div');
  internalBody.className = 'eq-internal-body';
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
  internalBody.append(internalDesc, internalList);
  internal.append(summary, internalBody);

  const side = document.createElement('aside');
  side.className = 'eq-side';
  side.append(listCard.root, internal);

  layout.append(canvasCard.root, side);
  root.append(layout);

  const ctx = canvas.getContext('2d');
  let mapper = new FreqMapper({ x: MARGIN.left, y: MARGIN.top, width: 1, height: 1 });

  // 交互层持有稳定代理，画布尺寸变化时只替换内部 mapper
  const mapperProxy = {
    freqToX: (freq: number) => mapper.freqToX(freq),
    gainToY: (gain: number) => mapper.gainToY(gain),
    xToFreq: (x: number) => mapper.xToFreq(x),
    yToGain: (y: number) => mapper.yToGain(y),
  };

  function syncRowValues(): void {
    for (const [index, rowInputs] of inputs) {
      const band = model.bandAt(index);
      if (!band) continue;
      rowInputs.freq.value = String(band.freq);
      rowInputs.gain.value = String(band.gain);
      rowInputs.q.value = String(band.q);
    }
    const focused = model.focusedIndex();
    for (const [index, row] of rows) {
      row.classList.toggle('is-focused', index === focused);
    }
  }

  function renderCanvas(): void {
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width;
    const cssHeight = rect.height;
    if (cssWidth < 10 || cssHeight < 10) return;
    const dpr = window.devicePixelRatio || 1;
    const pxWidth = Math.round(cssWidth * dpr);
    const pxHeight = Math.round(cssHeight * dpr);
    if (canvas.width !== pxWidth || canvas.height !== pxHeight) {
      canvas.width = pxWidth;
      canvas.height = pxHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const viewport: Viewport = {
      x: MARGIN.left,
      y: MARGIN.top,
      width: Math.max(10, cssWidth - MARGIN.left - MARGIN.right),
      height: Math.max(10, cssHeight - MARGIN.top - MARGIN.bottom),
    };
    mapper = new FreqMapper(viewport);

    const bands = model.allBands();
    const pointCount = Math.min(1200, Math.max(240, Math.round(cssWidth)));

    drawEq(ctx, {
      width: cssWidth,
      height: cssHeight,
      freqTicks: FreqMapper.freqTicks(20, 20000),
      gainTicks: FreqMapper.gainTicks(-24, 12, 6),
      bands,
      visibleCount: model.visibleCount(),
      focusedIndex: model.focusedIndex(),
      curve: computeCurve(bands, { pointCount }),
      freqToX: mapperProxy.freqToX,
      gainToY: mapperProxy.gainToY,
      xToFreq: mapperProxy.xToFreq,
      yToGain: mapperProxy.yToGain,
    });
  }

  function commitBands(): void {
    store.setBands(model.allBands());
    syncRowValues();
    renderCanvas();
  }

  const detach = attachEqInteractions({
    canvas,
    model,
    mapper: mapperProxy,
    onChange: () => {
      syncRowValues();
      renderCanvas();
      store.setBands(model.allBands());
    },
  });

  const observer = new ResizeObserver(() => renderCanvas());
  observer.observe(canvasWrap);

  const unsubscribe = store.onChange((state) => {
    const bands = model.allBands();
    const changed = state.bands.some((band: EqBand, index: number) => {
      const current = bands[index];
      return (
        !current ||
        current.freq !== band.freq ||
        current.gain !== band.gain ||
        current.q !== band.q ||
        current.type !== band.type
      );
    });
    if (changed) {
      for (const band of state.bands) {
        model.setBand(band.index, { freq: band.freq, gain: band.gain, q: band.q, type: band.type });
      }
      syncRowValues();
      renderCanvas();
    }
  });

  syncRowValues();
  window.requestAnimationFrame(() => renderCanvas());

  (root as HTMLElement & { destroy?: () => void }).destroy = () => {
    detach();
    observer.disconnect();
    unsubscribe();
  };

  return root;
}
