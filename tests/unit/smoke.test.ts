import { describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';

describe('toolchain smoke', () => {
  it('runs arithmetic', () => {
    expect(1 + 1).toBe(2);
  });

  it('supports happy-dom documents', () => {
    const win = new Window();
    win.document.body.innerHTML = '<div id="x">ok</div>';
    expect(win.document.getElementById('x')?.textContent).toBe('ok');
  });
});
