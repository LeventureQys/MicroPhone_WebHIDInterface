// EQ 满增益取证：7 段全部 +12 dB，检查曲线是否越界、节点是否贴边
(() => {
  document.querySelector('.nav-item[data-route="eq"]')?.click();
  const rows = document.querySelectorAll('.eq-row[data-band]');
  rows.forEach((row) => {
    const inputs = row.querySelectorAll('input.eq-input');
    if (inputs[1]) {
      inputs[1].value = '12';
      inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  return `eq-max rows=${rows.length}`;
})();
