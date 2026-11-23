# SubStage 4-1 — U 系列（一）主界面 U1–U6

> 归属 Stage 4；覆盖 **U1 / U2 / U3 / U4 / U5 / U6**（主界面工作台）。
> 轮次：本份跑 **mock 轮**（`micstudio.channel=mock` + `micstudio.autoConnect=false`），**不碰真机**；需要设备侧回读的判据在 `SubStage_4_2`（虚拟轮）与 `SubStage_5_2`（真机）补齐。
> 前置：`SubStage_1_2.md` 的 G4 产物；本份产出的 CDP 骨架 `fulltest-cdp.mjs` 会被 `SubStage_4_2`/`4_3` 复用。

> **执行约定**：本文所有 PowerShell 片段默认在仓库根 `$root` 下执行（`--exec-file` / 相对路径都以它为基准）；需要"在被测树里跑"的命令都显式 `Push-Location $snap`，跑完 `Pop-Location`。
---

## 0. 目标

在 1266×783 的内容区里，把主界面 6 组交互（版式 / 场景 / 音色 / 三开关 / 双阈值 / EQ）在**中文与英文**各走一遍，断言优先用 `data-*` 钩子，每项出「截图 + JSON」。

## 1. 环境准备（mock 轮，可反复重跑）

```powershell
$root = 'D:\WorkShop\MicroPhone_WebHIDInterface'
$snap = 'D:\Temp\micstudio-fulltest\v1.1.3-baseline'
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$ev   = Join-Path $root 'artifacts\fulltest-20261121'
$electron = Join-Path $snap 'node_modules\electron\dist\electron.exe'
$ud   = 'D:\Temp\micstudio-fulltest\userdata-ui-mock'
$port = 9411
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}
New-Item -ItemType Directory -Force -Path (Join-Path $ev 'ui') | Out-Null
New-Item -ItemType Directory -Force -Path $ud | Out-Null
Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue   # 期望空

$env:MICSTUDIO_USER_DATA = $ud
$el = Start-Process -FilePath $electron -WorkingDirectory $snap -PassThru -ArgumentList @(
  '.', '--no-sandbox', "--remote-debugging-port=$port", '--width=1280', '--height=820',
  '--disable-background-timer-throttling','--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows','--disable-features=CalculateNativeWinOcclusion'
)
"ELECTRON_PID=$($el.Id)"
Start-Sleep -Seconds 6
(Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 5) |
  Where-Object type -eq 'page' | Select-Object url,webSocketDebuggerUrl | Format-List
```

**隔离预热（关键，防连真机）**：真机插着，`micstudio.autoConnect` 默认是 `true`（`domain/channel-config.ts:63`），不处理就会被自动连上并改写参数。预热由 scenario 里的 `warm()` 完成（`localStorage` 写 `micstudio.channel=mock` + `micstudio.autoConnect=false` → `location.reload()` → 重新等 `__micstudioGo`），与 `verify-v006-20261121.mjs:216-229` 的做法一致。**不要**用"点设置抽屉切换通道"代替：那一步本身会触发连接探测。

## 2. 新建 CDP 骨架 `scripts/probes/fulltest-cdp.mjs`

