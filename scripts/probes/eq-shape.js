// EQ 交互取证：通过 DOM 事件模拟用户改段增益 / Q，验证曲线重算与列表同步
(() => {
  const rows = document.querySelectorAll('.eq-row[data-band]');
  const setNumber = (input, value) => {
    if (!input) return;
    input.value = String(value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const gain = (index, value) => {
    const row = rows[index];
    if (!row) return;
    setNumber(row.querySelectorAll('input.eq-input')[1], value);
  };
  const q = (index, value) => {
    const row = rows[index];
    if (!row) return;
    setNumber(row.querySelectorAll('input.eq-input')[2], value);
  };

  gain(0, 4);
  gain(1, 2.5);
  gain(2, -6);
  q(2, 4);
  gain(4, 5);
  q(6, 1.4);
  gain(6, 3);
  return 'eq-shaped';
})();
