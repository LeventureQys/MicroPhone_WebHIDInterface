import type { MockTransport } from '../../device/mock-transport';
import type { LevelFrame } from '../../device/transport';
import { findParam } from '../../domain/params';
import type { AppStore } from '../../domain/state';
import { t } from '../../i18n';
import { card, readonlyField, segmented } from '../controls';
import { MeterCanvas } from '../meter';

export function createMeterView(store: AppStore, transport: MockTransport): HTMLElement {
  const root = document.createElement('div');
  const layout = document.createElement('div');
  layout.className = 'meter-layout';

  const state = store.get();

  const meterCard = card({
    eyebrow: 'METER / LIVE',
    title: t('meter.title'),
    tag: '50 HZ',
    desc: t('meter.subtitle'),
  });

  const canvas = document.createElement('canvas');
  canvas.className = 'meter-canvas';
  meterCard.body.append(canvas);

  const meter = new MeterCanvas(canvas, { minDb: -60, rowHeight: 44 });

  const side = document.createElement('aside');
  side.className = 'meter-side';

  const gainCard = card({ eyebrow: 'GAIN', title: t('meter.card.gain'), tag: 'READ ONLY' });
  for (const id of ['gain.Mic', 'gain.Hp']) {
    const spec = findParam(id);
    if (!spec) continue;
    gainCard.body.append(readonlyField(spec, state.params[id] ?? spec.default));
  }

  const sceneCard = card({ eyebrow: 'SCENE', title: t('meter.card.scene'), tag: 'MOCK' });
  sceneCard.body.append(
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

  const statusCard = card({ eyebrow: 'STATUS', title: t('meter.card.status'), tag: 'TRANSPORT' });

  const transportRow = document.createElement('div');
  transportRow.className = 'pfield';
  const transportHead = document.createElement('div');
  transportHead.className = 'pfield-head';
  const transportLabel = document.createElement('span');
  transportLabel.className = 'pfield-label';
  transportLabel.textContent = t('meter.status.transport');
  const transportValue = document.createElement('span');
  transportValue.className = 'pfield-value';
  transportValue.textContent = state.transport;
  transportHead.append(transportLabel, transportValue);
  transportRow.append(transportHead);

  const writesRow = document.createElement('div');
  writesRow.className = 'pfield';
  const writesHead = document.createElement('div');
  writesHead.className = 'pfield-head';
  const writesLabel = document.createElement('span');
  writesLabel.className = 'pfield-label';
  writesLabel.textContent = t('meter.status.writes');
  const writesValue = document.createElement('span');
  writesValue.className = 'pfield-value';
  writesValue.textContent = '0';
  writesHead.append(writesLabel, writesValue);
  writesRow.append(writesHead);

  statusCard.body.append(transportRow, writesRow);

  side.append(gainCard.root, sceneCard.root, statusCard.root);
  layout.append(meterCard.root, side);
  root.append(layout);

  let latest: LevelFrame | null = transport.lastFrame();
  let frameId: number | null = null;
  let disposed = false;

  const paint = (): void => {
    if (disposed) return;
    frameId = null;
    const frame = latest ?? { t: 0, inputRms: -96, inputPeak: -96, outputRms: -96, outputPeak: -96 };
    meter.render([
      { label: t('meter.input'), rms: frame.inputRms, peak: frame.inputPeak },
      { label: t('meter.output'), rms: frame.outputRms, peak: frame.outputPeak },
    ]);
  };

  const schedulePaint = (): void => {
    if (frameId !== null) return;
    frameId = window.requestAnimationFrame(paint);
  };

  const unsubscribeLevels = transport.onLevels((frame) => {
    latest = frame;
    schedulePaint();
  });

  const unsubscribeStore = store.onChange((next) => {
    transportValue.textContent = next.transport;
    writesValue.textContent = String(transport.writtenBuffer().length);
  });

  paint();

  (root as HTMLElement & { destroy?: () => void }).destroy = () => {
    disposed = true;
    if (frameId !== null) window.cancelAnimationFrame(frameId);
    unsubscribeLevels();
    unsubscribeStore();
    meter.destroy();
  };

  return root;
}