```powershell
$cdpLib = Join-Path $root 'scripts\probes\fulltest-cdp.mjs'
$lib = @'
// 本轮新增（测试资产）：最小 CDP 客户端 + 截图 + 就绪等待，供 U 系列各 scenario 复用。
// 用法：import { connect } from './fulltest-cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connect(port) {
  const deadline = Date.now() + 40_000;
  let page = null;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && (t.url ?? '').includes('index.html')) ?? null;
      if (page?.webSocketDebuggerUrl) break;
    } catch {}
    await wait(300);
  }
  if (!page) throw new Error(`no page target on ${port}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('cdp socket error')), { once: true });
  });
  let nextId = 1; const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data); const w = pending.get(m.id); if (!w) return;
    pending.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
  });
  const send = (method, params = {}, timeoutMs = 60_000) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`cdp timeout: ${method}`)); }, timeoutMs);
  });
  await send('Page.enable'); await send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };
  const json = async (expression) => JSON.parse(await evaluate(expression));

  const waitReady = async (timeout = 30_000) => {
    const dl = Date.now() + timeout;
    while (Date.now() < dl) {
      if (await evaluate(`typeof window.__micstudioGo === 'function'`)) return true;
      await wait(300);
    }
    return false;
  };
  const waitSync = async (timeout = 45_000) => {
    const dl = Date.now() + timeout;
    while (Date.now() < dl) {
      if (await evaluate(`!!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready')`)) return true;
      await wait(400);
    }
    return false;
  };
  const shotDirOf = (dir) => { fs.mkdirSync(dir, { recursive: true }); return dir; };
  const shot = async (dir, name) => {
    shotDirOf(dir);
    await send('Page.bringToFront', {}, 5_000).catch(() => undefined);
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, 15_000);
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  };
  /** 隔离预热：写通道配置后 reload，确保整轮不碰真机 */
  const warm = async ({ channel, bridgeUrl, lang }) => {
    await evaluate(`(() => {
      localStorage.setItem('micstudio.channel', ${JSON.stringify(channel)});
      localStorage.setItem('micstudio.autoConnect', 'false');
      ${bridgeUrl ? `localStorage.setItem('micstudio.bridgeUrl', ${JSON.stringify(bridgeUrl)});` : ''}
      ${lang ? `localStorage.setItem('micstudio.lang', ${JSON.stringify(lang)});` : ''}
      location.reload(); return true; })()`);
    await wait(2500);
    await waitReady(35_000);
    const kind = await evaluate(`localStorage.getItem('micstudio.channel')`);
    if (kind !== channel) throw new Error(`warm failed: channel=${kind}`);
  };
  return { send, evaluate, json, waitReady, waitSync, shot, warm, ws };
}
'@
Write-Utf8NoBom $cdpLib $lib
"written $cdpLib"
```

- **判据**：文件生成且 `node --input-type=module -e "import('file:///.../fulltest-cdp.mjs').then(m=>console.log(typeof m.connect))"` 打印 `function`。

## 3. 新建 scenario `scripts/probes/fulltest-ui-console.mjs`（U1–U6）

```powershell
$sc = Join-Path $root 'scripts\probes\fulltest-ui-console.mjs'
$src = @'
// 本轮新增（测试资产）：U1–U6 主界面走查（mock 轮）。每项出 1 张截图 + 1 组断言。
// 用法：node scripts/probes/fulltest-ui-console.mjs <cdpPort> <shotDir> <outJson> <lang>
import fs from 'node:fs';
import { connect, wait } from './fulltest-cdp.mjs';

const [portArg, shotDir, outArg, langArg] = process.argv.slice(2);
const port = Number(portArg || 9411);
const lang = langArg || 'zh';
const dir = shotDir || 'artifacts/fulltest-20261121/ui';
const out = outArg || `artifacts/fulltest-20261121/ui/ui-console-${lang}.json`;

const cdp = await connect(port);
await cdp.warm({ channel: 'mock', lang });
await cdp.waitSync(60_000);
await wait(1200);

const items = [];
const push = (id, slug, ok, expected, actual, files) => {
  items.push({ id, slug, ok: !!ok, expected, actual, evidence: files.filter(Boolean) });
};

