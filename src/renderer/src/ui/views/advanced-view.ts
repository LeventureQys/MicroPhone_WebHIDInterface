import type { AppStore } from '../../domain/state';
import { t } from '../../i18n';
import { createDrcView } from './drc-view';
import { createDynamicsView } from './dynamics-view';
import { createEqBandTable } from './eq-band-table';
import { createInputView } from './input-view';

type ViewFactory = () => HTMLElement;

interface Section {
  title: string;
  desc: string;
  build: ViewFactory;
}

/**
 * 高级参数抽屉：把原先分散在四个页面的协议参数按"输入 / 动态 / 均衡 / 分频"
 * 竖排到同一个可滚动面板里，用户不用在页面之间来回跳。
 */
export function createAdvancedView(store: AppStore): HTMLElement {
  const root = document.createElement('div');
  root.className = 'advanced-view';

  const sections: Section[] = [
    {
      title: t('advanced.section.input'),
      desc: t('advanced.section.input.desc'),
      build: () => createInputView(store),
    },
    {
      title: t('advanced.section.dynamics'),
      desc: t('advanced.section.dynamics.desc'),
      build: () => createDynamicsView(store),
    },
    {
      title: t('advanced.section.eq'),
      desc: t('advanced.section.eq.desc'),
      build: () => createEqBandTable(store),
    },
    {
      title: t('advanced.section.drc'),
      desc: t('advanced.section.drc.desc'),
      build: () => createDrcView(store),
    },
  ];

  const disposers: Array<() => void> = [];

  for (const section of sections) {
    const wrap = document.createElement('section');
    wrap.className = 'advanced-section';

    const head = document.createElement('header');
    head.className = 'advanced-section-head';
    const title = document.createElement('h3');
    title.className = 'advanced-section-title';
    title.textContent = section.title;
    const desc = document.createElement('p');
    desc.className = 'advanced-section-desc';
    desc.textContent = section.desc;
    head.append(title, desc);

    const content = section.build();
    if (typeof (content as HTMLElement & { destroy?: () => void }).destroy === 'function') {
      disposers.push((content as HTMLElement & { destroy?: () => void }).destroy!);
    }

    wrap.append(head, content);
    root.append(wrap);
  }

  (root as HTMLElement & { destroy?: () => void }).destroy = () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        console.warn('[advanced] section dispose failed', error);
      }
    }
  };

  return root;
}
