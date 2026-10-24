// 取证：切到英文后重新打开设置抽屉（切语言会重建界面并关掉抽屉）
(() => {
  document.querySelector('.topbar .segmented--lang .seg-btn[data-value="en"]')?.click();
  window.__micstudioGo?.('settings');
  return JSON.stringify({
    lang: localStorage.getItem('micstudio.lang'),
    titles: Array.from(document.querySelectorAll('.card-title')).map((item) => item.textContent),
  });
})();
