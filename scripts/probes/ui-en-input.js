// 英文长文案取证：切英文后停在输入页（ENC 卡文案最长）
(() => {
  const lang = document.querySelector('.segmented--lang .seg-btn[data-value="en"]');
  if (!lang) return 'lang-missing';
  lang.click();
  document.querySelector('.nav-item[data-route="input"]')?.click();
  return 'en-input';
})();
