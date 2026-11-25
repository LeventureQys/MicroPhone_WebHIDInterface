import type { ParamSpec } from '../../domain/params';
import type { AppState, AppStore } from '../../domain/state';
import { t } from '../../i18n';
import { paramSlider, setResetDisabled, setSliderValue, setSwitchChecked, switchControl } from '../controls';

export interface ParamFields {
  nodes: HTMLElement[];
  sync: (state: AppState) => void;
}

/** 布尔开关：寄存器表里 min 0 / max 1 / step 1 的项就是二值项 */
export function isBooleanSpec(spec: ParamSpec): boolean {
  return spec.min === 0 && spec.max === 1 && spec.step === 1;
}

/** 批量构建参数控件（布尔项出开关，其余出滑杆），并返回统一回填函数 */
export function createParamFields(store: AppStore, specs: readonly ParamSpec[]): ParamFields {
  const mapping = new Map<string, HTMLElement>();
  const switches = new Set<string>();
  const nodes = specs.map((spec) => {
    if (isBooleanSpec(spec)) {
      const node = switchControl({
        checked: (store.get().params[spec.id] ?? 0) === 1,
        label: t(`param.${spec.id}.label`),
        onChange: (checked) => store.setParam(spec.id, checked ? 1 : 0),
        reset: {
          onClick: () => store.restoreParam(spec.id),
          disabled: store.isParamAtSceneTarget(spec.id),
        },
      });
      // 与 paramSlider 对齐：每张控件都带 data-param，自动化与验收脚本按 id 定位
      node.dataset.param = spec.id;
      node.querySelector<HTMLButtonElement>('.param-reset')?.setAttribute('data-reset-param', spec.id);
      mapping.set(spec.id, node);
      switches.add(spec.id);
      return node;
    }
    const node = paramSlider(spec, {
      value: store.get().params[spec.id] ?? spec.default,
      onInput: (value) => store.setParam(spec.id, value),
      reset: {
        onClick: () => store.restoreParam(spec.id),
        disabled: store.isParamAtSceneTarget(spec.id),
      },
    });
    mapping.set(spec.id, node);
    node.querySelector<HTMLButtonElement>('.param-reset')?.setAttribute('data-reset-param', spec.id);
    return node;
  });

  const sync = (state: AppState): void => {
    for (const spec of specs) {
      const node = mapping.get(spec.id);
      if (!node) continue;
      if (switches.has(spec.id)) {
        setSwitchChecked(node, (state.params[spec.id] ?? 0) === 1);
        setResetDisabled(node, store.isParamAtSceneTarget(spec.id), spec.id);
        continue;
      }
      setSliderValue(node, spec, state.params[spec.id] ?? spec.default);
      setResetDisabled(node, store.isParamAtSceneTarget(spec.id), spec.id);
    }
  };

  return { nodes, sync };
}
