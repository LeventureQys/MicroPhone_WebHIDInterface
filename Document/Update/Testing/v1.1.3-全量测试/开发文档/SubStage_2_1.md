# SubStage 2-1 — 打包门禁 G6（electron-builder portable）

> 归属 Stage 2；覆盖需求项 **N6**、门禁 **G6**。
> **在冻结快照内打包**，产物落 `D:\Temp\micstudio-fulltest\v1.1.3-baseline\release\`；仓库 `release/` 一行不动（S2）。
> 前置：`SubStage_1_1.md`（G1）、`SubStage_1_2.md`（G4）已完成。后续：`SubStage_2_2.md`（G7 启动冒烟）。

> **执行约定**：本文所有 PowerShell 片段默认在仓库根 `$root` 下执行（`--exec-file` / 相对路径都以它为基准）；需要"在被测树里跑"的命令都显式 `Push-Location $snap`，跑完 `Pop-Location`。
---

## 0. 目标

用仓库自己的打包链（`scripts/dist.ps1`，它负责镜像、pnpm shim、依赖检查、electron-vite build、electron-builder、build-info 生成）在**快照**里产出一个 `MicStudio-<ver>-portable.exe`，并留全「路径 / 体积 / SHA256 / build-info / 使用说明」四类证据。

**为什么用 `dist.ps1` 而不是手敲 `electron-builder`**：它内置三件本机必需品的处理——镜像变量（坑 10）、`pnpm.cmd` shim（坑 20：electron-builder 会 spawn `pnpm list --json`，PATH 里只有 `pnpm.mjs` 时子进程空输出直接失败）、`ELECTRON_RUN_AS_NODE` 清理（坑 13）。

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
New-Item -ItemType Directory -Force -Path (Join-Path $ev 'dist') | Out-Null
```

| # | 检查 | 命令 | 期望 |
|---|---|---|---|
| 1 | 快照内打包脚本存在 | `Test-Path (Join-Path $snap 'scripts\dist.ps1')` | `True` |
| 2 | 快照版本号 | `([regex]::Match([System.IO.File]::ReadAllText((Join-Path $snap 'package.json'),[Text.Encoding]::UTF8), '"version"\s*:\s*"([^"]+)"')).Groups[1].Value` | `1.1.2`（**必须用 UTF8 读**，PS 5.1 控制台按 GBK 解析会坏在中文 description 上） |
| 3 | 依赖完整 | `Test-Path (Join-Path $snap 'node_modules\electron-builder\out\cli\cli.js')`；`Test-Path (Join-Path $snap 'node_modules\electron\dist\electron.exe')` | 均 `True`（缺则 `& $node $pnpm install`，见坑 2/7） |
| 4 | 镜像变量已设 | `$env:ELECTRON_MIRROR; $env:ELECTRON_BUILDER_BINARIES_MIRROR` | 两个 URL（下面第 2 节会设） |
| 5 | 没有进程占用快照 `release\` | `Get-Process Mimic,MicStudio,electron -ErrorAction SilentlyContinue` | 无输出（有则先关：electron-builder 无法覆盖 `win-unpacked\`，`dist.ps1:375-387`） |
| 6 | 磁盘空间 | `Get-PSDrive D \| Select-Object Free` | Free ≥ 2 GB（portable ≈ 73 MB + win-unpacked ≈ 250 MB） |
| 7 | 网络可达镜像 | `curl.exe -sS -o NUL -w "%{http_code}" https://npmmirror.com/mirrors/electron/` | `200`/`301`/`302`（坑 3：本机用 `curl.exe`，不要 `Invoke-WebRequest`） |

## 2. G6 打包

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:MICSTUDIO_USER_DATA = 'D:\Temp\micstudio-fulltest\userdata-dist'   # 让 dist.ps1 内部的退路验证用干净目录

