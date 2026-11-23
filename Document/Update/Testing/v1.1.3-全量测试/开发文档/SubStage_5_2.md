# SubStage 5-2 — R 系列（二）参数对账 / 逐项写入回读 / 场景回读 R4–R6

> 归属 Stage 5；覆盖 **R4 / R5 / R6**。
> 前置：`SubStage_5_1` 已通过（R1 只读快照成立、R2 自动连接、R3 自检 3/3）；`SubStage_4_1` 的 `scripts/probes/fulltest-cdp.mjs`、`SubStage_3_1` 的 `scripts/probes/fulltest-app-params.js` 与 `scripts/probes/fulltest-param-audit.mjs` 已创建。
> **本份开始写设备**。铁律：①每次写前后都能用裸 HID 回读；②两段之间必须**先关应用**再跑裸 HID（互斥，见设计文档 §5.5）；③结束时按 R12 还原（`SubStage_5_3`）。
> 写口径：`TIMING.writeTimeoutMs=3000`、`writeRetries=1`、`writeSettleMs=600`、`writeGraceMs=8000`（坑 27）——看到写静默 1–2 s 属正常落 Flash，不要判掉线。

> **执行约定**：本文所有 PowerShell 片段默认在仓库根 `$root` 下执行（`--exec-file` / 相对路径都以它为基准）；需要"在被测树里跑"的命令都显式 `Push-Location $snap`，跑完 `Pop-Location`。
---

## 1. 前置

```powershell
$root = 'D:\WorkShop\MicroPhone_WebHIDInterface'
$snap = 'D:\Temp\micstudio-fulltest\v1.1.3-baseline'
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$py   = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$ev   = Join-Path $root 'artifacts\fulltest-20261121'
$electron = Join-Path $snap 'node_modules\electron\dist\electron.exe'
$ud   = 'D:\Temp\micstudio-fulltest\userdata-real'
$port = 9421
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
function Write-Utf8NoBom([string]$Path, [String]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}
function Start-AppReal {
  Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $env:MICSTUDIO_USER_DATA = $ud
  Start-Process -FilePath $electron -WorkingDirectory $snap -ArgumentList @(
    '.', '--no-sandbox', "--remote-debugging-port=$port", '--width=1280', '--height=820',
    '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion'
  ) | Out-Null
  Start-Sleep -Seconds 6
}
function Read-BareHid([string]$tag) {
  Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  & $py (Join-Path $root 'scripts\probes\real8-health.py') $tag | Out-Null
  Copy-Item (Join-Path $root "artifacts\dfu-check-20261121\health-$tag.json") (Join-Path $ev "real\R-$tag-registers.json") -Force
  "bare-hid snapshot: real\R-$tag-registers.json"
}
```

| # | 检查 | 命令 | 期望 |
|---|---|---|---|
| 1 | R1/R2/R3 已有结论 | `Get-Content (Join-Path $ev 'real\result-5_1.json') -Raw -Encoding UTF8` | 三条 `status` 不是 `blocked` |
| 2 | 设备在位、无进程占用 | 同 `SubStage_5_1` §1 第 1/2 项 | 通过 |
| 3 | 记一次「写前快照」 | `Read-BareHid 'r5-before'` | 生成 `real\R-r5-before-registers.json`（**任何写操作之前**必须有它） |

## 2. 新建探针 `scripts/probes/fulltest-param-write.mjs`（写入 + 校验两模式）

