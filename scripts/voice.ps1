<#
语音链路入口（逻辑层），根目录 voice.cmd 只是转发器。
本文件必须保存为 UTF-8 带 BOM：PowerShell 5.1 按 GBK 解中文会直接语法错误（AGENTS.md 已知坑）。

子命令：
  fetch [--check|--record] [--only <id>]   下载 / 校验模型与预编译二进制（tools/voice/fetch-models.mjs）
  venv                                    创建 tools\voice\.venv 并装 requirements.txt
  python <args...>                        用 .venv 的 python 运行（不动全局 Python）
  pipeline <args...>                      voice.cmd python tools\voice\pipeline.py <args...>
                                          （SubStage 4.3：--text / --once --wav / --loop）
  trainenv                                创建 tools\voice\.venv-train 并装 CUDA 训练依赖（SubStage 5.2）
  server [--model base|teacher|student] [--port 8768] [--verbose]
                                           llama-server 常驻（SubStage 3.3 落地；默认端口 8768）
#>

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$VoiceDir = Join-Path $RepoRoot 'tools\voice'

function Write-Log([string]$Message) {
  Write-Host "[voice] $Message"
}

function Write-Fail([string]$Message) {
  Write-Host "[voice] $Message" -ForegroundColor Red
}

# SubStage_1.1 §5：脚本被存成无 BOM 的 UTF-8 时，中文提示会变成乱码甚至语法错误，先自检再干活。
function Test-Utf8Bom([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $head = New-Object byte[] 3
    $read = $stream.Read($head, 0, 3)
  } finally {
    $stream.Dispose()
  }
  return ($read -eq 3 -and $head[0] -eq 0xEF -and $head[1] -eq 0xBB -and $head[2] -eq 0xBF)
}

# PATH 里通常没有 node（AGENTS.md §Toolchain），按 DSH 运行时布局找绝对路径。
function Resolve-NodePath {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:MICSTUDIO_NODE) { $candidates.Add($env:MICSTUDIO_NODE) }

  $fromPath = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($fromPath) { $candidates.Add($fromPath.Source) }

  $dshRuntimes = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path -LiteralPath $dshRuntimes) {
    Get-ChildItem -LiteralPath $dshRuntimes -Directory -ErrorAction SilentlyContinue |
      Sort-Object -Property Name -Descending |
      ForEach-Object { $candidates.Add((Join-Path $_.FullName 'dependencies\node\bin\node.exe')) }
  }

  $candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
  $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))

  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  return $null
}

# python 已在 PATH 时直接用；换机器时可用 MICSTUDIO_PYTHON 指定。
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

function Get-VenvPython {
  return (Join-Path $VoiceDir '.venv\Scripts\python.exe')
}

# pip 镜像写在清单里（SubStage_1.1 §4.1 的 pipIndex），不在脚本里再写一份。
function Get-PipIndex {
  $manifest = Join-Path $VoiceDir 'manifest.json'
  if (Test-Path -LiteralPath $manifest -PathType Leaf) {
    $doc = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($doc.pipIndex) { return [string]$doc.pipIndex }
  }
  return 'https://pypi.tuna.tsinghua.edu.cn/simple'
}

function Invoke-Fetch([string[]]$Arguments) {
  $node = Resolve-NodePath
  if (-not $node) {
    throw '找不到 Node.js（需要 v20+）。请安装 Node.js，或用环境变量 MICSTUDIO_NODE 指定 node.exe 的绝对路径'
  }
  $script = Join-Path $VoiceDir 'fetch-models.mjs'
  if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "缺少 $script" }

  Push-Location $RepoRoot
  try {
    # 必须 Out-Host：直接 `& node` 的输出会被调用方当成函数返回值吞掉（$exitCode = Invoke-Fetch ...）。
    & $node $script @Arguments | Out-Host
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  return $code
}

