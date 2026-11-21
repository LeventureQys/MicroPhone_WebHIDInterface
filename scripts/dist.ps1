#Requires -Version 5.1
<#
.SYNOPSIS
  MIC STUDIO 一键打包（Windows / PowerShell 5.1+）。

.DESCRIPTION
  从终端运行 dist.cmd（或本脚本）即可产出用户双击即用的单文件免安装包：
      release\MicStudio-<version>-portable.exe

  脚本自己负责本机打包链路的全部环境坑（定位逻辑与 scripts\start.ps1 同一套）：
  - PATH 里没有 node/pnpm：按 DSH 运行时布局定位绝对路径，并在 %LOCALAPPDATA% 下生成
    pnpm.cmd shim。electron-builder 会 spawn `pnpm list --json`，PATH 里只有 pnpm.mjs
    时打包会报 "No JSON content found in output"（AGENTS.md 已知坑 20）。
  - GitHub 直连不通：默认设 npmmirror 的 electron / electron-builder-binaries 镜像；
    外部已经设了镜像变量则不覆盖（AGENTS.md 已知坑 10）。
  - DSH 派生进程带 ELECTRON_RUN_AS_NODE=1：打包前清掉，否则冒烟启动的 Electron 会按
    Node 模式解析参数后静默退出（AGENTS.md 已知坑 13）。
  - 本机 Chromium 子进程受限：冒烟启动走 ShellExecute（Start-Process），等价资源管理器
    双击，绕开"直接 & 拉起可执行文件被沙箱掐死"的坑（已知坑 14）。

  流程：依赖检查 → 类型检查 + 单测 → electron-vite build → electron-builder portable
        → 产物校验（存在性 / 体积 / SHA256）→ 冒烟启动（截图 + startup.log 校验）
        → release\build-info.txt 与 release\使用说明.txt

  产物落在 release\（已 gitignore）：
      MicStudio-<ver>-portable.exe    单文件免安装包，双击即启动（默认唯一目标）
      MicStudio Setup <ver>.exe       可选，-Installer
      MicStudio-<ver>-win-x64.zip     可选，-Zip（解压即用的绿色版）
      win-unpacked\                   未打包目录，排障用
      build-info.txt / 使用说明.txt   版本、提交、体积、SHA256 与用户说明

  冒烟启动直接双击语义拉起产物；如果本机 App Control（SAC / WDAC，已知坑 29）拦住刚打出来的
  未签名 exe，脚本会自动退到「用签名过的 electron.exe 加载 app.asar」的退路验证，并在
  release\build-info.txt 里标注「exe 本体未能在本机启动」。这只说明本机策略不让启动，不是产物坏了。

.PARAMETER Installer
  额外产出 NSIS 安装包。本机未验证（AGENTS.md 已知坑 10 / 14），失败不影响 portable。

.PARAMETER Zip
  额外把 release\win-unpacked 压成 release\MicStudio-<ver>-win-x64.zip（解压即用）。

.PARAMETER SkipChecks
  跳过 tsc --noEmit 与 vitest run，只打包（赶时间时用，别当作发布默认）。

.PARAMETER SkipSmoke
  跳过打包后的冒烟启动（不出截图、不校验 startup.log）。

.PARAMETER SkipInstall
  依赖缺失时直接报错，不自动执行 pnpm install。

.PARAMETER Clean
  打包前清掉 release\ 下的旧产物（portable / 安装包 / zip / win-unpacked / builder-debug.yml）。
  用户数据目录 release\MicStudioData 不会被删。

.PARAMETER OpenFolder
  打包成功后用资源管理器打开 release\ 目录。

.EXAMPLE
  .\dist.cmd
  默认：类型检查 + 单测 + 单文件 portable + 冒烟启动，产物 release\MicStudio-<ver>-portable.exe。

.EXAMPLE
  .\dist.cmd -Installer -Zip -OpenFolder
  单文件包 + NSIS 安装包 + 绿色版 zip，结束后打开 release\。

.EXAMPLE
  .\dist.cmd -SkipChecks -SkipSmoke
  只跑构建与打包（仅用于反复调试打包链路，别用于交付）。
#>

[CmdletBinding()]
param(
  [switch]$Installer,

  [switch]$Zip,

  [switch]$SkipChecks,

  [switch]$SkipSmoke,

  [switch]$SkipInstall,

  [switch]$Clean,

  [switch]$OpenFolder
)

$ErrorActionPreference = 'Stop'

