# SubStage 2-2 — 启动冒烟 G7（构建产物 + 打包产物）

> 归属 Stage 2；覆盖需求项 **N7 / N8**、门禁 **G7**。
> 前置：`SubStage_1_2.md`（G4 产物 `out/**`）、`SubStage_2_1.md`（G6 产物 `release\MicStudio-1.1.2-portable.exe`）。
> 铁律：**一律带 `--no-sandbox`**（坑 14 / 18）；`MICSTUDIO_USER_DATA` 指到仓库外（S7）；打包产物的 userData 由 `PORTABLE_EXECUTABLE_DIR` 自动决定（`src/main/index.ts:24-25`），落在 exe 同级 `MicStudioData\`。

> **执行约定**：本文所有 PowerShell 片段默认在仓库根 `$root` 下执行（`--exec-file` / 相对路径都以它为基准）；需要"在被测树里跑"的命令都显式 `Push-Location $snap`，跑完 `Pop-Location`。
---

## 0. 目标

对**两份产物**各做一次启动冒烟，证明"窗口能起来、页面能渲染、日志无崩溃、截图非空白"：

| 冒烟 | 对象 | 判据 |
|---|---|---|
| G7-a | 构建产物（`$snap\out\**` + `electron.exe .`） | 出图 ≥10 KB；`startup.log` 有 `ready` / `window-created` / `did-finish-load` / `[boot] renderer ready`；无 `uncaught` / `unhandledRejection` / `did-fail-load` |
| G7-b | 打包产物（portable exe） | 同上，且日志里有 `boot packaged=true`；窗口存活 **≥5 s**（`--hold=8000` 单独验证） |

## 1. 前置检查

```powershell
$root = 'D:\WorkShop\MicroPhone_WebHIDInterface'
$snap = 'D:\Temp\micstudio-fulltest\v1.1.3-baseline'
$ev   = Join-Path $root 'artifacts\fulltest-20261121'
$electron = Join-Path $snap 'node_modules\electron\dist\electron.exe'
$exe      = Join-Path $snap 'release\MicStudio-1.1.2-portable.exe'
$udBuild  = 'D:\Temp\micstudio-fulltest\userdata-g7-build'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}
New-Item -ItemType Directory -Force -Path (Join-Path $ev 'dist') | Out-Null
New-Item -ItemType Directory -Force -Path $udBuild | Out-Null
```

| # | 检查 | 命令 | 期望 |
|---|---|---|---|
| 1 | Electron 二进制 | `Test-Path $electron` | `True` |
| 2 | 构建产物齐全 | `foreach ($r in 'out\main\index.js','out\preload\index.js','out\renderer\index.html') { "$r -> $(Test-Path (Join-Path $snap $r))" }` | 三行 `True` |
| 3 | 打包产物存在 | `(Get-Item $exe).Length` | ≥ 52428800（50 MB） |
| 4 | 环境变量干净 | `if ($env:ELECTRON_RUN_AS_NODE) {'NOT-EMPTY'} else {'EMPTY'}` | `EMPTY`（坑 13：不清会让 exe 以 Node 模式静默退场） |
| 5 | 没有旧实例抢锁 | `Get-Process electron,MicStudio -ErrorAction SilentlyContinue` | 无输出；有则 `Stop-Process -Id <id> -Force` |
| 6 | 冒烟目录可写 | `New-Item -ItemType Directory -Force 'D:\Temp\micstudio-fulltest\userdata-g7-build' \| Out-Null; 'OK'` | `OK` |

## 2. G7-a 构建产物：`--screenshot`（一次成像）

```powershell
$shot1 = Join-Path $ev 'dist\G7-build-screenshot.png'
if (Test-Path $shot1) { Remove-Item $shot1 -Force }
$env:MICSTUDIO_USER_DATA = $udBuild
if (Test-Path (Join-Path $udBuild 'startup.log')) { Remove-Item (Join-Path $udBuild 'startup.log') -Force }

