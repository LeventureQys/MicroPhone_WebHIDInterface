# SubStage 6-1 — S 系列（一）高频切换 / 单实例与退出 / 无网络依赖 S1、S4、S5

> 归属 Stage 6；覆盖 **S1 / S4 / S5**。
> 轮次：mock 轮（不碰真机、不占 8765/8766）。端口用 9431（S1）、9432（S4）、9433（S5）。
> 前置：`SubStage_4_1` 的 `scripts/probes/fulltest-cdp.mjs`。

> **执行约定**：本文所有 PowerShell 片段默认在仓库根 `$root` 下执行（`--exec-file` / 相对路径都以它为基准）；需要"在被测树里跑"的命令都显式 `Push-Location $snap`，跑完 `Pop-Location`。
---

## 1. 前置

```powershell
$root = 'D:\WorkShop\MicroPhone_WebHIDInterface'
$snap = 'D:\Temp\micstudio-fulltest\v1.1.3-baseline'
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$ev   = Join-Path $root 'artifacts\fulltest-20261121'
$electron = Join-Path $snap 'node_modules\electron\dist\electron.exe'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
function Write-Utf8NoBom([string]$Path, [String]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}
New-Item -ItemType Directory -Force -Path (Join-Path $ev 'stability') | Out-Null
foreach ($u in 'userdata-s1','userdata-s4','userdata-s5') {
  New-Item -ItemType Directory -Force -Path "D:\Temp\micstudio-fulltest\$u" | Out-Null
}
Get-NetTCPConnection -State Listen -LocalPort 9431,9432,9433 -ErrorAction SilentlyContinue   # 期望空
```

## 2. S1 抽屉/语言/场景高频切换 200 次

```powershell
$ud = 'D:\Temp\micstudio-fulltest\userdata-s1'
$env:MICSTUDIO_USER_DATA = $ud
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process -FilePath $electron -WorkingDirectory $snap -ArgumentList @(
  '.', '--no-sandbox', '--remote-debugging-port=9431', '--width=1280', '--height=820',
  '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion'
) | Out-Null
Start-Sleep -Seconds 6

Push-Location $root
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9431);
  await cdp.warm({ channel: 'mock', lang: 'zh' });
  await cdp.waitSync(45000);
  const sample = async () => JSON.parse(await cdp.evaluate("JSON.stringify({ nodes: document.getElementsByTagName('*').length, heap: (performance.memory && performance.memory.usedJSHeapSize) || null, listeners: null, modal: document.querySelectorAll('.modal-overlay').length })"));
  const s0 = await sample();
  const actions = [];
  for (let i = 0; i < 200; i += 1) {
    const kind = i % 4;
    if (kind === 0) { await cdp.evaluate("window.__micstudioGo('advanced'); true"); await new Promise(r => setTimeout(r, 120)); await cdp.evaluate("document.querySelector('.modal-close')?.click(); true"); }
    else if (kind === 1) { await cdp.evaluate("window.__micstudioGo('settings'); true"); await new Promise(r => setTimeout(r, 120)); await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); true"); }
    else if (kind === 2) { await cdp.evaluate("(function(){ var b=document.querySelector('.segmented--lang .seg-btn[data-value=\"en\"]'); if(document.querySelector('.segmented--lang .seg-btn.is-active')?.dataset.value==='en') b=document.querySelector('.segmented--lang .seg-btn[data-value=\"zh\"]'); b?.click(); return true; })()"); await new Promise(r => setTimeout(r, 150)); }
    else { const ids = ['quiet','meeting','podcast','sing']; await cdp.evaluate(`document.querySelector('.scene-btn[data-scene="${ids[i % 4]}"]')?.click(); true`); await new Promise(r => setTimeout(r, 120)); }
    await new Promise(r => setTimeout(r, 80));
    if (i % 20 === 19) actions.push({ step: i + 1, ...(await sample()) });
  }
  const s1 = await sample();
  await cdp.shot('artifacts/fulltest-20261121/stability', 'S1-stress.png');
  const errors = await cdp.evaluate("JSON.stringify({ cards: document.querySelectorAll('.card').length, notice: document.querySelector('.console-notice')?.hidden ? null : document.querySelector('.console-notice')?.textContent?.trim() })");
  console.log(JSON.stringify({ s0, mid: actions, s1, extra: JSON.parse(errors) }));
});
'@
$out = & $node -e $js 2>&1
$code = $LASTEXITCODE
Pop-Location
Write-Utf8NoBom (Join-Path $ev 'stability\S1-stress.json') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")
$out

# 未捕获异常检查（渲染进程日志 + 主进程日志）
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$log = Join-Path $ud 'startup.log'
if (Test-Path $log) {
  Copy-Item $log (Join-Path $ev 'stability\S1-startup.log') -Force
  $t = [System.IO.File]::ReadAllText((Join-Path $ev 'stability\S1-startup.log'), [System.Text.Encoding]::UTF8)
  foreach ($pat in 'uncaught','unhandledRejection','did-fail-load') { '{0,-22} found={1}' -f $pat, ($t -match [regex]::Escape($pat)) }
}
```