function Invoke-Venv {
  $venvPython = Get-VenvPython
  if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    $python = Resolve-PythonPath
    if (-not $python) {
      Write-Fail '找不到 python。请安装 Python 3.12，或用环境变量 MICSTUDIO_PYTHON 指定 python.exe 的绝对路径'
      return 1
    }
    Write-Log "创建虚拟环境 tools\voice\.venv（$python -m venv）"
    & $python -m venv (Join-Path $VoiceDir '.venv') | Out-Host
    if ($LASTEXITCODE -ne 0) {
      Write-Fail "创建虚拟环境失败（python -m venv 退出码 $LASTEXITCODE）"
      return $LASTEXITCODE
    }
  } else {
    Write-Log '复用已有虚拟环境 tools\voice\.venv'
  }

  $requirements = Join-Path $VoiceDir 'requirements.txt'
  if (-not (Test-Path -LiteralPath $requirements -PathType Leaf)) { throw "缺少 $requirements" }

  $index = Get-PipIndex
  Write-Log "安装依赖：python -m pip install -r tools\voice\requirements.txt -i $index"
  # --disable-pip-version-check 必须带：装完后 pip 会去 pypi.org 查新版，本机直连 PyPI 不通，
  # 进程会卡在退出前（实测 >10 分钟不返回）。用命令行开关而不是全局环境变量（§4.4 不许设全局变量）。
  & $venvPython -m pip install -r $requirements -i $index --disable-pip-version-check --no-input | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "依赖安装失败（pip 退出码 $LASTEXITCODE）"
    return $LASTEXITCODE
  }
  Write-Log '依赖就绪'
  return 0
}

function Get-TrainVenvPython {
  return (Join-Path $VoiceDir '.venv-train\Scripts\python.exe')
}

# SubStage_5.2 §2/§8：训练依赖是**独立** venv（.venv-train），推理侧 .venv 里不许出现
# torch/transformers——否则推理侧会被打包进 3 GB 训练依赖。
# Windows 的默认 PyPI 轮子 torch 是 CPU-only，必须额外挂 CUDA 12.4 官方轮子索引，
# 装完立刻自证 cuda.is_available()，避免训到一半才发现跑在 CPU 上。
function Invoke-TrainEnv {
  $venvDir = Join-Path $VoiceDir '.venv-train'
  $venvPython = Get-TrainVenvPython
  if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    $python = Resolve-PythonPath
    if (-not $python) {
      Write-Fail '找不到 python。请安装 Python 3.12，或用环境变量 MICSTUDIO_PYTHON 指定 python.exe 的绝对路径'
      return 1
    }
    Write-Log "创建训练虚拟环境 tools\voice\.venv-train（$python -m venv）"
    & $python -m venv $venvDir | Out-Host
    if ($LASTEXITCODE -ne 0) {
      Write-Fail "创建训练虚拟环境失败（python -m venv 退出码 $LASTEXITCODE）"
      return $LASTEXITCODE
    }
  } else {
    Write-Log '复用已有训练虚拟环境 tools\voice\.venv-train'
  }

  $requirements = Join-Path $VoiceDir 'train\requirements-train.txt'
  if (-not (Test-Path -LiteralPath $requirements -PathType Leaf)) { throw "缺少 $requirements" }

  $index = Get-PipIndex
  $torchIndex = 'https://download.pytorch.org/whl/cu124'
  # 分两步装：download.pytorch.org 的索引对任意包名都回整张 flat 清单（实测 /whl/cu124/jinja2/
  # 也是 HTTP 200 的大页面），一次解析里带 --extra-index-url 会卡十几分钟。
  Write-Log '第一步：装 torch 的纯 Python 依赖（走镜像）'
  & $venvPython -m pip install filelock typing-extensions networkx jinja2 fsspec sympy mpmath MarkupSafe setuptools -i $index --disable-pip-version-check --no-input | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "torch 依赖安装失败（pip 退出码 $LASTEXITCODE）"
    return $LASTEXITCODE
  }
  Write-Log "第二步：装 CUDA 轮子 torch==2.6.0+cu124（$torchIndex，--no-deps）"
  & $venvPython -m pip install 'torch==2.6.0+cu124' -i $torchIndex --no-deps --disable-pip-version-check --no-input | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "torch（cu124）安装失败（pip 退出码 $LASTEXITCODE）"
    return $LASTEXITCODE
  }

  Write-Log '第三步：按 tools\voice\train\requirements-train.txt 装其余训练依赖（torch 已满足）'
  # --disable-pip-version-check --no-input 必须带（同 Invoke-Venv：本机连不上 pypi.org，
  # pip 退出前的新版检查会卡住 10 分钟以上）。
  & $venvPython -m pip install -r $requirements -i $index --disable-pip-version-check --no-input | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "训练依赖安装失败（pip 退出码 $LASTEXITCODE）"
    return $LASTEXITCODE
  }

  # 双引号会被 PowerShell 5.1 在传给原生进程时吃掉（实测 python 报 SyntaxError），这里只用单引号。
  $probe = "import torch;print('torch', torch.__version__);print('cuda', torch.cuda.is_available());print('gpu', torch.cuda.get_device_name(0) if torch.cuda.is_available() else '-')"
  & $venvPython -c $probe | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "训练依赖自检失败（python -c 退出码 $LASTEXITCODE）"
    return $LASTEXITCODE
  }

  # 隔离性：只查目录名（快），真正的证据是验收时跑 pip list（SubStage_5.2 §7.6）。
  $inferSitePackages = Join-Path $VoiceDir '.venv\Lib\site-packages'
  $leaks = @()
  foreach ($name in @('torch', 'transformers', 'peft', 'trl', 'datasets', 'accelerate', 'bitsandbytes')) {
    if (Test-Path -LiteralPath (Join-Path $inferSitePackages $name)) { $leaks += $name }
  }
  if ($leaks.Count -gt 0) {
    Write-Fail "隔离性被破坏：tools\voice\.venv 里出现 $($leaks -join '、')"
    return 1
  }
  Write-Log '隔离性自检通过：tools\voice\.venv 里没有 torch/transformers/peft/trl/datasets/accelerate/bitsandbytes'
  Write-Log '训练环境就绪（跑 .\tools\voice\.venv-train\Scripts\python.exe tools\voice\train\qlora.py --smoke 验一下）'
  return 0
}

