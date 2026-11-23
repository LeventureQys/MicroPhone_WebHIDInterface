# SubStage 1-1 — 静态门禁 G1/G2/G3（类型 + 单测 + 覆盖率）

> 归属 Stage 1（门禁 G1–G5）；覆盖需求项 **N1 / N2 / N3**、门禁 **G1 / G2 / G3**。
> 判定对象：**冻结快照** `D:\Temp\micstudio-fulltest\v1.1.3-baseline`（正式结论）。工作树结果只作差异附录（S9）。
> 前置任务书：无（本份是全轮第一份）。后续：`SubStage_1_2.md`（G4/G5）。

> **执行约定**：本文所有 PowerShell 片段默认在仓库根 `$root` 下执行（`--exec-file` / 相对路径都以它为基准）；需要"在被测树里跑"的命令都显式 `Push-Location $snap`，跑完 `Pop-Location`。
---

## 0. 目标

在快照上依次跑通类型检查、单测全量、覆盖率三项门禁，并把**命令全文 + 退出码 + 尾部统计**落成证据。三项全绿才允许进入 Stage 2；任一失败按需求文档 §6 定级并修复后**整轮重跑本份**。

## 1. 前置检查（逐条执行，期望输出写在后面）

```powershell
$root = 'D:\WorkShop\MicroPhone_WebHIDInterface'
$snap = 'D:\Temp\micstudio-fulltest\v1.1.3-baseline'
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
$py   = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$ev   = Join-Path $root 'artifacts\fulltest-20261121'
$env:PATH = "C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;$env:PATH"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue    # 坑 13
New-Item -ItemType Directory -Force -Path (Join-Path $ev 'gates') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ev 'build') | Out-Null

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}
```

| # | 检查 | 命令 | 期望 |
|---|---|---|---|
| 1 | 三个工具链存在 | `foreach ($p in @($node,$pnpm,$py)) { "$p -> $(Test-Path $p)" }` | 三行都是 `True` |
| 2 | 版本 | `& $node -v`；`& $node $pnpm -v`；`& $py -V` | `v24.21.0`；`11.7.0`；`Python 3.12.14` |
| 3 | 快照存在且是"活的" | `Test-Path $snap`；`Test-Path (Join-Path $snap 'node_modules\electron\dist\electron.exe')` | 均 `True` |
| 4 | 快照无 `.git`（提醒：不要在快照里做 git 操作） | `Test-Path (Join-Path $snap '.git')` | `False` |
| 5 | 依赖未漂移（S1） | `(Get-FileHash (Join-Path $snap 'package.json') -Algorithm SHA256).Hash` 与 `hashes-before.sha256` 中 `package.json` 行比对 | 一致；不一致 → 记「依赖漂移」并写进报告，不阻断 |
| 6 | 端口空闲（G5 才需要，本份可跳过） | `Get-NetTCPConnection -State Listen -LocalPort 8765,8766 -ErrorAction SilentlyContinue` | 无输出 |
| 7 | `ELECTRON_RUN_AS_NODE` 为空 | `if ($env:ELECTRON_RUN_AS_NODE) { 'NOT-EMPTY' } else { 'EMPTY' }` | `EMPTY` |

## 2. G1 类型检查（N1）

```powershell
Push-Location $snap
$codes = @()
foreach ($run in 1..3) {                       # 需求 §5.1 + O1：连跑 3 次排除"并发写入造成的瞬时不一致"
  $out  = & $node $pnpm --config.verify-deps-before-run=false run typecheck 2>&1
  $code = $LASTEXITCODE
  $errs = ($out | Select-String -Pattern 'error TS' -AllMatches).Count
  Write-Utf8NoBom (Join-Path $ev "gates\G1-typecheck-run$run.log") ((($out | Out-String).TrimEnd()) + "`nEXIT=$code ERROR_TS=$errs`n")
  $codes += "run$run exit=$code errorTS=$errs"
  "run$run exit=$code errorTS=$errs"
}
Pop-Location
Write-Utf8NoBom (Join-Path $ev 'gates\G1-exitcodes.txt') (($codes -join "`n") + "`n")
```