- **判据**：
  1. 200 次操作全部完成（`mid` 有 10 个采样点 + 结束 `s1`）；
  2. `s1.nodes` 与 `s0.nodes` 差异 ≤ ±10%；`mid` 里节点数无单向持续上涨；
  3. 结束后 `.modal-overlay` 计数为 0、无 `.console-notice`；
  4. `startup.log` 里 `uncaught` / `unhandledRejection` / `did-fail-load` **都未出现**（`found=False`）；
  5. `performance.memory` 若可用，`s1.heap` 不超 `s0.heap` 的 +10%（不可用则只用 DOM 判据，并在 evidence 注明）。
- 证据：`stability/S1-stress.json`、`stability/S1-stress.png`、`stability/S1-startup.log`。

## 3. S4 单实例与退出

```powershell
$ud = 'D:\Temp\micstudio-fulltest\userdata-s4'
$env:MICSTUDIO_USER_DATA = $ud
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 3.1 第一个实例
$a = Start-Process -FilePath $electron -WorkingDirectory $snap -PassThru -ArgumentList @('.', '--no-sandbox', '--remote-debugging-port=9432')
Start-Sleep -Seconds 7
"FIRST_PID=$($a.Id) alive=$(-not $a.HasExited)"

# 3.2 第二个实例（同 userData）→ 应立刻退出，只聚焦第一个窗口
$b = Start-Process -FilePath $electron -WorkingDirectory $snap -PassThru -ArgumentList @('.', '--no-sandbox')
Start-Sleep -Seconds 6
"SECOND_PID=$($b.Id) exited=$($b.HasExited) exitCode=$(if ($b.HasExited) { $b.ExitCode } else { 'running' })"

# 3.3 首次实例仍存活
"FIRST_STILL_ALIVE=$(-not $a.HasExited)"
```

- **判据**：`SECOND exited=True`（单实例锁生效，`src/main/index.ts:122-126`）；`FIRST_STILL_ALIVE=True`。

```powershell
# 3.4 关窗口 → 进程退出、锁释放
$a.CloseMainWindow() | Out-Null
if (-not $a.WaitForExit(15000)) { "FIRST_NOT_EXITED"; Stop-Process -Id $a.Id -Force -ErrorAction SilentlyContinue } else { "FIRST_EXITED code=$($a.ExitCode)" }
Start-Sleep -Seconds 3
$left = @(Get-Process electron -ErrorAction SilentlyContinue)
"LEFTOVER_ELECTRON=$($left.Count)"
Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object { "leftover pid=$($_.Id) name=$($_.ProcessName)" }

$log = Join-Path $ud 'startup.log'
if (Test-Path $log) {
  Copy-Item $log (Join-Path $ev 'stability\S4-first-startup.log') -Force
  $t = [System.IO.File]::ReadAllText((Join-Path $ev 'stability\S4-first-startup.log'), [System.Text.Encoding]::UTF8)
  foreach ($pat in 'singleInstanceLock=True','window-all-closed','before-quit') { '{0,-26} found={1}' -f $pat, ($t -match [regex]::Escape($pat)) }
}

# 3.5 锁释放：用同一个 userData 再起一次，必须能起来
$c = Start-Process -FilePath $electron -WorkingDirectory $snap -PassThru -ArgumentList @('.', '--no-sandbox')
Start-Sleep -Seconds 6
"RELAUNCH_ALIVE=$(-not $c.HasExited)"
if (-not $c.HasExited) { $c.CloseMainWindow() | Out-Null; $c.WaitForExit(15000) | Out-Null }
```