if (-not $PSScriptRoot) {
  throw '无法定位脚本目录，请用 dist.cmd 或 powershell -File 运行本脚本'
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoRoot

$ReleaseDir = Join-Path $RepoRoot 'release'
$ArtifactsDir = Join-Path $RepoRoot 'artifacts'
$Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

function Write-Step {
  param([string]$Message)
  Write-Host "[dist] $Message" -ForegroundColor Cyan
}

function Write-Detail {
  param([string]$Message)
  Write-Host "       $Message" -ForegroundColor DarkGray
}

function Write-Warn {
  param([string]$Message)
  Write-Host "[dist] $Message" -ForegroundColor Yellow
}

function Format-Megabytes {
  param([long]$Bytes)
  return ('{0:N1} MB' -f ($Bytes / 1MB))
}

function Get-NodeMajorVersion {
  param([string]$Path)
  try {
    $raw = & $Path -v 2>$null
    if (-not $raw) { return 0 }
    return ([version](([string]$raw).Trim().TrimStart('v'))).Major
  } catch {
    return 0
  }
}

# 与 start.ps1 同款定位：PATH 里通常没有 node（见 AGENTS.md §Toolchain），
# 优先用 DSH 运行时里的绝对路径；electron-vite 5 需要 v20+，先校验再返回。
function Resolve-NodePath {
  if ($env:MICSTUDIO_NODE) {
    if (-not (Test-Path -LiteralPath $env:MICSTUDIO_NODE -PathType Leaf)) {
      throw "MICSTUDIO_NODE 指向的文件不存在：$env:MICSTUDIO_NODE"
    }
    $explicit = (Resolve-Path -LiteralPath $env:MICSTUDIO_NODE).Path
    $explicitMajor = Get-NodeMajorVersion -Path $explicit
    if ($explicitMajor -lt 20) {
      throw "MICSTUDIO_NODE 的版本过低（v$explicitMajor，需要 v20+）：$explicit"
    }
    return $explicit
  }

  $candidates = New-Object System.Collections.Generic.List[string]

  $fromPath = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($fromPath) { $candidates.Add($fromPath.Source) }

  $dshRuntimes = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path -LiteralPath $dshRuntimes) {
    Get-ChildItem -LiteralPath $dshRuntimes -Directory -ErrorAction SilentlyContinue |
      Sort-Object -Property Name -Descending |
      ForEach-Object { $candidates.Add((Join-Path $_.FullName 'dependencies\node\bin\node.exe')) }
  }

  $candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
  if (${env:ProgramFiles(x86)}) {
    $candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'))
  }
  $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))

  $rejected = New-Object System.Collections.Generic.List[string]
  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $full = (Resolve-Path -LiteralPath $candidate).Path
    $major = Get-NodeMajorVersion -Path $full
    if ($major -ge 20) { return $full }
    $rejected.Add("$full (v$major)")
  }

  if ($rejected.Count -gt 0) {
    throw "找到的 Node.js 版本过低（electron-vite 5 需要 v20+）：$([string]::Join('；', $rejected))"
  }
  throw '找不到 Node.js（需要 v20+）。请安装 Node.js，或用环境变量 MICSTUDIO_NODE 指定 node.exe 的绝对路径'
}

function Resolve-PnpmPath {
  param([string]$NodePath)

  if ($env:MICSTUDIO_PNPM) {
    if (-not (Test-Path -LiteralPath $env:MICSTUDIO_PNPM -PathType Leaf)) {
      throw "MICSTUDIO_PNPM 指向的文件不存在：$env:MICSTUDIO_PNPM"
    }
    return (Resolve-Path -LiteralPath $env:MICSTUDIO_PNPM).Path
  }

  $candidates = New-Object System.Collections.Generic.List[string]

  # DSH 运行时把 node 和 pnpm 放在同一个 dependencies 目录下，从 node.exe 反推：
  # ...\dependencies\node\bin\node.exe → ...\dependencies\pnpm\bin\pnpm.mjs
  $depsDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $NodePath))
  if ($depsDir) { $candidates.Add((Join-Path $depsDir 'pnpm\bin\pnpm.mjs')) }

  $dshRuntimes = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path -LiteralPath $dshRuntimes) {
    Get-ChildItem -LiteralPath $dshRuntimes -Directory -ErrorAction SilentlyContinue |
      Sort-Object -Property Name -Descending |
      ForEach-Object { $candidates.Add((Join-Path $_.FullName 'dependencies\pnpm\bin\pnpm.mjs')) }
  }

  foreach ($name in @('pnpm.cmd', 'pnpm.exe', 'pnpm')) {
    $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { $candidates.Add($command.Source) }
  }

  $candidates.Add((Join-Path $env:APPDATA 'npm\pnpm.cmd'))

  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  return $null
}

function Add-PathEntry {
  param([string]$Directory)

  if ([string]::IsNullOrWhiteSpace($Directory)) { return }
  $trimmed = $Directory.TrimEnd('\')
  $rest = @($env:PATH -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ne $trimmed })
  $env:PATH = (@($trimmed) + $rest) -join ';'
}

