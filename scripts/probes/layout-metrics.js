// 版式取证：输出一屏工作台/抽屉的关键元素边界，用来核对间距与是否溢出
(() => {
  const scope = document.querySelector('.console') || document.querySelector('.modal');
  const rect = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      w: Math.round(box.width),
      h: Math.round(box.height),
      bottom: Math.round(box.bottom),
    };
  };
  const host = document.querySelector('.console-host') || document.querySelector('.modal-body');
  const cards = [...document.querySelectorAll('.console .card')].map((node) => {
    const box = node.getBoundingClientRect();
    const title = node.querySelector('.card-title');
    return {
      title: title ? title.textContent : '',
      y: Math.round(box.y),
      h: Math.round(box.height),
      bottom: Math.round(box.bottom),
    };
  });
  return JSON.stringify({
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    host: rect(host),
    scope: rect(scope),
    scrollHeight: host?.scrollHeight ?? 0,
    cards,
  });
})();