const snap = async () => cdp.json(`(() => {
  const clean = (n) => n?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
  const q = (s) => document.querySelector(s);
  return JSON.stringify({
    viewport: { w: innerWidth, h: innerHeight },
    scroll: { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight },
    cards: Array.from(document.querySelectorAll('.console .card')).map((n) => { const b = n.getBoundingClientRect(); return { title: clean(n.querySelector('.card-title')), y: Math.round(b.y), h: Math.round(b.height), bottom: Math.round(b.bottom) }; }),
    scene: q('.scene-btn[aria-pressed="true"]')?.dataset.scene ?? null,
    sceneSeq: Array.from(document.querySelectorAll('.scene-btn')).map((n) => n.dataset.scene),
    tone: q('.tone-chip[aria-pressed="true"]')?.dataset.tone ?? null,
    toneSeq: Array.from(document.querySelectorAll('.tone-chip')).map((n) => n.dataset.tone),
    eqCursor: q('.eq-canvas')?.dataset.cursor ?? null,
    gains: Array.from(document.querySelectorAll('.console-gain-value')).map(clean),
    macros: Object.fromEntries(Array.from(document.querySelectorAll('[data-macro]')).map((n) => [n.dataset.macro, clean(n.querySelector('.pfield-value'))])),
    switches: Array.from(document.querySelectorAll('.switch-item')).map((n) => ({ label: clean(n.querySelector('.switch-label') ?? n), checked: n.querySelector('input[type="checkbox"]')?.checked ?? null, level: clean(n.querySelector('.seg-btn.is-active')) })),
    notice: q('.console-notice')?.hidden ? null : clean(q('.console-notice')),
    visible: { meter: !!q('.meter-screen'), canvas: !!q('.console-eq-canvas'), sceneRow: !!q('.scene-row'), switches: !!q('.switch-grid') },
    stats: Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((n) => [n.dataset.stat, n.textContent.trim()])),
  });
})()`);

const paramsOf = async () => {
  await cdp.evaluate(`window.__micstudioGo('advanced'); true`);
  await wait(700);
  const p = await cdp.json(`(() => {
    const clean = (n) => n?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
    const rows = Array.from(document.querySelectorAll('.modal [data-param]')).map((n) => {
      const num = n.querySelector('input[type="number"]'); const cb = n.querySelector('input[type="checkbox"]');
      const seg = n.querySelector('.seg-btn.is-active');
      return { id: n.dataset.param, value: num ? Number(num.value) : null, checked: cb ? cb.checked : null,
               seg: seg ? seg.dataset.value : null, text: clean(n.querySelector('.pfield-readout strong') ?? n.querySelector('.pfield-value')),
               disabled: n.querySelector('input')?.disabled ?? null };
    });
    const eq = Array.from(document.querySelectorAll('.modal .eq-row[data-band]')).map((row) => {
      const i = Array.from(row.querySelectorAll('input[type="number"]'));
      return { band: Number(row.dataset.band), type: row.querySelector('select')?.value ?? null, freq: i[0]?.value ?? null, gain: i[1]?.value ?? null, q: i[2]?.value ?? null };
    });
    return JSON.stringify({ rows, eq, hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth });
  })()`);
  await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
  await wait(300);
  return p;
};

// ---- U1 版式 ---------------------------------------------------------------
const s0 = await snap();
const f1 = await cdp.shot(dir, `U1-layout-${lang}.png`);
const noOverlap = s0.cards.every((c, i) => i === 0 || c.y >= s0.cards[i - 1].bottom - 1);
push('U1', 'layout', s0.scroll.sw <= s0.scroll.cw && noOverlap && s0.visible.meter && s0.visible.canvas && s0.visible.sceneRow && s0.visible.switches,
  '无横向滚动；卡片不重叠；电平表/曲线/场景条/开关可见',
  `vp=${s0.viewport.w}x${s0.viewport.h} sw=${s0.scroll.sw} cw=${s0.scroll.cw} cards=${s0.cards.length} overlapFree=${noOverlap}`,
  [f1]);

// ---- U2 场景 5 连 ----------------------------------------------------------
const sceneOrder = ['quiet', 'meeting', 'podcast', 'sing', 'custom'];
const seq = [];
for (const id of sceneOrder) {
  await cdp.evaluate(`document.querySelector('.scene-btn[data-scene="${id}"]')?.click(); true`);
  await wait(450);
  const s = await snap();
  const p = await paramsOf();
  seq.push({ id, active: s.scene, notice: s.notice, threshold: p.rows.find((r) => r.id === 'noisegate.threshold_db')?.text, comp: p.rows.find((r) => r.id === 'comp.Threshold')?.text, gains: p.eq.map((e) => e.gain) });
}
const f2 = await cdp.shot(dir, `U2-scenes-${lang}.png`);
push('U2', 'scenes',
  seq.map((x) => x.active).join(',') === sceneOrder.join(',') && seq.every((x) => x.notice === null),
  `顺序 ${sceneOrder.join(' → ')}；每步写入 5 字段 + 7 段 EQ；主界面读数同步；无 notice`,
  `active=${seq.map((x) => x.active).join(',')} notices=${seq.filter((x) => x.notice).length}`,
  [f2]);

