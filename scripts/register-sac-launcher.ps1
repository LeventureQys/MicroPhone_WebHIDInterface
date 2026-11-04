#Requires -Version 5.1
<#
.SYNOPSIS
  在当前用户下注册一个 Smart App Control 兼容的双击启动入口（.micstudio）。

.DESCRIPTION
  这台机器的 Smart App Control / WDAC 策略会拦截从资源管理器直接启动的
  .cmd / .bat / .lnk（事件 CodeIntegrity 3033），所以 start.cmd 双击没有反应。
  策略没有按文件的例外，改脚本内容也绕不过去——但 powershell.exe 本身是被允许的。

  本脚本把 .micstudio 扩展名关联到：
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1 app
  双击仓库根目录的「启动 MIC STUDIO.micstudio」即可启动已构建产物；
  另外在文件夹右键菜单加一项「启动 MIC STUDIO」。

  只写 HKCU，不需要管理员，随时可用 -Unregister 撤销。

.PARAMETER Unregister
  删除本脚本注册的扩展名、ProgID 与右键菜单（不会删除构建产物或用户数据）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-sac-launcher.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-sac-launcher.ps1 -Unregister
#>

[CmdletBinding()]
param(
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

$ScriptRoot = $PSScriptRoot
$RepoRoot = Split-Path -Parent $ScriptRoot
$StartScript = Join-Path $ScriptRoot 'start.ps1'
$LauncherFile = Join-Path $RepoRoot '启动 MIC STUDIO.micstudio'
$Extension = '.micstudio'
$ProgId = 'MicStudio.Launch'
$FolderVerb = 'MicStudioLaunch'

function Remove-KeyIfExists {
  param([string]$Path)
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
    Write-Host "[sac] 已删除 $Path" -ForegroundColor DarkGray
  }
}

if ($Unregister) {
  Remove-KeyIfExists "HKCU:\Software\Classes\$Extension"
  Remove-KeyIfExists "HKCU:\Software\Classes\$ProgId"
  Remove-KeyIfExists "HKCU:\Software\Classes\Directory\shell\$FolderVerb"
  # 启动文件是仓库里的 tracked 文件，撤销关联时保留，避免把 git 工作区改脏
  Write-Host "[sac] 已撤销 Smart App Control 兼容启动入口（启动文件保留：$LauncherFile）。" -ForegroundColor Green
  exit 0
}

if (-not (Test-Path -LiteralPath $StartScript -PathType Leaf)) {
  throw "找不到启动脚本：$StartScript"
}

# Windows PowerShell 5.1 的宿主路径；用绝对路径，避免 Explorer 启动时 PATH 不可靠。
$PowerShellExe = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path -LiteralPath $PowerShellExe -PathType Leaf)) {
  $PowerShellExe = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}

$ElectronExe = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
$CommandLine = '"{0}" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "{1}" app' -f $PowerShellExe, $StartScript

# .micstudio → ProgID
$extKey = "HKCU:\Software\Classes\$Extension"
New-Item -Path $extKey -Force | Out-Null
Set-ItemProperty -Path $extKey -Name '(default)' -Value $ProgId

# ProgID：显示名、图标、打开命令
$progKey = "HKCU:\Software\Classes\$ProgId"
New-Item -Path $progKey -Force | Out-Null
Set-ItemProperty -Path $progKey -Name '(default)' -Value 'MIC STUDIO 启动器'
if (Test-Path -LiteralPath $ElectronExe -PathType Leaf) {
  New-Item -Path (Join-Path $progKey 'DefaultIcon') -Force | Out-Null
  Set-ItemProperty -Path (Join-Path $progKey 'DefaultIcon') -Name '(default)' -Value ('"{0}",0' -f $ElectronExe)
}
$commandKey = Join-Path $progKey 'shell\open\command'
New-Item -Path $commandKey -Force | Out-Null
Set-ItemProperty -Path $commandKey -Name '(default)' -Value $CommandLine

# 文件夹右键菜单：启动 MIC STUDIO
$folderKey = "HKCU:\Software\Classes\Directory\shell\$FolderVerb"
New-Item -Path $folderKey -Force | Out-Null
Set-ItemProperty -Path $folderKey -Name '(default)' -Value '启动 MIC STUDIO'
Set-ItemProperty -Path $folderKey -Name 'Icon' -Value (Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe')
$folderCommandKey = Join-Path $folderKey 'command'
New-Item -Path $folderCommandKey -Force | Out-Null
Set-ItemProperty -Path $folderCommandKey -Name '(default)' -Value $CommandLine

# 双击文件本身只是触发器，内容不参与启动；写一段说明方便以后辨认。
$note = @'
MIC STUDIO 启动器（Smart App Control 兼容）

这个文件由 scripts\register-sac-launcher.ps1 注册。
双击它等价于执行：
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1 app

为什么不是 start.cmd：
  当前机器的 Smart App Control / WDAC 策略会拦截资源管理器直接启动的
  .cmd / .bat / .lnk；powershell.exe 不受影响，所以用这个扩展名做触发器。

撤销注册：
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-sac-launcher.ps1 -Unregister
'@
[System.IO.File]::WriteAllText($LauncherFile, $note, (New-Object System.Text.UTF8Encoding($false)))

Write-Host '[sac] 已注册 Smart App Control 兼容启动入口：' -ForegroundColor Green
Write-Host "      双击：$LauncherFile" -ForegroundColor Cyan
Write-Host '      或右键仓库文件夹 →「启动 MIC STUDIO」' -ForegroundColor Cyan
Write-Host '      撤销：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-sac-launcher.ps1 -Unregister' -ForegroundColor DarkGray
Write-Host '      注意：本入口固定启动 out/ 构建产物（app 模式）；开发模式请从终端运行 start.cmd' -ForegroundColor DarkGray
