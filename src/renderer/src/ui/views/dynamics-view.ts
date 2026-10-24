import { paramsOf } from '../../domain/params';
import type { AppStore } from '../../domain/state';
import { t } from '../../i18n';
import { card } from '../controls';
import { createParamFields } from './param-list';

export function createDynamicsView(store: AppStore): HTMLElement {
  const root = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'panel-grid';

  const compCard = card({
    eyebrow: 'DYNAMICS / COMP',
    title: t('module.comp'),
    tag: '6 PARAMS',
    desc: t('module.comp.desc'),
  });
  const compFields = createParamFields(store, paramsOf('comp'));
  compCard.body.append(...compFields.nodes);

  const limitCard = card({
    eyebrow: 'DYNAMICS / LIMIT',
    title: t('module.limit'),
    tag: '3 PARAMS',
    desc: t('module.limit.desc'),
  });
  const limitFields = createParamFields(store, paramsOf('limit'));
  limitCard.body.append(...limitFields.nodes);

  grid.append(compCard.root, limitCard.root);
  root.append(grid);

  const unsubscribe = store.onChange((next) => {
    compFields.sync(next);
    limitFields.sync(next);
  });

  (root as HTMLElement & { destroy?: () => void }).destroy = () => unsubscribe();

  return root;
}