$sw = [System.Diagnostics.Stopwatch]::StartNew()
Push-Location $snap
$out = & $electron '.' '--no-sandbox' "--screenshot=$shot1" '--route=console' '--width=1280' '--height=820' 2>&1
Pop-Location
$code = $LASTEXITCODE
$sw.Stop()
Write-Utf8NoBom (Join-Path $ev 'dist\G7-build-run.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code ELAPSED_MS=$($sw.ElapsedMilliseconds)`nCMD=electron.exe . --no-sandbox --screenshot=$shot1 --route=console`n")
"EXIT=$code elapsed=$($sw.ElapsedMilliseconds)ms"
if (Test-Path $shot1) { "SHOT_BYTES=$((Get-Item $shot1).Length)" } else { 'SHOT_MISSING' }
if (Test-Path (Join-Path $udBuild 'startup.log')) {
  Copy-Item (Join-Path $udBuild 'startup.log') (Join-Path $ev 'dist\G7-build-startup.log') -Force
  Get-Content (Join-Path $ev 'dist\G7-build-startup.log') -Encoding UTF8 | Select-Object -Last 30
} else { 'STARTUP_LOG_MISSING' }
```

- **判据**：`EXIT=0`；`SHOT_BYTES >= 10240`；`startup.log` 四条标记齐全，且 **不匹配** `uncaught|unhandledRejection|did-fail-load`。
- 说明：`--screenshot` 走 `win.webContents.capturePage()`（`src/main/screenshot.ts:19-49`），出图后 `app.exit(0)`，所以退出码 0 是"脚本正常走完"，不是"窗口活了很久"——存活时长由 2.3 的 `--hold` 单独证明。

## 3. G7-a2 构建产物：`--hold=8000`（存活验证）

```powershell
$env:MICSTUDIO_USER_DATA = $udBuild
if (Test-Path (Join-Path $udBuild 'startup.log')) { Remove-Item (Join-Path $udBuild 'startup.log') -Force }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Push-Location $snap
$out = & $electron '.' '--no-sandbox' '--hold=8000' 2>&1
Pop-Location
$code = $LASTEXITCODE
$sw.Stop()
Copy-Item (Join-Path $udBuild 'startup.log') (Join-Path $ev 'dist\G7-build-hold-startup.log') -Force
Write-Utf8NoBom (Join-Path $ev 'dist\G7-build-hold.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code ELAPSED_MS=$($sw.ElapsedMilliseconds)`n")
"EXIT=$code elapsed=$($sw.ElapsedMilliseconds)ms"

# 日志标记核对（Select-String 的默认编码在 PS7 与 5.1 之间不同，统一用 .NET 读）
$text = [System.IO.File]::ReadAllText((Join-Path $ev 'dist\G7-build-hold-startup.log'), [System.Text.Encoding]::UTF8)
foreach ($pat in 'hold-mode 8000ms','hold-mode-finished','ready','window-created','did-finish-load','renderer ready','uncaught','did-fail-load') {
  '{0,-24} {1}' -f $pat, ($text -match [regex]::Escape($pat))
}
```

- **判据**：`EXIT=0`；`ELAPSED_MS >= 7500`（证明窗口真的存活了 8 s 而不是立刻退）；日志里同时出现 `hold-mode 8000ms` 与 `hold-mode-finished`（`src/main/index.ts:225-232`）。

## 4. G7-b 打包产物：`Start-Process`（等价双击）+ `--no-sandbox`

```powershell
$shot2 = Join-Path $ev 'dist\G7-portable-screenshot.png'
if (Test-Path $shot2) { Remove-Item $shot2 -Force }
$dataDir = Join-Path (Split-Path -Parent $exe) 'MicStudioData'
$dataExisted = Test-Path $dataDir

$proc = Start-Process -FilePath $exe -ArgumentList @("--screenshot=$shot2", '--no-sandbox') -PassThru
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline -and -not (Test-Path $shot2)) { Start-Sleep -Milliseconds 400 }
if (Test-Path $shot2) { "SHOT_BYTES=$((Get-Item $shot2).Length)" } else { "SHOT_MISSING exited=$($proc.HasExited) code=$($proc.ExitCode)" }
$proc.WaitForExit(10000) | Out-Null
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }

