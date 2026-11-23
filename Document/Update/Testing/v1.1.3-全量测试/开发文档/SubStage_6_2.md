# SubStage 6-2 — S 系列（二）已知坑复现验证 / 历史修复点回归 S2、S3

> 归属 Stage 6；覆盖 **S2 / S3**。
> 前置：`SubStage_1_2`（G5 三连跑）、`SubStage_5_1`（R 系列现场）、`SubStage_4_*`（界面证据）。S2 的坑 25 直接引用 G5；坑 27 需要真机。
> 原则：**每一项都要给出「本轮复现 / 未复现 + 证据」**，不允许写"应该没问题"。

> **执行约定**：本文所有 PowerShell 片段默认在仓库根 `$root` 下执行（`--exec-file` / 相对路径都以它为基准）；需要"在被测树里跑"的命令都显式 `Push-Location $snap`，跑完 `Pop-Location`。
---

## 1. 前置

```powershell
$root = 'D:\WorkShop\MicroPhone_WebHIDInterface'
$snap = 'D:\Temp\micstudio-fulltest\v1.1.3-baseline'
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$py   = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$ev   = Join-Path $root 'artifacts\fulltest-20261121'
$electron = Join-Path $snap 'node_modules\electron\dist\electron.exe'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
function Write-Utf8NoBom([string]$Path, [String]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}
New-Item -ItemType Directory -Force -Path (Join-Path $ev 'stability') | Out-Null
New-Item -ItemType Directory -Force -Path 'D:\Temp\micstudio-fulltest\userdata-s2' | Out-Null
```

## 2. S2 逐坑验证

### 2.1 坑 14 / 18：不带 `--no-sandbox` 会崩（对照组）

```powershell
$ud = 'D:\Temp\micstudio-fulltest\userdata-s2'
$env:MICSTUDIO_USER_DATA = $ud
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# A 组：不带 --no-sandbox
Push-Location $snap
$outA = & $electron '.' '--hold=3000' 2>&1
Pop-Location
$codeA = $LASTEXITCODE
Write-Utf8NoBom (Join-Path $ev 'stability\S2-trap14-without-nosandbox.log') ((($outA | Out-String).TrimEnd()) + "`nEXIT=$codeA`n")
"A_EXIT=$codeA"
($outA | Select-String -Pattern 'GPU process|FATAL|error_code' | Select-Object -First 5 | ForEach-Object { $_.Line })

# B 组：带 --no-sandbox
Push-Location $snap
$outB = & $electron '.' '--no-sandbox' '--hold=3000' 2>&1
Pop-Location
$codeB = $LASTEXITCODE
Write-Utf8NoBom (Join-Path $ev 'stability\S2-trap14-with-nosandbox.log') ((($outB | Out-String).TrimEnd()) + "`nEXIT=$codeB`n")
"B_EXIT=$codeB"
```

- **期望**：A 组非 0 且日志含 `GPU process isn't usable` / `FATAL:gpu_data_manager_impl_private.cc`；B 组 `EXIT=0` 且日志含 `hold-mode-finished`。
- **判定**：A 复现 + B 正常 → 「本轮复现（坑 14/18 仍存在，`--no-sandbox` 是必需）」，这是**环境事实**而非缺陷（S8）。

### 2.2 坑 25：T07 写合并（引用 G5）

