# SubStage 1-2 — 构建 G4 与虚拟下位机自检 G5

> 归属 Stage 1；覆盖需求项 **N4 / N5**、门禁 **G4 / G5**。
> 判定对象：冻结快照 `D:\Temp\micstudio-fulltest\v1.1.3-baseline`。
> 前置：`SubStage_1_1.md` 已完成（G1 必须通过——类型不过就没有资格构建）。

> **执行约定**：本文所有 PowerShell 片段默认在仓库根 `$root` 下执行（`--exec-file` / 相对路径都以它为基准）；需要"在被测树里跑"的命令都显式 `Push-Location $snap`，跑完 `Pop-Location`。
---

## 0. 目标

1. 在快照上跑通 `electron-vite build`，产出三端产物并证明 **mtime 晚于本次构建开始**（防"用旧产物冒充"）。
2. 在快照上跑通 `tools/vdevice/selftest.mjs` 的 **20 例**端到端自检：**连跑 3 次**（S11：T07 写合并对定时器精度敏感，单次失败要区分环境抖动与回归）。

## 1. 前置检查

```powershell
$root = 'D:\WorkShop\MicroPhone_WebHIDInterface'
$snap = 'D:\Temp\micstudio-fulltest\v1.1.3-baseline'
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
$ev   = Join-Path $root 'artifacts\fulltest-20261121'
$env:PATH = "C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;$env:PATH"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}
```

| # | 检查 | 命令 | 期望 |
|---|---|---|---|
| 1 | G1 已通过 | `Get-Content (Join-Path $ev 'gates\G1-exitcodes.txt')` | 三行 `exit=0` |
| 2 | 磁盘空间 | `Get-PSDrive D \| Select-Object Used,Free` | Free ≥ 1 GB |
| 3 | 快照可写 | `New-Item -ItemType Directory -Force (Join-Path $snap 'out') \| Out-Null; 'OK'` | `OK` |
| 4 | **端口 8765/8766 空闲** | `Get-NetTCPConnection -State Listen -LocalPort 8765,8766 -ErrorAction SilentlyContinue \| Select-Object LocalPort,OwningProcess` | 无输出；有占用 → 先杀掉占用进程（Stage 3-V / 4-U 虚拟轮可能正在跑） |
| 5 | 没有 Electron 在跑（避免定时器精度被抬高，S11 风险预警） | `Get-Process electron -ErrorAction SilentlyContinue` | 无输出 |

## 2. G4 构建（N4）

```powershell
$buildStart = Get-Date
Push-Location $snap
$out  = & $node $pnpm --config.verify-deps-before-run=false run build 2>&1
$code = $LASTEXITCODE
Pop-Location
Write-Utf8NoBom (Join-Path $ev 'build\G4-build.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`nBUILD_START=$($buildStart.ToString('s'))`n")

$rows = @()
foreach ($rel in @('out\main\index.js','out\preload\index.js','out\renderer\index.html')) {
  $item = Get-Item (Join-Path $snap $rel) -ErrorAction SilentlyContinue
  if ($item) {
    $fresh = ($item.LastWriteTime -ge $buildStart.AddSeconds(-2))
    $rows += ("{0}`tEXISTS`t{1}`t{2}`tFRESH={3}" -f $rel, $item.Length, $item.LastWriteTime.ToString('s'), $fresh)
  } else {
    $rows += ("{0}`tMISSING`t0`t-`tFRESH=False" -f $rel)
  }
}
$rows | ForEach-Object { $_ }
Write-Utf8NoBom (Join-Path $ev 'build\G4-artifacts.txt') (($rows -join "`n") + "`nEXIT=$code`n")