```powershell
$p = Join-Path $root 'scripts\probes\fulltest-param-write.mjs'
$src = @'
// 本轮新增（测试资产）：R5 逐项写入（CDP）与回读校验（离线）。
// 写入：node scripts/probes/fulltest-param-write.mjs write  <cdpPort> <writePlanJson>
// 校验：node scripts/probes/fulltest-param-write.mjs verify <writePlanJson> <registersJson> <outJson>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connect, wait } from './fulltest-cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const importTs = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const reg = await importTs('src/renderer/src/device/registers.ts');
const prm = await importTs('src/renderer/src/domain/params.ts');

const mode = process.argv[2];

if (mode === 'write') {
  const port = Number(process.argv[3] || 9421);
  const planPath = process.argv[4] || 'artifacts/fulltest-20261121/real/R5-write-plan.json';
  const cdp = await connect(port);
  await cdp.waitSync(60_000);
  await cdp.evaluate(`window.__micstudioGo('advanced'); true`);
  await wait(900);

  const plan = [];
  for (const spec of prm.PARAMS) {
    const rspec = reg.findRegister(spec.addr);
    if (rspec.access !== 'rw') { plan.push({ id: spec.id, addr: spec.addr, skip: 'readonly' }); continue; }
    const target = rspec.max;                        // 用上限做"可见变化"
    const raw = reg.toRaw(rspec, target);
    const before = await cdp.evaluate(`(() => { const n = document.querySelector('.modal [data-param="${spec.id}"]'); return n ? n.querySelector('input')?.value ?? null : 'no-node'; })()`);
    const applied = await cdp.evaluate(`(() => {
      const box = document.querySelector('.modal [data-param="${spec.id}"]');
      if (!box) return 'no-node';
      const cb = box.querySelector('input[type="checkbox"]');
      if (cb) { if (!cb.checked) cb.click(); return 'checkbox'; }
      const segs = Array.from(box.querySelectorAll('.seg-btn'));
      if (segs.length) { const last = segs[segs.length - 1]; last.click(); return 'seg:' + (last.dataset.value ?? ''); }
      const num = box.querySelector('input[type="number"]');
      if (num) { num.value = String(${JSON.stringify(target)}); num.dispatchEvent(new Event('input', { bubbles: true })); num.dispatchEvent(new Event('change', { bubbles: true })); return 'number'; }
      return 'none';
    })()`);
    await wait(450);
    const after = await cdp.evaluate(`(() => { const n = document.querySelector('.modal [data-param="${spec.id}"]'); return n ? (n.querySelector('input[type="number"]')?.value ?? null) : null; })()`);
    const stats = await cdp.evaluate(`JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((n) => [n.dataset.stat, n.textContent.trim()])))`);
    plan.push({ id: spec.id, addr: spec.addr, field: rspec.field, target, raw, before, applied, after, stats: JSON.parse(stats) });
  }
  fs.mkdirSync(path.dirname(path.resolve(root, planPath)), { recursive: true });
  fs.writeFileSync(path.resolve(root, planPath), JSON.stringify({ at: new Date().toISOString(), plan }, null, 2) + '\n', 'utf8');
  const writable = plan.filter((x) => !x.skip);
  console.log(JSON.stringify({ total: plan.length, writable: writable.length, appliedKinds: writable.map((x) => String(x.applied).split(':')[0]).reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {}) }));
} else if (mode === 'verify') {
  const planPath = process.argv[3];
  const rawPath = process.argv[4];
  const outPath = process.argv[5];
  const plan = JSON.parse(fs.readFileSync(path.resolve(root, planPath), 'utf8')).plan;
  const raw = JSON.parse(fs.readFileSync(path.resolve(root, rawPath), 'utf8').replace(/^\uFEFF/, ''));
  const preset = raw.raw?.preset ?? raw.preset ?? [];
  const wordAt = (a) => preset[a - 0x2000];
  const rows = []; let ok = 0, bad = 0, skipped = 0;
  for (const item of plan) {
    if (item.skip) { skipped += 1; continue; }
    const rspec = reg.findRegister(item.addr);
    const readRaw = wordAt(item.addr);
    const match = Number.isFinite(readRaw) && readRaw === item.raw;
    if (match) ok += 1; else bad += 1;
    rows.push({ id: item.id, addr: `0x${item.addr.toString(16).toUpperCase()}`, expectRaw: item.raw, readRaw: Number.isFinite(readRaw) ? readRaw : null, match });
  }
  const payload = { at: new Date().toISOString(), plan: planPath, registers: rawPath, summary: { total: rows.length, ok, bad, skipped }, ok: ok >= 40 && bad === 0, rows };
  fs.mkdirSync(path.dirname(path.resolve(root, outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(root, outPath), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(payload.summary));
  process.exitCode = payload.ok ? 0 : 1;
} else {
  console.error('usage: write <cdpPort> <plan> | verify <plan> <registers> <out>');
  process.exitCode = 2;
}
'@
Write-Utf8NoBom $p $src
"written $p"
```