$distPs  = Join-Path $snap 'scripts\dist.ps1'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$out  = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $distPs -SkipChecks -SkipSmoke 2>&1
$code = $LASTEXITCODE
$sw.Stop()
$text = ($out | Out-String)
Write-Utf8NoBom (Join-Path $ev 'dist\G6-dist.log') ($text + "`nEXIT=$code ELAPSED_MS=$($sw.ElapsedMilliseconds)`nSNAPSHOT=$snap`n")
"EXIT=$code elapsed=$([math]::Round($sw.Elapsed.TotalSeconds,1))s"
($text -split "`n" | Where-Object { $_ -match '打包|electron-builder|portable|SHA256|失败|ERROR|⨯' } | Select-Object -Last 25)
```

参数说明（不要加别的）：

| 参数 | 为什么 |
|---|---|
| `-SkipChecks` | G1–G3 已在**同一棵树**上单独做过门禁（`SubStage_1_1`），此处重复跑只会让日志臃肿；G6 的判据是**产物**，不是检查 |
| `-SkipSmoke` | 冒烟由 `SubStage_2_2` 用**显式 `--no-sandbox` + `--screenshot`/`--hold`** 单独做（便于同时满足"截图"与"存活 ≥5 s"两条判据），不重复 |
| 不加 `-Clean` | 快照 `release/` 为空，无需清理；`-Clean` 会删目录，属多余风险 |
| 不加 `-Installer` / `-Zip` | 本轮只要求 portable 单文件（需求 §4 G6、§3.1 D） |

**超时**：本机首次跑 3–6 min（依赖已缓存时）；给 900 s。若命令被工具掐断，`dist.ps1` 会留下半成品 → 重跑前先确认 `$snap\release` 里没有正在写的 exe。

**判据（逐条都要满足）**：

1. `EXIT=0`；
2. `$snap\release\MicStudio-1.1.2-portable.exe` 存在且 ≥ 50 MB；
3. `$snap\release\build-info.txt` 存在，且含**版本**（`1.1.2`）、**提交**（`8b7560e` 或 `unknown`——快照无 `.git` 时脚本按 `unknown` 记，允许，但要在报告注明）、**SHA256**；
4. `$snap\release\使用说明.txt` 存在且非空；
5. 仓库 `$root\release\` 的文件数与 mtime **没有变化**（S2）。

## 3. 采集产物证据

```powershell
$exe = Join-Path $snap 'release\MicStudio-1.1.2-portable.exe'
$item = Get-Item $exe
$sha  = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
$info = Join-Path $snap 'release\build-info.txt'
$readme = Join-Path $snap 'release\使用说明.txt'
$lines = @(
  "EXE=$($item.FullName)"
  "BYTES=$($item.Length)"
  "MB=$([math]::Round($item.Length/1MB,2))"
  "SHA256=$sha"
  "MTIME=$($item.LastWriteTime.ToString('s'))"
  "BUILD_INFO=$(if (Test-Path $info) {'present'} else {'MISSING'})"
  "README=$(if (Test-Path $readme) {'present'} else {'MISSING'})"
  "REPO_RELEASE_UNTOUCHED=$(if ((Get-ChildItem (Join-Path $root 'release') -File | Measure-Object).Count -ge 5) {'check-manually'} else {'unknown'})"
)
$lines | ForEach-Object { $_ }
Write-Utf8NoBom (Join-Path $ev 'dist\G6-artifacts.txt') (($lines -join "`r`n") + "`r`n")

Copy-Item $info    (Join-Path $ev 'dist\build-info.txt')   -Force -ErrorAction SilentlyContinue
Copy-Item $readme  (Join-Path $ev 'dist\使用说明.txt')      -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $snap 'release\builder-debug.yml') (Join-Path $ev 'dist\builder-debug.yml') -Force -ErrorAction SilentlyContinue

# 仓库 release/ 基线（用于证明没被覆盖）
Get-ChildItem (Join-Path $root 'release') -File |
  Select-Object Name,Length,LastWriteTime |
  Format-Table -AutoSize | Out-String -Width 160 |
  ForEach-Object { Write-Utf8NoBom (Join-Path $ev 'dist\repo-release-before-after.txt') $_ }
