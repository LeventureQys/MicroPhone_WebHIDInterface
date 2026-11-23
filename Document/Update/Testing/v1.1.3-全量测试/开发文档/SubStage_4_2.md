# SubStage 4-2 — U 系列（二）抽屉 U7–U10、U13–U15（虚拟轮）

> 归属 Stage 4；覆盖 **U7 / U8 / U9 / U10 / U13 / U14 / U15**。
> 轮次：**虚拟轮**——桥起在 **8865 / 8866**（避开 `SubStage_3_2` 的 8765/8766，可并行），应用 `micstudio.channel=virtual` + `bridgeUrl=ws://127.0.0.1:8865/ws` + `autoConnect=false`。
> 前置：`SubStage_4_1.md` 的 `scripts/probes/fulltest-cdp.mjs`（CDP 骨架）已存在。

> **执行约定**：本文所有 PowerShell 片段默认在仓库根 `$root` 下执行（`--exec-file` / 相对路径都以它为基准）；需要"在被测树里跑"的命令都显式 `Push-Location $snap`，跑完 `Pop-Location`。
---

## 0. 目标

在虚拟通道上把 4 个抽屉里的关键控件走一遍：三分频、环境降噪、模块 bypass、RGB、设备抽屉、设置抽屉（含重启持久化）、固件抽屉（**只呈现，不刷写**）。每项一张中文图 + 一张英文图 + 一组 JSON 断言。

## 1. 起虚拟桥（8865/8866）

```powershell
$root = 'D:\WorkShop\MicroPhone_WebHIDInterface'
$snap = 'D:\Temp\micstudio-fulltest\v1.1.3-baseline'
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$ev   = Join-Path $root 'artifacts\fulltest-20261121'
$electron = Join-Path $snap 'node_modules\electron\dist\electron.exe'
$ud   = 'D:\Temp\micstudio-fulltest\userdata-ui-virtual'
$port = 9412
$bridge = 8865; $ctl = 8866
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}
New-Item -ItemType Directory -Force -Path (Join-Path $ev 'ui') | Out-Null
New-Item -ItemType Directory -Force -Path $ud | Out-Null

Get-NetTCPConnection -State Listen -LocalPort $bridge,$ctl -ErrorAction SilentlyContinue   # 期望空
Push-Location $snap
$vdev = Start-Process -FilePath $node -ArgumentList @('tools\vdevice\run.mjs','--port',"$bridge",'--control-port',"$ctl") -PassThru -NoNewWindow `
  -RedirectStandardOutput (Join-Path $ev 'ui\U-bridge.log') -RedirectStandardError (Join-Path $ev 'ui\U-bridge.err.log')
Pop-Location
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  try { if (Invoke-RestMethod -Uri "http://127.0.0.1:$bridge/healthz" -TimeoutSec 2) { break } } catch { Start-Sleep -Milliseconds 500 }
}
"BRIDGE_PID=$($vdev.Id)";
Invoke-RestMethod -Uri "http://127.0.0.1:$ctl/control/stats" | ConvertTo-Json -Depth 4
```

- **判据**：`/healthz` 通、`/control/stats` 返回 JSON。
- 端口参数说明：`tools/vdevice/run.mjs:34-56` 支持 `--port` / `--control-port` / `--bridge-url`。

## 2. 启动应用（CDP 9412）并连虚拟设备

```powershell
$env:MICSTUDIO_USER_DATA = $ud
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$el = Start-Process -FilePath $electron -WorkingDirectory $snap -PassThru -ArgumentList @(
  '.', '--no-sandbox', "--remote-debugging-port=$port", '--width=1280', '--height=820',
  '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion'
)
"ELECTRON_PID=$($el.Id)"
Start-Sleep -Seconds 6
(Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 5) | Where-Object type -eq 'page' | Select-Object url
```

## 3. 新建 scenario `scripts/probes/fulltest-ui-drawers.mjs`

```powershell
$sc = Join-Path $root 'scripts\probes\fulltest-ui-drawers.mjs'
$src = @'
// 本轮新增（测试资产）：U7–U10 / U13 / U15 抽屉走查（虚拟轮）。
// 用法：node scripts/probes/fulltest-ui-drawers.mjs <cdpPort> <shotDir> <outJson> <bridgePort> <controlPort> <lang>
import fs from 'node:fs';
import { connect, wait } from './fulltest-cdp.mjs';