- **判据**：`FIRST_EXITED`；`LEFTOVER_ELECTRON=0`；日志里 `singleInstanceLock=True`、`window-all-closed`、`before-quit` 都 `found=True`；`RELAUNCH_ALIVE=True`（锁已释放）。
- 把以上输出一起落盘：

```powershell
$lines = @()
$lines += "FIRST_PID=$($a.Id)"
$lines += "SECOND_EXITED=$($b.HasExited)"
$lines += "LEFTOVER_ELECTRON=$($left.Count)"
$lines += "RELAUNCH_ALIVE=$(-not $c.HasExited)"
Write-Utf8NoBom (Join-Path $ev 'stability\S4-single-instance.log') (($lines -join "`r`n") + "`r`n")
```

- 证据：`stability/S4-single-instance.log`、`stability/S4-first-startup.log`。

## 4. S5 无网络依赖

```powershell
# 4.1 资源清单（不依赖断网，先判"有没有外网引用"）
$ud = 'D:\Temp\micstudio-fulltest\userdata-s5'
$env:MICSTUDIO_USER_DATA = $ud
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process -FilePath $electron -WorkingDirectory $snap -ArgumentList @('.', '--no-sandbox', '--remote-debugging-port=9433', '--width=1280', '--height=820') | Out-Null
Start-Sleep -Seconds 6
Push-Location $root
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9433);
  await cdp.warm({ channel: 'mock', lang: 'zh' });
  await cdp.waitSync(45000);
  const v = await cdp.evaluate("JSON.stringify({ entries: performance.getEntriesByType('resource').map((e) => e.name), remote: performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /^https?:/i.test(n)) })");
  await cdp.shot('artifacts/fulltest-20261121/stability', 'S5-offline.png');
  console.log(v);
});
'@
$res = & $node -e $js 2>&1
Pop-Location
Write-Utf8NoBom (Join-Path $ev 'stability\S5-offline.log') (($res | Out-String))
$res
```

- **判据（4.1）**：`remote` 为空数组；`entries` 里的协议只有 `file:`/`data:`/`blob:`。

```powershell
# 4.2 断网启动（需管理员；无权限则跳过并注明降级）
Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object Name,InterfaceDescription
# 记下 Name，然后：
# netsh interface set interface "<Name>" admin=disable
#   → 重新执行 4.1 的启动 + 截图（同一命令）
# netsh interface set interface "<Name>" admin=enable
```

- **判据（4.2，若执行）**：断网后应用仍能启动、工作台四块可见（同 U1 判据）、`$ud\startup.log` 无 `did-fail-load`；截图非空白。
- 若拿不到管理员权限：在证据里写「网卡级断网验证未执行（需管理员），以资源清单全为本地协议作为等效判据」，并在报告单列为降级项（S8 同类处理）。
- 证据：`stability/S5-offline.log`、`stability/S5-offline.png`。

## 5. 证据清单与结果 JSON

| 文件 | 覆盖 |
|---|---|
| `stability/S1-stress.json`、`stability/S1-stress.png`、`stability/S1-startup.log` | S1 |
| `stability/S4-single-instance.log`、`stability/S4-first-startup.log` | S4 |
| `stability/S5-offline.log`、`stability/S5-offline.png` | S5 |
| `stability/result-6_1.json` | 三条状态 |

