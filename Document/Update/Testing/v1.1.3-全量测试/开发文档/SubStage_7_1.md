# SubStage 7-1 — 收尾复跑与报告素材（阶段四输入）

> 归属 Stage 7；不新增验收项，负责把 Stage 1–6 的结论**汇总成可判定的一份表**，并在**工作树**上做 Final Run（差异附录，S9）。
> 前置：`result-1_1/1_2/2_1/2_2/3_1/3_2/4_1/4_2/4_3/5_1/5_2/5_3/6_1/6_2.json` 全部存在。
> 产出：`summary/acceptance.json`、`summary/hashes-final.sha256`、`summary/final-run-*.log`、`summary/报告素材.md`。

> **执行约定**：本文所有 PowerShell 片段默认在仓库根 `$root` 下执行（`--exec-file` / 相对路径都以它为基准）；需要"在被测树里跑"的命令都显式 `Push-Location $snap`，跑完 `Pop-Location`。
---

## 1. 前置与汇总

```powershell
$root = 'D:\WorkShop\MicroPhone_WebHIDInterface'
$snap = 'D:\Temp\micstudio-fulltest\v1.1.3-baseline'
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
$ev   = Join-Path $root 'artifacts\fulltest-20261121'
$git  = 'C:\Program Files\Git\cmd\git.exe'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:PATH = "C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;$env:PATH"
function Write-Utf8NoBom([string]$Path, [String]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}
New-Item -ItemType Directory -Force -Path (Join-Path $ev 'summary') | Out-Null

$files = @(
  'gates\result-1_1.json','gates\result-1_2.json','dist\result-2_1.json','dist\result-2_2.json',
  'real\result-3_1.json','vdevice\result-3_2.json',
  'ui\result-4_1.json','ui\result-4_2.json','ui\result-4_3.json',
  'real\result-5_1.json','real\result-5_2.json','real\result-5_3.json',
  'stability\result-6_1.json','stability\result-6_2.json'
)
foreach ($f in $files) {
  $p = Join-Path $ev $f
  '{0,-32} {1}' -f $f, $(if (Test-Path $p) { 'OK' } else { 'MISSING' })
}
```

- **判据**：14 个文件全部 `OK`。缺哪个 → 回哪个 SubStage 补，**不许**用其它阶段证据替代。

## 2. 汇总 `summary/acceptance.json` 并校验 54 个 ID

```powershell
$expected = @(
  'N1','N2','N3','N4','N5','N6','N7','N8',
  'P1','P2','P3','P4','P5','P6','P7','P8',
  'U1','U2','U3','U4','U5','U6','U7','U8','U9','U10','U11','U12','U13','U14','U15','U16','U17',
  'R1','R2','R3','R4','R5','R6','R7','R8','R9','R10','R11','R12',
  'S1','S2','S3','S4','S5'
)
$items = @(); $notRun = @()
foreach ($f in $files) {
  $p = Join-Path $ev $f
  if (-not (Test-Path $p)) { continue }
  $o = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($it in $o.items) { $it | Add-Member -NotePropertyName source -NotePropertyValue ($f -replace '\\','/') -Force; $items += $it }
  if ($o.notRun) { $notRun += $o.notRun }
}
# 去重（同一 ID 出现多次时保留第一个非 pass，便于发现问题）
$byId = [ordered]@{}
foreach ($it in $items) {
  if (-not $byId.Contains($it.id)) { $byId[$it.id] = $it }
  elseif ($byId[$it.id].status -eq 'pass' -and $it.status -ne 'pass') { $byId[$it.id] = $it }
}
$merged = @($byId.Values)
$missing = $expected | Where-Object { $_ -notin $merged.id }
$extra   = $merged.id | Where-Object { $_ -notin $expected }
"共 $($merged.Count) 条；缺失: $($missing -join ', ')；意外多出: $($extra -join ', ')"
$merged | Group-Object status | Select-Object Name,Count | Format-Table -AutoSize | Out-String -Width 80

$acc = @{
  generatedAt = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')
  snapshot = $snap; gitHead = '8b7560e762bc38a9db79c7fcc5fcb5524b966feb'; version = '1.1.2'
  counts = @{ expected = $expected.Count; collected = $merged.Count; missing = $missing.Count }
  missing = @($missing)
  notRun = @($notRun)
  items = $merged
}
Write-Utf8NoBom (Join-Path $ev 'summary\acceptance.json') ($acc | ConvertTo-Json -Depth 10)
```