- **判据**：三次都 `exit=0` 且 `errorTS=0`。
- **证据**：`artifacts/fulltest-20261121/gates/G1-typecheck-run{1,2,3}.log`、`gates/G1-exitcodes.txt`。
- **注意**：`--config.verify-deps-before-run=false` 是必须的（坑 2：`pnpm run` 前的依赖状态检查会重跑 install 并继承其退出码）。
- **不要**用"有没有红字"判断：`tsc` 正常时也可能往 stderr 打东西。

## 3. G2 单测全量（N2）

```powershell
Push-Location $snap
$out  = & $node $pnpm --config.verify-deps-before-run=false run test 2>&1
$code = $LASTEXITCODE
Pop-Location
$text = ($out | Out-String)
Write-Utf8NoBom (Join-Path $ev 'gates\G2-test.log') ($text + "`nEXIT=$code`n")

$files = ([regex]::Match($text, 'Test Files\s+(\d+) passed')).Groups[1].Value
$tests = ([regex]::Match($text, 'Tests\s+(\d+) passed')).Groups[1].Value
$failed = ([regex]::Matches($text, '\b\d+ failed\b')).Count
"EXIT=$code FILES=$files TESTS=$tests FAILED_MARKS=$failed"
Write-Utf8NoBom (Join-Path $ev 'gates\G2-summary.txt') "EXIT=$code`nFILES=$files`nTESTS=$tests`nFAILED_MARKS=$failed`nBASELINE_TESTS=729`nJUDGE=$(if ($code -eq 0 -and [int]$files -eq 50 -and [int]$tests -ge 729 -and $failed -eq 0) {'PASS'} else {'FAIL'})`n"
```

- **判据**：`EXIT=0`；`FILES=50`；`TESTS >= 729`（基线 729，允许新增用例变大；变小或出现 skip/失败 = 不通过）；`FAILED_MARKS=0`。
- **证据**：`gates/G2-test.log`（尾部含 `Test Files  50 passed (50)` / `Tests  732 passed (732)` 之类统计行）、`gates/G2-summary.txt`。
- 阶段一实测参考：`50 passed (50)` / `732 passed (732)`（732 = 729 + 新增 3 例，属允许）。
- **DFU 用例不裁剪**（S5）：`tests/unit/dfu/**` 必须随这次跑，失败照常记缺陷。

## 4. G3 覆盖率（N3）