$logSrc = Join-Path $dataDir 'startup.log'
if (Test-Path $logSrc) {
  Copy-Item $logSrc (Join-Path $ev 'dist\G7-portable-startup.log') -Force
  Get-Content (Join-Path $ev 'dist\G7-portable-startup.log') -Encoding UTF8 | Select-Object -Last 30
} else { "STARTUP_LOG_MISSING ($logSrc)" }
```

- **判据**：出图且 `SHOT_BYTES >= 10240`；`startup.log` 含 `boot packaged=true`（证明跑的是打包产物，不是 `electron .`）、`window-created`、`did-finish-load`、`renderer: [boot] renderer ready`；无崩溃标记。
- 若 `Start-Process` 抛 `An Application Control policy has blocked this file`（SAC / 坑 29 变体）或进程以 `0x80000003` 退出 → 按 S8 记**环境限制**：这一步记 `blocked`（不记 fail），并补做退路验证：

```powershell
# 退路：让签名过的 electron.exe 加载打包出来的 app.asar（只证明打包内容可用）
$asar = Join-Path $snap 'release\win-unpacked\resources\app.asar'
if (-not (Test-Path $asar)) { $asar = Join-Path $snap 'release\resources\app.asar' }
"ASAR=$asar exists=$(Test-Path $asar)"
$env:MICSTUDIO_USER_DATA = $udBuild
& $electron $asar '--no-sandbox' "--screenshot=$(Join-Path $ev 'dist\G7-payload-screenshot.png')" 2>&1 | Out-String
"EXIT=$LASTEXITCODE"
```

## 5. 打包产物存活 ≥5 s（N8 的第二条判据）

```powershell
$proc = Start-Process -FilePath $exe -ArgumentList @('--hold=8000', '--no-sandbox') -PassThru
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$alive = $true
while ($sw.Elapsed.TotalSeconds -lt 5) {
  Start-Sleep -Milliseconds 250
  if ($proc.HasExited) { $alive = $false; break }
}
"ALIVE_5S=$alive elapsed=$([math]::Round($sw.Elapsed.TotalSeconds,1))s exit=$(if ($proc.HasExited) { $proc.ExitCode } else { 'running' })"
$proc.WaitForExit(15000) | Out-Null
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
Write-Utf8NoBom (Join-Path $ev 'dist\G7-portable-hold.txt') "ALIVE_5S=$alive`nELAPSED_S=$([math]::Round($sw.Elapsed.TotalSeconds,1))`n"
Copy-Item (Join-Path $dataDir 'startup.log') (Join-Path $ev 'dist\G7-portable-hold-startup.log') -Force -ErrorAction SilentlyContinue
```

- **判据**：`ALIVE_5S=True`；进程最终自行退出（`hold-mode-finished` 后 `app.exit(0)`）。
- 收尾：仅当 `$dataExisted -eq $false` 时清理 `$dataDir`（这是本次冒烟新建的解包数据目录，别删用户数据）。

## 6. 截图非空白（两条判据叠加）

1. **体积**：≥10 KB（`scripts/dist.ps1:584` 的既有阈值）；
2. **目视**：用 `read_image` 打开 `dist/G7-build-screenshot.png` 与 `dist/G7-portable-screenshot.png`，确认能看到工作台（顶栏胶囊 + 场景条 + 曲线），把结论写进证据：

```powershell
$shots = @(
  (Join-Path $ev 'dist\G7-build-screenshot.png'),
  (Join-Path $ev 'dist\G7-portable-screenshot.png')
)
$sizeOk = @{}
foreach ($p in $shots) {
  $bytes = if (Test-Path $p) { (Get-Item $p).Length } else { 0 }
  $sizeOk[[System.IO.Path]::GetFileName($p)] = ($bytes -ge 10240)
  '{0,-32} bytes={1} ok={2}' -f [System.IO.Path]::GetFileName($p), $bytes, $sizeOk[[System.IO.Path]::GetFileName($p)]
}

