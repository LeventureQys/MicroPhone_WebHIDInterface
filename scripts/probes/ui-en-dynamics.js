// 英文长文案取证 2：切英文后停在动态页（Comp/Limit 参数标签最长）
(() => {
  const lang = document.querySelector('.segmented--lang .seg-btn[data-value="en"]');
  if (!lang) return 'lang-missing';
  lang.click();
  document.querySelector('.nav-item[data-route="dynamics"]')?.click();
  return 'en-dynamics';
})();
