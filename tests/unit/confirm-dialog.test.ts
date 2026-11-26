import { beforeEach, describe, expect, it } from 'vitest';
import { setLang } from '../../src/renderer/src/i18n';
import { confirmDialog } from '../../src/renderer/src/ui/confirm-dialog';

function open() {
  return confirmDialog({
    title: '复位「游戏」场景？',
    message: '这个场景保存的快速调音与音色改动会被清空，回到出厂预设。',
    confirmLabel: '确定复位',
  });
}

const primary = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('.confirm-actions .btn--primary');
const ghost = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('.confirm-actions .btn--ghost');

describe('confirm dialog', () => {
  beforeEach(() => {
    setLang('zh');
    document.body.innerHTML = '';
  });

  it('renders an app-styled centered dialog instead of window.confirm', async () => {
    const promise = open();
    const dialog = document.querySelector<HTMLElement>('.confirm');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(document.querySelector('.confirm-title')?.textContent).toBe('复位「游戏」场景？');
    expect(document.querySelector('.confirm-message')?.textContent).toContain('回到出厂预设');
    expect(primary()?.textContent).toBe('确定复位');
    expect(ghost()?.textContent).toBe('取消');
    // 默认焦点在取消上：误按 Enter 不会直接清掉场景
    expect(document.activeElement).toBe(ghost());

    ghost()?.click();
    await expect(promise).resolves.toBe(false);
    expect(document.querySelector('.confirm-overlay')).toBeNull();
  });

  it('resolves true when confirming and restores focus afterwards', async () => {
    const origin = document.createElement('button');
    origin.id = 'origin';
    document.body.append(origin);
    origin.focus();

    const promise = open();
    primary()?.click();
    await expect(promise).resolves.toBe(true);
    expect(document.querySelector('.confirm-overlay')).toBeNull();
    expect(document.activeElement).toBe(origin);
  });

  it('cancels on Escape and on a backdrop click', async () => {
    const escape = open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(escape).resolves.toBe(false);

    const backdrop = open();
    // 刚打开的一小段时间里忽略遮罩点击：双击「复位」的第二下正好落在遮罩上，
    // 不能把刚弹出来的确认框关掉
    document.querySelector<HTMLElement>('.confirm-overlay')?.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    );
    expect(document.querySelector('.confirm-overlay')).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 300));
    document.querySelector<HTMLElement>('.confirm-overlay')?.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    );
    await expect(backdrop).resolves.toBe(false);
  });

  it('does not close when the click starts inside the panel', async () => {
    const promise = open();
    document.querySelector<HTMLElement>('.confirm')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('.confirm-overlay')).not.toBeNull();
    primary()?.click();
    await expect(promise).resolves.toBe(true);
  });
});