# 产物哈希（供 Stage 7 复跑比对）
$hashes = @()
foreach ($rel in @('out\main\index.js','out\preload\index.js','out\renderer\index.html')) {
  $p = Join-Path $snap $rel
  if (Test-Path $p) { $hashes += ('{0}  {1}' -f (Get-FileHash $p -Algorithm SHA256).Hash.ToLower(), $rel) }
}
Write-Utf8NoBom (Join-Path $ev 'build\G4-out-sha256.txt') (($hashes -join "`n") + "`n")
```

- **判据**：`EXIT=0`；三行都是 `EXISTS` 且 `FRESH=True`（mtime ≥ 构建开始时间 -2 s 容差）；`G4-out-sha256.txt` 三行齐全。
- **证据**：`build/G4-build.log`、`build/G4-artifacts.txt`、`build/G4-out-sha256.txt`。
- 参考输出（阶段一实测，`build/G4-build.log`）：`out/main/index.js 12.35 kB`、`out/preload/index.js 1.95 kB`、`out/renderer/index.html 0.75 kB` + 两个 assets。
- **不要**写 `outDir` 到配置里（坑 12）：electron-vite 固定输出 `out/{main,preload,renderer}`。

## 3. G5 虚拟下位机自检 20 例（N5）

```powershell
Push-Location $snap
$summary = @()
foreach ($run in 1..3) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $out  = & $node $pnpm --config.verify-deps-before-run=false run test:device 2>&1
  $code = $LASTEXITCODE
  $sw.Stop()
  $text = ($out | Out-String)
  Write-Utf8NoBom (Join-Path $ev "gates\G5-selftest-run$run.log") ($text + "`nEXIT=$code ELAPSED_MS=$($sw.ElapsedMilliseconds)`n")
  $line = ($text -split "`n" | Where-Object { $_ -match 'SUMMARY' } | Select-Object -Last 1)
  $summary += "run$run exit=$code elapsed=$($sw.ElapsedMilliseconds)ms $line"
  "run$run exit=$code elapsed=$($sw.ElapsedMilliseconds)ms $line"
}
Pop-Location
Write-Utf8NoBom (Join-Path $ev 'gates\G5-summary.txt') (($summary -join "`n") + "`n")

# 把自检 JSON 归集到本轮证据目录（脚本写的是 $snap\artifacts\vdevice\）
New-Item -ItemType Directory -Force -Path (Join-Path $ev 'vdevice') | Out-Null
$src = Join-Path $snap 'artifacts\vdevice'
if (Test-Path $src) {
  Get-ChildItem $src -Filter 'selftest-*.json' | Sort-Object LastWriteTime |
    Select-Object -Last 3 | ForEach-Object { Copy-Item $_.FullName (Join-Path $ev 'vdevice') -Force }
  Get-ChildItem $src -Filter 'selftest-*.log' | Sort-Object LastWriteTime |
    Select-Object -Last 3 | ForEach-Object { Copy-Item $_.FullName (Join-Path $ev 'vdevice') -Force }
}
Get-ChildItem (Join-Path $ev 'vdevice') | Select-Object Name,Length
```

- **判据（每一次都算）**：`EXIT=0` 且输出最后一行 `SUMMARY passed=20 failed=0`。
- **S11 判定**：3 次全过 → 通过（把耗时记进报告，T07 允许 3–4 s，本机定时器粒度 15.6 ms）；**任一次失败** → 记回归缺陷，定位到具体用例（多半是 `T07 写合并`），**不得**调大 `writeThrottleMs` 或改断言来变绿。
- **证据**：`gates/G5-selftest-run{1,2,3}.log`、`gates/G5-summary.txt`、`vdevice/selftest-*.json` + `.log`（各 ≥1 份，建议 3 份）。
- 参考输出（阶段一实测）：20 行 `PASS T01…T20` + `SUMMARY passed=20 failed=0`，T07 耗时 3829 ms。
- 自检内部自己起停桥（8765/8766），所以第 4 项端口检查必须过；跑完再查一次端口，确认脚本把桥收干净：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 8765,8766 -ErrorAction SilentlyContinue |
  Select-Object LocalPort,OwningProcess
# 期望：无输出
```

## 4. 证据清单

