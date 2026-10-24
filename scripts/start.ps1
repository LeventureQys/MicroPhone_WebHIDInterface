#Requires -Version 5.1
<#
.SYNOPSIS
  MIC STUDIO 一键启动（Windows / PowerShell 5.1+）。

.DESCRIPTION
  双击仓库根目录的 start.cmd 即可启动，参数原样透传。脚本自己负责本机的环境坑：
  - PATH 里没有 node/pnpm：按 DSH 运行时布局定位绝对路径，并把 node 目录塞回 PATH
  - DSH 工具进程带 ELECTRON_RUN_AS_NODE=1：启动前清掉，否则 Electron 会按 Node 模式解析参数后静默退出
  - 默认 userData 在本机沙箱下会崩（0xC0000005）：显式落到项目内 .userdata
  - 本机 Chromium 子进程受限：默认给 Electron 加 --no-sandbox（-Sandboxed 可关闭）
  - GitHub 直连不通：依赖安装/Electron 下载预置 npmmirror 镜像

.PARAMETER Mode
  dev（默认）＝ electron-vite dev，界面热更新；app ＝ 启动 out/ 里已构建的产物（源码比产物新时自动重建）。

.PARAMETER Rebuild
  app 模式下无条件重建，跳过时间戳判断。

.PARAMETER SkipInstall
  依赖缺失时直接报错，不自动执行 pnpm install。

.PARAMETER Sandboxed
  不给 Electron 加 --no-sandbox。只有确认本机 Chromium 沙箱可用时才加这个开关。

.PARAMETER Bridge
  启动前顺带拉起 WebHID 虚拟设备桥接（third_party/web_hid_utils 的 virtual_hid，127.0.0.1:8765），
  退出时自动关闭自己拉起的那个进程；已有桥接在跑则直接复用。

.EXAMPLE
  .\start.cmd
  开发模式启动。

.EXAMPLE
  .\start.cmd app -Rebuild
  强制重建后启动构建产物。

.EXAMPLE
  .\start.cmd -Bridge
  开发模式 + 虚拟 HID 桥接，设备抽屉可直接连虚拟设备。
#>

[CmdletBinding()]
param(
  [ValidateSet('dev', 'app')]
  [string]$Mode = 'dev',

  [switch]$Rebuild,

  [switch]$SkipInstall,

  [switch]$Sandboxed,

  [switch]$Bridge
)

$ErrorActionPreference = 'Stop'

if (-not $PSScriptRoot) {
  throw '无法定位脚本目录，请用 start.cmd 或 powershell -File 运行本脚本'
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoRoot

function Write-Step {
  param([string]$Message)
  Write-Host "[start] $Message" -ForegroundColor Cyan
}

function Write-Detail {
  param([string]$Message)
  Write-Host "        $Message" -ForegroundColor DarkGray
}

function Write-Warn {
  param([string]$Message)
  Write-Host "[start] $Message" -ForegroundColor Yellow
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

# PATH 里通常没有 node（见 AGENTS.md §Toolchain），优先用 DSH 运行时里的绝对路径；
# 版本低于 v20 的 node 会让 electron-vite 5 直接报错，所以先校验再返回。
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

# 只有需要安装依赖时才找 pnpm：日常启动不应该被 pnpm 挡住。
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

function Resolve-PythonPath {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:MICSTUDIO_PYTHON) { $candidates.Add($env:MICSTUDIO_PYTHON) }

  $fromPath = Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($fromPath) { $candidates.Add($fromPath.Source) }

  $dshRuntimes = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path -LiteralPath $dshRuntimes) {
    Get-ChildItem -LiteralPath $dshRuntimes -Directory -ErrorAction SilentlyContinue |
      Sort-Object -Property Name -Descending |
      ForEach-Object { $candidates.Add((Join-Path $_.FullName 'dependencies\python\python.exe')) }
  }

  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  return $null
}

function Invoke-Pnpm {
  param([string[]]$Arguments)

  $pnpm = Resolve-PnpmPath -NodePath $NodePath
  if (-not $pnpm) {
    throw '找不到 pnpm。请先安装 pnpm（或用 MICSTUDIO_PNPM 指定 pnpm.mjs 的绝对路径）后重试'
  }
  Write-Detail "pnpm：$pnpm"
  if ($pnpm -match '\.(mjs|cjs|js)$') {
    & $NodePath $pnpm @Arguments
  } else {
    & $pnpm @Arguments
  }
}

