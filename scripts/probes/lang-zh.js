// 截图取证：切到中文界面再抓图
(() => {
  localStorage.setItem('micstudio.lang', 'zh');
  document.querySelector('.topbar .segmented--lang .seg-btn[data-value="zh"]')?.click();
  return 'zh';
})();