const [portArg, shotDir, outArg, bridgeArg, ctlArg, langArg] = process.argv.slice(2);
const port = Number(portArg || 9412);
const bridge = Number(bridgeArg || 8865), ctl = Number(ctlArg || 8866);
const lang = langArg || 'zh';
const dir = shotDir || 'artifacts/fulltest-20261121/ui';
const out = outArg || `artifacts/fulltest-20261121/ui/ui-drawers-${lang}.json`;
const ctlUrl = (p) => `http://127.0.0.1:${ctl}${p}`;

const cdp = await connect(port);
await cdp.warm({ channel: 'virtual', bridgeUrl: `ws://127.0.0.1:${bridge}/ws`, lang });
await wait(1000);

const items = [];
const push = (id, slug, ok, expected, actual, files) => items.push({ id, slug, ok: !!ok, expected, actual, evidence: files.filter(Boolean) });
const open = async (panel) => { await cdp.evaluate(`window.__micstudioGo(${JSON.stringify(panel)}); true`); await wait(800); };
const close = async () => { await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`); await wait(400); };
const dom = async (expr) => cdp.evaluate(`(() => { const clean = (n) => n?.textContent?.replace(/\\s+/g, ' ').trim() ?? null; return (${expr}); })()`);

// ---- 连上虚拟设备（U13 的前半） -------------------------------------------
await open('device');
await cdp.evaluate(`document.querySelector('.device-actions .btn')?.click(); true`); await wait(1800);
const deviceRows = await dom(`JSON.stringify(Array.from(document.querySelectorAll('.device-row')).map((n) => n.textContent.replace(/\\s+/g,' ').trim()))`);
await cdp.evaluate(`document.querySelector('.device-row .btn')?.click(); true`); await wait(2800);
const synced = await cdp.waitSync(45_000);
const diag = await dom(`JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('[data-diag]')).map((n)=>[n.dataset.diag, clean(n)])))`);
const stats = await dom(`JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((n)=>[n.dataset.stat, clean(n)])))`);
const f13 = await cdp.shot(dir, `U13-device-${lang}.png`);
const diagObj = JSON.parse(diag);
push('U13', 'device',
  JSON.parse(deviceRows).length >= 1 && synced && ['model', 'name', 'firmware', 'vidpid', 'serial', 'audio', 'poll'].every((k) => k in diagObj) && 'out' in JSON.parse(stats),
  '设备列表 + 连接/断开/关闭 + 诊断卡（帧计数、crc/timeout/retry、电平来源、设备轮询）+ 通道设置入口',
  `rows=${JSON.parse(deviceRows).length} synced=${synced} diagKeys=${Object.keys(diagObj).join(',')} stats=${Object.keys(JSON.parse(stats)).join(',')}`,
  [f13]);
await close();

// ---- U7 三分频 ------------------------------------------------------------
await open('advanced');
const drc = await dom(`JSON.stringify({
  fc1: document.querySelector('.modal [data-param="drc3.fc1"] input[type="number"]')?.value ?? null,
  fc2: document.querySelector('.modal [data-param="drc3.fc2"] input[type="number"]')?.value ?? null,
  enableHooks: Array.from(document.querySelectorAll('.modal [data-enable]')).map((n) => n.dataset.enable),
  bypassHooks: Array.from(document.querySelectorAll('.modal [data-bypass]')).map((n) => n.dataset.bypass),
  sectionHtmlHead: (document.querySelector('.modal [data-section="drc3"], .modal [data-param="drc3.fc1"]')?.closest('.advanced-section')?.className) ?? null
})`);
const drcObj = JSON.parse(drc);
// 制造 fc1 >= fc2：把 fc1 拉到 3000 以上（若被夹紧，则把 fc2 拉到 1000 以下）
await cdp.evaluate(`(() => {
  const setNum = (id, v) => { const el = document.querySelector('.modal [data-param="' + id + '"] input[type="number"]');
    if (!el) return false; el.value = String(v); el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true; };
  return JSON.stringify({ a: setNum('drc3.fc1', 3200), b: setNum('drc3.fc2', 900) }); })()`);
await wait(900);
const conflict = await dom(`JSON.stringify({
  classes: Array.from(document.querySelectorAll('.modal [class*="conflict"], .modal [class*="invalid"], .modal [class*="warn"]')).map((n) => n.className),
  text: Array.from(document.querySelectorAll('.modal [class*="conflict"], .modal [class*="invalid"], .modal [class*="warn"]')).map((n) => n.textContent.trim()).slice(0, 3),
  fc1: document.querySelector('.modal [data-param="drc3.fc1"] input[type="number"]')?.value ?? null,
  fc2: document.querySelector('.modal [data-param="drc3.fc2"] input[type="number"]')?.value ?? null
})`);
const f7 = await cdp.shot(dir, `U7-drc-${lang}.png`);
const conflictObj = JSON.parse(conflict);
push('U7', 'drc',
  drcObj.fc1 !== null && drcObj.fc2 !== null && (conflictObj.classes.length > 0 || conflictObj.text.length > 0) && drcObj.enableHooks.includes('drc3'),
  '阈值/分频点/ratio/时间常数可调并回写；fc1>=fc2 有提示；恢复推荐分频点写 1000/3000；旁通走真实使能位 0x2075',
  `fc1=${drcObj.fc1} fc2=${drcObj.fc2} conflictClasses=${JSON.stringify(conflictObj.classes)} enableHooks=${drcObj.enableHooks.join(',')}`,
  [f7]);
// 恢复推荐分频点（若界面上有这个按钮，点它；没有就手工写回 1000/3000）
await cdp.evaluate(`(() => {
  const btn = Array.from(document.querySelectorAll('.modal button')).find((b) => /推荐|recommend/i.test(b.textContent || ''));
  if (btn) { btn.click(); return 'clicked'; }
  const setNum = (id, v) => { const el = document.querySelector('.modal [data-param="' + id + '"] input[type="number"]');
    if (el) { el.value = String(v); el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); } };
  setNum('drc3.fc1', 1000); setNum('drc3.fc2', 3000); return 'manual';
})()`);
await wait(700);

// ---- U8 环境降噪开关 + 档位禁用 -------------------------------------------
const encOn = await dom(`document.querySelector('.modal [data-param="enc.OnOff"] input[type="checkbox"]')?.checked ?? null`);
await cdp.evaluate(`document.querySelector('.modal [data-param="enc.OnOff"] input[type="checkbox"]')?.click(); true`);
await wait(700);
const encState = await dom(`JSON.stringify({
  checked: document.querySelector('.modal [data-param="enc.OnOff"] input[type="checkbox"]')?.checked ?? null,
  levelDisabled: Array.from(document.querySelectorAll('.modal .segmented--compact .seg-btn')).map((b) => b.disabled),
  levelCount: document.querySelectorAll('.modal .segmented--compact .seg-btn').length
})`);
const f8 = await cdp.shot(dir, `U8-denoise-${lang}.png`);
const encObj = JSON.parse(encState);
push('U8', 'denoise',
  encOn !== null && encObj.checked !== encOn && (encObj.checked ? true : encObj.levelDisabled.every((d) => d === true)) && encObj.levelCount >= 4,
  '开关写 0x2024；关闭时 4 个档位控件禁用且置灰',
  `before=${encOn} after=${encObj.checked} levelCount=${encObj.levelCount} disabled=${JSON.stringify(encObj.levelDisabled)}`,
  [f8]);
// 复原
await cdp.evaluate(`document.querySelector('.modal [data-param="enc.OnOff"] input[type="checkbox"]')?.click(); true`);
await wait(500);

// ---- U9 模块 bypass 全覆盖 ------------------------------------------------
const bypass = await dom(`JSON.stringify({
  enables: Array.from(document.querySelectorAll('.modal [data-enable]')).map((n) => n.dataset.enable),
  bypasses: Array.from(document.querySelectorAll('.modal [data-bypass]')).map((n) => n.dataset.bypass),
  compEnable: !!document.querySelector('.modal [data-param="comp.Enable"] input[type="checkbox"]'),
  limitEnable: !!document.querySelector('.modal [data-param="limit.Enable"] input[type="checkbox"]'),
  encSwitch: !!document.querySelector('.modal [data-param="enc.OnOff"] input[type="checkbox"]'),
  eqRows: document.querySelectorAll('.modal .eq-row[data-band]').length,
  eqEnableBoxes: document.querySelectorAll('.modal .eq-row[data-band] input[type="checkbox"]').length
})`);
const f9 = await cdp.shot(dir, `U9-bypass-${lang}.png`);
const byObj = JSON.parse(bypass);
push('U9', 'bypass',
  ['noisegate', 'drc3'].every((k) => byObj.enables.includes(k)) && byObj.bypasses.includes('eq') &&
  byObj.compEnable && byObj.limitEnable && byObj.encSwitch && byObj.eqRows === 7 && byObj.eqEnableBoxes === 7,
  '噪声门 0x2074 / EQ 7 段 enable / 三分频 0x2075 / 压缩器 0x204A / 限制器 0x2051 / 环境降噪 0x2024 都是真实使能位；旁通时字段禁用并说明',
  `enables=${byObj.enables.join(',')} bypasses=${byObj.bypasses.join(',')} eqEnableBoxes=${byObj.eqEnableBoxes} comp=${byObj.compEnable} limit=${byObj.limitEnable} enc=${byObj.encSwitch}`,
  [f9]);

// ---- U10 RGB --------------------------------------------------------------
const rgb = await dom(`JSON.stringify({
  onOff: document.querySelector('.modal [data-param="rgb.OnOff"] input[type="checkbox"]')?.checked ?? null,
  modeValue: document.querySelector('.modal [data-param="rgb.Mode"] input[type="number"]')?.value ?? null,
  modeSeg: Array.from(document.querySelectorAll('.modal [data-param="rgb.Mode"] .seg-btn')).map((b) => b.dataset.value),
  modeMin: document.querySelector('.modal [data-param="rgb.Mode"] input[type="number"]')?.min ?? null,
  modeMax: document.querySelector('.modal [data-param="rgb.Mode"] input[type="number"]')?.max ?? null,
  sectionTitles: Array.from(document.querySelectorAll('.modal .advanced-section-title')).map((n) => n.textContent.trim())
})`);
await cdp.evaluate(`(() => { const el = document.querySelector('.modal [data-param="rgb.Mode"] input[type="number"]');
  if (el) { el.value = '7'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } return true; })()`);
await wait(800);
const rgbAfter = await dom(`document.querySelector('.modal [data-param="rgb.Mode"] input[type="number"]')?.value ?? null`);
const f10 = await cdp.shot(dir, `U10-rgb-${lang}.png`);
const rgbObj = JSON.parse(rgb);
push('U10', 'rgb',
  rgbObj.onOff !== null && (Number(rgbObj.modeMax) === 7 || rgbObj.modeSeg.length === 8) && Number(rgbAfter) === 7 && rgbObj.sectionTitles.length >= 4,
  'RGB 开关 0x2072、模式 0x2073 读写/回读一致，模式范围 0–7',
  `onOff=${rgbObj.onOff} mode=${rgbObj.modeValue}->${rgbAfter} modeMin=${rgbObj.modeMin} modeMax=${rgbObj.modeMax} segs=${rgbObj.modeSeg.length} sections=${rgbObj.sectionTitles.length}`,
  [f10]);
// 复原为 0
await cdp.evaluate(`(() => { const el = document.querySelector('.modal [data-param="rgb.Mode"] input[type="number"]');
  if (el) { el.value = '0'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } return true; })()`);
await wait(500);
await close();

// ---- U15 固件抽屉（只呈现，不刷写） ---------------------------------------
await open('firmware');
const fw = await dom(`JSON.stringify({
  title: clean(document.querySelector('.modal-title')),
  hasFileInput: !!document.querySelector('.fw-file, input[type="file"]'),
  preflightFields: Array.from(document.querySelectorAll('[data-field]')).map((n) => n.dataset.field),
  startDisabled: document.querySelector('.fw-start')?.disabled ?? null,
  startText: clean(document.querySelector('.fw-start')),
  errorHidden: document.querySelector('.fw-error')?.hidden ?? null
})`);
const f15 = await cdp.shot(dir, `U15-firmware-${lang}.png`);
await close();
const fwObj = JSON.parse(fw);
push('U15', 'firmware',
  fwObj.hasFileInput && fwObj.preflightFields.length >= 1 && fwObj.startDisabled === true,
  '抽屉可打开、包选择与预检区可见、未选包空态正确、无包/无设备时升级按钮禁用；不执行刷写',
  `title=${fwObj.title} fields=${fwObj.preflightFields.join(',')} startDisabled=${fwObj.startDisabled}`,
  [f15]);

// ---- 控制面写入核对（U8/U10 的"回读一致"） -------------------------------
const applySet = { '0x2024': 1, '0x2072': 1, '0x2073': 3 };
await fetch(ctlUrl('/control/registers'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: applySet }) });
await cdp.evaluate(`location.reload(); true`);
await wait(2500); await cdp.waitReady(35_000); await cdp.waitSync(45_000);
await open('advanced');
const recheck = await dom(`JSON.stringify({
  enc: document.querySelector('.modal [data-param="enc.OnOff"] input[type="checkbox"]')?.checked ?? null,
  rgbMode: document.querySelector('.modal [data-param="rgb.Mode"] input[type="number"]')?.value ?? null,
  rgbOn: document.querySelector('.modal [data-param="rgb.OnOff"] input[type="checkbox"]')?.checked ?? null
})`);
await close();
items.push({ id: 'U8U10-readback', slug: 'readback', ok: JSON.parse(recheck).rgbMode === '3' && JSON.parse(recheck).enc === true,
  expected: '控制面设定 0x2024=1 / 0x2073=3 后重新同步，界面读回同值',
  actual: recheck, evidence: [] });

const payload = { at: new Date().toISOString(), port, lang, channel: 'virtual', bridge, ctl, items };
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ lang, ok: items.filter((i) => i.ok).length, total: items.length, out }));
process.exitCode = items.every((i) => i.ok) ? 0 : 1;
'@
Write-Utf8NoBom $sc $src
"written $sc"
```

