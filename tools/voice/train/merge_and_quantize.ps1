<#
SubStage 5.2 §4.3：LoRA → f16 HF → GGUF f16 → Q4_K_M 三步串行。

行为（SubStage_5.2 §4.3 / §5）：
  1) .venv-train 的 python 跑 train\merge.py：LoRA 合并进 f16 HF 权重；
  2) 同一个 python 跑 train\vendor\convert_hf_to_gguf.py（llama.cpp b9000 的单文件脚本）转 GGUF；
  3) tools\voice\models\llama\llama-quantize.exe 量化成 Q4_K_M；
  4) 写 tools\voice\data\manifest.json 的 student 字段（文件名 + 体积 + sha256 + 超参）。
任一步失败 → exit 1，并删掉 <OutGguf>.partial，**不留半成品**；目标文件只在三步全成功后原子改名出现。

本文件必须保存为 UTF-8 带 BOM（PowerShell 5.1 按 GBK 解中文会直接语法错误，见 AGENTS.md 已知坑）。

用法：
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\voice\train\merge_and_quantize.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\voice\train\merge_and_quantize.ps1 -Lora <适配器目录> -OutGguf <输出.gguf>   # 单测用
#>
param(
  [string]$Lora = '',
  [string]$Merged = '',
  [string]$OutGguf = '',
  [string]$Config = 'tools\voice\train\config.json',
  [switch]$SkipManifest
)

$ErrorActionPreference = 'Stop'

$TrainDir = $PSScriptRoot
$VoiceDir = Split-Path -Parent $TrainDir
$RepoRoot = Split-Path -Parent (Split-Path -Parent $VoiceDir)

function Write-Log([string]$Message) {
  Write-Host "[merge-quant] $Message"
}

function Write-Fail([string]$Message) {
  Write-Host "[merge-quant] $Message" -ForegroundColor Red
}

function Resolve-RepoPath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
  return (Join-Path $RepoRoot $Path)
}

function Get-FileSizeGb([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 0 }
  return ((Get-Item -LiteralPath $Path).Length / 1GB)
}

# BOM 自检：与 scripts\voice.ps1 同款（本文件被存成无 BOM 的 UTF-8 时中文会乱码甚至语法错误）。
$stream = [System.IO.File]::OpenRead($PSCommandPath)
try {
  $head = New-Object byte[] 3
  $read = $stream.Read($head, 0, 3)
} finally {
  $stream.Dispose()
}
if (-not ($read -eq 3 -and $head[0] -eq 0xEF -and $head[1] -eq 0xBB -and $head[2] -eq 0xBF)) {
  Write-Fail 'tools\voice\train\merge_and_quantize.ps1 不是 UTF-8 带 BOM（缺 EF BB BF），PowerShell 5.1 会按 GBK 解中文。请用 UTF-8 BOM 重新保存后再跑。'
  exit 1
}

$configPath = Resolve-RepoPath $Config
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  Write-Fail "缺少训练配置 $configPath"
  exit 1
}
$cfg = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json

$loraPath = if ($Lora) { Resolve-RepoPath $Lora } else { Resolve-RepoPath 'tools\voice\train\out\qwen3-1.7b-lora' }
$mergedPath = if ($Merged) { Resolve-RepoPath $Merged } else { Resolve-RepoPath 'tools\voice\train\out\merged' }
$outPath = if ($OutGguf) { Resolve-RepoPath $OutGguf } else { Resolve-RepoPath 'tools\voice\models\student\Qwen3-1.7B-ft-Q4_K_M.gguf' }
$basePath = Resolve-RepoPath ([string]$cfg.base)

$python = Join-Path $VoiceDir '.venv-train\Scripts\python.exe'
$converter = Join-Path $TrainDir 'vendor\convert_hf_to_gguf.py'
$quantize = Join-Path $VoiceDir 'models\llama\llama-quantize.exe'
$trainOutDir = Split-Path -Parent $outPath
$f16Path = Join-Path (Resolve-RepoPath 'tools\voice\train\out') 'merged-f16.gguf'
$partialPath = "$outPath.partial"

# 前置检查：缺一件就直接退出 1，别等跑一半才炸（§6 单测 4 就查这条路径）。
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
  Write-Fail 'tools\voice\.venv-train 不存在，先跑 .\voice.cmd trainenv'
  exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $loraPath 'adapter_config.json') -PathType Leaf)) {
  Write-Fail "找不到 LoRA 适配器 $loraPath\adapter_config.json（先跑正式训练 qlora.py）"
  exit 1
}
if (-not (Test-Path -LiteralPath $basePath -PathType Container)) {
  Write-Fail "找不到基座权重目录 $basePath（先跑 .\voice.cmd fetch 拉 base-hf）"
  exit 1
}
if (-not (Test-Path -LiteralPath $converter -PathType Leaf)) {
  Write-Fail "缺少 $converter"
  exit 1
}
if (-not (Test-Path -LiteralPath $quantize -PathType Leaf)) {
  Write-Fail "缺少 $quantize（先跑 .\voice.cmd fetch --only llama-cpp）"
  exit 1
}

