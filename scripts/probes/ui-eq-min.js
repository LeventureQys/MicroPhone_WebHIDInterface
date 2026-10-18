// EQ 满衰减取证：7 段全部 -32 dB、Q 0.1，检查曲线贴底与数值宽度
(() => {
  document.querySelector('.nav-item[data-route="eq"]')?.click();
  const rows = document.querySelectorAll('.eq-row[data-band]');
  rows.forEach((row) => {
    const inputs = row.querySelectorAll('input.eq-input');
    if (inputs[1]) {
      inputs[1].value = '-32';
      inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (inputs[2]) {
      inputs[2].value = '0.1';
      inputs[2].dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  return `eq-min rows=${rows.length}`;
})();