```powershell
Push-Location $snap
$out  = & $node $pnpm --config.verify-deps-before-run=false run test:coverage 2>&1
$code = $LASTEXITCODE
Pop-Location
$text = ($out | Out-String)
Write-Utf8NoBom (Join-Path $ev 'gates\G3-coverage.log') ($text + "`nEXIT=$code`n")

# 取汇总行（v8 报告：All files | %Stmts | %Branch | %Funcs | %Lines）
$all = ($text -split "`n" | Where-Object { $_ -match '^All files' }) -join "`n"
Write-Utf8NoBom (Join-Path $ev 'gates\G3-thresholds.txt') ($all + "`nEXIT=$code`nTHRESHOLDS=lines:90 functions:85 branches:80 statements:90`n")
$all
"EXIT=$code"
```

- **判据**：`EXIT=0`（`vitest` 在阈值不达标时以非 0 退出，`vitest.config.ts:25`）；`All files` 行四项分别 ≥ 90 / 85 / 80 / 90（注意列序是 Stmts / Branch / Funcs / Lines）。
- **证据**：`gates/G3-coverage.log`、`gates/G3-thresholds.txt`；覆盖率报告目录 `$snap\coverage\`（默认落 cwd，S1 已核对 `vitest.config.ts` 未配 `reportsDirectory`，**不要**把它指到 `node_modules`）。
- 阶段一实测参考：`All files 96.31 | 84.71 | 98.55 | 96.31`（branch 84.71 ≥ 80 通过）。
- **禁止**调低阈值（S12）。若 `dfu/**` 因 DFU 免测掉线，只在报告里单列说明 + 补测计划。

## 5. 证据清单（本份结束必须存在）

| 文件 | 内容 |
|---|---|
| `artifacts/fulltest-20261121/gates/G1-typecheck-run1.log` … `run3.log` | 各自含 `EXIT=` 与 `ERROR_TS=` |
| `artifacts/fulltest-20261121/gates/G1-exitcodes.txt` | 三行 `runN exit=… errorTS=…` |
| `artifacts/fulltest-20261121/gates/G2-test.log` | vitest 全量输出 |
| `artifacts/fulltest-20261121/gates/G2-summary.txt` | `FILES` / `TESTS` / `JUDGE` |
| `artifacts/fulltest-20261121/gates/G3-coverage.log` | 覆盖率表 |
| `artifacts/fulltest-20261121/gates/G3-thresholds.txt` | All files 行 + 阈值声明 |
| `artifacts/fulltest-20261121/gates/result-1_1.json` | 按设计文档 §3.2 schema 写 N1/N2/N3 三条 |

最后写结果 JSON：

```powershell
$now = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
$json = @{
  stage = 1; substage = '1_1'
  env = @{ snapshot = $snap; gitHead = '8b7560e762bc38a9db79c7fcc5fcb5524b966feb'; channel = 'none'; lang = 'none';
           userData = ''; device = 'none'; startedAt = $now }
  items = @(
    @{ id='N1'; status='pass'; expected='typecheck 退出码 0，无 error TS（连跑 3 次）';
       actual='run1..3 exit=0 errorTS=0'; evidence=@('artifacts/fulltest-20261121/gates/G1-typecheck-run1.log','artifacts/fulltest-20261121/gates/G1-exitcodes.txt'); ts=$now; durationMs=0; probe='pnpm run typecheck'; notes='' }
    @{ id='N2'; status='pass'; expected='50 个测试文件全通过，用例数 ≥729，无 skip';
       actual='FILES=50 TESTS=732'; evidence=@('artifacts/fulltest-20261121/gates/G2-test.log'); ts=$now; durationMs=0; probe='pnpm run test'; notes='' }
    @{ id='N3'; status='pass'; expected='lines≥90 functions≥85 branches≥80 statements≥90';
       actual='96.31 / 98.55 / 84.71 / 96.31'; evidence=@('artifacts/fulltest-20261121/gates/G3-coverage.log'); ts=$now; durationMs=0; probe='pnpm run test:coverage'; notes='' }
  )
  notRun = @()
}
Write-Utf8NoBom (Join-Path $ev 'gates\result-1_1.json') ($json | ConvertTo-Json -Depth 8)
```

## 6. 失败处置

| 现象 | 处置 |
|---|---|
| G1 报 `error TS` | 定位到文件:行；若是另一会话正在写的文件（比对 mtime 与 `hashes-before`），**先别改**，等 60 s 重跑一次；仍失败按缺陷处理（P0/P1），记 `fixes/D-xx.diff` 后重跑本份 |
| G1 报找不到 `tsc` | 依赖不完整 → `& $node $pnpm install`（坑 2/7）后重跑；仍失败记 `blocked` |
| G2 用例数 < 729 或出现 `skipped` | 检查命令是否被加了 `-t`/`--exclude`；恢复全量重跑；确认不是 `vitest.config.ts:13` 的 `include` 被改 |
| G2 单条失败 | 记缺陷（含失败用例名 + 断言差异 + 复现命令）；修复后**整轮**重跑 G2（不许只跑失败文件当结论） |
| G3 报 `Cannot find module '@vitest/coverage-v8'` / 覆盖率全 0 | 坑 23：`@vitest/coverage-v8` 必须与 vitest **1.6.1** 同版本；核对 `package.json:23` 后重装 |
| G3 某项低于阈值 | S12：补测试，**不调阈值**；把"哪一项、差多少、补测计划"写进缺陷清单 |
| 三次 G1 结果不一致 | 记 P1 并附三次日志；在报告里写明"快照不干净"（S9 风险） |

## 7. 完成定义（DoD）

1. `gates/G1-exitcodes.txt` 三行都是 `exit=0 errorTS=0`；
2. `gates/G2-summary.txt` 的 `JUDGE=PASS`，且 `FILES=50`、`TESTS>=729`、`FAILED_MARKS=0`；
3. `gates/G3-thresholds.txt` 的 `EXIT=0`，四项阈值全达标；
4. `gates/result-1_1.json` 存在且 `items` 有 N1/N2/N3 三条、`status` 均为 `pass`（或按规定记 `fail`/`blocked`）；
5. 所有证据文件非空、路径与设计文档 §3.1 一致；
6. 若期间修过产品代码，`fixes/` 下有对应 `.diff` 且已同步快照（S4），并在本份末尾追加「修复记录」小节（ID / 文件 / 重跑结果）。
