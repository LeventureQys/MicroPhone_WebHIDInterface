// 极值取证：把噪声门参数推到上下限，检查数字显示与滑块端点
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
  document.querySelector('.nav-item[data-route="input"]')?.click();
  const ok1 = setRange('noisegate.threshold_db', -91);
  const ok2 = setRange('noisegate.ratio', 0.999);
  const ok3 = setRange('noisegate.attack_ms', 500);
  const ok4 = setRange('noisegate.release_ms', 5);
  const ok5 = setRange('noisegate.knee_width_db', 6);
  const ok6 = setRange('noisegate.hp_freq', 200);
  return `extremes ok=${[ok1, ok2, ok3, ok4, ok5, ok6].filter(Boolean).length}`;
})();
