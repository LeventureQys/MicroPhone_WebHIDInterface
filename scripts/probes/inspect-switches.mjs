/**
 * 版式取证：量「输入开关」三列里标签与开关的实际边界，用来核对"三个开关是否同一水平线"。
 *
 *   node scripts/probes/inspect-switches.mjs
 *
 * 2026-11-21 用它定位过问题单第 6 条：`.switch-row + .switch-row { margin-top:10px }`
 * 在三列网格里让第 2、3 个开关整体下沉 10 px（row top 相差 10、开关 top 相差 5）。
 * 输出每行的 row / label / switch / track 边界与行内计算样式，并截一张局部放大图。
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Cdp, findPageTarget, killApp, launchApp, repo, wait, waitReady } from './lib/cdp.mjs';

const profile = path.join(repo, 'artifacts', 'tmp-inspect-profile');
const port = 9371;

const SNAPSHOT = `(() => {
  const round = (value) => Math.round(value * 100) / 100;
  const box = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      top: round(rect.top), bottom: round(rect.bottom), height: round(rect.height),
      left: round(rect.left), width: round(rect.width),
      align: style.alignItems, justifyContent: style.justifyContent, display: style.display,
      lineHeight: style.lineHeight, fontSize: style.fontSize, marginTop: style.marginTop,
      alignSelf: style.alignSelf,
    };
  };
  const grid = document.querySelector('.tune-switch-grid');
  const rows = Array.from(grid?.children ?? []);
  return JSON.stringify({
    grid: box(grid),
    gridStyle: grid ? { template: getComputedStyle(grid).gridTemplateColumns, align: getComputedStyle(grid).alignItems } : null,
    rows: rows.map((row) => ({
      tag: row.tagName,
      param: row.dataset.param ?? null,
      row: box(row),
      label: box(row.querySelector('.switch-label')),
      sw: box(row.querySelector('.switch')),
      track: box(row.querySelector('.switch-track')),
    })),
    switchTops: rows.map((row) => box(row.querySelector('.switch'))?.top ?? null),
  });
})()`;

const child = launchApp({ profile, port });
let cdp = null;
try {
  const target = await findPageTarget(port);
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
  await waitReady(cdp);
  await wait(1500);
  const snapshot = await cdp.json(SNAPSHOT);
  console.log(JSON.stringify(snapshot, null, 2));
  const clip = { x: 400, y: 660, width: 520, height: 140, scale: 3 };
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 3 } }, 10_000);
  writeFileSync(path.join(repo, 'artifacts', 'inspect-switches.png'), Buffer.from(shot.data, 'base64'));
  console.log('[inspect] artifacts/inspect-switches.png');
} finally {
  cdp?.close();
  killApp(child);
}
