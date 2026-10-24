import { paramsOf, type ParamSpec } from '../../domain/params';
import type { AppState, AppStore } from '../../domain/state';
import { formatValue } from '../../domain/values';
import { t } from '../../i18n';
import {
  card,
  readonlyField,
  segmented,
  setSegmentedValue,
  setSwitchChecked,
  switchControl,
} from '../controls';
import { createParamFields } from './param-list';

/** 布尔开关：寄存器表里 min 0 / max 1 / step 1 的项就是二值项 */
function isBooleanSpec(spec: ParamSpec): boolean {
  return spec.min === 0 && spec.max === 1 && spec.step === 1;
}

function readoutOf(node: HTMLElement): HTMLElement | null {
  return node.querySelector<HTMLElement>('.pfield-readout strong');
}

export function createInputView(store: AppStore): HTMLElement {
  const root = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'panel-grid';

  const state = store.get();

  // 增益卡：`gain` 模块共 5 项——Mic/Hp 增益只读，静音 / 信号静音 / 监听 3 项可写。
  // 3.2 之前整卡按只读渲染，导致这 3 个可写项在抽屉里既没有控件也点不动（§4.12）
  const gainSpecs = paramsOf('gain');
  const gainCard = card({
    eyebrow: 'INPUT / GAIN',
    title: t('module.gain'),
    tag: `${gainSpecs.length} PARAMS`,
    desc: t('module.gain.desc'),
  });

  const booleanSpecs = gainSpecs.filter((spec) => !spec.readonly && isBooleanSpec(spec));
  const sliderSpecs = gainSpecs.filter((spec) => !spec.readonly && !isBooleanSpec(spec));

  const gainFields = createParamFields(store, sliderSpecs);
  const sliderById = new Map(sliderSpecs.map((spec, index) => [spec.id, gainFields.nodes[index]]));

  const switchById = new Map<string, HTMLElement>();
  for (const spec of booleanSpecs) {
    const node = switchControl({
      checked: (state.params[spec.id] ?? 0) === 1,
      label: t(`param.${spec.id}.label`),
      onChange: (checked) => store.setParam(spec.id, checked ? 1 : 0),
    });
    // 与 paramSlider 对齐：每张控件都带 data-param，自动化与验收脚本按 id 定位
    node.dataset.param = spec.id;
    switchById.set(spec.id, node);
  }

  const readonlyById = new Map<string, { spec: ParamSpec; node: HTMLElement; readout: HTMLElement | null }>();
  for (const spec of gainSpecs) {
    if (!spec.readonly) continue;
    const node = readonlyField(spec, state.params[spec.id] ?? spec.default);
    readonlyById.set(spec.id, { spec, node, readout: readoutOf(node) });
  }

  // 按 paramsOf('gain') 的声明顺序落位，保持与寄存器表行序一致
  for (const spec of gainSpecs) {
    const node = readonlyById.get(spec.id)?.node ?? switchById.get(spec.id) ?? sliderById.get(spec.id);
    if (node) gainCard.body.append(node);
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

  let switchNode: HTMLElement | null = null;
  let levelNode: HTMLElement | null = null;

  if (onOffSpec) {
    switchNode = switchControl({
      checked: (state.params[onOffSpec.id] ?? 0) === 1,
      label: t(`param.${onOffSpec.id}.label`),
      onChange: (checked) => store.setParam(onOffSpec.id, checked ? 1 : 0),
    });
    encCard.body.append(switchNode);
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
    // 协议里 Level 0–3 是四个档位，0 不等于「关闭」；关闭由上面的 OnOff 控制
    levelNode = segmented<number>({
      options: [0, 1, 2, 3].map((value) => ({ value, label: String(value) })),
      value: state.params[levelSpec.id] ?? 1,
      onChange: (value) => store.setParam(levelSpec.id, value),
    });
    levelLabel.append(levelNode);
    encCard.body.append(levelLabel);
  }

  // 均衡器模式（`eq.mode` / `0x2026`）：42 项里此前唯一没有控件入口的参数，补成一张小卡，
  // 否则用户只能在设备上切模式（验收 A20）
  const eqModeSpec = paramsOf('eq').find((spec) => spec.field === 'mode');
  let modeNode: HTMLElement | null = null;
  let modeCard: HTMLElement | null = null;

  if (eqModeSpec) {
    const built = card({
      eyebrow: 'INPUT / EQ MODE',
      title: t('module.eq'),
      tag: '1 PARAM',
      desc: t('module.eq.desc'),
    });
    const modeField = document.createElement('div');
    modeField.className = 'pfield';
    const head = document.createElement('div');
    head.className = 'pfield-head';
    const label = document.createElement('span');
    label.className = 'pfield-label';
    label.textContent = t(`param.${eqModeSpec.id}.label`);
    head.append(label);
    // 协议里模式是 0–4 的枚举，取值语义未定，按原始档位展示（与 ENC 档位同一处理）
    modeNode = segmented<number>({
      options: [0, 1, 2, 3, 4].map((value) => ({ value, label: String(value) })),
      value: state.params[eqModeSpec.id] ?? 0,
      onChange: (value) => store.setParam(eqModeSpec.id, value),
    });
    modeNode.dataset.param = eqModeSpec.id;
    modeField.append(head, modeNode);
    built.body.append(modeField);
    modeCard = built.root;
  }

  const cards: HTMLElement[] = [gainCard.root, gateCard.root, encCard.root];
  if (modeCard) cards.push(modeCard);
  grid.append(...cards);
  root.append(grid);

  const sync = (next: AppState): void => {
    gateFields.sync(next);
    gainFields.sync(next);
    for (const [id, node] of switchById) {
      setSwitchChecked(node, (next.params[id] ?? 0) === 1);
    }
    for (const [id, entry] of readonlyById) {
      if (!entry.readout) continue;
      entry.readout.textContent = formatValue(entry.spec, next.params[id] ?? entry.spec.default);
    }
    if (onOffSpec && switchNode) {
      setSwitchChecked(switchNode, (next.params[onOffSpec.id] ?? 0) === 1);
    }
    if (levelSpec && levelNode) {
      setSegmentedValue(levelNode, next.params[levelSpec.id] ?? 1);
    }
    if (eqModeSpec && modeNode) {
      setSegmentedValue(modeNode, next.params[eqModeSpec.id] ?? 0);
    }
  };

  const unsubscribe = store.onChange(sync);

  (root as HTMLElement & { destroy?: () => void }).destroy = () => unsubscribe();

  return root;
}
