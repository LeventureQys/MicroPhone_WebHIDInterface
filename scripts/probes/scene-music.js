// 电平场景取证：切到「音乐」场景
(() => {
  const buttons = Array.from(document.querySelectorAll('.view--meter .seg-btn'));
  const music = buttons.find((button) => button.dataset.value === 'music');
  if (!music) return 'scene-button-missing';
  music.click();
  return 'scene-music';
})();
