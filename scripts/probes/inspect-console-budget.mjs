/**
 * 版式预算取证：一屏工作台在 1266×783 下还剩多少纵向余量（改中栏控件前先跑一遍）。
 *
 *   node scripts/probes/inspect-console-budget.mjs
 *
 * 输出：
 *   - `scrollable`：`.console-middle` 第一张卡的 `clientHeight / scrollHeight`，
 *     `scroll=true` 说明已经溢出（会出现内部滚动条，或者控件压到下面的卡上）；
 *   - `inputs`：三个输入开关的位置（它们是最容易被挤下去的一组）；
 *   - `labels`：快捷开关两列的标签是否被省略号截断（英文 `Noise cancellation` 会先顶不住）；
 *   - `modeWidths`：灯效 0–7 模式每个 chip 的实际宽度（窄列下最小约 11 px）；
 *   - `sceneRow`：场景按钮与「复位」按钮的高度（必须一致）。
 *
 * 2026-11-22 这一轮就是靠它把「灯效」压进两列、把 `.tune-grid` 间距收紧到不出滚动条。
 */
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { Cdp, findPageTarget, killApp, launchApp, repo, wait, waitReady } from './lib/cdp.mjs';

const profile = path.join(repo, 'artifacts', 'tmp-inspect-budget');
const port = 9385;

const STATE = `(() => {
  const body = document.querySelector('.console-middle > .card:first-child > .card-body');
  const inputs = document.querySelector('.tune-switch-grid');
  const rect = (node) => node ? { top: Math.round(node.getBoundingClientRect().top), bottom: Math.round(node.getBoundingClientRect().bottom) } : null;
  return JSON.stringify({
    viewport: { w: innerWidth, h: innerHeight },
    scrollable: body ? { clientHeight: body.clientHeight, scrollHeight: body.scrollHeight, scroll: body.scrollHeight > body.clientHeight + 1 } : null,
    inputs: rect(inputs),
    tuneCardBody: rect(body),
    labels: Array.from(document.querySelectorAll('.switch-item .switch-label')).map((node) => ({
      text: node.textContent,
      clipped: node.scrollWidth > node.clientWidth + 1,
    })),
    modeWidths: Array.from(document.querySelectorAll('.segmented--modes .seg-btn')).map((node) => Math.round(node.getBoundingClientRect().width)),
    sceneRow: Array.from(document.querySelectorAll('.scene-btn, .scene-reset')).map((node) => Math.round(node.getBoundingClientRect().height)),
  });
})()`;

const child = launchApp({ profile, port, width: 1280, height: 820 });
let cdp = null;
try {
  const target = await findPageTarget(port);
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
  await waitReady(cdp);
  await wait(1800);
  console.log('ZH', JSON.stringify(await cdp.json(STATE)));
  let shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, 10_000);
  writeFileSync(path.join(repo, 'artifacts', 'inspect-console-budget-zh.png'), Buffer.from(shot.data, 'base64'));

  await cdp.evaluate(`(() => { const button = Array.from(document.querySelectorAll('.seg-btn')).find((node) => node.textContent === 'EN'); button?.click(); return true; })()`);
  await wait(1200);
  console.log('EN', JSON.stringify(await cdp.json(STATE)));
  shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, 10_000);
  writeFileSync(path.join(repo, 'artifacts', 'inspect-console-budget-en.png'), Buffer.from(shot.data, 'base64'));
} finally {
  cdp?.close();
  killApp(child);
}