function Invoke-VenvPython([string[]]$Arguments) {
  $venvPython = Get-VenvPython
  if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    Write-Fail 'tools\voice\.venv 不存在，先运行 .\voice.cmd venv'
    return 1
  }

  Push-Location $RepoRoot
  try {
    & $venvPython @Arguments | Out-Host
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  return $code
}

# SubStage_4.3 §3：`pipeline` 子命令 = 用 .venv 的 python 跑 tools\voice\pipeline.py。
# 单独包一层是为了在脚本缺失时给出中文提示，而不是让 Python 抛 ENOENT。
function Invoke-Pipeline([string[]]$Arguments) {
  $script = Join-Path $VoiceDir 'pipeline.py'
  if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    Write-Fail "缺少 $script（SubStage 4.3 的产物）"
    return 1
  }
  return (Invoke-VenvPython -Arguments (@('tools\voice\pipeline.py') + $Arguments))
}

function Test-PortInUse([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync('127.0.0.1', $Port)
    if (-not $task.Wait(400)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    try { $client.Close() } catch { }
  }
}

# 统一用 curl.exe：Invoke-WebRequest 在本机非交互会话里会直接报错（AGENTS.md 已知坑 3）。
# 必须用 -s（不要 -sS）：脚本开头把 $ErrorActionPreference 设成 Stop，PowerShell 5.1 会把原生进程的
# stderr 当成 NativeCommandError 抛出去——连接被拒时 curl -sS 正好会写一行 stderr，轮询逻辑会被打断
# （实测第一次探测就抛，finally 把刚起的子进程收掉）。-s 让 curl 只把状态码打到 stdout。
function Test-LlamaHealth([int]$Port) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $code = & curl.exe -s -o NUL -w "%{http_code}" --max-time 2 "http://127.0.0.1:$Port/health" 2>$null
  } finally {
    $ErrorActionPreference = $previous
  }
  return ([string]$code -eq '200')
}