```powershell
$g5 = Join-Path $ev 'gates\G5-summary.txt'
[System.IO.File]::ReadAllText($g5, [System.Text.Encoding]::UTF8)
$t = [System.IO.File]::ReadAllText((Join-Path $ev 'gates\G5-selftest-run1.log'), [System.Text.Encoding]::UTF8)
($t -split "`n" | Where-Object { $_ -match 'T07' })
```

- **判定**：三次 `passed=20 failed=0` 且 T07 时长 < 5 s → 「未复现（已修）」；任一次 T07 失败 → 「本轮复现」并记回归缺陷（S11）。
- 证据：`gates/G5-summary.txt`、`gates/G5-selftest-run{1,2,3}.log`。

### 2.3 坑 26：`sync()` 抢发 `0x13` 与在途 `0x12` 竞态

```powershell
$env:MICSTUDIO_USER_DATA = $ud
Start-Process -FilePath $electron -WorkingDirectory $snap -ArgumentList @('.', '--no-sandbox', '--remote-debugging-port=9434') | Out-Null
Start-Sleep -Seconds 6
Push-Location $root
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9434);
  await cdp.waitSync(60000);
  await cdp.evaluate("window.__micstudioGo('device'); true");
  await new Promise(r => setTimeout(r, 800));
  const click = "(() => { const b = Array.from(document.querySelectorAll('.modal button')).find((x) => /\u81ea\u68c0|sync|\u540c\u6b65/i.test(x.textContent || '')); if (!b) return 'not-found'; b.click(); return 'clicked'; })()";
  const rounds = [];
  for (let i = 0; i < 3; i += 1) {
    const c = await cdp.evaluate(click);
    await new Promise(r => setTimeout(r, 2500));   // 故意在上一轮还没完全稳的时候再点
    const v = await cdp.evaluate("JSON.stringify({ sync: document.querySelector('#sync-pill')?.textContent?.trim() ?? null, ready: !!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready'), notice: document.querySelector('.console-notice')?.hidden ? null : document.querySelector('.console-notice')?.textContent?.trim(), stats: Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((n) => [n.dataset.stat, n.textContent.trim()])), selfCheck: Array.from(document.querySelectorAll('.diag-selfcheck-steps > *')).map((n) => n.className) })");
    rounds.push({ i, clicked: c, state: JSON.parse(v) });
  }
  await cdp.shot('artifacts/fulltest-20261121/stability', 'S2-trap26-sync-race.png');
  console.log(JSON.stringify(rounds));
});
'@
$out = & $node -e $js 2>&1
$code = $LASTEXITCODE
Pop-Location
Write-Utf8NoBom (Join-Path $ev 'stability\S2-trap26-sync-race.json') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")
$out
```

- **判据**：三轮 `ready` 全为 true、无「预设回读应答不是连续读响应」类 notice、`stats.crc/timeout` 不涨 → 「未复现（已修）」；任一轮失败 → 「本轮复现」，记 P1（`device/proto/session.ts` 的 `abandoned`/`syncGeneration` 逻辑）。
- **说明**：该项必须**在真机或虚拟通道**下做才有意义（mock 不产生真实轮询竞争）；本份默认用真机（`userdata-real` 已预热成 native，可直接复用 `SubStage_5_1` 的 profile）。若用虚拟通道，把 `$ud` 换成 `userdata-ui-virtual` 并确保桥在 8865 起。

### 2.4 坑 27：写 Flash 宽限（真机）

```powershell
# 真机通道：写一个参数，然后在 0–3 s 内高频看 sync 状态与 stats
$env:MICSTUDIO_USER_DATA = 'D:\Temp\micstudio-fulltest\userdata-real'
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process -FilePath $electron -WorkingDirectory $snap -ArgumentList @('.', '--no-sandbox', '--remote-debugging-port=9435') | Out-Null
Start-Sleep -Seconds 6
Push-Location $root
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9435);
  await cdp.waitSync(60000);
  await cdp.evaluate("window.__micstudioGo('advanced'); true"); await new Promise(r => setTimeout(r, 900));
  const before = await cdp.evaluate("JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((n) => [n.dataset.stat, n.textContent.trim()])))");
  await cdp.evaluate("(() => { const el = document.querySelector('.modal [data-param=\"enc.Level\"] input[type=\"number\"]'); if (el) { el.value='2'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } return true; })()");
  const samples = [];
  for (let i = 0; i < 8; i += 1) {
    await new Promise(r => setTimeout(r, 400));
    samples.push(JSON.parse(await cdp.evaluate("JSON.stringify({ t: Date.now(), ready: !!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready'), sync: document.querySelector('#sync-pill')?.textContent?.trim() ?? null, stats: Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((n) => [n.dataset.stat, n.textContent.trim()])) })")));
  }
  console.log(JSON.stringify({ before: JSON.parse(before), samples }));
});
'@
$out = & $node -e $js 2>&1
$code = $LASTEXITCODE
Pop-Location
Write-Utf8NoBom (Join-Path $ev 'stability\S2-trap27-write-grace.json') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")
$out
```

- **判据**：8 个采样点 `ready` 全为 true；`timeout` 不增长（`retry` 允许 ≤1）；3.2 s 内没有掉线 → 「未复现（宽限生效）」。
- 若 `ready` 变 false 且伴随 `timeout` 上涨 → 「本轮复现」，记 P1（`writeGraceMs`/`writeSettleMs` 回归）。
- **写后必须还原**：本项改了 `enc.Level`，跑完立刻走 `SubStage_5_3` 的 R12 还原流程。

### 2.5 坑 29：双击 `.cmd` / 启动器被 SAC 拦

```powershell
$lines = @()
$lines += "POLICY=$((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState)"
$lines += "LAUNCHER_EXISTS=$(Test-Path (Join-Path $root '启动 MIC STUDIO.micstudio'))"
$lines += "REGISTER_SCRIPT=$(Test-Path (Join-Path $root 'scripts\register-sac-launcher.ps1'))"

