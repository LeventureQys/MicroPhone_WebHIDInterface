// 取证：在设置抽屉里改通道卡的四项配置（走真实 DOM 事件，等价用户操作）
(() => {
  const setText = (name, text) => {
    const node = document.querySelector('[data-field="' + name + '"]');
    if (!node) return;
    node.value = text;
    node.dispatchEvent(new Event('change'));
  };

  document.querySelector('[data-channel-control="kind"] .seg-btn[data-value="virtual"]')?.click();
  setText('bridgeUrl', 'ws://127.0.0.1:9000/ws');
  setText('reportIdOut', '0x50');
  setText('reportIdIn', '0x10');
  setText('whitelist', '0xFF01:1');
  setText('vids', '0x352F');
  document.querySelector('[data-channel-control="vidpid"] input[type="checkbox"]')?.click();
  setText('diagLimit', '800');

  const KEYS = [
    'micstudio.channel',
    'micstudio.bridgeUrl',
    'micstudio.reportId.out',
    'micstudio.reportId.in',
    'micstudio.whitelist',
    'micstudio.whitelist.useVidPid',
    'micstudio.diagLimit',
  ];
  const storage = {};
  for (const key of KEYS) storage[key] = localStorage.getItem(key);

  return JSON.stringify({
    status: document.querySelector('.channel-status')?.textContent ?? null,
    firstControl: document.querySelector('[data-channel-control="report"] [data-field="reportIdOut"]')?.value,
    storage,
  });
})();
