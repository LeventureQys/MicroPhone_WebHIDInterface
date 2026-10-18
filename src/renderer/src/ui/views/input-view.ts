import { paramsOf } from '../../domain/params';
import type { AppStore } from '../../domain/state';
import { t } from '../../i18n';
import { card, readonlyField, segmented, switchControl } from '../controls';
import { createParamFields } from './param-list';

export function createInputView(store: AppStore): HTMLElement {
  const root = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'panel-grid';

  const state = store.get();

  // 增益（只读）
  const gainCard = card({
    eyebrow: 'INPUT / GAIN',
    title: t('module.gain'),
    tag: 'READ ONLY',
    desc: t('module.gain.desc'),
  });
  for (const spec of paramsOf('gain')) {
    gainCard.body.append(readonlyField(spec, state.params[spec.id] ?? spec.default));
  }

  // 噪声门
  const gateCard = card({
    eyebrow: 'INPUT / GATE',
    title: t('module.noisegate'),
    tag: '6 PARAMS',
    desc: t('module.noisegate.desc'),
  });
  const gateFields = createParamFields(store, paramsOf('noisegate'));
  gateCard.body.append(...gateFields.nodes);

  // 环境降噪
  const encCard = card({
    eyebrow: 'INPUT / ENC',
    title: t('module.enc'),
    tag: '2 PARAMS',
    desc: t('module.enc.desc'),
  });
  const onOffSpec = paramsOf('enc').find((spec) => spec.field === 'OnOff');
  const levelSpec = paramsOf('enc').find((spec) => spec.field === 'Level');

  if (onOffSpec) {
    encCard.body.append(
      switchControl({
        checked: (state.params[onOffSpec.id] ?? 0) === 1,
        label: t(`param.${onOffSpec.id}.label`),
        onChange: (checked) => store.setParam(onOffSpec.id, checked ? 1 : 0),
      }),
    );
  }

  if (levelSpec) {
    const levelLabel = document.createElement('div');
    levelLabel.className = 'pfield';
    const head = document.createElement('div');
    head.className = 'pfield-head';
    const label = document.createElement('span');
    label.className = 'pfield-label';
    label.textContent = t(`param.${levelSpec.id}.label`);
    head.append(label);
    levelLabel.append(head);
    levelLabel.append(
      segmented<number>({
        options: [
          { value: 0, label: t('common.off') },
          { value: 1, label: '1' },
          { value: 2, label: '2' },
          { value: 3, label: '3' },
        ],
        value: state.params[levelSpec.id] ?? 1,
        onChange: (value) => store.setParam(levelSpec.id, value),
      }),
    );
    encCard.body.append(levelLabel);
  }

  grid.append(gainCard.root, gateCard.root, encCard.root);
  root.append(grid);

  store.onChange((next) => {
    gateFields.sync(next);
  });

  return root;
}