# 试着用 ShellExecute 拉起启动器（等价双击），记录是否被拦
try {
  $p = Start-Process -FilePath (Join-Path $root '启动 MIC STUDIO.micstudio') -PassThru -ErrorAction Stop
  $lines += "SHELLEXEC=ok pid=$($p.Id)"
} catch {
  $lines += "SHELLEXEC=blocked $($_.Exception.Message)"
}
$lines | ForEach-Object { $_ }
Write-Utf8NoBom (Join-Path $ev 'stability\S2-trap29-launcher.txt') (($lines -join "`r`n") + "`r`n")
```

- **判据**：`POLICY=1` 且 `SHELLEXEC=blocked ... Application Control policy has blocked this file` → 「本轮复现（SAC 仍拦）」，记环境限制；若能拉起 → 「本轮未复现」。
- 两条都合法，只要证据在。

### 2.6 汇总

```powershell
$now = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
$traps = [ordered]@{
  '14/18' = @{ verdict = '复现（环境事实：必须 --no-sandbox）'; evidence = 'artifacts/fulltest-20261121/stability/S2-trap14-without-nosandbox.log' }
  '25'    = @{ verdict = '未复现（T07 三连跑通过）'; evidence = 'artifacts/fulltest-20261121/gates/G5-summary.txt' }
  '26'    = @{ verdict = '未复现（三轮 sync/自检无 notice、crc/timeout 不涨）'; evidence = 'artifacts/fulltest-20261121/stability/S2-trap26-sync-race.json' }
  '27'    = @{ verdict = '未复现（写后 8 采样 ready 全真）'; evidence = 'artifacts/fulltest-20261121/stability/S2-trap27-write-grace.json' }
  '29'    = @{ verdict = '见 S2-trap29-launcher.txt'; evidence = 'artifacts/fulltest-20261121/stability/S2-trap29-launcher.txt' }
}
Write-Utf8NoBom (Join-Path $ev 'stability\S2-traps.json') (($traps | ConvertTo-Json -Depth 5))
Get-Content (Join-Path $ev 'stability\S2-traps.json') -Encoding UTF8
```

- **注意**：`S2-traps.json` 里的 `verdict` 必须按**实测**改写（上面的默认值是"预期"，不是结论）。改完再进 S3。

## 3. S3 历史修复点回归

八条修复点，逐条指向最少成本的可复核证据：

| # | 修复点 | 判定方式 | 证据 |
|---|---|---|---|
| 1 | 增益去抖（耳机音量不再跳） | 连续 10 次采样 `.console-gain-value`，值不抖动 | `stability/S3-gain-debounce.json` |
| 2 | USB 探测降频（`getDevices` 不再周期调用） | R2 的 `getDevicesIn12s` | `real/R2-autoconnect.json` |
| 3 | 写合并尾沿（一次拖拽 1 帧） | G5 T07 + U5/U6 拖拽后 `[data-stat="out"]` 只 +1 | `gates/G5-selftest-run1.log`、`ui/ui-console-zh.json` |
| 4 | 界面文案与布局（场景顺序/音色/阈值直连/开关） | U1/U2/U3/U5 + 英文轮无缺键 | `ui/ui-console-{zh,en}.json`、`ui/U11-pill-en.png` |
| 5 | 自定义场景 | U2 的 `custom` + R6 的 `custom` 轮 | `ui/ui-console-zh.json`、`real/R6-scenes-summary.json` |
| 6 | 模块 bypass（真实使能位） | U9 + `verify-v006` 的 `data-enable` 断言 | `ui/ui-drawers-{zh,en}.json` |
| 7 | 参数表 V0.3 落地 | P1/P2（46 项 + 默认值 + 118 项） | `real/P1-compare.json`、`real/P2-defaults.json` |
| 8 | DFU 回读失败文案 | `tests/unit/firmware-view.test.ts` 通过（G2） + `i18n` 键存在 | `gates/G2-test.log` |

第 1 条（唯一需要新跑的一项）：

```powershell
$env:MICSTUDIO_USER_DATA = 'D:\Temp\micstudio-fulltest\userdata-s2'
Start-Process -FilePath $electron -WorkingDirectory $snap -ArgumentList @('.', '--no-sandbox', '--remote-debugging-port=9436') | Out-Null
Start-Sleep -Seconds 6
Push-Location $root
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9436);
  await cdp.warm({ channel: 'mock', lang: 'zh' });
  await cdp.waitSync(45000);
  const samples = [];
  for (let i = 0; i < 10; i += 1) {
    samples.push(JSON.parse(await cdp.evaluate("JSON.stringify(Array.from(document.querySelectorAll('.console-gain-value')).map((n) => n.textContent.trim()))")));
    await new Promise(r => setTimeout(r, 300));
  }
  const values = samples.map((s) => s.join('/'));
  const unique = Array.from(new Set(values));
  console.log(JSON.stringify({ samples: values, unique, stable: unique.length <= 2 }));
});
'@
$out = & $node -e $js 2>&1
$code = $LASTEXITCODE
Pop-Location
Write-Utf8NoBom (Join-Path $ev 'stability\S3-gain-debounce.json') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")
$out
```

- **判据**：`stable=true`（10 次采样里不同读数 ≤2 种；mock 通道下增益是恒定值，理想是 1 种）。

其余 7 条按上表逐一核对文件存在并摘录关键行：

```powershell
$rows = @()
function Check-Ev([string]$id, [string]$path, [string]$pattern) {
  $full = Join-Path $root $path
  $ok = Test-Path $full
  $hit = $false
  if ($ok -and $pattern) { $hit = ([System.IO.File]::ReadAllText($full, [System.Text.Encoding]::UTF8) -match $pattern) }
  [pscustomobject]@{ id = $id; file = $path; exists = $ok; patternHit = $hit }
}
$rows += Check-Ev '2' 'artifacts/fulltest-20261121/real/R2-autoconnect.json' 'getDevicesIn12s'
$rows += Check-Ev '3' 'artifacts/fulltest-20261121/gates/G5-selftest-run1.log' 'T07'
$rows += Check-Ev '4' 'artifacts/fulltest-20261121/ui/ui-console-en.json' 'U11'
$rows += Check-Ev '5' 'artifacts/fulltest-20261121/real/R6-scenes-summary.json' 'custom'
$rows += Check-Ev '6' 'artifacts/fulltest-20261121/ui/ui-drawers-zh.json' 'U9'
$rows += Check-Ev '7' 'artifacts/fulltest-20261121/real/P1-compare.json' 'summary'
$rows += Check-Ev '8' 'artifacts/fulltest-20261121/gates/G2-test.log' 'firmware-view\.test\.ts'
$rows | Format-Table -AutoSize | Out-String -Width 200
Write-Utf8NoBom (Join-Path $ev 'stability\S3-regression.json') ($rows | ConvertTo-Json -Depth 4)
```

- **判据**：8 行 `exists=True`；`patternHit` 允许个别为 `False`（例如 `R6-scenes-summary.json` 里不一定出现字符串 `custom`），但必须在报告里逐行人工确认，不能只看布尔值。

## 4. 证据与结果 JSON

```powershell
$now = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
$s3 = Get-Content (Join-Path $ev 'stability\S3-regression.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$items = @(
  @{ id='S2'; status='pass'; expected='已知坑 14/18/25/26/27/29 逐条给出本轮复现/未复现 + 证据';
     actual='见 stability/S2-traps.json（需按实测改写 verdict）'; evidence=@('artifacts/fulltest-20261121/stability/S2-traps.json','artifacts/fulltest-20261121/stability/S2-trap14-without-nosandbox.log','artifacts/fulltest-20261121/stability/S2-trap26-sync-race.json','artifacts/fulltest-20261121/stability/S2-trap27-write-grace.json','artifacts/fulltest-20261121/stability/S2-trap29-launcher.txt'); ts=$now; durationMs=0; probe='多探针组合'; notes='' }
  @{ id='S3'; status=$(if (($s3 | Where-Object { -not $_.exists }).Count -eq 0) {'pass'} else {'fail'});
     expected='v1.1.1/v1.1.2 的 8 个修复点全部仍成立'; actual=("checked={0} missing={1}" -f $s3.Count, ($s3 | Where-Object { -not $_.exists }).Count);
     evidence=@('artifacts/fulltest-20261121/stability/S3-regression.json','artifacts/fulltest-20261121/stability/S3-gain-debounce.json'); ts=$now; durationMs=0; probe='证据核对 + fulltest-cdp.mjs'; notes='' }
)
$json = @{ stage=6; substage='6_2'; env=@{ snapshot=$snap; gitHead='8b7560e762bc38a9db79c7fcc5fcb5524b966feb'; channel='native+mock'; lang='zh'; userData='userdata-s2 / userdata-real'; device='M001 0A67:0010'; startedAt=$now }; items=$items; notRun=@() }
Write-Utf8NoBom (Join-Path $ev 'stability\result-6_2.json') ($json | ConvertTo-Json -Depth 8)
$items | ForEach-Object { '{0} {1}' -f $_.id, $_.status }
```

## 5. 失败处置

| 现象 | 处置 |
|---|---|
| 坑 14 A 组没崩 | 说明本机沙箱策略变了 → 记录事实（"未复现"），但 `--no-sandbox` 仍照旧使用（S8），并在报告注明环境变化 |
| 坑 26 复现 | 记 P1，附 `S2-trap26-sync-race.json`；对照 `device/proto/session.ts` 的 `abandoned`/`syncGeneration` |
| 坑 27 复现 | 记 P1；先停写、跑 R12 还原，再定位 `TIMING.writeGraceMs` |
| 坑 29 无法验证 | 记 `blocked`（需交互式桌面会话），注明解除条件 |
| S3 某条证据缺失 | 回补对应 Stage（不要用别的项替代）；补不齐则 S3 记 `fail` 并写明缺哪条 |
| 增益仍抖动 | 记 P1；附 10 次采样序列 |

## 6. 完成定义（DoD）

1. `stability/S2-traps.json` 的 5 组坑（14/18、25、26、27、29）都有 `verdict`（**已按实测改写**）与 `evidence`；
2. 每组的证据文件存在且非空；
3. `stability/S3-regression.json` 8 行齐全、`exists` 全 true，且报告里有逐行人工确认；
4. `stability/S3-gain-debounce.json` 的 `stable=true`；
5. `stability/result-6_2.json` 里 S2/S3 状态齐全；
6. 若本份写过参数（坑 27 项）→ 已跑 R12 还原并留 `real/R12-restore.json`（`mismatch=0`）。