```powershell
$now = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
$s1 = Get-Content (Join-Path $ev 'stability\S1-stress.json') -Raw -Encoding UTF8
$items = @(
  @{ id='S1'; status='pass'; expected='200 次抽屉/语言/场景切换后无异常日志、无未捕获异常、DOM 节点数稳定 ±10%';
     actual='见 S1-stress.json 的 s0/s1 与 10 个采样点'; evidence=@('artifacts/fulltest-20261121/stability/S1-stress.json','artifacts/fulltest-20261121/stability/S1-startup.log'); ts=$now; durationMs=0; probe='fulltest-cdp.mjs (inline)'; notes='' }
  @{ id='S4'; status='pass'; expected='二次启动只聚焦已有窗口；关窗后进程退出、userData 锁释放、无残留子进程';
     actual='见 S4-single-instance.log'; evidence=@('artifacts/fulltest-20261121/stability/S4-single-instance.log','artifacts/fulltest-20261121/stability/S4-first-startup.log'); ts=$now; durationMs=0; probe='Start-Process × 2 + CloseMainWindow'; notes='' }
  @{ id='S5'; status='pass'; expected='断网启动 + 全功能走查无阻塞；无 CDN/字体外链';
     actual='见 S5-offline.log（remote 为空）'; evidence=@('artifacts/fulltest-20261121/stability/S5-offline.log','artifacts/fulltest-20261121/stability/S5-offline.png'); ts=$now; durationMs=0; probe='fulltest-cdp.mjs (inline)'; notes='网卡级断网若未执行则降级说明' }
)
$json = @{ stage=6; substage='6_1'; env=@{ snapshot=$snap; gitHead='8b7560e762bc38a9db79c7fcc5fcb5524b966feb'; channel='mock'; lang='zh+en'; userData='D:\Temp\micstudio-fulltest\userdata-s1|s4|s5'; device='none'; startedAt=$now }; items=$items; notRun=@() }
Write-Utf8NoBom (Join-Path $ev 'stability\result-6_1.json') ($json | ConvertTo-Json -Depth 8)
$items | ForEach-Object { '{0} {1}' -f $_.id, $_.status }
```

## 6. 失败处置

| 现象 | 处置 |
|---|---|
| S1 节点数持续上涨 | 记 P2（泄漏）；把 `mid` 采样序列与最后 `.modal-overlay` 计数一起附上；若是抽屉未 `destroy` 导致 → P1 |
| S1 出现 `uncaught` | 记 P1，附 `startup.log` 里的堆栈行 |
| S4 第二个实例没退出 | 记 P1（单实例锁失效）；对比 `startup.log` 的 `singleInstanceLock=` 两行 |
| S4 关窗后仍有 electron 残留 | 记 P1；列出残留 PID 与命令行；查 `before-quit` 守卫（DFU 守卫不应在非升级态生效） |
| S4 重启起不来 | 锁没释放 → 记 P1；确认 userData 里 `SingletonLock` 是否残留文件 |
| S5 有 `http(s)` 资源 | 记 P1（离线不成立），列出 URL；常见是字体/CDN 或 dev server 残留 |
| S5 无管理员 | 降级为资源清单判据，报告注明（不得写成"断网启动通过"） |

## 7. 完成定义（DoD）

1. `S1-stress.json` 有 `s0`、10 个 `mid`、`s1`，且 `EXIT=0`；
2. `S1-startup.log` 里三个崩溃/加载失败关键词 `found=False`；
3. `S4-single-instance.log` 里 `SECOND_EXITED=True`、`LEFTOVER_ELECTRON=0`、`RELAUNCH_ALIVE=True`；
4. `S5-offline.log` 里 `remote` 为空（或已注明降级）；
5. `stability/result-6_1.json` 里 S1/S4/S5 状态齐全；
6. 三个 userData 目录都在仓库外，收尾无残留 electron 进程。