- **判据**：`missing` 为空（54 条齐全；`V4` 不出现在 `items`，只在 `notRun` 里）。
- **注意**：`$expected` 里**故意不含 `V4`**——V4 是"不执行"，只登记在 `notRun`（见 §6）。

## 3. 证据完整性校验

```powershell
$bad = @()
foreach ($it in $merged) {
  if ($it.status -eq 'pass' -or $it.status -eq 'fail') {
    if (-not $it.evidence -or @($it.evidence).Count -eq 0) { $bad += "$($it.id): 无 evidence"; continue }
    foreach ($e in @($it.evidence)) {
      $full = Join-Path $root ($e -replace '/','\')
      if ($e -match '/$' -or $e -match '\\$') { continue }   # 目录型证据（例如 vdevice/）跳过
      if (-not (Test-Path $full)) { $bad += "$($it.id): 缺文件 $e" }
      elseif ((Get-Item $full).Length -eq 0) { $bad += "$($it.id): 空文件 $e" }
    }
  }
  if ($it.status -eq 'blocked' -and (-not $it.blockedReason -or -not $it.unblock)) { $bad += "$($it.id): blocked 但缺 blockedReason/unblock" }
  if ($it.status -notin @('pass','fail','blocked')) { $bad += "$($it.id): 非法 status '$($it.status)'" }
}
if ($bad.Count -eq 0) { '证据完整性：OK' } else { '证据完整性问题：'; $bad | ForEach-Object { " - $_" } }
Write-Utf8NoBom (Join-Path $ev 'summary\evidence-check.txt') (($bad -join "`r`n") + "`r`n")
```

- **判据**：`OK`（无输出项）。有问题就回补证据或把该项改 `blocked`，**不许**保留 pass。

## 4. 工作树 Final Run（差异附录，S9）

```powershell
$finalDir = Join-Path $ev 'summary'
$run = @{}

# F1 类型
$out = & $node $pnpm --config.verify-deps-before-run=false run typecheck 2>&1
$code = $LASTEXITCODE
Write-Utf8NoBom (Join-Path $finalDir 'final-run-G1.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")
$run['G1'] = $code

# F2 单测
$out = & $node $pnpm --config.verify-deps-before-run=false run test 2>&1
$code = $LASTEXITCODE
$t = ($out | Out-String)
Write-Utf8NoBom (Join-Path $finalDir 'final-run-G2.log') ($t + "`nEXIT=$code`n")
$run['G2'] = $code
($t -split "`n" | Where-Object { $_ -match 'Test Files|Tests ' } | Select-Object -Last 3)