function Resolve-LlamaModel([string]$Name) {
  $modelsDir = Join-Path $VoiceDir 'models'
  switch ($Name) {
    'base' { return (Join-Path $modelsDir 'llm\Qwen3-1.7B-Q4_K_M.gguf') }
    'teacher' { return (Join-Path $modelsDir 'teacher\Qwen3-8B-Q4_K_M.gguf') }
    'student' {
      $studentDir = Join-Path $modelsDir 'student'
      if (Test-Path -LiteralPath $studentDir) {
        $pick = Get-ChildItem -LiteralPath $studentDir -Filter *.gguf -ErrorAction SilentlyContinue |
          Sort-Object -Property LastWriteTime -Descending |
          Select-Object -First 1
        if ($pick) { return $pick.FullName }
      }
      return $null
    }
    default { return $null }
  }
}

# SubStage_3.3 §4.1：启动参数逐字照抄（两个关思考开关缺一不可；-t 14 是物理核，20 反而慢）。
# 端口被占时**不自动换端口**（llm.py 默认连 8768，静默换端口只会让调用方连不上）。
# --port 只用于显式让路（教师服务走 8769），不是自动避让。
function Invoke-Server([string[]]$Arguments) {
  $model = 'base'
  $port = 8768
  $verbose = $false
  for ($i = 0; $i -lt $Arguments.Count; $i++) {
    $arg = [string]$Arguments[$i]
    if ($arg -eq '--model') {
      if ($i + 1 -ge $Arguments.Count) { Write-Fail '--model 需要值：base|teacher|student'; return 1 }
      $model = ([string]$Arguments[$i + 1]).ToLowerInvariant()
      $i += 1
    } elseif ($arg -like '--model=*') {
      $model = $arg.Substring('--model='.Length).ToLowerInvariant()
    } elseif ($arg -eq '--port') {
      if ($i + 1 -ge $Arguments.Count) { Write-Fail '--port 需要端口号'; return 1 }
      if (-not [int]::TryParse([string]$Arguments[$i + 1], [ref]$port)) { Write-Fail "--port 不是整数：$($Arguments[$i + 1])"; return 1 }
      $i += 1
    } elseif ($arg -like '--port=*') {
      if (-not [int]::TryParse($arg.Substring('--port='.Length), [ref]$port)) { Write-Fail "--port 不是整数：$arg"; return 1 }
    } elseif ($arg -eq '--verbose') {
      $verbose = $true
    } else {
      Write-Fail "server 不认识的参数：$arg"
      return 1
    }
  }

  $exe = Join-Path $VoiceDir 'models\llama\llama-server.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    Write-Fail "缺少 $exe（先跑 .\voice.cmd fetch --only llama-cpp）"
    return 1
  }
  $modelPath = Resolve-LlamaModel -Name $model
  if (-not $modelPath) {
    Write-Fail "--model 只能是 base|teacher|student；student 还需要 models\student\*.gguf 已经产出"
    return 1
  }
  if (-not (Test-Path -LiteralPath $modelPath -PathType Leaf)) {
    Write-Fail "找不到模型文件 $modelPath（先跑 .\voice.cmd fetch --check）"
    return 1
  }

  Write-Log "检查端口 $port 是否空闲"
  if (Test-PortInUse -Port $port) {
    Write-Fail "127.0.0.1:$port 已被占用：8765=WebHID 桥、8766=虚拟下位机控制面、8767=执行器、8768=推理侧、8769=教师。请先关掉占用 $port 的进程，再重跑 .\voice.cmd server（本脚本不会自动换端口）"
    return 1
  }

  # 单引号原样透传：PowerShell 不对 \" 做转义，Start-Process 的 -ArgumentList 接**单个字符串**时
  # 也不会再补引号，命令行落到 CRT 就是 --chat-template-kwargs "{\"enable_thinking\":false}"
  # → llama-server 收到 {"enable_thinking":false}。用双引号拼会在这里被 PowerShell 截断。
  $argLine = @(
    ('-m "' + $modelPath + '"'),
    '--host 127.0.0.1',
    "--port $port",
    '-t 14',
    '-c 4096',
    '-np 1',
    '--jinja',
    '--reasoning-budget 0',
    '--chat-template-kwargs "{\"enable_thinking\":false}"'
  ) -join ' '

  $logDir = Join-Path $RepoRoot 'artifacts\voice'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $outLog = Join-Path $logDir 'llama-server.log'
  $errLog = Join-Path $logDir 'llama-server.err.log'

  Write-Log "启动 llama-server（model=$model，port=$port）"
  Write-Log "  $exe $argLine"

  $startArgs = @{
    FilePath         = $exe
    ArgumentList     = $argLine
    PassThru         = $true
    WorkingDirectory = (Split-Path -Parent $exe)
  }
  if ($verbose) {
    $startArgs.NoNewWindow = $true
  } else {
    $startArgs.RedirectStandardOutput = $outLog
    $startArgs.RedirectStandardError = $errLog
    $startArgs.WindowStyle = 'Hidden'
  }
  $proc = Start-Process @startArgs

  try {
    $deadline = (Get-Date).AddSeconds(60)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
      if ($proc.HasExited) { break }
      if (Test-LlamaHealth -Port $port) { $ready = $true; break }
      Start-Sleep -Milliseconds 500
    }

    if (-not $ready) {
      if ($proc.HasExited) {
        Write-Fail "llama-server 启动即退出（退出码 $($proc.ExitCode)）"
      } else {
        Write-Fail "等待 http://127.0.0.1:$port/health 返回 200 超过 60 s"
      }
      if (-not $verbose -and (Test-Path -LiteralPath $errLog -PathType Leaf)) {
        Write-Log "最后 20 行日志（$errLog）："
        Get-Content -LiteralPath $errLog -Tail 20 | Out-Host
      }
      return 1
    }

    Write-Host 'llama-server ready'
    if (-not $verbose) { Write-Log "  日志：$errLog" }
    Write-Log "  PID $($proc.Id)，端口 $port，model=$model"
    Write-Log '  按 Ctrl+C 结束（子进程会一起收掉）'

    while (-not $proc.HasExited) { Start-Sleep -Milliseconds 300 }
    Write-Log "llama-server 已退出（退出码 $($proc.ExitCode)）"
    if ($proc.ExitCode -ne 0) { return 1 }
    return 0
  } finally {
    if ($proc -and -not $proc.HasExited) {
      try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { }
      Write-Log 'llama-server 已结束'
    }
  }
}

