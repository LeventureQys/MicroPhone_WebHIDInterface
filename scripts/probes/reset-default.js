// 恢复默认取证：改两处参数 → 设置页复位 → 回 EQ 检查是否归零
(() => {
  const setRange = (param, value) => {
    const field = document.querySelector(`[data-param="${param}"]`);
    if (!field) return false;
    const range = field.querySelector('.pfield-range');
    const number = field.querySelector('.pfield-number');
    if (range) {
      range.value = String(value);
      range.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (number) {
      number.value = String(value);
      number.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  };
  const backToInput = document.querySelector('.nav-item[data-route="input"]');
  const backToEq = document.querySelector('.nav-item[data-route="eq"]') ?? document.querySelector('.nav-item[data-route="equalizer"]');
  const toSettings = document.querySelector('.nav-item[data-route="settings"]');

  backToInput?.click();
  setRange('noisegate.threshold_db', -40);

  const navEq = Array.from(document.querySelectorAll('.nav-item'))[2];
  navEq?.click();
  const row = document.querySelector('.eq-row[data-band="2"]');
  if (row) {
    const inputs = row.querySelectorAll('input.eq-input');
    if (inputs[1]) {
      inputs[1].value = '8';
      inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  toSettings?.click();
  const resetButton = Array.from(document.querySelectorAll('.btn')).find((button) =>
    /复位|Reset/i.test(button.textContent ?? ''),
  );
  resetButton?.click();

  const navEq2 = Array.from(document.querySelectorAll('.nav-item'))[2];
  navEq2?.click();
  const rowAfter = document.querySelector('.eq-row[data-band="2"]');
  const gainAfter = rowAfter ? rowAfter.querySelectorAll('input.eq-input')[1]?.value : 'missing';
  return `reset: eq-gain=${gainAfter} button=${Boolean(resetButton)}`;
})();