# F3 覆盖率
$out = & $node $pnpm --config.verify-deps-before-run=false run test:coverage 2>&1
$code = $LASTEXITCODE
Write-Utf8NoBom (Join-Path $finalDir 'final-run-G3.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")
$run['G3'] = $code

# F4 构建
$out = & $node $pnpm --config.verify-deps-before-run=false run build 2>&1
$code = $LASTEXITCODE
Write-Utf8NoBom (Join-Path $finalDir 'final-run-G4.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")
$run['G4'] = $code

# F5 虚拟下位机（先确认 8765/8766 空闲）
$out = & $node $pnpm --config.verify-deps-before-run=false run test:device 2>&1
$code = $LASTEXITCODE
$t = ($out | Out-String)
Write-Utf8NoBom (Join-Path $finalDir 'final-run-G5.log') ($t + "`nEXIT=$code`n")
$run['G5'] = $code
($t -split "`n" | Where-Object { $_ -match 'SUMMARY' })

$run.GetEnumerator() | ForEach-Object { '{0} exit={1}' -f $_.Key, $_.Value }
Write-Utf8NoBom (Join-Path $finalDir 'final-run-exitcodes.txt') (($run.GetEnumerator() | ForEach-Object { '{0} exit={1}' -f $_.Key, $_.Value }) -join "`r`n")
```

- **工作目录必须是仓库根** `$root`（不是快照）：`Push-Location $root` … `Pop-Location`，或先在 `$root` 下执行。
- **判据**：五项与首跑（快照）一致；任何一项退步 → 记「最终树回归」缺陷（S9），**不得**用快照结果掩盖。

```powershell
# 工作树最终哈希（用于归因）
Push-Location $root
$list = & $git status --porcelain
Write-Utf8NoBom (Join-Path $finalDir 'git-status-final.txt') (($list | Out-String))
$tracked = & $git ls-files
$rows = @()
foreach ($f in $tracked) {
  $p = Join-Path $root $f
  if (Test-Path $p) { $rows += ('{0}  {1}' -f (Get-FileHash $p -Algorithm SHA256).Hash.ToLower(), $f) }
}
Write-Utf8NoBom (Join-Path $finalDir 'hashes-final.sha256') (($rows -join "`n") + "`n")
"hashes-final: $($rows.Count) 个文件"
Pop-Location
```

- 与 `baseline/hashes-before.sha256`（582 文件）比对：

```powershell
$before = @{}
Get-Content (Join-Path $ev 'baseline\hashes-before.sha256') -Encoding UTF8 | ForEach-Object {
  if ($_ -match '^([0-9a-f]{64})\s+(.+)$') { $before[$matches[2].Trim()] = $matches[1] }
}
$after = @{}
Get-Content (Join-Path $ev 'summary\hashes-final.sha256') -Encoding UTF8 | ForEach-Object {
  if ($_ -match '^([0-9a-f]{64})\s+(.+)$') { $after[$matches[2].Trim()] = $matches[1] }
}
$changed = @(); foreach ($k in $after.Keys) { if ($before.ContainsKey($k) -and $before[$k] -ne $after[$k]) { $changed += $k } }
$added = @($after.Keys | Where-Object { -not $before.ContainsKey($_) })
$removed = @($before.Keys | Where-Object { -not $after.ContainsKey($_) })
"CHANGED=$($changed.Count) ADDED=$($added.Count) REMOVED=$($removed.Count)"
$changed | ForEach-Object { "M $_" }
$added   | Select-Object -First 40 | ForEach-Object { "A $_" }
Write-Utf8NoBom (Join-Path $ev 'summary\final-drift.txt') (@("CHANGED=$($changed.Count) ADDED=$($added.Count) REMOVED=$($removed.Count)") + ($changed | ForEach-Object { "M $_" }) + ($added | ForEach-Object { "A $_" }) + ($removed | ForEach-Object { "R $_" })) 
```

- **判据**：`CHANGED` 里的文件必须都能在 `fixes/fixes-index.md` 里找到对应缺陷；出现"没登记过的改动"= 另一会话动过 → 记「外部改动」，不得混入本轮修复。

## 5. 报告素材 `summary/报告素材.md`

```powershell
$acc = Get-Content (Join-Path $ev 'summary\acceptance.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$g = @{}
foreach ($k in 'G1','G2','G3','G4','G5') { $g[$k] = ($acc.items | Where-Object { $_.id -in @('N1','N2','N3','N4','N5') }) }
$lines = @()
$lines += '# v1.1.3 全量测试 — 报告素材（Stage 7 自动汇总）'
$lines += ''
$lines += "生成时间：$($acc.generatedAt)"
$lines += "判定对象：快照 ``$($acc.snapshot)``（git ``$($acc.gitHead)``，version $($acc.version)）"
$lines += ''
$lines += '## 1. 门禁总览'
$lines += ''
$lines += '| 门禁 | 项 | 状态 | 证据 |'
$lines += '|---|---|---|---|'
foreach ($id in 'N1','N2','N3','N4','N5','N6','N7','N8') {
  $it = $acc.items | Where-Object { $_.id -eq $id } | Select-Object -First 1
  if ($it) { $lines += "| $id | $($it.expected) | $($it.status) | $((@($it.evidence) -join '<br>')) |" }
}
$lines += ''
$lines += '## 2. 功能项统计'
$lines += ''
foreach ($grp in $acc.items | Group-Object { $_.id.Substring(0,1) }) {
  $p = @($grp.Group | Where-Object status -eq 'pass').Count
  $f = @($grp.Group | Where-Object status -eq 'fail').Count
  $b = @($grp.Group | Where-Object status -eq 'blocked').Count
  $lines += "- $($grp.Name) 系列：共 $($grp.Count) 项，pass=$p fail=$f blocked=$b"
}
$lines += ''
$lines += '## 3. 未执行项（不得写成通过）'
$lines += ''
foreach ($n in $acc.notRun) { $lines += "- $($n.id)：$($n.reason)" }
$lines += '- §3.2-1 DFU 实刷与 DFU 界面走查：未执行（Q6）'
$lines += '- §3.2-2 macOS / Linux 产物、arm64 构建：未执行'
$lines += '- §3.2-3 预设保存 0x1004–0x1005 / 心跳 0x1000 / 固件签名 / 多设备并发 / 在线升级：未执行'
$lines += '- §3.2-4 硬件电气性能（THD、噪声底、灯效一致性）/ 听感主观评价：未执行'
$lines += '- §3.2-5 修改 third_party/web_hid_utils 上游代码：未执行'
$lines += ''
$lines += '## 4. 失败与阻塞（需逐条展开）'
$lines += ''
$bad = @($acc.items | Where-Object { $_.status -ne 'pass' })
if ($bad.Count -eq 0) { $lines += '（无）' } else {
  foreach ($it in $bad) { $lines += "- $($it.id) [$($it.status)] $($it.expected) → $($it.actual)" }
}
Write-Utf8NoBom (Join-Path $ev 'summary\报告素材.md') (($lines -join "`r`n") + "`r`n")
Get-Content (Join-Path $ev 'summary\报告素材.md') -Encoding UTF8 | Select-Object -First 40
```

## 6. 结论判定（照 `验收文档.md` §5 的规则写进 `验收报告.md`）

| 条件 | 结论 |
|---|---|
| 任一 `G1–G7` 失败（N1–N8 对应门禁） | **不通过** |
| 出现 P0 缺陷 | **不通过**（一票否决） |
| 有 `blocked` 项 | 写清阻塞原因 + 解除条件 + 责任方；该项**不得**计入通过 |
| 全部门禁通过 + 无 P0 + 功能项无 fail | 通过（遗留的 P2/P3 列清单） |

## 7. 完成定义（DoD）

1. 14 个 `result-*.json` 全部存在（§1 全 `OK`）；
2. `summary/acceptance.json` 的 `missing` 为空，`items` 覆盖 54 项中的 53 项（`V4` 在 `notRun`）；
3. `summary/evidence-check.txt` 为空（或每个问题都已处理）；
4. `summary/final-run-{G1..G5}.log` + `final-run-exitcodes.txt` 齐全，且与快照结果对比结论已写进 `final-drift.txt` / 报告素材；
5. `summary/hashes-final.sha256` 存在，`final-drift.txt` 里每个 `M` 都能对应到 `fixes/fixes-index.md`；
6. `summary/报告素材.md` 生成且含门禁表、统计、未执行项、失败/阻塞四节；
7. 本份**不写** `验收报告.md` / `总结报告.md` / `缺陷清单.md`——那是阶段四主 Agent 的产出，本份只交素材。