## 3. R4 46 项界面值 ⇄ 寄存器真值

```powershell
Start-AppReal
Push-Location $root
$appShot = Join-Path $ev 'real\R4-app-params.png'
Push-Location $snap
$out = & $electron '.' '--no-sandbox' "--screenshot=$appShot" '--exec-file=scripts/probes/fulltest-app-params.js' '--width=1280' '--height=820' 2>&1
Pop-Location
$code = $LASTEXITCODE
Write-Utf8NoBom (Join-Path $ev 'real\R4-app-params.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")
$line = ($out | Where-Object { $_ -match '^\[probe\]' } | Select-Object -Last 1)
if (-not $line) { throw 'R4 探针无输出' }
Write-Utf8NoBom (Join-Path $ev 'real\R4-app-params.json') ($line -replace '^\s*\[probe\]\s*', '')

# 裸 HID 只读快照（关应用后）
Read-BareHid 'r4'
Move-Item (Join-Path $ev 'real\R-r4-registers.json') (Join-Path $ev 'real\R4-registers.json') -Force

# 46 项对账（与 P1 同一脚本）
$out = & $node 'scripts\probes\fulltest-param-audit.mjs' `
  'artifacts\fulltest-20261121\real\R4-app-params.json' `
  'artifacts\fulltest-20261121\real\R4-registers.json' `
  'artifacts\fulltest-20261121\real\R4-compare.json' 2>&1