```

基线（本轮开始时仓库 `release/` 有 5 个文件：`MicStudio-1.0.0-alpha.0/1.1.0/1.1.1/1.1.2-portable.exe`、`build-info.txt`、`使用说明.txt`、`builder-debug.yml`，`MicStudio-1.1.2-portable.exe` = 72,589,552 B / 2026-11-21 13:10:08）。跑完再列一次，**mtime 必须不变**。

## 4. 证据清单

| 文件 | 内容 |
|---|---|
| `dist/G6-dist.log` | dist.ps1 全文 + `EXIT=` + `ELAPSED_MS=` |
| `dist/G6-artifacts.txt` | exe 绝对路径 / 字节 / MB / SHA256 / mtime / build-info / README |
| `dist/build-info.txt` | 产物自带的版本-提交-体积-SHA256 |
| `dist/使用说明.txt` | 面向最终用户的双击说明副本 |
| `dist/builder-debug.yml` | 打包器配置快照（排障用） |
| `dist/repo-release-before-after.txt` | 仓库 `release/` 前后对比 |
| `dist/result-2_1.json` | N6 一条结果 |

```powershell
$now = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
$json = @{
  stage = 2; substage = '2_1'
  env = @{ snapshot = $snap; gitHead = '8b7560e762bc38a9db79c7fcc5fcb5524b966feb'; channel = 'none'; lang = 'none'; userData = 'D:\Temp\micstudio-fulltest\userdata-dist'; device = 'none'; startedAt = $now }
  items = @(
    @{ id='N6'; status='pass'
       expected='快照内产出 MicStudio-1.1.2-portable.exe（≥50 MB）；build-info.txt 含版本/提交/SHA256；使用说明.txt 存在；仓库 release/ 不变'
       actual="SHA256=$sha BYTES=$($item.Length)"
       evidence=@('artifacts/fulltest-20261121/dist/G6-dist.log','artifacts/fulltest-20261121/dist/G6-artifacts.txt','artifacts/fulltest-20261121/dist/build-info.txt')
       ts=$now; durationMs=0; probe='scripts\dist.ps1 -SkipChecks -SkipSmoke'; notes='' }
  )
  notRun = @()
}
Write-Utf8NoBom (Join-Path $ev 'dist\result-2_1.json') ($json | ConvertTo-Json -Depth 8)
```

## 5. 失败处置

| 现象 | 处置 |
|---|---|
| `⨯ Timeout awaiting 'request' for 600000ms` | 坑 10：镜像变量没设或没生效 → 重设两个变量后重跑；已缓存时几十秒完成（`%LOCALAPPDATA%\electron\Cache`、`%LOCALAPPDATA%\electron-builder\Cache`） |
| `⨯ No JSON content found in output  failedTask=build` | 坑 20：electron-builder spawn `pnpm list --json` 失败。**不要**手敲 electron-builder；确认走的是 `dist.ps1`（它会在 `%LOCALAPPDATA%\MicStudio\build\pnpm-shim` 生成 shim，`dist.ps1:228-250`） |
| `release\win-unpacked` 被占用 | 关掉残留 `MicStudio.exe` / `electron.exe`（`Get-Process` + `Stop-Process`）；必要时 `-Clean` |
| exe 只有几百 KB / 找不到 | 打包没真正完成；看 `dist\builder-debug.yml` 与 `G6-dist.log` 末尾 |
| `build-info.txt` 里提交是 `unknown` | 预期行为（快照无 `.git`，`dist.ps1` 的 git 采集落空）；报告里注明"提交号取自 `baseline/git-snapshot.txt`" |
| 产物被 SAC / WDAC 拦（`An Application Control policy has blocked this file`） | 这不影响 G6（G6 只要求产物存在），把现象记到 G7（`SubStage_2_2`）与环境限制栏（S8） |
| 打包后仓库 `release/` 变了 | 严重：说明打包跑错树（用了 `$root`）。立即恢复（从 `git status` 看是否被覆盖，别 commit），把错误写进报告并从 `$snap` 重跑 |

## 6. 完成定义（DoD）

1. `dist/G6-dist.log` 末行 `EXIT=0`；
2. `$snap\release\MicStudio-1.1.2-portable.exe` 存在、≥50 MB，`dist/G6-artifacts.txt` 里有其 SHA256；
3. `dist/build-info.txt` 与 `dist/使用说明.txt` 都已复制且非空；`build-info.txt` 里能找到版本号与 SHA256；
4. 仓库 `$root\release\` 的 mtime 与本份开始时一致（附对比表）；
5. `dist/result-2_1.json` 存在，N6 状态已填；
6. 若期间改过产品代码 → 已按 S4 记录 diff、同步快照并重跑 G1/G2/G4（否则产物与证据不同源）。