# 日志标记（用 .NET 读，绕开 Select-String 的编码默认值差异）
function Test-Markers([string]$Path, [string[]]$Must, [string[]]$MustNot) {
  if (-not (Test-Path $Path)) { return @{ file = $Path; missing = $true } }
  $t = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  $result = [ordered]@{ file = [System.IO.Path]::GetFileName($Path); missing = $false }
  foreach ($m in $Must)    { $result["has:$m"]    = ($t -match [regex]::Escape($m)) }
  foreach ($m in $MustNot) { $result["no:$m"]     = -not ($t -match [regex]::Escape($m)) }
  return $result
}
$rows = @()
$rows += (Test-Markers (Join-Path $ev 'dist\G7-build-startup.log') `
  @('ready','window-created','did-finish-load','renderer ready') `
  @('uncaught','unhandledRejection','did-fail-load'))
$rows += (Test-Markers (Join-Path $ev 'dist\G7-portable-startup.log') `
  @('boot packaged=true','ready','window-created','did-finish-load','renderer ready') `
  @('uncaught','unhandledRejection','did-fail-load'))

# 落证据：体积 + 日志标记 + 目视结论（目视结论由执行者用 read_image 看到后手填最后两行）
$lines = @()
$lines += ($sizeOk.GetEnumerator() | ForEach-Object { "SHOT {0} ok={1}" -f $_.Key, $_.Value })
foreach ($r in $rows) {
  $lines += (($r.GetEnumerator() | ForEach-Object { "{0}={1}" -f $_.Key, $_.Value }) -join ' | ')
}
$lines += 'VISUAL G7-build-screenshot.png = <read_image 目视结论>'
$lines += 'VISUAL G7-portable-screenshot.png = <read_image 目视结论>'
$lines | ForEach-Object { $_ }
Write-Utf8NoBom (Join-Path $ev 'dist\G7-visual-check.txt') (($lines -join "`r`n") + "`r`n")
```

最后把两行 `VISUAL …` 换成真实目视结论（"可见工作台：顶栏胶囊 + 场景条 + 曲线" / 或写"空白/异常"），再重写一次该文件。**不要**保留占位符。

## 7. 证据清单

| 文件 | 内容 |
|---|---|
| `dist/G7-build-run.log` | 构建产物 `--screenshot` 的 stdout/stderr + EXIT |
| `dist/G7-build-screenshot.png` | 构建产物截图 |
| `dist/G7-build-startup.log` | 构建产物 `startup.log` 副本 |
| `dist/G7-build-hold.log` / `dist/G7-build-hold-startup.log` | 存活验证 |
| `dist/G7-portable-screenshot.png` | 打包产物截图 |
| `dist/G7-portable-startup.log` | 打包产物 `startup.log` 副本（含 `boot packaged=true`） |
| `dist/G7-portable-hold.txt` / `dist/G7-portable-hold-startup.log` | ≥5 s 存活验证 |
| `dist/G7-visual-check.txt` | 目视结论 |
| `dist/result-2_2.json` | N7 / N8 两条结果 |

```powershell
$now = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
$json = @{
  stage = 2; substage = '2_2'
  env = @{ snapshot = $snap; gitHead = '8b7560e762bc38a9db79c7fcc5fcb5524b966feb'; channel = 'mock(default)'; lang = 'zh'; userData = $udBuild; device = 'none'; startedAt = $now }
  items = @(
    @{ id='N7'; status='pass'; expected='构建产物拉起后出图≥10KB；startup.log 有 ready/window-created/did-finish-load/renderer ready；无 uncaught/unhandledRejection/did-fail-load';
       actual='EXIT=0；SHOT_BYTES=…；四条标记齐全'; evidence=@('artifacts/fulltest-20261121/dist/G7-build-screenshot.png','artifacts/fulltest-20261121/dist/G7-build-startup.log'); ts=$now; durationMs=0; probe='electron.exe . --no-sandbox --screenshot=…'; notes='' }
    @{ id='N8'; status='pass'; expected='portable 出图≥10KB；startup.log 有 boot packaged=true；窗口存活≥5 s；无崩溃';
       actual='SHOT_BYTES=…；ALIVE_5S=True'; evidence=@('artifacts/fulltest-20261121/dist/G7-portable-screenshot.png','artifacts/fulltest-20261121/dist/G7-portable-startup.log','artifacts/fulltest-20261121/dist/G7-portable-hold.txt'); ts=$now; durationMs=0; probe='Start-Process portable --screenshot --no-sandbox'; notes='' }
  )
  notRun = @()
}
Write-Utf8NoBom (Join-Path $ev 'dist\result-2_2.json') ($json | ConvertTo-Json -Depth 8)
```

## 8. 失败处置

| 现象 | 处置 |
|---|---|
| 窗口秒退、日志都没有 | ①`ELECTRON_RUN_AS_NODE` 没清（坑 13，症状是 `bad option: --no-sandbox`）②漏了 `--no-sandbox`（坑 14/18，症状是 `GPU process isn't usable`）③快照路径不对（`cwd` 必须是 `$snap`） |
| `startup.log` 只有 `boot packaged=…` 没有 `ready` | 主进程在 `whenReady` 前崩了；看有没有 `uncaught=`；复核 `out/main/index.js` 是否为本轮构建产物（`build/G4-out-sha256.txt`） |
| 有 `did-fail-load` | 渲染进程加载失败：检查 `out/renderer/index.html` 是否存在、路径是否符合 electron-vite 固定输出（坑 12） |
| 截图 <10 KB / 全黑 | 窗口被遮挡或渲染未就绪；加 `--width=1280 --height=820`、确认没有并发 Electron 抢前台；重跑一次仍失败 → 记 fail 并附 `startup.log` |
| portable 被 SAC 拦 / `0x80000003` | 按 S8：`blocked` + 退路验证（第 4 节末）+ 报告注明"目标机双击行为未验证"；**不要**把构建产物冒烟的通过当成打包产物通过 |
| portable 出图但日志里没有 `boot packaged=true` | 跑起来的不是打包产物（可能启动了 `electron .`）；检查 `$exe` 路径与 `Start-Process -FilePath` |
| 存活验证 `ALIVE_5S=False` | 记 fail（N8 不成立），附退出码与 `startup.log`；`0x80000003` 则转 blocked（环境） |

## 9. 完成定义（DoD）

1. `dist/G7-build-screenshot.png` 与 `dist/G7-portable-screenshot.png` 都存在且 ≥10 KB，且 `G7-visual-check.txt` 有目视结论；
2. 两份 `startup.log` 副本都含 `ready`、`window-created`、`did-finish-load`、`renderer … [boot] renderer ready`，且都不含 `uncaught` / `unhandledRejection` / `did-fail-load`；
3. portable 的日志含 `boot packaged=true`；
4. `dist/G7-portable-hold.txt` 的 `ALIVE_5S=True`；
5. `dist/result-2_2.json` 里 N7/N8 已判定（`pass` / `fail` / `blocked`，blocked 必须写 `blockedReason` + `unblock`）；
6. 冒烟期间没有污染仓库 `release/` 与 `$root\.userdata`（用 `Get-ChildItem` 对比）。
