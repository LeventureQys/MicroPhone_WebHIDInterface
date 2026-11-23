import { paramsOf } from '../../domain/params';
import type { AppState, AppStore } from '../../domain/state';
import { t } from '../../i18n';
import { card, segmented, setSegmentedValue, setSwitchChecked, switchControl } from '../controls';
import { createParamFields } from './param-list';

function hint(text: string): HTMLElement {
  const note = document.createElement('p');
  note.className = 'macro-hint';
  note.textContent = text;
  return note;
}

export function createInputView(store: AppStore): HTMLElement {
  const root = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'panel-grid';

  const state = store.get();

  // 噪声门：V0.3 参数表补了模块使能位 0x2074，开关就是真正的旁通（直通），
  // 不再像 2026-11-13 那版把阈值钉到 -91 dB 来近似。
  const gateCard = card({
    title: t('module.noisegate'),
    desc: t('module.noisegate.desc'),
  });
  const gateEnable = switchControl({
    checked: (state.params['noisegate.Enable'] ?? 0) === 1,
    label: t('param.noisegate.Enable.label'),
    onChange: (checked) => store.setParam('noisegate.Enable', checked ? 1 : 0),
  });
  gateEnable.classList.add('module-bypass');
  gateEnable.dataset.enable = 'noisegate';
  gateEnable.dataset.param = 'noisegate.Enable';
  const gateFields = createParamFields(
    store,
    paramsOf('noisegate').filter((spec) => spec.id !== 'noisegate.Enable'),
  );
  // 问题单 2026-11-21 第 11 条：用户以为"少了一个压缩比"，其实 0x205C 的 ratio 一直在，
  // 只是名字叫「扩展比」、值域 0.05–0.999 不像常见的 4:1，所以卡片上要写清它怎么用
  gateCard.body.append(gateEnable, hint(t('module.noisegate.bypassHint')), ...gateFields.nodes, hint(t('module.noisegate.ratioHint')));

  // 环境降噪：`enc.OnOff` 就是真正的使能位，关闭时档位不可操作
  const encCard = card({
    title: t('module.enc'),
    desc: t('module.enc.desc'),
  });
  const onOffSpec = paramsOf('enc').find((spec) => spec.field === 'OnOff');
  const levelSpec = paramsOf('enc').find((spec) => spec.field === 'Level');

  const encSwitch = switchControl({
    checked: (state.params['enc.OnOff'] ?? 0) === 1,
    label: t('param.enc.OnOff.label'),
    onChange: (checked) => store.setParam('enc.OnOff', checked ? 1 : 0),
  });
  encSwitch.dataset.param = onOffSpec?.id ?? 'enc.OnOff';
  encCard.body.append(encSwitch);

  let levelNode: HTMLElement | null = null;
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
    levelNode.dataset.param = levelSpec.id;
    levelLabel.append(levelNode);
    encCard.body.append(levelLabel);
  }

  grid.append(gateCard.root, encCard.root);
  root.append(grid);

  const sync = (next: AppState): void => {
    gateFields.sync(next);
    setSwitchChecked(gateEnable, (next.params['noisegate.Enable'] ?? 0) === 1);

    setSwitchChecked(encSwitch, (next.params['enc.OnOff'] ?? 0) === 1);
    if (levelSpec && levelNode) {
      setSegmentedValue(levelNode, next.params[levelSpec.id] ?? 1);
      const off = (next.params['enc.OnOff'] ?? 0) !== 1;
      for (const button of levelNode.querySelectorAll<HTMLButtonElement>('.seg-btn')) {
        button.disabled = off;
      }
      levelNode.classList.toggle('is-disabled', off);
    }
  };

  sync(state);
  const unsubscribe = store.onChange(sync);

  (root as HTMLElement & { destroy?: () => void }).destroy = () => unsubscribe();

  return root;
}
