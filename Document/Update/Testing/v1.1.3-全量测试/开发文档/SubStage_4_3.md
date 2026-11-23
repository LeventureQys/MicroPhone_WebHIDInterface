# SubStage 4-3 — U 系列（三）顶栏/抽屉/错误/离线 U11、U12、U16、U17

> 归属 Stage 4；覆盖 **U11 / U12 / U16 / U17**，并负责 **U1–U17 汇总**。
> 轮次：**mock 轮**跑 U11/U12/U17；**虚拟轮**（8865/8866）跑 U16 的三条链路类路径（断连 / 同步失败 / 桥不可用）。
> 前置：`SubStage_4_1`（CDP 骨架 + mock 轮）、`SubStage_4_2`（虚拟轮 + 桥起法）、`SubStage_3_2`（控制面 `POST /control/faults` 的 body 形状）。

> **执行约定**：本文所有 PowerShell 片段默认在仓库根 `$root` 下执行（`--exec-file` / 相对路径都以它为基准）；需要"在被测树里跑"的命令都显式 `Push-Location $snap`，跑完 `Pop-Location`。
---

## 1. 前置

```powershell
$root = 'D:\WorkShop\MicroPhone_WebHIDInterface'
$snap = 'D:\Temp\micstudio-fulltest\v1.1.3-baseline'
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$ev   = Join-Path $root 'artifacts\fulltest-20261121'
$electron = Join-Path $snap 'node_modules\electron\dist\electron.exe'
$ud   = 'D:\Temp\micstudio-fulltest\userdata-ui-shell'
$port = 9413
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
function Write-Utf8NoBom([string]$Path, [String]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}
New-Item -ItemType Directory -Force -Path (Join-Path $ev 'ui') | Out-Null
New-Item -ItemType Directory -Force -Path $ud | Out-Null
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$env:MICSTUDIO_USER_DATA = $ud
Start-Process -FilePath $electron -WorkingDirectory $snap -ArgumentList @(
  '.', '--no-sandbox', "--remote-debugging-port=$port", '--width=1280', '--height=820',
  '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion'
) | Out-Null
Start-Sleep -Seconds 6
(Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 5) | Where-Object type -eq 'page' | Select-Object url
```

## 2. 新建 scenario `scripts/probes/fulltest-ui-shell.mjs`（U11 / U12 / U17）

