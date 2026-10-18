// 稳定性取证：六个页面往返 3 轮，检查视图节点数量与页面是否仍在
(() => {
  const routes = ['meter', 'input', 'eq', 'dynamics', 'drc', 'settings'];
  let clicks = 0;
  for (let round = 0; round < 3; round += 1) {
    for (const route of routes) {
      const button = document.querySelector(`.nav-item[data-route="${route}"]`);
      if (!button) return `missing-nav:${route}`;
      button.click();
      clicks += 1;
    }
  }
  const views = document.querySelectorAll('.view').length;
  const errors = document.querySelectorAll('.view-error').length;
  return `stability: clicks=${clicks} views=${views} errors=${errors}`;
})();