# electron-builder 的依赖收集器直接 spawn `pnpm list --json`；本机 PATH 里只有
# pnpm.mjs，没有 pnpm 可执行文件，子进程只会得到空输出（已知坑 20，实测）。
# 这里在 %LOCALAPPDATA% 下生成一次性 shim，并把它放到 PATH 最前面。
function New-PnpmShim {
  param([string]$NodePath, [string]$PnpmPath)

  if ($PnpmPath -notmatch '\.(mjs|cjs|js)$') {
    # 已经是 pnpm.cmd / pnpm.exe：把它所在目录提到 PATH 最前面就够了
    Add-PathEntry (Split-Path -Parent $PnpmPath)
    return $null
  }

  $shimDir = Join-Path $env:LOCALAPPDATA 'MicStudio\build\pnpm-shim'
  New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
  $cmdPath = Join-Path $shimDir 'pnpm.cmd'
  $content = @(
    '@echo off',
    'rem Generated by scripts\dist.ps1 on every run. Do not edit.',
    'rem electron-builder spawns `pnpm list --json`, but this machine only has',
    'rem pnpm.mjs on PATH (AGENTS.md known trap 20).',
    ('"{0}" "{1}" %*' -f $NodePath, $PnpmPath),
    ''
  ) -join "`r`n"
  # 无 BOM 的 UTF-8：cmd.exe 会把 BOM 当成命令的一部分
  [System.IO.File]::WriteAllText($cmdPath, $content, (New-Object System.Text.UTF8Encoding($false)))
  Add-PathEntry $shimDir
  return $shimDir
}

function Get-ProjectVersion {
  $pkgPath = Join-Path $RepoRoot 'package.json'
  if (-not (Test-Path -LiteralPath $pkgPath -PathType Leaf)) {
    throw "找不到 package.json：$pkgPath（dist.ps1 必须放在仓库的 scripts\ 下）"
  }
  # 必须显式按 UTF-8 读：PowerShell 5.1 的 Get-Content 默认按 ANSI(GBK) 解码无 BOM 的
  # package.json，中文 description 会变成乱码，ConvertFrom-Json 直接报错。
  $raw = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8)
  $pkg = $raw | ConvertFrom-Json
  if (-not $pkg.version) { throw 'package.json 里没有 version 字段' }
  return [string]$pkg.version
}

function Get-PackageVersion {
  param([string]$PackageName)

  $pkgPath = Join-Path $RepoRoot "node_modules\$PackageName\package.json"
  if (-not (Test-Path -LiteralPath $pkgPath -PathType Leaf)) { return 'not installed' }
  try {
    $raw = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8)
    return [string]($raw | ConvertFrom-Json).version
  } catch {
    return 'unknown'
  }
}

function Get-GitSummary {
  $git = 'C:\Program Files\Git\cmd\git.exe'
  if (-not (Test-Path -LiteralPath $git -PathType Leaf)) {
    $command = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { return 'unknown' }
    $git = $command.Source
  }
  try {
    $sha = (& $git -C $RepoRoot rev-parse --short HEAD 2>$null)
    if (-not $sha) { return 'unknown' }
    $dirty = (& $git -C $RepoRoot status --porcelain 2>$null)
    if ($dirty) { return "$sha (dirty)" }
    return "$sha (clean)"
  } catch {
    return 'unknown'
  }
}

function Test-Dependencies {
  $required = @($ElectronVitePath, $ElectronExePath, $BuilderCliPath)
  if (-not $SkipChecks) { $required += @($TscPath, $VitestPath) }
  foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
  }
  return $true
}

function Install-Dependencies {
  if ($SkipInstall) {
    throw '依赖不完整（缺 electron-vite / electron-builder / Electron 二进制），且指定了 -SkipInstall'
  }

  Write-Step '安装依赖（首次运行要下载 Electron，慢的话等几分钟）'
  & $NodePath $PnpmPath install
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm install 失败（exit $LASTEXITCODE）。若报 ERR_PNPM_IGNORED_BUILDS，检查 pnpm-workspace.yaml 的 allowBuilds（已知坑 2）"
  }

  # pnpm 的 allowBuilds 已经放行 electron 的 postinstall；万一仍缺二进制，再单独补一次。
  if (-not (Test-Path -LiteralPath $ElectronExePath -PathType Leaf)) {
    $installer = Join-Path $RepoRoot 'node_modules\electron\install.js'
    if (Test-Path -LiteralPath $installer -PathType Leaf) {
      Write-Step '补下载 Electron 二进制'
      & $NodePath $installer
      if ($LASTEXITCODE -ne 0) { throw "Electron 二进制下载失败（exit $LASTEXITCODE）" }
    }
  }

  if (-not (Test-Dependencies)) {
    throw '依赖安装后仍不完整：缺 electron-vite / electron-builder / Electron 二进制'
  }
}