function Show-Usage {
  Write-Host '用法：voice <子命令> [参数]'
  Write-Host '  fetch [--check|--record] [--only <id>]   下载 / 校验模型与预编译二进制'
  Write-Host '  venv                                    创建 tools\voice\.venv 并装依赖'
  Write-Host '  python <args...>                        用 .venv 的 python 运行'
  Write-Host '  pipeline <args...>                      voice.cmd python tools\voice\pipeline.py <args...>'
  Write-Host '                                          （--text / --once --wav / --loop）'
  Write-Host '  trainenv                                创建 tools\voice\.venv-train 并装 CUDA 训练依赖'
  Write-Host '  server [--model base|teacher|student] [--port 8768] [--verbose]'
  Write-Host '                                          llama-server 常驻（默认端口 8768，Ctrl+C 结束）'
}

$Command = ''
$Rest = @()
if ($args.Count -gt 0) { $Command = ([string]$args[0]).ToLowerInvariant() }
if ($args.Count -gt 1) {
  $Rest = @()
  for ($i = 1; $i -lt $args.Count; $i++) { $Rest += [string]$args[$i] }
}

$exitCode = 0
try {
  if (-not (Test-Utf8Bom -Path $PSCommandPath)) {
    Write-Fail 'scripts\voice.ps1 不是 UTF-8 带 BOM（缺 EF BB BF），PowerShell 5.1 会按 GBK 解中文。请用 UTF-8 BOM 重新保存后再跑。'
    exit 1
  }

  switch ($Command) {
    'fetch' { $exitCode = Invoke-Fetch -Arguments $Rest }
    'venv' { $exitCode = Invoke-Venv }
    'python' { $exitCode = Invoke-VenvPython -Arguments $Rest }
    'pipeline' { $exitCode = Invoke-Pipeline -Arguments $Rest }
    'trainenv' { $exitCode = Invoke-TrainEnv }
    'server' { $exitCode = Invoke-Server -Arguments $Rest }
    default {
      Show-Usage
      $exitCode = 1
    }
  }
} catch {
  Write-Fail $_.Exception.Message
  exit 1
}

exit $exitCode
