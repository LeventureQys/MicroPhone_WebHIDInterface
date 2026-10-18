// 双语取证：点顶栏语言分段切到英文
(() => {
  const button = document.querySelector('.segmented--lang .seg-btn[data-value="en"]');
  if (!button) return 'lang-button-missing';
  button.click();
  return 'lang-en';
})();
