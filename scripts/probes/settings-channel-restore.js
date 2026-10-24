// 取证收尾：清掉本次写入的通道配置、语言回到中文，再打开设置抽屉确认回到默认值
(() => {
  const KEYS = [
    'micstudio.channel',
    'micstudio.bridgeUrl',
    'micstudio.reportId.out',
    'micstudio.reportId.in',
    'micstudio.whitelist',
    'micstudio.whitelist.useVidPid',
    'micstudio.diagLimit',
  ];
  for (const key of KEYS) localStorage.removeItem(key);
  document.querySelector('.topbar .segmented--lang .seg-btn[data-value="zh"]')?.click();
  window.__micstudioGo?.('settings');

  const node = (name) => document.querySelector('[data-field="' + name + '"]');
  return JSON.stringify({
    lang: localStorage.getItem('micstudio.lang'),
    remaining: KEYS.filter((key) => localStorage.getItem(key) !== null),
    bridgeUrl: node('bridgeUrl') ? node('bridgeUrl').value : null,
    diagLimit: node('diagLimit') ? node('diagLimit').value : null,
  });
})();