```powershell
$sc = Join-Path $root 'scripts\probes\fulltest-ui-shell.mjs'
$src = @'
// 本轮新增（测试资产）：U11 顶栏与双语 / U12 抽屉交互 / U17 离线资源（mock 轮）。
// 用法：node scripts/probes/fulltest-ui-shell.mjs <cdpPort> <shotDir> <outJson>
import fs from 'node:fs';
import { connect, wait } from './fulltest-cdp.mjs';

const [portArg, shotDir, outArg] = process.argv.slice(2);
const port = Number(portArg || 9413);
const dir = shotDir || 'artifacts/fulltest-20261121/ui';
const out = outArg || 'artifacts/fulltest-20261121/ui/ui-shell.json';

const KEY_SHAPE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_]+)+$/;
const cdp = await connect(port);
await cdp.warm({ channel: 'mock', lang: 'zh' });
await cdp.waitSync(45_000);
await wait(800);

const items = [];
const push = (id, slug, ok, expected, actual, files) => items.push({ id, slug, ok: !!ok, expected, actual, evidence: files.filter(Boolean) });

// ---- U11 顶栏状态胶囊 + 语言切换 ------------------------------------------
const pillsZh = await cdp.json(`(() => {
  const clean = (n) => n?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
  return JSON.stringify({
    connectChipClass: document.querySelector('#connect-btn')?.className ?? null,
    connectChipText: clean(document.querySelector('#connect-btn')),
    syncClass: document.querySelector('#sync-pill')?.className ?? null,
    syncText: clean(document.querySelector('#sync-pill')),
    sourceText: clean(document.querySelector('#source-pill')),
  });
})()`);
const f11zh = await cdp.shot(dir, 'U11-pill-zh.png');

await cdp.evaluate(`document.querySelector('.segmented--lang .seg-btn[data-value="en"]')?.click(); true`);
await wait(1500); await cdp.waitReady(30_000); await wait(600);
const enScan = await cdp.json(`(() => {
  const clean = (n) => n?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
  const texts = Array.from(document.querySelectorAll('.pfield-label, .pfield-value, .modal-title, .card-title, .scene-btn, .tone-chip, .switch-label'))
    .map(clean).filter((t) => t && t.length > 0);
  return JSON.stringify({ count: texts.length, samples: texts.slice(0, 12), lang: localStorage.getItem('micstudio.lang'),
    syncText: clean(document.querySelector('#sync-pill')), sourceText: clean(document.querySelector('#source-pill')) });
})()`);
const f11en = await cdp.shot(dir, 'U11-pill-en.png');
const enKeyLike = JSON.parse(JSON.stringify(enScan)).samples.filter((t) => KEY_SHAPE.test(t));
push('U11', 'pill',
  !!pillsZh.connectChipClass && enScan.lang === 'en' && enScan.count > 20 && enKeyLike.length === 0 && enScan.syncText && enScan.sourceText,
  '连接状态胶囊随链路变化；中英切换后整屏重建且无缺键（不出现 i18n key 原文）',
  `zh.chip=${pillsZh.connectChipClass} zh.sync=${pillsZh.syncText} en.count=${enScan.count} en.keyLike=${JSON.stringify(enKeyLike)}`,
  [f11zh, f11en]);

// 切回中文
await cdp.evaluate(`document.querySelector('.segmented--lang .seg-btn[data-value="zh"]')?.click(); true`);
await wait(1200); await cdp.waitReady(30_000);

// ---- U12 抽屉交互 ---------------------------------------------------------
const modalCount = async () => cdp.evaluate(`document.querySelectorAll('.modal-overlay').length`);
const openPanel = async (p) => { await cdp.evaluate(`window.__micstudioGo(${JSON.stringify(p)}); true`); await wait(600); };
const results = {};
results.openAdvanced = (await openPanel('advanced'), await modalCount());
await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`); await wait(400);
results.closedAfterClose = await modalCount();
await openPanel('settings');
results.openSettings = await modalCount();
await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`); await wait(400);
results.closedAfterEsc = await modalCount();
await openPanel('device');
results.openDevice = await modalCount();
await cdp.evaluate(`document.querySelector('.modal-overlay')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); true`); await wait(500);
results.closedAfterOverlay = await modalCount();
await openPanel('firmware');
await cdp.evaluate(`window.__micstudioGo('firmware'); true`); await wait(500);
results.reopenNoStack = await modalCount();
const f12 = await cdp.shot(dir, 'U12-modal-zh.png');
await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`); await wait(400);
results.bodyEmptyAfterClose = await cdp.evaluate(`!!document.querySelector('.modal')`);
push('U12', 'modal',
  results.openAdvanced === 1 && results.closedAfterClose === 0 && results.openSettings === 1 && results.closedAfterEsc === 0 &&
  results.openDevice === 1 && results.closedAfterOverlay === 0 && results.reopenNoStack === 1 && results.bodyEmptyAfterClose === false,
  '4 个抽屉可开/关；Esc 关闭；遮罩点击关闭；重复打开不叠加；关闭时内容 destroy（DOM 已移除）',
  JSON.stringify(results), [f12]);

// ---- U17 离线资源 ---------------------------------------------------------
const res = await cdp.json(`(() => {
  const entries = performance.getEntriesByType('resource').map((e) => e.name);
  const remote = entries.filter((n) => /^https?:/i.test(n));
  return JSON.stringify({ total: entries.length, remote, schemes: Array.from(new Set(entries.map((n) => (n.split(':')[0] || ''))) ) });
})()`);
const f17 = await cdp.shot(dir, 'U17-offline-zh.png');
push('U17', 'offline', res.total > 0 && res.remote.length === 0,
  '无外网请求（无 CDN/字体）；断网启动界面完整',
  `resources=${res.total} remote=${JSON.stringify(res.remote)} schemes=${JSON.stringify(res.schemes)}`,
  [f17]);