New-Item -ItemType Directory -Force -Path $trainOutDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $f16Path) | Out-Null
Remove-Item -LiteralPath $partialPath -Force -ErrorAction SilentlyContinue

$stepStarted = Get-Date
try {
  Write-Log "第 1/3 步：合并 LoRA -> f16 HF（$loraPath -> $mergedPath）"
  & $python (Join-Path $TrainDir 'merge.py') --base $basePath --lora $loraPath --out $mergedPath
  if ($LASTEXITCODE -ne 0) { throw "第 1 步失败：merge.py 退出码 $LASTEXITCODE" }
  Write-Log ("第 1 步完成，用时 {0:N1} s" -f ((Get-Date) - $stepStarted).TotalSeconds)

  $stepStarted = Get-Date
  Write-Log "第 2/3 步：转 GGUF f16（$f16Path）"
  # PYTHONPATH 指到 vendor：convert_hf_to_gguf.py 需要 vendor\gguf（llama.cpp b9000 的 gguf-py，
  # PyPI 的 gguf 0.9.1 太老，缺 MistralTokenizerType / MistralVocab）。见 vendor\commit.txt。
  $previousPythonPath = $env:PYTHONPATH
  $env:PYTHONPATH = (Join-Path $TrainDir 'vendor')
  try {
    & $python $converter $mergedPath --outfile $f16Path --outtype f16
    $convertCode = $LASTEXITCODE
  } finally {
    if ($null -eq $previousPythonPath) { Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue } else { $env:PYTHONPATH = $previousPythonPath }
  }
  if ($convertCode -ne 0) { throw "第 2 步失败：convert_hf_to_gguf.py 退出码 $convertCode" }
  if (-not (Test-Path -LiteralPath $f16Path -PathType Leaf)) { throw "第 2 步失败：没有产出 $f16Path" }
  $f16Gb = Get-FileSizeGb $f16Path
  Write-Log ("第 2 步完成，f16 GGUF {0:N2} GB，用时 {1:N1} s" -f $f16Gb, ((Get-Date) - $stepStarted).TotalSeconds)
  if ($f16Gb -gt 4.5) {
    Write-Log "警告：f16 GGUF 超过 4.5 GB（$([math]::Round($f16Gb, 2)) GB），量化很可能没生效或基座不是 1.7B"
  }

  $stepStarted = Get-Date
  Write-Log "第 3/3 步：量化 $($cfg.quant.type)（先写 $partialPath）"
  & $quantize $f16Path $partialPath ([string]$cfg.quant.type)
  if ($LASTEXITCODE -ne 0) { throw "第 3 步失败：llama-quantize 退出码 $LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath $partialPath -PathType Leaf)) { throw "第 3 步失败：没有产出 $partialPath" }

  $finalGb = Get-FileSizeGb $partialPath
  if ($finalGb -gt 4.5) {
    Write-Log "警告：量化后的 GGUF 有 $([math]::Round($finalGb, 2)) GB（> 4.5 GB），多半量化参数没生效"
  } elseif ($finalGb -lt 1.0 -or $finalGb -gt 1.4) {
    Write-Log "提示：量化后 $([math]::Round($finalGb, 2)) GB 落在 1.0-1.4 GB 之外（§7.3 的期望区间），先看是不是被截断"
  }

  Move-Item -LiteralPath $partialPath -Destination $outPath -Force
  $sha = (Get-FileHash -LiteralPath $outPath -Algorithm SHA256).Hash.ToLower()
  Write-Log ("第 3 步完成：{0}  {1:N2} GB  sha256={2}" -f $outPath, $finalGb, $sha)

  if (-not $SkipManifest) {
    $metricsPath = Join-Path $loraPath 'train_metrics.json'
    $recordArgs = @(
      (Join-Path $TrainDir 'record_student.py'),
      '--gguf', $outPath,
      '--manifest', (Join-Path $VoiceDir 'data\manifest.json'),
      '--config', $configPath
    )
    if (Test-Path -LiteralPath $metricsPath -PathType Leaf) { $recordArgs += @('--metrics', $metricsPath) }
    & $python @recordArgs
    if ($LASTEXITCODE -ne 0) { throw "写 data/manifest.json 的 student 字段失败（record_student.py 退出码 $LASTEXITCODE）" }
  } else {
    Write-Log '按 -SkipManifest 跳过 data\manifest.json 的 student 字段'
  }

  Write-Log '全部完成'
  exit 0
} catch {
  Write-Fail $_.Exception.Message
  if (Test-Path -LiteralPath $partialPath) { Remove-Item -LiteralPath $partialPath -Force -ErrorAction SilentlyContinue }
  Write-Fail '已清理半成品（目标文件未生成）'
  exit 1
}