// ---- U3 音色 5 项 + 曲线锁定 ----------------------------------------------
const tonal = [];
for (const id of ['original', 'vocal', 'warm', 'bright', 'custom']) {
  await cdp.evaluate(`document.querySelector('.tone-chip[data-tone="${id}"]')?.click(); true`);
  await wait(400);
  const s = await snap();
  tonal.push({ id, active: s.tone, cursor: s.eqCursor });
}
const f3 = await cdp.shot(dir, `U3-tone-${lang}.png`);
const lockedOk = tonal.filter((t) => t.id !== 'custom').every((t) => t.cursor !== 'grab');
push('U3', 'tone', lockedOk && tonal.every((t) => t.active === t.id),
  '原声/人声增强/温暖/明亮/自定义；非自定义曲线不可拖（dataset.cursor 非 grab），自定义可拖并回写',
  `cursor=${tonal.map((t) => `${t.id}:${t.cursor}`).join(',')}`,
  [f3]);

// ---- U4 三个输入开关 -------------------------------------------------------
const before = await snap();
for (let i = 0; i < 3; i += 1) {
  await cdp.evaluate(`document.querySelectorAll('.tune-switch-grid input[type="checkbox"]')[${i}]?.click(); true`);
  await wait(400);
}
const after = await snap();
const f4 = await cdp.shot(dir, `U4-switches-${lang}.png`);
push('U4', 'switches',
  after.switches.filter((s) => s.checked !== null).some((s, i) => s.checked !== before.switches.filter((x) => x.checked !== null)[i]?.checked),
  '麦克风静音 / 监听 / 电平信号静音三项各自切换并回读一致',
  `before=${JSON.stringify(before.switches.map((s) => s.checked))} after=${JSON.stringify(after.switches.map((s) => s.checked))}`,
  [f4]);

// ---- U5 双阈值直连（工作台 ⇄ 高级参数） ------------------------------------
const macroDenoise = (await snap()).macros.denoise;
const p5 = await paramsOf();
const gate = p5.rows.find((r) => r.id === 'noisegate.threshold_db');
const f5 = await cdp.shot(dir, `U5-threshold-${lang}.png`);
push('U5', 'threshold', gate && gate.value !== null && macroDenoise !== null,
  '工作台阈值滑杆与高级参数同名参数同一个值（dB 直连，无 0..100 换算）',
  `workbenchDenoise=${macroDenoise} advancedGate=${gate ? gate.value : null} (两者口径不同：工作台是 macro 读数，判据见 4_2 虚拟轮)`,
  [f5]);

// ---- U6 EQ 拖拽 + 逐段精调 -------------------------------------------------
await cdp.evaluate(`document.querySelector('.tone-chip[data-tone="custom"]')?.click(); true`);
await wait(400);
const cursorBefore = (await snap()).eqCursor;
const box = await cdp.json(`(() => { const b = document.querySelector('.eq-canvas').getBoundingClientRect(); return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height }); })()`);
const px = Math.round(box.x + box.w * 0.4), py = Math.round(box.y + box.h * 0.5);
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
for (let k = 1; k <= 6; k += 1) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px + k * 8, y: py - k * 6, button: 'left' });
  await wait(60);
}
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px + 48, y: py - 36, button: 'left', clickCount: 1 });
await wait(700);
const p6 = await paramsOf();
const toneAfterDrag = (await snap()).tone;
const f6 = await cdp.shot(dir, `U6-eq-${lang}.png`);
push('U6', 'eq', p6.eq.length === 7 && p6.eq.every((e) => e.freq !== null && e.gain !== null && e.q !== null && e.type !== null) && toneAfterDrag === 'custom',
  '拖拽改频点/增益；逐段表 7 段 × 4 字段可编辑；手改后音色自动标「自定义」',
  `cursorBefore=${cursorBefore} toneAfterDrag=${toneAfterDrag} eqRows=${p6.eq.length}`,
  [f6]);

