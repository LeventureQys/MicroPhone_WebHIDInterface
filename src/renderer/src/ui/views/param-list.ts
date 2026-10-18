import type { ParamSpec } from '../../domain/params';
import { paramSlider, setSliderValue } from '../controls';
import type { AppState, AppStore } from '../../domain/state';

export interface ParamFields {
  nodes: HTMLElement[];
  sync: (state: AppState) => void;
}

/** 批量构建参数滑块，并返回统一回填函数，避免每个视图重复写映射表。 */
export function createParamFields(store: AppStore, specs: readonly ParamSpec[]): ParamFields {
  const mapping = new Map<string, HTMLElement>();
  const nodes = specs.map((spec) => {
    const node = paramSlider(spec, {
      value: store.get().params[spec.id] ?? spec.default,
      onInput: (value) => store.setParam(spec.id, value),
    });
    mapping.set(spec.id, node);
    return node;
  });

  const sync = (state: AppState): void => {
    for (const spec of specs) {
      const node = mapping.get(spec.id);
      if (!node) continue;
      setSliderValue(node, spec, state.params[spec.id] ?? spec.default);
    }
  };

  return { nodes, sync };
}