function Invoke-Checks {
  Write-Step '类型检查（tsc --noEmit）'
  & $NodePath $TscPath --noEmit
  if ($LASTEXITCODE -ne 0) {
    throw "类型检查失败（exit $LASTEXITCODE）；确认无误后可用 -SkipChecks 跳过"
  }
  Write-Detail '类型检查通过'

  Write-Step '单元测试（vitest run）'
  & $NodePath $VitestPath run
  if ($LASTEXITCODE -ne 0) {
    throw "单元测试失败（exit $LASTEXITCODE）；确认无误后可用 -SkipChecks 跳过"
  }
  Write-Detail '单元测试通过'
}

function Invoke-AppBuild {
  Write-Step '构建 main / preload / renderer（electron-vite build）'
  $started = Get-Date
  & $NodePath $ElectronVitePath build
  if ($LASTEXITCODE -ne 0) { throw "构建失败（exit $LASTEXITCODE）" }
  Write-Detail ("构建完成，耗时 {0:N1}s" -f ((Get-Date) - $started).TotalSeconds)
}

function Invoke-ElectronBuilder {
  param(
    [string[]]$Targets,
    [string]$Label
  )

  Write-Step "打包：$Label（electron-builder）"
  $started = Get-Date
  & $NodePath $BuilderCliPath @Targets '--publish' 'never'
  if ($LASTEXITCODE -ne 0) {
    throw "electron-builder 失败（exit $LASTEXITCODE）。排查顺序：镜像变量 → pnpm shim（已知坑 20）→ release\builder-debug.yml"
  }
  Write-Detail ("打包完成，耗时 {0:N1}s" -f ((Get-Date) - $started).TotalSeconds)
}

# release\win-unpacked 里的 exe 被占用时 electron-builder 会报文件锁，
# 报错信息很不直观，先在入口处说清楚。
function Assert-ReleaseNotInUse {
  if (-not (Test-Path -LiteralPath $ReleaseDir)) { return }
  $releaseFull = [System.IO.Path]::GetFullPath($ReleaseDir)
  $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $path = $null
      try { $path = $_.Path } catch { $path = $null }
      $path -and $path.StartsWith($releaseFull, [System.StringComparison]::OrdinalIgnoreCase)
    })
  if ($running.Count -gt 0) {
    $names = ($running | Select-Object -ExpandProperty ProcessName -Unique) -join ', '
    throw "release\ 下有进程正在运行（$names），请先关掉它再打包（否则 electron-builder 无法覆盖 win-unpacked\）"
  }
}

