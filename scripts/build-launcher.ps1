# Build the one-click launcher exe (release\MIC STUDIO.exe).
# The launcher starts the portable payload with --no-sandbox, required on machines
# whose Chromium sandbox cannot start Electron (exit 0x80000003 before main JS runs).
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
# powershell -File 下 param() 默认值求值时 $PSScriptRoot 还是空的，只能在函数体里补；
# 本机 5.1 里 $PSScriptRoot 有时仍为空，所以再退回 $PSCommandPath / $MyInvocation
if (-not $RepoRoot) {
    $scriptPath = $PSCommandPath
    if (-not $scriptPath) { $scriptPath = $MyInvocation.MyCommand.Path }
    if (-not $scriptPath) { $scriptPath = $MyInvocation.MyCommand.Definition }
    if (-not $scriptPath -and $PSScriptRoot) { $scriptPath = Join-Path $PSScriptRoot 'build-launcher.ps1' }
    # 脚本在 <repo>\scripts\ 下，仓库根是它的上一级
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $scriptPath)
}
if (-not $RepoRoot) { throw 'RepoRoot 推断失败，请显式传 -RepoRoot <仓库根>' }
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
    $csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $csc)) {
    throw 'csc.exe not found (need .NET Framework 4.x)'
}

$source = Join-Path $PSScriptRoot 'launcher\MicStudioLauncher.cs'
$target = Join-Path $RepoRoot 'release\MIC STUDIO.exe'
$icon = Join-Path $RepoRoot 'build\icon.ico'
if (-not (Test-Path -LiteralPath $source)) { throw "launcher source missing: $source" }
$releaseDir = Split-Path -Parent $target
if (-not (Test-Path -LiteralPath $releaseDir)) { New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null }

& $csc /nologo /target:winexe /platform:anycpu "/win32icon:$icon" "/out:$target" /r:System.dll $source
if ($LASTEXITCODE -ne 0) { throw "csc failed (exit $LASTEXITCODE)" }

$item = Get-Item -LiteralPath $target
$hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
Write-Host ("launcher: {0} ({1} B) SHA256 {2}" -f $item.FullName, $item.Length, $hash)
exit 0