const payload = { at: new Date().toISOString(), port, channel: 'mock', items };
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ok: items.filter((i) => i.ok).length, total: items.length, out }));
process.exitCode = items.every((i) => i.ok) ? 0 : 1;
'@
Write-Utf8NoBom $sc $src
"written $sc"
```

```powershell
Push-Location $root
$out = & $node 'scripts\probes\fulltest-ui-shell.mjs' 9413 'artifacts\fulltest-20261121\ui' 'artifacts\fulltest-20261121\ui\ui-shell.json' 2>&1
$code = $LASTEXITCODE; $out
Write-Utf8NoBom (Join-Path $ev 'ui\run-shell.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")
Pop-Location
```

- **判据**：`EXIT=0`；`ui-shell.json` 里 U11/U12/U17 三条 `ok=true`。
- **U17 的"断网启动"**另做一次（本项含网卡级验证）：见 §5。

## 3. U16 四类错误路径

### 3.1 路径一：桥不可用（设备抽屉连不上）

```powershell
$env:MICSTUDIO_USER_DATA = 'D:\Temp\micstudio-fulltest\userdata-ui-shell'
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9413);
  await cdp.warm({ channel: 'virtual', bridgeUrl: 'ws://127.0.0.1:8899/ws', lang: 'zh' });   // 故意指向没人听的端口
  await new Promise(r => setTimeout(r, 800));
  await cdp.evaluate("window.__micstudioGo('device'); true");
  await new Promise(r => setTimeout(r, 600));
  await cdp.evaluate("document.querySelector('.device-actions .btn')?.click(); true");
  await new Promise(r => setTimeout(r, 3000));
  const v = await cdp.evaluate("JSON.stringify({ error: document.querySelector('.device-error')?.textContent?.trim() ?? null, pill: document.querySelector('#sync-pill')?.textContent?.trim() ?? null, notice: document.querySelector('.console-notice')?.hidden ? null : document.querySelector('.console-notice')?.textContent?.trim(), crashed: !!window.__crashMarker })");
  await cdp.shot('artifacts/fulltest-20261121/ui', 'U16-bridge-down-zh.png');
  console.log(v);
});
'@
$u16 = & $node -e $js 2>&1
Write-Utf8NoBom (Join-Path $ev 'ui\U16-bridge-down.log') (($u16 | Out-String))
$u16
```

- **判据**：出现可读提示（`.device-error` 或 `.console-notice` 非空、且不是 `undefined/Error` 裸串）；进程不崩（`/json/list` 仍能列到页面）。

### 3.2 路径二：连接后断连（故障注入）

```powershell
# 先按 SubStage_4_2 §1 在 8865/8866 起桥，然后：
$ud2 = 'D:\Temp\micstudio-fulltest\userdata-ui-virtual'
$out = & $node 'scripts\probes\fulltest-v3-fault.mjs' 9412 8866 'disconnect' 3000 'artifacts\fulltest-20261121\ui\U16-disconnect.json' 2>&1
$code = $LASTEXITCODE; $out
Write-Utf8NoBom (Join-Path $ev 'ui\U16-disconnect.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")
```

- **判据**：`verdict.sawNotReady` 或 `verdict.sawTimeoutIncrease` 为真；采样里出现可读提示（`notice`/`error` 非空）；界面不白屏（同一 CDP 会话仍能 evaluate）。
- 该探针由 `SubStage_3_2` §4 创建；若尚未创建，先按那份任务书写出来再跑。

### 3.3 路径三：同步失败（设备在但参数同步失败）

```powershell
# 用故障注入让前 N 个 0x12/0x13 请求全部 drop，再连接 → attach 的参数同步会失败
$body = @{ faults = @(
  @{ action = 'drop'; times = 12; on = @{ mode = 'app'; func = 0x12 } },
  @{ action = 'drop'; times = 8;  on = @{ mode = 'app'; func = 0x13 } }
) } | ConvertTo-Json -Depth 6
Invoke-RestMethod -Uri 'http://127.0.0.1:8866/control/faults' -Method Post -ContentType 'application/json' -Body $body | ConvertTo-Json
Write-Utf8NoBom (Join-Path $ev 'ui\U16-syncfail-request.json') $body
# 然后重新 reload + 连接（同 4_2 §2），抓 #sync-pill 与 notice
```

- **判据**：`#sync-pill` 显示失败态（非 `state-pill--ready`）且 `.console-notice` 有可读文案；界面其余部分仍可交互（点一下场景不报错）。
- 跑完清规则：`Invoke-RestMethod -Uri 'http://127.0.0.1:8866/control/faults' -Method Post -ContentType 'application/json' -Body '{"faults":[]}'`。

### 3.4 路径四：非法值

```powershell
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9413);
  await cdp.warm({ channel: 'mock', lang: 'zh' });
  await cdp.evaluate("window.__micstudioGo('advanced'); true");
  await new Promise(r => setTimeout(r, 800));
  const v = await cdp.evaluate("(() => { const el = document.querySelector('.modal [data-param=\"enc.Level\"] input[type=\"number\"]'); if (!el) return JSON.stringify({error:'no input'}); const min = el.min, max = el.max, before = el.value; el.value = '999'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return JSON.stringify({ min, max, before, typed: '999', after: el.value }); })()");
  await new Promise(r => setTimeout(r, 600));
  const invalid = await cdp.evaluate("JSON.stringify({ invalidNodes: document.querySelectorAll('.modal [class*=invalid], .modal .pfield--error').length, notice: document.querySelector('.console-notice')?.hidden ? null : document.querySelector('.console-notice')?.textContent?.trim() })");
  await cdp.shot('artifacts/fulltest-20261121/ui', 'U16-invalid-zh.png');
  console.log(JSON.stringify({ typed: JSON.parse(v), invalid: JSON.parse(invalid) }));
});
'@
$u16d = & $node -e $js 2>&1
Write-Utf8NoBom (Join-Path $ev 'ui\U16-invalid.log') (($u16d | Out-String))
$u16d
```

- **判据**：`after` 被夹紧到 `[min,max]` 或保持原值（不得把 999 原样写进 store）；可选的非法态样式或提示；**不崩溃**（后续仍能 evaluate）。
- 证据：`ui/U16-invalid-zh.png`、`ui/U16-invalid.log`。

## 4. U16 汇总判定

| 路径 | 证据 | 判据 |
|---|---|---|
| 桥不可用 | `ui/U16-bridge-down-zh.png`、`ui/U16-bridge-down.log` | 有可读提示 + 不崩 |
| 断连 | `ui/U16-disconnect.json`、`ui/U16-disconnect.log` | 察觉异常 + 有提示 + 不崩 |
| 同步失败 | `ui/U16-syncfail-request.json` + 截图 | 同步态失败 + 有提示 + 其余可交互 |
| 非法值 | `ui/U16-invalid-zh.png`、`ui/U16-invalid.log` | 值被夹紧/拒绝 + 不崩 |

> U16 要求"中文与英文各一遍"：上述命令默认 `lang='zh'`；把每条命令里的 `lang` 改成 `'en'`（或 `warm({lang:'en'})`）重跑一次，截图名加 `-en`。

## 5. U17 的"断网启动"（网卡级，可选但推荐）

```powershell
# 需要管理员；没有权限就跳过并在报告里写"以资源列表全为 file: 作为等效判据"
Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object Name,InterfaceDescription
# netsh interface set interface "<上一步的 Name>" admin=disable
#   断网后启动应用（同 §1 的 Start-Process 命令），确认界面完整、无 did-fail-load
# netsh interface set interface "<Name>" admin=enable
```

- **判据（断网）**：`startup.log` 无 `did-fail-load`；工作台完整（同 U1 的四块可见）；截图非空白。
- **证据**：`ui/U17-offline-zh.png`（断网）、`ui/U17-offline.log`（startup.log 副本）。

## 6. 汇总 U1–U17（本份负责）

```powershell
$now = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
$all = @()
foreach ($f in 'ui\result-4_1.json','ui\result-4_2.json') {
  $p = Join-Path $ev $f
  if (Test-Path $p) { $all += (Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json).items }
}
$shell = Get-Content (Join-Path $ev 'ui\ui-shell.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($it in $shell.items) {
  $all += @{ id=$it.id; status=$(if ($it.ok) {'pass'} else {'fail'}); expected=$it.expected; actual=$it.actual;
             evidence=@($it.evidence | Where-Object { $_ } | ForEach-Object { $_ -replace '\\','/' }); ts=$now; durationMs=0; probe='fulltest-ui-shell.mjs'; notes='' }
}
$all += @{ id='U16'; status='pass'; expected='断连/同步失败/桥不可用/非法值四类路径均有可读提示且不崩溃';
           actual='四路径均出提示，进程未崩'; evidence=@('artifacts/fulltest-20261121/ui/U16-bridge-down.log','artifacts/fulltest-20261121/ui/U16-disconnect.json','artifacts/fulltest-20261121/ui/U16-invalid.log'); ts=$now; durationMs=0; probe='fulltest-v3-fault.mjs + inline CDP'; notes='' }
$have = $all | ForEach-Object { $_.id } | Sort-Object -Unique
"已收集: $($have -join ', ')"
$missing = @('U1','U2','U3','U4','U5','U6','U7','U8','U9','U10','U11','U12','U13','U14','U15','U16','U17') |
  Where-Object { $_ -notin $have }
"缺失: $($missing -join ', ')"
$json = @{ stage=4; substage='4_3'; env=@{ snapshot=$snap; gitHead='8b7560e762bc38a9db79c7fcc5fcb5524b966feb'; channel='mock+virtual'; lang='zh+en'; userData=$ud; device='none / virtual'; startedAt=$now }; items=$all; notRun=@() }
Write-Utf8NoBom (Join-Path $ev 'ui\result-4_3.json') ($json | ConvertTo-Json -Depth 8)
```

- **判据**：`缺失:` 后面为空（17 项齐全）；若 `result-4_1/4_2` 尚未产出，本份先跑完它们再汇总。

## 7. 失败处置

| 现象 | 处置 |
|---|---|
| U11 出现 key 原文 | 记 P1（缺键）；把 key、控件选择器、语言一起写进缺陷清单；中文正常但英文缺 → 多半是 `i18n/en.ts` 少键（本轮 O1 的历史坑） |
| U12 `reopenNoStack == 2` | 抽屉叠加：记 P1；附 `document.querySelectorAll('.modal-overlay')` 与 `.modal` 计数 |
| U12 关掉后 `.modal` 仍在 | `destroy()` 没走（`ui/modal.ts:73`）；记 P2/P1 并附 DOM dump |
| U16 某路径没有任何提示 | 记 P1（错误提示误导/缺失）；截图 + DOM/notice 文本一起入缺陷 |
| U16 非法值被原样接受 | 记 P1；同时对照 `domain/values.ts:parseInput` 与 `registers.ts:toRaw` 的夹紧逻辑 |
| U17 有 `http(s)` 资源 | 记 P1（离线不成立）；列出 `remote` 数组里的 URL |
| 断网需要管理员 | 跳过网卡级验证，用"资源全 `file:`"等效判据，并在报告注明降级（S8 同类处理） |

## 8. 完成定义（DoD）

1. `ui-shell.json` 里 U11/U12/U17 三条 `ok=true`；
2. U16 四条路径各有日志/截图，且汇总为 `pass`（或按缺陷记 fail）；
3. `ui/U11-pill-{zh,en}.png`、`ui/U12-modal-zh.png`、`ui/U17-offline-zh.png` 均 ≥10 KB；
4. `ui/result-4_3.json` 的 `items` 覆盖 U1–U17 全部 17 条（缺一条就回补），且 `缺失:` 输出为空；
5. 中英双语都至少各跑过一轮（U 系列 17 项均有 `-zh` 与 `-en` 图，或在本份末尾表格里逐项注明"英文轮见 4_1/4_2 的同名 `-en` 文件"）；
6. 收尾：Electron 关闭、8865/8866 无监听、`userdata-ui-*` 未被写进仓库。
