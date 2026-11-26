import { t } from '../i18n';
import { icon } from './icons';

export interface ConfirmDialogOptions {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** 图标语气：warn（默认，黄色警示）/ danger（红色）/ accent（橙色） */
  readonly tone?: 'warn' | 'danger' | 'accent';
}

/**
 * 应用内确认弹窗：居中、深色面板、橙色主按钮，和抽屉/卡片同一套 token。
 *
 * 不用 `window.confirm`：Electron 原生对话框由系统绘制，浅色、字体和间距都跟
 * 应用不一致，在一屏深色工作台里显得很突兀（2026-11-25 用户反馈"画的很丑"）。
 *
 * 行为：Esc / 点遮罩 / 取消 → false；确定 → true；关闭后焦点回到触发按钮。
 */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement as HTMLElement | null;

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const dialog = document.createElement('section');
    dialog.className = 'confirm';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', options.title);

    const head = document.createElement('div');
    head.className = 'confirm-head';

    const badge = document.createElement('div');
    badge.className = `confirm-icon confirm-icon--${options.tone ?? 'warn'}`;
    badge.append(icon('alert', 18));

    const copy = document.createElement('div');
    copy.className = 'confirm-copy';
    const title = document.createElement('h2');
    title.className = 'confirm-title';
    title.textContent = options.title;
    const message = document.createElement('p');
    message.className = 'confirm-message';
    message.textContent = options.message;
    copy.append(title, message);
    head.append(badge, copy);

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn--ghost';
    cancel.textContent = options.cancelLabel ?? t('common.cancel');

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn--primary';
    confirm.textContent = options.confirmLabel ?? t('common.confirm');

    actions.append(cancel, confirm);
    dialog.append(head, actions);
    overlay.append(dialog);

    let settled = false;
    // 弹窗是同步插入的：双击「复位」时第二下会正好落在遮罩上，被当成"点遮罩取消"。
    // 刚打开的一小段时间内忽略遮罩点击，双击就只算一次。
    const openedAt = Date.now();
    const close = (value: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.removeEventListener('mousedown', onOverlay);
      overlay.remove();
      previousFocus?.focus?.();
      resolve(value);
    };

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(false);
        return;
      }
      if (event.key !== 'Tab') return;
      // 只有两个可聚焦按钮：Tab 在它们之间循环，别让焦点跑到底下的工作台
      const first = cancel;
      const last = confirm;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const onOverlay = (event: MouseEvent): void => {
      if (Date.now() - openedAt < 250) return;
      if (event.target === overlay) close(false);
    };

    cancel.addEventListener('click', () => close(false));
    confirm.addEventListener('click', () => close(true));
    overlay.addEventListener('mousedown', onOverlay);
    document.addEventListener('keydown', onKey, true);

    document.body.append(overlay);
    // 默认焦点放"取消"：误按 Enter 不会直接清掉场景
    cancel.focus();
  });
}