function Install-Dependencies {
  if ($SkipInstall) {
    throw '依赖不完整（缺 electron-vite 或 Electron 二进制），且指定了 -SkipInstall'
  }

  Write-Step '安装依赖（首次运行要下载 Electron，慢的话等几分钟）'
  Invoke-Pnpm -Arguments @('install')
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm install 失败（exit $LASTEXITCODE）。若报 ERR_PNPM_IGNORED_BUILDS，检查 pnpm-workspace.yaml 的 allowBuilds"
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
    throw '依赖安装后仍不完整：缺 node_modules/electron-vite 或 node_modules/electron/dist/electron.exe'
  }
}

function Test-Dependencies {
  return (Test-Path -LiteralPath $ElectronVitePath -PathType Leaf) -and
    (Test-Path -LiteralPath $ElectronExePath -PathType Leaf)
}

function Get-LatestWriteTime {
  param([string[]]$RelativePaths)

  $latest = [datetime]::MinValue
  foreach ($relative in $RelativePaths) {
    $full = Join-Path $RepoRoot $relative
    if (-not (Test-Path -LiteralPath $full)) { continue }
    $item = Get-Item -LiteralPath $full
    if ($item.PSIsContainer) {
      Get-ChildItem -LiteralPath $full -Recurse -File -Force -ErrorAction SilentlyContinue |
        ForEach-Object { if ($_.LastWriteTime -gt $latest) { $latest = $_.LastWriteTime } }
    } elseif ($item.LastWriteTime -gt $latest) {
      $latest = $item.LastWriteTime
    }
  }
  return $latest
}

# out/ 三个入口中最旧的一个，比「源码 + 构建配置」最新的一个还新，才算构建产物没过期。
function Test-BuildFresh {
  $outputs = @('out\main\index.js', 'out\preload\index.js', 'out\renderer\index.html')
  $oldestOutput = [datetime]::MaxValue
  foreach ($relative in $outputs) {
    $full = Join-Path $RepoRoot $relative
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return $false }
    $written = (Get-Item -LiteralPath $full).LastWriteTime
    if ($written -lt $oldestOutput) { $oldestOutput = $written }
  }

  $newestSource = Get-LatestWriteTime @(
    'src',
    'third_party\web_hid_utils\packages\webhid-kit\src',
    'electron.vite.config.ts'
  )
  return ($newestSource -le $oldestOutput)
}

function Invoke-AppBuild {
  Write-Step '构建 main / preload / renderer（electron-vite build）'
  $started = Get-Date
  & $NodePath $ElectronVitePath build
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "构建失败（exit $code）" }
  Write-Detail ("构建完成，耗时 {0:N1}s" -f ((Get-Date) - $started).TotalSeconds)
}

function Test-PortOpen {
  param([int]$Port)

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(300)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Start-VirtualHidBridge {
  $port = 8765
  if (Test-PortOpen -Port $port) {
    Write-Detail "127.0.0.1:$port 已有桥接在跑，直接复用"
    return $null
  }

  $python = Resolve-PythonPath
  if (-not $python) {
    Write-Warn '找不到 Python，跳过虚拟 HID 桥接（设备抽屉仍可用真机通道）'
    return $null
  }

  $bridgeRoot = Join-Path $RepoRoot 'third_party\web_hid_utils\packages\virtual-hid'
  $config = Join-Path $bridgeRoot 'profiles\dev-kit.json'
  if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
    Write-Warn "缺虚拟设备配置（$config），跳过桥接。子模块可能没初始化"
    return $null
  }

  # virtual_hid 是纯标准库的包，不安装，只把它所在的目录塞进 PYTHONPATH；
  # 只改 Start-Process 的继承环境，别把 PYTHONPATH 泄漏给后面的进程。
  $previousPythonPath = $env:PYTHONPATH
  $env:PYTHONPATH = $bridgeRoot
  try {
    $argumentLine = '-m virtual_hid serve --config "{0}" --port {1}' -f $config, $port
    Write-Step "启动 WebHID 虚拟设备桥接（127.0.0.1:$port）"
    $bridge = Start-Process -FilePath $python `
      -ArgumentList $argumentLine `
      -WorkingDirectory $RepoRoot `
      -WindowStyle Minimized `
      -PassThru
  } finally {
    $env:PYTHONPATH = $previousPythonPath
  }

  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 200
    if (Test-PortOpen -Port $port) {
      Write-Detail "桥接就绪（PID $($bridge.Id)）"
      return $bridge
    }
    if ($bridge.HasExited) { break }
  }

  Write-Warn '桥接 5 秒内没有就绪，继续启动应用（设备抽屉可能连不上）'
  return $bridge
}

