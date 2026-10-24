// 取证：设置抽屉「通道」卡的渲染值 + localStorage 持久化内容（只读，不改配置）
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
  const node = (name) => document.querySelector('[data-field="' + name + '"]');
  const value = (name) => (node(name) ? node(name).value : null);

  const storage = {};
  for (const key of KEYS) storage[key] = localStorage.getItem(key);

  return JSON.stringify({
    lang: localStorage.getItem('micstudio.lang'),
    controls: Array.from(document.querySelectorAll('[data-channel-control]')).map((item) =>
      item.getAttribute('data-channel-control'),
    ),
    activeKind: document
      .querySelector('[data-channel-control="kind"] .seg-btn.is-active')
      ?.getAttribute('data-value'),
    bridgeUrl: value('bridgeUrl'),
    reportIdOut: value('reportIdOut'),
    reportIdIn: value('reportIdIn'),
    whitelist: value('whitelist'),
    vids: value('vids'),
    pids: value('pids'),
    diagLimit: value('diagLimit'),
    storage,
  });
})();
