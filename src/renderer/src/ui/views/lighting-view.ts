import { paramsOf } from '../../domain/params';
import type { AppState, AppStore } from '../../domain/state';
import { t } from '../../i18n';
import { card } from '../controls';
import { createParamFields } from './param-list';

/**
 * 灯效（参数表 V0.3 新增 `0x2072` RGB 开关 / `0x2073` RGB 模式）。
 *
 * 两项都直接读写协议位：开关出开关控件，模式出滑杆，
 * 由 `createParamFields` 按寄存器范围决定控件形态，这里不做本地派生。
 */
export function createLightingView(store: AppStore): HTMLElement {
  const root = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'panel-grid';

  const rgbCard = card({ title: t('module.rgb'), desc: t('module.rgb.desc') });
  const fields = createParamFields(store, paramsOf('rgb'));
  const hint = document.createElement('p');
  hint.className = 'macro-hint';
  hint.textContent = t('module.rgb.hint');
  rgbCard.body.append(...fields.nodes, hint);

  grid.append(rgbCard.root);
  root.append(grid);

  const sync = (next: AppState): void => fields.sync(next);

  sync(store.get());
  const unsubscribe = store.onChange(sync);

  (root as HTMLElement & { destroy?: () => void }).destroy = () => unsubscribe();

  return root;
}
