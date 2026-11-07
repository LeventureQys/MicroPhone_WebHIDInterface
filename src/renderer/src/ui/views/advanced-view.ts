import type { AppStore } from '../../domain/state';
import { t } from '../../i18n';
import { createDrcView } from './drc-view';
import { createDynamicsView } from './dynamics-view';
import { createEqBandTable } from './eq-band-table';
import { createInputView } from './input-view';

type ViewFactory = () => HTMLElement;

interface Section {
  id: string;
  title: string;
  desc: string;
  build: ViewFactory;
}

/**
 * 判定"当前分区"的基准线：跳转条高度 + 分区的 scroll-margin-top（70 px）再留一点余量，
 * 否则点了跳转、分区刚好停在线下面，高亮会落在上一节
 */
const NAV_OFFSET_PX = 100;

/**
 * 高级参数抽屉：把原先分散在四个页面的协议参数按"输入 / 动态 / 均衡 / 分频"
 * 竖排到同一个可滚动面板里，顶部一条跳转条，用户不用在长列表里翻找。
 */
export function createAdvancedView(store: AppStore): HTMLElement {
  const root = document.createElement('div');
  root.className = 'advanced-view';

  const sections: Section[] = [
    {
      id: 'input',
      title: t('advanced.section.input'),
      desc: t('advanced.section.input.desc'),
      build: () => createInputView(store),
    },
    {
      id: 'dynamics',
      title: t('advanced.section.dynamics'),
      desc: t('advanced.section.dynamics.desc'),
      build: () => createDynamicsView(store),
    },
    {
      id: 'eq',
      title: t('advanced.section.eq'),
      desc: t('advanced.section.eq.desc'),
      build: () => createEqBandTable(store),
    },
    {
      id: 'drc',
      title: t('advanced.section.drc'),
      desc: t('advanced.section.drc.desc'),
      build: () => createDrcView(store),
    },
  ];

  const disposers: Array<() => void> = [];

  const nav = document.createElement('nav');
  nav.className = 'advanced-nav';
  nav.setAttribute('aria-label', t('advanced.nav'));
  root.append(nav);

  const anchors: Array<{ section: HTMLElement; link: HTMLButtonElement }> = [];

  const setActive = (index: number): void => {
    anchors.forEach((entry, i) => {
      entry.link.classList.toggle('is-active', i === index);
      entry.link.setAttribute('aria-current', i === index ? 'true' : 'false');
    });
  };

  for (const section of sections) {
    const wrap = document.createElement('section');
    wrap.className = 'advanced-section';
    wrap.dataset.section = section.id;

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

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'advanced-nav-link';
    link.textContent = section.title;
    const index = anchors.length;
    link.addEventListener('click', () => {
      setActive(index);
      wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    nav.append(link);
    anchors.push({ section: wrap, link });
  }
  setActive(0);

  // 滚动容器是抽屉的 .modal-body（挂载后才知道）：scroll 不冒泡，用捕获阶段在 document 上统一收
  let frame: number | null = null;
  const onScroll = (event: Event): void => {
    const scroller = event.target as HTMLElement | null;
    if (!scroller || typeof scroller.contains !== 'function' || !scroller.contains(root)) return;
    if (frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      const top = scroller.getBoundingClientRect().top + NAV_OFFSET_PX;
      // 滚到底时最后一节可能永远到不了顶部，直接判给它
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      let current = 0;
      anchors.forEach((entry, i) => {
        if (entry.section.getBoundingClientRect().top <= top) current = i;
      });
      setActive(atEnd ? anchors.length - 1 : current);
    });
  };
  document.addEventListener('scroll', onScroll, true);

  (root as HTMLElement & { destroy?: () => void }).destroy = () => {
    document.removeEventListener('scroll', onScroll, true);
    if (frame !== null) window.cancelAnimationFrame(frame);
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
