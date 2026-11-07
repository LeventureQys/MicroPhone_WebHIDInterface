import { icon } from './icons';

export interface ModalOptions {
  title: string;
  subtitle?: string;
  content: HTMLElement;
  /** wide = 高级参数；medium = 设备 / 设置；narrow = 固件升级 */
  size?: 'narrow' | 'medium' | 'wide';
}

export interface ModalHandle {
  root: HTMLElement;
  close: () => void;
}

/**
 * 单实例抽屉：从右侧滑出，用于高级参数 / 设备 / 固件 / 设置。
 * 打开时不销毁底层界面，关闭后回到原来的状态与滚动位置；
 * 关闭是同步移除（没有退场动画），调用方关掉后立刻就能再开下一个。
 */
export function openModal(opts: ModalOptions): ModalHandle {
  const previousFocus = document.activeElement as HTMLElement | null;

  const root = document.createElement('div');
  root.className = 'modal-overlay';

  const panel = document.createElement('section');
  panel.className = `modal modal--${opts.size ?? 'medium'}`;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', opts.title);

  const head = document.createElement('header');
  head.className = 'modal-head';

  const textBox = document.createElement('div');
  textBox.className = 'modal-heading';
  const title = document.createElement('h2');
  title.className = 'modal-title';
  title.textContent = opts.title;
  textBox.append(title);
  if (opts.subtitle) {
    const subtitle = document.createElement('p');
    subtitle.className = 'modal-subtitle';
    subtitle.textContent = opts.subtitle;
    textBox.append(subtitle);
  }

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'modal-close';
  closeButton.setAttribute('aria-label', 'close');
  closeButton.append(icon('close', 18));

  head.append(textBox, closeButton);

  const body = document.createElement('div');
  body.className = 'modal-body';
  body.append(opts.content);

  panel.append(head, body);
  root.append(panel);

  let closed = false;
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    (opts.content as HTMLElement & { destroy?: () => void }).destroy?.();
    root.remove();
    previousFocus?.focus?.();
  };

  closeButton.addEventListener('click', close);
  root.addEventListener('mousedown', (event) => {
    if (event.target === root) close();
  });
  document.addEventListener('keydown', onKey);

  document.body.append(root);
  closeButton.focus();

  return { root, close };
}