function Remove-StaleArtifacts {
  if (-not (Test-Path -LiteralPath $ReleaseDir)) { return }

  Write-Step '清理 release\ 下的旧产物（保留 MicStudioData）'
  $releaseFull = [System.IO.Path]::GetFullPath($ReleaseDir)
  $patterns = @('MicStudio-*-portable.exe', 'MicStudio Setup *.exe', 'MicStudio-*-win-x64.zip', 'builder-debug.yml', 'builder-effective-config.yaml')
  foreach ($pattern in $patterns) {
    Get-ChildItem -LiteralPath $ReleaseDir -Filter $pattern -File -ErrorAction SilentlyContinue | ForEach-Object {
      $full = [System.IO.Path]::GetFullPath($_.FullName)
      if (-not $full.StartsWith($releaseFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝删除 release\ 之外的文件：$full"
      }
      Remove-Item -LiteralPath $full -Force
      Write-Detail "删除 $($_.Name)"
    }
  }

  $unpacked = Join-Path $ReleaseDir 'win-unpacked'
  if (Test-Path -LiteralPath $unpacked) {
    $full = [System.IO.Path]::GetFullPath($unpacked)
    if ($full.StartsWith($releaseFull, [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $full -Recurse -Force
      Write-Detail '删除 win-unpacked\'
    }
  }
}

function Resolve-Artifact {
  param(
    [string]$Pattern,
    [long]$MinimumBytes,
    [string]$Label
  )

  $candidates = @(Get-ChildItem -LiteralPath $ReleaseDir -Filter $Pattern -File -ErrorAction SilentlyContinue |
      Sort-Object -Property LastWriteTime -Descending)
  if ($candidates.Count -eq 0) {
    throw "打包结束但没有找到$Label（release\$Pattern）"
  }
  $item = $candidates[0]
  if ($item.Length -lt $MinimumBytes) {
    throw "$Label 体积异常（$($item.Name) 只有 $($item.Length) B，预期 ≥ $MinimumBytes B）"
  }
  return $item
}

function New-UnpackedZip {
  param([string]$Version)

  $source = Join-Path $ReleaseDir 'win-unpacked'
  if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    Write-Warn '没有 win-unpacked\，跳过绿色版 zip'
    return $null
  }

  $zipPath = Join-Path $ReleaseDir ("MicStudio-{0}-win-x64.zip" -f $Version)
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

  Write-Step '压缩绿色版（win-unpacked → zip）'
  $started = Get-Date
  Compress-Archive -Path (Join-Path $source '*') -DestinationPath $zipPath -CompressionLevel Optimal
  if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) { throw "zip 生成失败：$zipPath" }
  Write-Detail ("zip 完成，耗时 {0:N1}s" -f ((Get-Date) - $started).TotalSeconds)
  return $zipPath
}

# 本机 App Control（SAC / WDAC，已知坑 29）会拦住刚打出来的未签名 exe，ShellExecute 直接
# 报 "An Application Control policy has blocked this file."（中文系统是一句本地化提示）。
# 退路：用仓库里签名过的 electron.exe 加载同一个 app.asar，验证打进去的内容能起窗口、能渲染。
# 它证明的是"产物内容没错"，不是"本机能双击这个 exe"——后者由策略决定，脚本无权绕过。
function Invoke-PayloadProbe {
  param([string]$Version)

  $asar = Join-Path $ReleaseDir 'win-unpacked\resources\app.asar'
  if (-not (Test-Path -LiteralPath $asar -PathType Leaf)) {
    throw "退路验证失败：找不到 $asar"
  }
  $electron = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) {
    throw "退路验证失败：找不到 $electron"
  }

  $shotPath = Join-Path $ArtifactsDir ("dist-payload-{0}.png" -f $Version)
  $userData = Join-Path $ArtifactsDir 'dist-payload-userdata'
  if (Test-Path -LiteralPath $shotPath) { Remove-Item -LiteralPath $shotPath -Force }
  if (Test-Path -LiteralPath $userData) { Remove-Item -LiteralPath $userData -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $userData | Out-Null

  $arguments = @($asar)
  if ($shotPath -match '\s') { $arguments += '--screenshot="{0}"' -f $shotPath } else { $arguments += '--screenshot={0}' -f $shotPath }
  $arguments += '--no-sandbox'

  # asar 模式不是 packaged，主进程会按 MICSTUDIO_USER_DATA 落数据；指到 artifacts 下，别污染 .userdata
  $previousUserData = $env:MICSTUDIO_USER_DATA
  $env:MICSTUDIO_USER_DATA = $userData
  try {
    $process = Start-Process -FilePath $electron -ArgumentList $arguments -PassThru -ErrorAction Stop
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
      if (Test-Path -LiteralPath $shotPath -PathType Leaf) { break }
      Start-Sleep -Milliseconds 400
    }
    if (-not (Test-Path -LiteralPath $shotPath -PathType Leaf)) {
      throw '退路验证失败：签名 electron 加载 app.asar 也没有出图'
    }

    $shot = Get-Item -LiteralPath $shotPath
    if ($shot.Length -lt 10KB) {
      throw "退路验证截图过小（$($shot.Length) B）：$shotPath"
    }

    $logSource = Join-Path $userData 'startup.log'
    if (Test-Path -LiteralPath $logSource -PathType Leaf) {
      $logText = [System.IO.File]::ReadAllText($logSource, [System.Text.Encoding]::UTF8)
      if ($logText -notmatch 'did-finish-load') {
        throw '退路验证：startup.log 里没有 did-finish-load'
      }
      Copy-Item -LiteralPath $logSource -Destination (Join-Path $ArtifactsDir 'dist-payload-startup.log') -Force
    }

    if (-not $process.WaitForExit(15000)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    return @{ Screenshot = $shotPath; Bytes = $shot.Length }
  } finally {
    if ($null -eq $previousUserData) {
      Remove-Item Env:MICSTUDIO_USER_DATA -ErrorAction SilentlyContinue
    } else {
      $env:MICSTUDIO_USER_DATA = $previousUserData
    }
    Remove-Item -LiteralPath $userData -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# 打包产物是 GUI 程序：直接 & 拉起会被本机沙箱掐死（已知坑 14），
# Start-Process 走 ShellExecute，等价资源管理器双击，因此这里用它做冒烟。
# portable 是 NSIS 自解压包：不带 --no-sandbox 时 Chromium 子进程起不来，
# 解包器会立刻带着 0x80000003 退出（已知坑 14 / 18，scripts\screenshot.mjs 同款处理）。
function Invoke-SmokeTest {
  param(
    [string]$ExePath,
    [string]$Version
  )

  New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null
  $shotPath = Join-Path $ArtifactsDir ("dist-smoke-{0}.png" -f $Version)
  if (Test-Path -LiteralPath $shotPath) { Remove-Item -LiteralPath $shotPath -Force }

  $dataDir = Join-Path (Split-Path -Parent $ExePath) 'MicStudioData'
  $dataExisted = Test-Path -LiteralPath $dataDir

  $arguments = @()
  if ($shotPath -match '\s') { $arguments += '--screenshot="{0}"' -f $shotPath } else { $arguments += '--screenshot={0}' -f $shotPath }
  $arguments += '--no-sandbox'

  Write-Step '冒烟启动（等价双击；出图后自动退出）'
  Write-Detail "exe：$ExePath"

  $launchError = $null
  $process = $null
  try {
    $process = Start-Process -FilePath $ExePath -ArgumentList $arguments -PassThru -ErrorAction Stop
  } catch {
    $launchError = $_.Exception.Message
  }

  if (-not $launchError) {
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
      if (Test-Path -LiteralPath $shotPath -PathType Leaf) { break }
      Start-Sleep -Milliseconds 400
    }
  }

  if ($launchError -or -not (Test-Path -LiteralPath $shotPath -PathType Leaf)) {
    if ($launchError) {
      Write-Warn "产物启动被系统拦住：$launchError"
    } else {
      $state = if ($process.HasExited) {
        '进程已退出（exit {0} / 0x{1:X8}）' -f $process.ExitCode, $process.ExitCode
      } else {
        '进程仍在运行'
      }
      Write-Warn "产物启动 120 秒内没有出图，$state"
    }
    Write-Warn '改做退路验证：用签名过的 electron.exe 加载打包出来的 app.asar'
    Write-Detail '这只证明打包内容可用；本机双击 exe 是否被策略拦截要单独确认（已知坑 29）'
    $probe = Invoke-PayloadProbe -Version $Version
    $note = if ($launchError) { $launchError } else { 'no screenshot within 120s' }
    return @{ Status = 'payload-only'; Screenshot = $probe.Screenshot; Bytes = $probe.Bytes; Note = $note }
  }

  $shot = Get-Item -LiteralPath $shotPath
  if ($shot.Length -lt 10KB) {
    throw "冒烟截图过小（$($shot.Length) B），窗口可能没渲染起来：$shotPath"
  }

  $logSource = Join-Path $dataDir 'startup.log'
  $logCopy = Join-Path $ArtifactsDir 'dist-smoke-startup.log'
  if (Test-Path -LiteralPath $logSource -PathType Leaf) {
    Copy-Item -LiteralPath $logSource -Destination $logCopy -Force
    $logText = [System.IO.File]::ReadAllText($logCopy, [System.Text.Encoding]::UTF8)
    if ($logText -notmatch 'boot packaged=true') {
      throw "startup.log 里没有 boot packaged=true，跑起来的不是打包产物：$logCopy"
    }
    if ($logText -notmatch 'did-finish-load') {
      throw "startup.log 里没有 did-finish-load，页面没有加载完成：$logCopy"
    }
    Write-Detail "启动日志：$logCopy"
  } else {
    Write-Warn "没有找到 startup.log（$logSource），跳过日志校验"
  }

  # 冒烟产生的数据目录是本次新建的才删；用户自己跑 portable 留下的数据保留
  if (-not $dataExisted) {
    $full = [System.IO.Path]::GetFullPath($dataDir)
    $exeDir = [System.IO.Path]::GetFullPath((Split-Path -Parent $ExePath))
    if ($full.StartsWith($exeDir + [System.IO.Path]::DirectorySeparatorChar) -and (Split-Path -Leaf $full) -eq 'MicStudioData') {
      Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  # 截图模式会自己 app.exit(0)，但 portable 解包器收尾还要 1–2 s；给它退出的时间，
  # 别在它清理 %TEMP% 解包目录时掐掉。
  if (-not $process.WaitForExit(10000)) {
    Write-Warn '冒烟进程 10 秒内没退出，强制结束'
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }

  return @{ Status = 'passed'; Screenshot = $shotPath; Bytes = $shot.Length; Note = '' }
}

function Write-BuildInfo {
  param(
    [string]$Version,
    [string]$NodeVersion,
    [string]$GitSummary,
    [object[]]$Artifacts,
    [string]$SmokeStatus,
    [string]$SmokeNote,
    [string]$SmokeShot
  )

  $lines = @()
  $lines += 'MIC STUDIO 打包信息'
  $lines += '=' * 40
  $lines += "生成时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
  $lines += "版本：$Version"
  $lines += "提交：$GitSummary"
  $lines += "Node：$NodeVersion"
  $lines += "Electron：$(Get-PackageVersion 'electron')"
  $lines += "electron-builder：$(Get-PackageVersion 'electron-builder')"
  $lines += "耗时：$([math]::Round($Stopwatch.Elapsed.TotalSeconds, 1)) s"
  $lines += ''
  $lines += '产物：'
  foreach ($item in $Artifacts) {
    $item = Get-Item -LiteralPath $item.FullName
    $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
    $lines += ('  {0}' -f $item.Name)
    $lines += ('    体积：{0} B（{1}）' -f $item.Length, (Format-Megabytes $item.Length))
    $lines += ('    SHA256：{0}' -f $hash)
  }
  $lines += ''
  if ($SmokeStatus -eq 'passed') {
    $lines += "冒烟启动：通过（截图 $SmokeShot；日志 artifacts\dist-smoke-startup.log）"
  } elseif ($SmokeStatus -eq 'payload-only') {
    $lines += '冒烟启动：exe 本体没能在本机启动（系统策略拦截），已退路验证打包内容'
    $lines += "  策略提示：$SmokeNote"
    $lines += "  退路截图：$SmokeShot（签名 electron.exe 加载 app.asar）"
    $lines += '  交付前请在目标机手动双击 exe 复核一次'
  } else {
    $lines += '冒烟启动：已跳过（-SkipSmoke）'
  }
  $lines += ''
  $lines += '重新生成：.\dist.cmd'

  $path = Join-Path $ReleaseDir 'build-info.txt'
  # 带 BOM：记事本和 PowerShell 5.1 的 Get-Content 默认按 ANSI 读无 BOM 文本，中文会乱码
  [System.IO.File]::WriteAllText($path, (($lines -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($true)))
  return $path
}

function Write-UsageReadme {
  param(
    [string]$Version,
    [string]$PortableName
  )

  $lines = @()
  $lines += 'MIC STUDIO 一键启动说明'
  $lines += ''
  $lines += "版本：$Version"
  $lines += ''
  $lines += '一、怎么启动'
  $lines += "  双击 $PortableName 即可启动，不用安装、不用装 Node.js，"
  $lines += '  整个软件就是这一个 exe，拷到别的 Windows 10/11 x64 机器上同样能跑。'
  $lines += ''
  $lines += '二、双击没反应 / 被拦'
  $lines += '  1. Windows SmartScreen：点「更多信息」→「仍要运行」。'
  $lines += '  2. 被安全软件隔离：把该 exe 加入信任后重试。'
  $lines += '  3. 公司策略（App Control）：改名或换目录也绕不过，需要 IT 放行签名。'
  $lines += '  4. 双击后窗口一闪而过（Chromium 沙箱被本机策略限制，见下）：'
  $lines += '     cmd /c start "" "<exe 的完整路径>" --no-sandbox'
  $lines += '  5. 命令行代跑：cmd /c start "" "<exe 的完整路径>"'
  $lines += ''
  $lines += '三、数据放哪里'
  $lines += '  配置与启动日志在 exe 同级的 MicStudioData\ 目录（首次运行自动创建）：'
  $lines += '    MicStudioData\startup.log   启动过程，出问题先看它'
  $lines += '  把 exe 拷走时，MicStudioData\ 可以一起拷（配置跟着走），也可以不拷。'
  $lines += '  注意：先退出软件再移动 exe，否则 exe 被占用无法移动。'
  $lines += ''
  $lines += '四、接设备'
  $lines += '  插上 M001（USB\VID_0A67&PID_0010），软件启动后会自动连接并同步参数；'
  $lines += '  设备抽屉里也能手动「打开」，虚拟桥接通道用于没有真机时演示。'
  $lines += ''
  $lines += '五、常见问题'
  $lines += '  - 窗口一闪而过：看 MicStudioData\startup.log 最后几行。'
  $lines += '  - 找不到设备：换一根数据线 / 直接插后置 USB 口，不要经扩展坞。'
  $lines += '  - 参数改不动：确认顶栏是「已连接 / 已同步」，设备停在升级模式时先去固件升级抽屉。'

  $path = Join-Path $ReleaseDir '使用说明.txt'
  # 带 BOM：这类 txt 会被用户用记事本 / 老 PowerShell 打开，无 BOM 时中文是乱码
  [System.IO.File]::WriteAllText($path, (($lines -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($true)))
  return $path
}

# ---- 主流程 -----------------------------------------------------------------

$smokeShot = $null
$smokeStatus = 'skipped'
$smokeNote = ''
$artifactItems = @()

try {
  $Version = Get-ProjectVersion

  $NodePath = Resolve-NodePath
  $NodeBin = Split-Path -Parent $NodePath
  Add-PathEntry $NodeBin

  $PnpmPath = Resolve-PnpmPath -NodePath $NodePath
  if (-not $PnpmPath) {
    throw '找不到 pnpm（打包必需，electron-builder 要用它收集依赖）。请安装 pnpm，或用 MICSTUDIO_PNPM 指定 pnpm.mjs 的绝对路径'
  }

  # 镜像只作默认值，外部已经设了就不覆盖（CI / 离线镜像站可以自己指定）
  if (-not $env:ELECTRON_MIRROR) {
    $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  }
  if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
  }

  # DSH 派生的进程带着 ELECTRON_RUN_AS_NODE=1，会让 Electron 按 Node 模式解析参数后静默退出
  if (Test-Path Env:ELECTRON_RUN_AS_NODE) {
    Remove-Item Env:ELECTRON_RUN_AS_NODE
  }

  $ElectronVitePath = Join-Path $RepoRoot 'node_modules\electron-vite\bin\electron-vite.js'
  $ElectronExePath = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
  $BuilderCliPath = Join-Path $RepoRoot 'node_modules\electron-builder\out\cli\cli.js'
  $TscPath = Join-Path $RepoRoot 'node_modules\typescript\bin\tsc'
  $VitestPath = Join-Path $RepoRoot 'node_modules\vitest\vitest.mjs'

  New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null
  $shimDir = New-PnpmShim -NodePath $NodePath -PnpmPath $PnpmPath

  Write-Host ''
  Write-Host '  MIC STUDIO 一键打包' -ForegroundColor White
  Write-Detail "仓库：$RepoRoot"
  Write-Detail "版本：$Version"
  Write-Detail "Node：$((& $NodePath -v).Trim())（$NodePath）"
  Write-Detail "pnpm：$PnpmPath"
  if ($shimDir) { Write-Detail "pnpm shim：$shimDir（electron-builder 依赖收集用）" }
  Write-Detail '目标：单文件免安装包 release\MicStudio-<ver>-portable.exe'
  Write-Host ''

  if (-not (Test-Dependencies)) { Install-Dependencies } else { Write-Detail '依赖已就绪' }

  if ($Clean) { Remove-StaleArtifacts }

  Assert-ReleaseNotInUse

  if ($SkipChecks) {
    Write-Warn '已跳过类型检查与单测（-SkipChecks），产物只保证能编译'
  } else {
    Invoke-Checks
  }

  Invoke-AppBuild

  Invoke-ElectronBuilder -Targets @('--win', 'portable') -Label '单文件免安装包（portable）'

  if ($Installer) {
    try {
      Invoke-ElectronBuilder -Targets @('--win', 'nsis') -Label 'NSIS 安装包'
      $installerItem = Resolve-Artifact -Pattern 'MicStudio Setup *.exe' -MinimumBytes 40MB -Label 'NSIS 安装包'
      $artifactItems += $installerItem
    } catch {
      # 安装包本机未验证（已知坑 10 / 14）：失败只告警，不拖垮 portable
      Write-Warn "NSIS 安装包失败：$($_.Exception.Message)"
    }
  }

  $portable = Resolve-Artifact -Pattern 'MicStudio-*-portable.exe' -MinimumBytes 40MB -Label '单文件免安装包'
  $artifactItems = @($portable) + $artifactItems

  if ($Zip) {
    $zipPath = New-UnpackedZip -Version $Version
    if ($zipPath) { $artifactItems += (Get-Item -LiteralPath $zipPath) }
  }

  if ($SkipSmoke) {
    Write-Warn '已跳过冒烟启动（-SkipSmoke），未验证产物能否起窗口'
  } else {
    $smoke = Invoke-SmokeTest -ExePath $portable.FullName -Version $Version
    $smokeShot = $smoke.Screenshot
    $smokeStatus = $smoke.Status
    $smokeNote = $smoke.Note
    if ($smokeStatus -eq 'passed') {
      Write-Detail ("冒烟通过：截图 {0}（{1} B）" -f $smokeShot, $smoke.Bytes)
    } else {
      Write-Warn '产物 exe 没能在本机直接启动（系统策略拦截）；打包内容已用退路验证，交付前请手动双击复核'
    }
  }

  $gitSummary = Get-GitSummary
  $infoPath = Write-BuildInfo -Version $Version -NodeVersion ((& $NodePath -v).Trim()) `
    -GitSummary $gitSummary -Artifacts $artifactItems -SmokeStatus $smokeStatus -SmokeNote $smokeNote -SmokeShot $smokeShot
  $readmePath = Write-UsageReadme -Version $Version -PortableName $portable.Name

  $Stopwatch.Stop()
  Write-Host ''
  Write-Host '  打包完成' -ForegroundColor Green
  foreach ($item in $artifactItems) {
    $item = Get-Item -LiteralPath $item.FullName
    $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
    Write-Host ("  {0}" -f $item.FullName) -ForegroundColor White
    Write-Host ("    {0}   SHA256 {1}" -f (Format-Megabytes $item.Length), $hash) -ForegroundColor DarkGray
  }
  Write-Detail "打包信息：$infoPath"
  Write-Detail "用户说明：$readmePath"
  if ($smokeShot) { Write-Detail "冒烟截图：$smokeShot" }
  Write-Host ''
  Write-Host ("  产物就是一个 exe：双击 {0} 即启动，不用安装" -f $portable.Name) -ForegroundColor Cyan
  if ($smokeStatus -eq 'payload-only') {
    Write-Host '  注意：本机策略拦住了这个 exe 的直接启动，产物内容已退路验证；请换一台机或放行后双击复核' -ForegroundColor Yellow
  }
  Write-Host ("  单次打包耗时 {0:N1}s" -f $Stopwatch.Elapsed.TotalSeconds) -ForegroundColor DarkGray
  Write-Host ''

  if ($OpenFolder) {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $ReleaseDir
  }
} catch {
  Write-Host ''
  Write-Host "[dist] 打包失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host '        排查顺序：镜像变量 → pnpm shim（已知坑 20）→ release\builder-debug.yml → 关掉占用 release\win-unpacked 的进程' -ForegroundColor DarkGray
  if ($env:MICSTUDIO_DEBUG) {
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
  }
  exit 1
}

exit 0