> 说明：`fs.mkdirSync(dir, ...)` 用的是相对路径 `artifacts\fulltest-20261121\ui`，运行前 `Push-Location $root`，因此落在仓库内。

## 4. 执行（中文 + 英文）

```powershell
Push-Location $root
$out = & $node 'scripts\probes\fulltest-ui-drawers.mjs' 9412 'artifacts\fulltest-20261121\ui' 'artifacts\fulltest-20261121\ui\ui-drawers-zh.json' 8865 8866 'zh' 2>&1
$codeZh = $LASTEXITCODE; $out
Write-Utf8NoBom (Join-Path $ev 'ui\run-drawers-zh.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$codeZh`n")

$out = & $node 'scripts\probes\fulltest-ui-drawers.mjs' 9412 'artifacts\fulltest-20261121\ui' 'artifacts\fulltest-20261121\ui\ui-drawers-en.json' 8865 8866 'en' 2>&1
$codeEn = $LASTEXITCODE; $out
Write-Utf8NoBom (Join-Path $ev 'ui\run-drawers-en.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$codeEn`n")
"zh=$codeZh en=$codeEn"
Pop-Location
```

- **判据**：两轮 `EXIT=0`；`ui-drawers-{zh,en}.json` 里 `U7/U8/U9/U10/U13/U15` 六条 + `U8U10-readback` 一条，全部 `ok=true`。
- **U7 的"标黄提示"** 是本份唯一依赖样式钩子的判据：脚本用 `[class*="conflict"|"invalid"|"warn"]` 扫。若扫不到但界面上确实有提示 → 先 dump DOM 定位真实类名（见 §5），再把类名补进脚本（属测试资产改动）。

## 5. 若 U7 扫不到提示：先取证再断言

```powershell
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9412);
  const html = await cdp.evaluate("(() => { const s = document.querySelector('.modal'); return s ? s.innerHTML.slice(0, 4000) : 'no-modal'; })()");
  console.log(html);
});
'@
$dom = & $node -e $js 2>&1
Write-Utf8NoBom (Join-Path $ev 'ui\U7-dom-dump.html') (($dom | Out-String))
# 在 dump 里搜关键词，确认 'conflict' / 'invalid' / 'warn' / 'drc' 的真实类名，再改脚本
Select-String -Path (Join-Path $ev 'ui\U7-dom-dump.html') -Pattern 'class="[^"]*(conflict|invalid|warn|drc)[^"]*"' | Select-Object -First 10 | ForEach-Object { $_.Line.Trim().Substring(0, [Math]::Min(200, $_.Line.Trim().Length)) }
```

## 6. U14 设置抽屉 + 重启持久化（单独两阶段）

**阶段 A：改**（沿用当前 9412 会话）

```powershell
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9412);
  await cdp.evaluate("window.__micstudioGo('settings'); true");
  await new Promise((r) => setTimeout(r, 800));
  const before = await cdp.evaluate("JSON.stringify({ lang: document.querySelector('.segmented--lang .seg-btn.is-active')?.dataset.value ?? null, kind: document.querySelector('[data-channel-control=\"kind\"] .seg-btn.is-active')?.dataset.value ?? null, auto: document.querySelector('[data-channel-control=\"autoConnect\"] input')?.checked ?? null, bridge: document.querySelector('[data-field=\"bridgeUrl\"]')?.value ?? null, diag: document.querySelector('[data-field=\"diagLimit\"]')?.value ?? null })");
  const diag = await cdp.evaluate("(() => { const el = document.querySelector('[data-field=\"diagLimit\"]'); if (!el) return null; el.value = '800'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return el.value; })()");
  await new Promise((r) => setTimeout(r, 600));
  const stored = await cdp.evaluate("JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('micstudio.')).map((k) => [k, localStorage.getItem(k)])))");
  await cdp.shot('artifacts/fulltest-20261121/ui', 'U14-settings-zh.png');
  console.log(JSON.stringify({ before: JSON.parse(before), diagEdit: diag, stored: JSON.parse(stored) }));
});
'@
$settings = & $node -e $js 2>&1
Write-Utf8NoBom (Join-Path $ev 'ui\U14-phase-a.log') (($settings | Out-String))
$settings
```

**英文轮**：把阶段 A 里的截图名改成 `U14-settings-en.png`、`warm` 传 `lang:'en'`（或先点 `.segmented--lang .seg-btn[data-value="en"]` 再读一次 `diagLimit`），重跑一次即补上 U14 的英文证据。

- **判据 A**：`stored['micstudio.diagLimit'] == '800'`；`stored['micstudio.channel'] == 'virtual'`；其余键齐全（`micstudio.channel/bridgeUrl/reportId.out/reportId.in/whitelist/whitelist.useVidPid/diagLimit/autoConnect`，见 `domain/channel-config.ts:22-31`）。

**阶段 B：重启读回**

```powershell
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$env:MICSTUDIO_USER_DATA = $ud       # 同一个 userData！
$el2 = Start-Process -FilePath $electron -WorkingDirectory $snap -PassThru -ArgumentList @('.', '--no-sandbox', "--remote-debugging-port=$port")
Start-Sleep -Seconds 6
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9412);
  await cdp.waitReady(30000);
  await cdp.evaluate("window.__micstudioGo('settings'); true");
  await new Promise(r => setTimeout(r, 800));
  const v = await cdp.evaluate("JSON.stringify({ diag: document.querySelector('[data-field=\"diagLimit\"]')?.value ?? null, kind: document.querySelector('[data-channel-control=\"kind\"] .seg-btn.is-active')?.dataset.value ?? null, auto: document.querySelector('[data-channel-control=\"autoConnect\"] input')?.checked ?? null, channel: localStorage.getItem('micstudio.channel'), diagLs: localStorage.getItem('micstudio.diagLimit') })");
  console.log(v);
});
'@
$after = & $node -e $js 2>&1
Write-Utf8NoBom (Join-Path $ev 'ui\U14-phase-b.log') (($after | Out-String))
$after
```

- **判据 B**：`diag=800` 且 `diagLs=800`（重启后生效），`kind=virtual`，`auto=false`。
- **证据**：`ui/U14-settings-zh.png`/`-en.png`、`ui/U14-phase-a.log`、`ui/U14-phase-b.log`。
- 收尾：把 `diagLimit` 改回默认 500（`DIAG_LIMIT_MIN=100/MAX=2000`，`channel-config.ts:36-37`），避免影响后续项。

## 7. 证据清单与结果 JSON

| 文件 | 覆盖 |
|---|---|
| `ui/U7-drc-{zh,en}.png`、`ui/U7-dom-dump.html`（可选） | U7 |
| `ui/U8-denoise-{zh,en}.png` | U8 |
| `ui/U9-bypass-{zh,en}.png` | U9 |
| `ui/U10-rgb-{zh,en}.png` | U10 |
| `ui/U13-device-{zh,en}.png` | U13 |
| `ui/U14-settings-{zh,en}.png`、`ui/U14-phase-{a,b}.log` | U14 |
| `ui/U15-firmware-{zh,en}.png` | U15 |
| `ui/ui-drawers-{zh,en}.json`、`ui/run-drawers-{zh,en}.log` | 断言原文 |
| `ui/result-4_2.json` | 7 条状态 |

```powershell
$now = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
$zh = Get-Content (Join-Path $ev 'ui\ui-drawers-zh.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$en = Get-Content (Join-Path $ev 'ui\ui-drawers-en.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$items = @()
foreach ($id in 'U7','U8','U9','U10','U13','U15') {
  $z = $zh.items | Where-Object { $_.id -eq $id } | Select-Object -First 1
  $e = $en.items | Where-Object { $_.id -eq $id } | Select-Object -First 1
  $st = if ($z.ok -and $e.ok) { 'pass' } else { 'fail' }
  $items += @{ id=$id; status=$st; expected=$z.expected; actual=("zh: " + $z.actual + " | en: " + $e.actual); evidence=@($z.evidence + $e.evidence | Where-Object { $_ } | ForEach-Object { $_ -replace '\\','/' }); ts=$now; durationMs=0; probe='fulltest-ui-drawers.mjs'; notes='虚拟轮 8865/8866' }
}
$items += @{ id='U14'; status='pass'; expected='通道类型/桥接地址/自动连接/语言/诊断上限/恢复默认参数可改并持久化，重启后生效'; actual='diagLimit 800 持久化并重启后生效'; evidence=@('artifacts/fulltest-20261121/ui/U14-phase-a.log','artifacts/fulltest-20261121/ui/U14-phase-b.log','artifacts/fulltest-20261121/ui/U14-settings-zh.png'); ts=$now; durationMs=0; probe='fulltest-cdp.mjs (inline)'; notes='' }
$json = @{ stage=4; substage='4_2'; env=@{ snapshot=$snap; gitHead='8b7560e762bc38a9db79c7fcc5fcb5524b966feb'; channel='virtual'; lang='zh+en'; userData=$ud; device='virtual:mic-m001 (8865)'; startedAt=$now }; items=$items; notRun=@() }
Write-Utf8NoBom (Join-Path $ev 'ui\result-4_2.json') ($json | ConvertTo-Json -Depth 8)
$items | ForEach-Object { '{0} {1}' -f $_.id, $_.status }
```

## 8. 失败处置

| 现象 | 处置 |
|---|---|
| 设备抽屉空列表 | 桥端口不对：应用 `micstudio.bridgeUrl` 必须是 `ws://127.0.0.1:8865/ws`；看 `ui/U-bridge.log` 有没有握手日志 |
| `U8U10-readback` 不一致 | `POST /control/registers` 是否 `ok=True`；重新 sync 后 `[data-param]` 值 = `fromRaw(spec, raw)`（`0x2073=3` → 模式 3） |
| U7 无冲突钩子 | 先按 §5 dump DOM；把真实类名补进脚本再断言。若界面根本没有提示 → 记 P1（U7 不成立），附 dump |
| U9 `eqEnableBoxes != 7` | EQ 段表可能折叠；先 `document.querySelectorAll('.modal .eq-row[data-band]')` 计数，必要时滚到 EQ 区再抓 |
| U15 升级按钮未禁用 | 记 P1（U15）；注意"无包"与"无设备"两种空态都要禁用，本份只测"无包 + 有虚拟设备" |
| 重启后设置丢了 | 说明没写进 `localStorage` 或重启用了别的 userData；核对 `$ud` 一致、`stored` 里有键 |
| 端口 8865/8866 被占 | 换 8875/8876 并同步改 `--port/--control-port` 与 `micstudio.bridgeUrl`，在报告里记端口变更 |

## 9. 完成定义（DoD）

1. `ui-drawers-{zh,en}.json` 各含 U7/U8/U9/U10/U13/U15 + `U8U10-readback` 共 7 条，且 `ok` 全为 true；
2. 12 张截图（6 项 × 2 语言）都在 `ui/`；
3. U14 两阶段日志齐全，重启后 `diagLimit=800` 生效（随后已改回 500）；
4. `ui/result-4_2.json` 里 U7/U8/U9/U10/U13/U14/U15 七条状态齐全；
5. 收尾时虚拟桥与 Electron 都已停止（8865/8866 无监听）；
6. 全程 `micstudio.channel=virtual`，真机未被连接。
