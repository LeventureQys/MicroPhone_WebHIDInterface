// 分频冲突取证：把 fc1 调到 6000 Hz（大于默认 fc2 3000 Hz），验证冲突提示
(() => {
  const field = document.querySelector('.view--drc [data-param="drc3.fc1"]');
  if (!field) return 'fc1-missing';
  const range = field.querySelector('.pfield-range');
  const number = field.querySelector('.pfield-number');
  if (range) {
    range.value = '6000';
    range.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (number) {
    number.value = '6000';
    number.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return 'drc-conflict';
})();