function Start-DevMode {
  $arguments = @($ElectronVitePath, 'dev')
  if (-not $Sandboxed) { $arguments += '--noSandbox' }

  Write-Step '以开发模式启动（界面热更新，关闭窗口即退出）'
  & $NodePath @arguments
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "electron-vite dev 退出码 $code" }
}

function Start-AppMode {
  if ($Rebuild) {
    Invoke-AppBuild
  } elseif (Test-BuildFresh) {
    Write-Detail 'out/ 已是最新，跳过构建（要强制重建加 -Rebuild）'
  } else {
    Invoke-AppBuild
  }

  $arguments = @('.')
  if (-not $Sandboxed) { $arguments += '--no-sandbox' }

  Write-Step '启动 MIC STUDIO'
  # electron.exe 是 GUI 子系统，调用运算符不会等它；直接等进程句柄，好把退出码带回来。
  $app = Start-Process -FilePath $ElectronExePath `
    -ArgumentList $arguments `
    -WorkingDirectory $RepoRoot `
    -PassThru
  $app.WaitForExit()
  $code = $app.ExitCode
  if ($code -ne 0) { throw "应用退出码 $code（启动日志：.userdata\startup.log）" }
}

$bridgeProcess = $null
try {
  # ---- 环境准备 -----------------------------------------------------------

  $NodePath = Resolve-NodePath
  $NodeBin = Split-Path -Parent $NodePath
  if (-not (($env:PATH -split ';') -contains $NodeBin)) {
    $env:PATH = "$NodeBin;$env:PATH"
  }

  $ElectronVitePath = Join-Path $RepoRoot 'node_modules\electron-vite\bin\electron-vite.js'
  $ElectronExePath = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'

  # 镜像只作默认值，外部已经设了就不覆盖（CI/离线镜像站可以自己指定）
  if (-not $env:ELECTRON_MIRROR) {
    $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  }
  if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
  }

  # DSH 派生的进程带着 ELECTRON_RUN_AS_NODE=1，会让 Electron 按 Node 模式解析参数后静默退出。
  if (Test-Path Env:ELECTRON_RUN_AS_NODE) {
    Remove-Item Env:ELECTRON_RUN_AS_NODE
  }

  # 默认 userData 在本机会崩（0xC0000005），显式落到项目内；启动日志也在这里。
  $UserDataDir = Join-Path $RepoRoot '.userdata'
  New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
  $env:MICSTUDIO_USER_DATA = $UserDataDir

  Write-Host ''
  Write-Host '  MIC STUDIO 一键启动' -ForegroundColor White
  Write-Detail "仓库：$RepoRoot"
  Write-Detail "Node：$((& $NodePath -v).Trim())（$NodePath）"
  if ($Mode -eq 'app') {
    Write-Detail '模式：app（已构建产物）'
  } else {
    Write-Detail '模式：dev（electron-vite 开发服务器 + 热更新）'
  }
  Write-Host ''

  if (-not (Test-Dependencies)) { Install-Dependencies } else { Write-Detail '依赖已就绪' }

  if ($Bridge) { $bridgeProcess = Start-VirtualHidBridge }

  if ($Mode -eq 'app') { Start-AppMode } else { Start-DevMode }

  Write-Step '应用已退出'
} catch {
  Write-Host ''
  Write-Host "[start] 启动失败：$($_.Exception.Message)" -ForegroundColor Red
  if ($env:MICSTUDIO_DEBUG) {
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
  }
  exit 1
} finally {
  if ($bridgeProcess -and -not $bridgeProcess.HasExited) {
    Write-Detail "关闭虚拟 HID 桥接（PID $($bridgeProcess.Id)）"
    Stop-Process -Id $bridgeProcess.Id -Force -ErrorAction SilentlyContinue
  }
}

exit 0