$code = $LASTEXITCODE
Pop-Location
$out
Write-Utf8NoBom (Join-Path $ev 'real\R4-compare.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")
```

- **判据**：`summary.fail=0`、`missing=0`、`items=46`、`readonlyNoNode=2`；`gain.Mic`/`gain.Hp` 两条 `readonly=true` 且 `state="readonly-no-control"`（R4 的"只读项 2 个无控件"——它们在主界面是只读读数，不在高级参数里）。
- 证据：`real/R4-app-params.json`、`real/R4-registers.json`、`real/R4-compare.json`、`real/R4-app-params.png`。

## 4. R5 逐项写入 → 裸 HID 回读

```powershell
# 4.1 写入（应用占设备）
Start-AppReal
Push-Location $root
$out = & $node 'scripts\probes\fulltest-param-write.mjs' write 9421 'artifacts\fulltest-20261121\real\R5-write-plan.json' 2>&1
$code = $LASTEXITCODE
$out
Write-Utf8NoBom (Join-Path $ev 'real\R5-write.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")
if ($code -ne 0) { throw "R5 写入段失败 exit=$code" }

# 4.2 回读（裸 HID）
Read-BareHid 'r5'
Move-Item (Join-Path $ev 'real\R-r5-registers.json') (Join-Path $ev 'real\R5-registers.json') -Force

# 4.3 校验
$out = & $node 'scripts\probes\fulltest-param-write.mjs' verify `
  'artifacts\fulltest-20261121\real\R5-write-plan.json' `
  'artifacts\fulltest-20261121\real\R5-registers.json' `
  'artifacts\fulltest-20261121\real\R5-writes.json' 2>&1
$code = $LASTEXITCODE
Pop-Location
$out
Write-Utf8NoBom (Join-Path $ev 'real\R5-verify.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")
```

- **判据**：`summary.ok >= 40`（需求：≥40 项，除只读）且 `summary.bad == 0`；`skipped=2`（`gain.Mic`/`gain.Hp`）。
- **ACK 时延**：`R5-write-plan.json` 每条都有 `stats`（`out/in/timeout/retry`），把最后一条与第一条的差值算出来写进报告；另可用 `tools/dfu/m001-dfu.py` 的同类读取测单次往返（可选）。
- **若 `bad>0`**：逐条看 `rows` 里 `expectRaw` 与 `readRaw`。常见原因：①该项被固件夹紧（如只读或范围不校验）②写入未落盘（等更久重读）③`applied` 是 `seg:` 但实际点到了别的档。属固件问题就记"固件侧遗留"，属上位机就记 P1。
- 证据：`real/R5-write-plan.json`、`real/R5-writes.json`、`real/R5-write.log`、`real/R5-verify.log`、`real/R5-registers.json`。

## 5. R6 场景写入回读（4 固定 + 自定义）

每个场景一轮：点场景 → 抓界面 12 个值 → 关应用 → 裸 HID 回读 → 46 项对账（证明界面与设备一致）→ 记录。5 轮。

```powershell
$sceneProbe = Join-Path $root 'scripts\probes\fulltest-scene-click.mjs'
$src = @'
// 本轮新增（测试资产）：点一个场景并 dump 关键读数（供 R6 逐场景回读）。
// 用法：node scripts/probes/fulltest-scene-click.mjs <cdpPort> <sceneId> <outJson>
import fs from 'node:fs';
import path from 'node:path';
import { connect, wait } from './fulltest-cdp.mjs';
const [portArg, sceneId, outArg] = process.argv.slice(2);
const cdp = await connect(Number(portArg || 9421));
await cdp.waitSync(60_000);
await cdp.evaluate(`window.__micstudioGo('advanced'); true`); await wait(700);
const before = await cdp.evaluate(`JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('.modal [data-param]')).map((n) => [n.dataset.param, (n.querySelector('input[type="number"]')?.value ?? n.querySelector('input[type="checkbox"]')?.checked ?? n.querySelector('.seg-btn.is-active')?.dataset.value ?? null)])))`);
await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`); await wait(400);
await cdp.evaluate(`document.querySelector('.scene-btn[data-scene="${sceneId}"]')?.click(); true`);
await wait(2500);   // 写合并 300ms 尾沿 + 落 Flash 宽限
await cdp.evaluate(`window.__micstudioGo('advanced'); true`); await wait(800);
const snap = await cdp.evaluate(`JSON.stringify({
  scene: document.querySelector('.scene-btn[aria-pressed="true"]')?.dataset.scene ?? null,
  params: Object.fromEntries(Array.from(document.querySelectorAll('.modal [data-param]')).map((n) => [n.dataset.param, (n.querySelector('input[type="number"]')?.value ?? n.querySelector('input[type="checkbox"]')?.checked ?? n.querySelector('.seg-btn.is-active')?.dataset.value ?? null)])),
  eq: Array.from(document.querySelectorAll('.modal .eq-row[data-band]')).map((row) => { const i = Array.from(row.querySelectorAll('input[type="number"]')); return { band: Number(row.dataset.band), type: row.querySelector('select')?.value ?? null, freq: i[0]?.value ?? null, gain: i[1]?.value ?? null, q: i[2]?.value ?? null }; }),
  stats: Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((n) => [n.dataset.stat, n.textContent.trim()]))
})`);
await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`); await wait(300);
fs.mkdirSync(path.dirname(path.resolve(outArg)), { recursive: true });
fs.writeFileSync(path.resolve(outArg), JSON.stringify({ at: new Date().toISOString(), sceneId, before: JSON.parse(before), after: JSON.parse(snap) }, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ sceneId, active: JSON.parse(snap).scene, stats: JSON.parse(snap).stats }));
'@
Write-Utf8NoBom $sceneProbe $src
"written $sceneProbe"

# 逐场景循环
Push-Location $root
$sceneIds = @('quiet','meeting','podcast','sing','custom')
foreach ($sid in $sceneIds) {
  Start-AppReal
  $out = & $node 'scripts\probes\fulltest-scene-click.mjs' 9421 $sid "artifacts\fulltest-20261121\real\R6-scene-$sid-ui.json" 2>&1
  Write-Utf8NoBom (Join-Path $ev "real\R6-$sid-ui.log") ((($out | Out-String).TrimEnd()) + "`nEXIT=$LASTEXITCODE`n")
  $out
  Read-BareHid "r6-$sid"
  Move-Item (Join-Path $ev "real\R-r6-$sid-registers.json") (Join-Path $ev "real\R6-$sid-registers.json") -Force
  $audit = & $node 'scripts\probes\fulltest-param-audit.mjs' `
    "artifacts\fulltest-20261121\real\R6-$sid-ui.json" `
    "artifacts\fulltest-20261121\real\R6-$sid-registers.json" `
    "artifacts\fulltest-20261121\real\R6-$sid-compare.json" 2>&1
  Write-Utf8NoBom (Join-Path $ev "real\R6-$sid-compare.log") ((($audit | Out-String).TrimEnd()) + "`nEXIT=$LASTEXITCODE`n")
  $audit
}
Pop-Location
```

> ⚠️ `fulltest-param-audit.mjs` 期望的界面快照结构是 `{params:[{id,...}]}`，而 `R6-*-ui.json` 的结构是 `{after:{params:{...}, eq:[...]}}`（**对象**不是数组）。执行前先做一次形状转换（下面这段），否则审计脚本会全判 `missing`：

```powershell
foreach ($sid in 'quiet','meeting','podcast','sing','custom') {
  $f = Join-Path $ev "real\R6-$sid-ui.json"
  $o = Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json
  $rows = @()
  foreach ($k in $o.after.params.PSObject.Properties.Name) {
    $v = $o.after.params.$k
    $isBool = $v -is [bool]
    $row = @{ id = $k; text = [string]$v; seg = $null; controls = 1 }
    if ($isBool) { $row.value = $null; $row.checked = $v } else { $row.value = $v; $row.checked = $null }
    $rows += $row
  }
  $shape = @{ at = $o.at; sceneId = $o.sceneId; params = $rows }
  Write-Utf8NoBom (Join-Path $ev "real\R6-$sid-app.json") ($shape | ConvertTo-Json -Depth 6)
}
# 再把上面 audit 命令里的 R6-$sid-ui.json 换成 R6-$sid-app.json 重跑
```

- **判据（每个场景）**：
  1. `active == 场景 id`；
  2. 该轮的审计 `summary.fail=0`（界面读数 = 设备回读，46 项）；
  3. 5 个固定场景的关键读数（噪声门阈值/压缩阈值/限制阈值/降噪开关/EQ 7 段增益）**彼此不完全相同**（把 5 轮 `after.params` 与 `after.eq` 并排打印比对，写进 `R6-scenes-summary.json`）；
  4. `custom` 场景的 EQ 7 段与其它场景不同（证明自定义生效）。
- 「与场景定义一致」由 **P5（定义侧 dump）** 证明；本份证明「点击 → 设备收到 → 回读一致」。报告里必须这样写，不得含糊。
- 证据：`real/R6-scene-<id>-ui.json`、`real/R6-<id>-registers.json`、`real/R6-<id>-compare.json`、`real/R6-scenes-summary.json`。

```powershell
$summary = @()
foreach ($sid in 'quiet','meeting','podcast','sing','custom') {
  $o = Get-Content (Join-Path $ev "real\R6-$sid-ui.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $c = Get-Content (Join-Path $ev "real\R6-$sid-compare.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $summary += [pscustomobject]@{
    scene = $sid
    active = $o.after.scene
    auditFail = $c.summary.fail
    gateThreshold = $o.after.params.'noisegate.threshold_db'
    eqGains = ($o.after.eq | ForEach-Object { $_.gain }) -join '|'
    stats = ($o.after.stats | ConvertTo-Json -Compress)
  }
}
$summary | Format-Table -AutoSize | Out-String -Width 200
Write-Utf8NoBom (Join-Path $ev 'real\R6-scenes-summary.json') ($summary | ConvertTo-Json -Depth 6)
```

## 6. 证据清单与结果 JSON

| 文件 | 覆盖 |
|---|---|
| `real/R4-app-params.json`、`real/R4-registers.json`、`real/R4-compare.json`、`real/R4-app-params.png` | R4 |
| `real/R5-write-plan.json`、`real/R5-registers.json`、`real/R5-writes.json`、`real/R5-write.log`、`real/R5-verify.log` | R5 |
| `real/R6-scene-*-ui.json`、`real/R6-*-registers.json`、`real/R6-*-compare.json`、`real/R6-scenes-summary.json` | R6 |
| `real/R-r5-before-registers.json`（写前快照） | 还原基线 |
| `real/result-5_2.json` | 三条状态 |

```powershell
$now = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
$r4 = Get-Content (Join-Path $ev 'real\R4-compare.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$r5 = Get-Content (Join-Path $ev 'real\R5-writes.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$s6 = Get-Content (Join-Path $ev 'real\R6-scenes-summary.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$items = @(
  @{ id='R4'; status=$(if ($r4.summary.fail -eq 0 -and $r4.items.Count -eq 46) {'pass'} else {'fail'});
     expected='46/46 一致；只读项 2 个无控件';
     actual=("items={0} fail={1} missing={2} readonlyNoNode={3}" -f $r4.items.Count, $r4.summary.fail, $r4.summary.missing, $r4.summary.readonlyNoNode);
     evidence=@('artifacts/fulltest-20261121/real/R4-compare.json','artifacts/fulltest-20261121/real/R4-app-params.png'); ts=$now; durationMs=0; probe='fulltest-param-audit.mjs'; notes='' },
  @{ id='R5'; status=$(if ($r5.ok -and $r5.summary.ok -ge 40) {'pass'} else {'fail'});
     expected='≥40 项（除只读）写入后裸 HID 回读一致；ACK 时延记录';
     actual=("ok={0} bad={1} skipped={2}" -f $r5.summary.ok, $r5.summary.bad, $r5.summary.skipped);
     evidence=@('artifacts/fulltest-20261121/real/R5-writes.json','artifacts/fulltest-20261121/real/R5-write-plan.json'); ts=$now; durationMs=0; probe='fulltest-param-write.mjs'; notes='' },
  @{ id='R6'; status=$(if (($s6 | Where-Object { $_.auditFail -ne 0 }).Count -eq 0 -and ($s6 | Where-Object { $_.active -ne $_.scene }).Count -eq 0) {'pass'} else {'fail'});
     expected='4 个固定场景 + 自定义，字段与 EQ 段全中（点击→设备→回读一致）';
     actual=("scenes={0} auditFail={1}" -f $s6.Count, (($s6 | ForEach-Object { $_.auditFail }) -join ','));
     evidence=@('artifacts/fulltest-20261121/real/R6-scenes-summary.json'); ts=$now; durationMs=0; probe='fulltest-scene-click.mjs + fulltest-param-audit.mjs'; notes='定义侧一致性见 P5' }
)
$json = @{ stage=5; substage='5_2'; env=@{ snapshot=$snap; gitHead='8b7560e762bc38a9db79c7fcc5fcb5524b966feb'; channel='native'; lang='zh'; userData=$ud; device='M001 0A67:0010'; startedAt=$now }; items=$items; notRun=@() }
Write-Utf8NoBom (Join-Path $ev 'real\result-5_2.json') ($json | ConvertTo-Json -Depth 8)
$items | ForEach-Object { '{0} {1}' -f $_.id, $_.status }
```

## 7. 失败处置

| 现象 | 处置 |
|---|---|
| 写入后读不到（`match=false` 全表） | ①应用还开着（HID 互斥）②写入没落盘（等 3 s 重读）③`toRaw` 夹紧（看 `expectRaw` 是否等于 `rawMaxOf`） |
| 个别项 `bad` | 记录到缺陷/固件遗留两栏；若连续 3 项以上属同类，合并成一条缺陷 |
| 写超时/`retry` 上涨 | 坑 27：这是落 Flash 慢，按 `writeGraceMs=8000` 判读；若 `timeout` 连续 3 次上涨 → 停止写入，先还原 |
| 审计 `missing` 很多 | 界面快照形状不对（见 §5 的形状转换提示）；先修转换再判 |
| 场景点击后 `active` 不对 | 场景按钮选择器 `/data-scene` 与实际不符；dump `.scene-btn` 的 `dataset` 确认 |
| 设备中途掉线 | 记 `blocked`；插回 → 先跑写前快照对比 → 继续；必要时先还原（`SubStage_5_3` R12） |

## 8. 完成定义（DoD）

1. `real/R5-*.json` 里 `summary.ok >= 40`、`bad == 0`、`skipped == 2`；
2. `real/R4-compare.json` 的 `fail=0`、`items=46`，且只读两项 `hasControl=false`；
3. 5 个场景各有 `ui/registers/compare` 三份证据，`R6-scenes-summary.json` 显示 `auditFail` 全 0、`active` 全对；
4. 写前快照 `real/R-r5-before-registers.json` 存在（还原基线）；
5. `real/result-5_2.json` 里 R4/R5/R6 状态齐全；
6. 结束时应用已关闭（准备进入 `SubStage_5_3` 的连续写与还原）。