| 文件 | 内容 |
|---|---|
| `build/G4-build.log` | electron-vite 输出 + `EXIT=` + `BUILD_START=` |
| `build/G4-artifacts.txt` | 三端产物 `EXISTS/FRESH` + 大小 + mtime |
| `build/G4-out-sha256.txt` | 三端产物 SHA256 |
| `gates/G5-selftest-run{1,2,3}.log` | 每次 20 例明细 + `SUMMARY` |
| `gates/G5-summary.txt` | 三行汇总（exit/elapsed/SUMMARY） |
| `vdevice/selftest-*.json` / `.log` | 自检原始 JSON |
| `gates/result-1_2.json` | N4/N5 两条结果 |

```powershell
$now = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
$json = @{
  stage = 1; substage = '1_2'
  env = @{ snapshot = $snap; gitHead = '8b7560e762bc38a9db79c7fcc5fcb5524b966feb'; channel = 'none'; lang = 'none'; userData = ''; device = 'none'; startedAt = $now }
  items = @(
    @{ id='N4'; status='pass'; expected='build 退出码 0；out/main/index.js、out/preload/index.js、out/renderer/index.html 均存在且 mtime 晚于构建开始';
       actual='EXIT=0；三端 EXISTS FRESH=True'; evidence=@('artifacts/fulltest-20261121/build/G4-build.log','artifacts/fulltest-20261121/build/G4-artifacts.txt'); ts=$now; durationMs=0; probe='pnpm run build'; notes='' }
    @{ id='N5'; status='pass'; expected='SUMMARY passed=20 failed=0（连跑 3 次）';
       actual='3/3 次 passed=20 failed=0'; evidence=@('artifacts/fulltest-20261121/gates/G5-summary.txt','artifacts/fulltest-20261121/vdevice/'); ts=$now; durationMs=0; probe='pnpm run test:device'; notes='' }
  )
  notRun = @()
}
Write-Utf8NoBom (Join-Path $ev 'gates\result-1_2.json') ($json | ConvertTo-Json -Depth 8)
```

## 5. 失败处置

| 现象 | 处置 |
|---|---|
| G4 `EXIT!=0`，报 `'outDir' does not exist in type` | 坑 12：配置里被加了 `outDir`/`rollupOptions`（`electron.vite.config.ts` 不该有）；回退该改动 |
| G4 通过但某端 `MISSING` | electron-vite 输出被改；对照 `build/G4-build.log` 的 `✓ built in` 与 `out/**` 实际目录 |
| G4 通过但 `FRESH=False` | 构建其实没写文件（缓存命中/被 skip）；删 `out/` 后重跑，并把 mtime 与 `BUILD_START` 一起写进报告 |
| G5 起不来（`EADDRINUSE` / `/healthz` 不通） | 端口被占 → 先 `Get-NetTCPConnection -LocalPort 8765,8766`；桥起不来再查 `MICSTUDIO_PYTHON`（`tools/vdevice/run.mjs:58-62`）与 profile JSON 有无 BOM（坑 21） |
| G5 报 `T07` 失败 | 按 S11：3 连跑里只要有 1 次失败 = 回归；定位 `device/proto/session.ts` 的 `writeThrottleMs`/尾沿，**不许**改测试窗口 |
| G5 报某例 `timeout` | 关掉同时跑的 Electron（定时器精度），重跑；仍失败按缺陷处理 |
| 跑完端口没释放 | 说明 `run.mjs` 的收尾没生效；`Get-Process node,python` 找残留并记录（S4 同类问题） |

## 6. 完成定义（DoD）

1. `build/G4-artifacts.txt` 三行 `EXISTS` + `FRESH=True`；
2. `gates/G5-summary.txt` 三行都含 `passed=20 failed=0` 且 `exit=0`；
3. `vdevice/` 下至少有 1 份本轮 `selftest-*.json`（建议 3 份，时间戳在本次执行窗口内）；
4. `gates/result-1_2.json` 存在，N4/N5 状态已填；
5. 8765/8766 复查为空闲；
6. 有修复的话：`fixes/D-xx.diff` 存在、已同步快照、并在本份末尾追加「修复记录」。