const payload = { at: new Date().toISOString(), port, lang, channel: 'mock', items };
fs.mkdirSync(dir.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ lang, ok: items.filter((i) => i.ok).length, total: items.length, out }));
process.exitCode = items.every((i) => i.ok) ? 0 : 1;
'@
Write-Utf8NoBom $sc $src
"written $sc"
```

## 4. 执行（中文轮 + 英文轮）

```powershell
Push-Location $root
$out = & $node 'scripts\probes\fulltest-ui-console.mjs' 9411 'artifacts\fulltest-20261121\ui' 'artifacts\fulltest-20261121\ui\ui-console-zh.json' 'zh' 2>&1
$codeZh = $LASTEXITCODE
$out
Write-Utf8NoBom (Join-Path $ev 'ui\run-console-zh.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$codeZh`n")

$out = & $node 'scripts\probes\fulltest-ui-console.mjs' 9411 'artifacts\fulltest-20261121\ui' 'artifacts\fulltest-20261121\ui\ui-console-en.json' 'en' 2>&1
$codeEn = $LASTEXITCODE
$out
Write-Utf8NoBom (Join-Path $ev 'ui\run-console-en.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$codeEn`n")
"zh=$codeZh en=$codeEn"
Pop-Location
```

- **判据**：两轮 `EXIT=0`（全部 6 项 `ok=true`）；`ui-console-{zh,en}.json` 各有 6 条 items；截图 6 张/语言（`U1-layout-zh.png`…`U6-eq-en.png`）。
- 英文轮同时充当 U11 的"整屏重建后无缺键"的辅助证据（严格判据在 `SubStage_4_3`）。

## 5. 每项的判据与证据（对照表）

| ID | 判据（本份可判的部分） | 证据文件 | 本份不判 / 交给他处的部分 |
|---|---|---|---|
| U1 | `scrollWidth <= clientWidth`；卡片 y 单调递增不重叠；电平表/曲线/场景条/开关四块可见；截图非空白 | `ui/U1-layout-{zh,en}.png`、`ui/ui-console-{zh,en}.json` | "1266×783" 的实测值记在 `actual` 里（窗口 1280×820 → 内容区约 1266×783，允许 ±4 px 边框差） |
| U2 | 顺序 `quiet → meeting → podcast → sing → custom`；每步激活态正确；无 `.console-notice`；每次点击后 5 字段 + 7 段读数被抓取 | `ui/U2-scenes-{zh,en}.png`、json 里的 `seq` | **协议字段数值是否等于场景定义** → P5（定义侧）+ R6（真机回读）；mock 轮只证明"界面按定义驱动" |
| U3 | 5 个 `data-tone` 依次可点中；非自定义时 `eqCanvas.dataset.cursor != 'grab'`；拖拽后音色变 `custom` | `ui/U3-tone-{zh,en}.png`、`ui/U6-eq-*.png` | 自定义曲线回写 `customEq` 的数值正确性 → U6 的 EQ 表 + R6 |
| U4 | 三个开关能切换且 `checked` 变化；`.switch-item` 三项齐全 | `ui/U4-switches-{zh,en}.png` | 对应寄存器是否写入 → `SubStage_4_2` 虚拟轮 + R4/R5 |
| U5 | 工作台 `[data-macro]` 与高级 `noisegate.threshold_db` 都被读到（口径说明写进 actual） | `ui/U5-threshold-{zh,en}.png` | **双向联动的一致性**必须在虚拟轮用同一时刻的两个读数比对（`SubStage_4_2` §U5），本份只验证"两处都能读到" |
| U6 | EQ 表 7 段 × 4 字段齐全；拖拽后音色自动 `custom` | `ui/U6-eq-{zh,en}.png`、json 的 `eq` | 拖拽是否真的改了频点/增益（像素 → 参数）→ 看 `eq` 前后差值，写进 actual；失败按缺陷记 |

## 6. 证据与结果 JSON

```powershell
$now = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
$zh = Get-Content (Join-Path $ev 'ui\ui-console-zh.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$en = Get-Content (Join-Path $ev 'ui\ui-console-en.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$items3 = @()
foreach ($id in 'U1','U2','U3','U4','U5','U6') {
  $z = $zh.items | Where-Object id -eq $id | Select-Object -First 1
  $e = $en.items | Where-Object id -eq $id | Select-Object -First 1
  $st = if ($z.ok -and $e.ok) { 'pass' } else { 'fail' }
  $evd = @($z.evidence) + @($e.evidence) | Where-Object { $_ } | ForEach-Object { $_ -replace [regex]::Escape($root + '\'), '' -replace '\\','/' }
  $items3 += @{ id = $id; status = $st; expected = $z.expected; actual = ("zh: " + $z.actual + " | en: " + $e.actual); evidence = $evd; ts = $now; durationMs = 0; probe = 'fulltest-ui-console.mjs'; notes = 'mock 轮' }
}
$json = @{ stage = 4; substage = '4_1'; env = @{ snapshot = $snap; gitHead = '8b7560e762bc38a9db79c7fcc5fcb5524b966feb'; channel = 'mock'; lang = 'zh+en'; userData = $ud; device = 'none'; startedAt = $now }; items = $items3; notRun = @() }
Write-Utf8NoBom (Join-Path $ev 'ui\result-4_1.json') ($json | ConvertTo-Json -Depth 8)
$items3 | ForEach-Object { '{0} {1}' -f $_.id, $_.status }
```

## 7. 失败处置

| 现象 | 处置 |
|---|---|
| CDP 连不上 | 端口被占（换 9413+）；`ELECTRON_RUN_AS_NODE` 未清（坑 13）；缺 `--no-sandbox`（坑 14/18）；看 `$ud\startup.log` 的 `did-fail-load` |
| `warm` 报 `channel=...` 不符 | `localStorage` 写入被 CSP/隐私模式挡？先手工在 DevTools 里跑一次；或改用 UI 设置抽屉切换通道（`[data-channel-control="kind"]`） |
| `sync-pill` 永不 ready（mock 轮） | mock 通道本应立即 ready；检查是否误连了 `virtual`/`native`（`warm` 之后 reload 前是否被 autoConnect 抢跑） |
| U1 有横向滚动 | 记 fail（P2）；用 `layout-metrics` 取具体元素边界，附截图；先把窗口 DPR 与 `--width/--height` 写进 actual |
| U3 `cursor` 一直 `grab` | 说明非自定义也能拖 → 记 P1（需求 U3 不成立） |
| U6 拖拽无效果 | 检查是否处于 `custom` 音色；`Input.dispatchMouseEvent` 的坐标必须是页面坐标（`getBoundingClientRect` + 视口偏移 0）；先 dispatch `mouseMoved` 再 `mousePressed` 试一次 |
| 英文轮缺键/出现 key 原文 | 记 P1（U11）；把缺的 key 文本与所在控件 `data-param` 一起写进缺陷清单 |

## 8. 完成定义（DoD）

1. `fulltest-cdp.mjs`、`fulltest-ui-console.mjs` 两个新资产已落盘且能跑通；
2. `ui/ui-console-zh.json`、`ui/ui-console-en.json` 各 6 条 items，`ok` 均为 true（否则按 fail 记并写缺陷）；
3. 截图 12 张（6 项 × 2 语言）都在 `ui/`，每张 ≥10 KB；
4. `ui/result-4_1.json` 里 U1–U6 状态齐全；
5. `ui/run-console-{zh,en}.log` 里有 `EXIT=0`；
6. 全程 `localStorage.micstudio.channel == 'mock'` 且真机未被连接（`$ud\startup.log` 里没有 `[auto-connect] 自动连接成功`）。
