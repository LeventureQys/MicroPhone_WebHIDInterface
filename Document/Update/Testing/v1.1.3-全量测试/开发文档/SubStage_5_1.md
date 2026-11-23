# SubStage 5-1 — R 系列（一）只读健康快照 / 自动连接 / 自检 R1–R3

> 归属 Stage 5；覆盖 **R1 / R2 / R3**。前置：真机 M001（`VID_0A67` / `PID_0010`）在位、MainApp 模式。
> **测试资产前置**：本份用 `scripts/probes/fulltest-cdp.mjs`（CDP 骨架）与 `scripts/probes/fulltest-app-params.js`——两者由 `SubStage_4_1` §2/§3 与 `SubStage_3_1` §2.1 创建；若尚未创建，先按那两处写出来再跑本份。
> **三条铁律**：①R1 必须最先做（任何写操作之前）；②同一时刻只有一个进程打开 HID；③`MICSTUDIO_USER_DATA` 指仓库外。
> 本份**不做任何写操作**（R1/R2/R3 全只读）。

> **执行约定**：本文所有 PowerShell 片段默认在仓库根 `$root` 下执行（`--exec-file` / 相对路径都以它为基准）；需要"在被测树里跑"的命令都显式 `Push-Location $snap`，跑完 `Pop-Location`。
---

## 1. 前置检查

```powershell
$root = 'D:\WorkShop\MicroPhone_WebHIDInterface'
$snap = 'D:\Temp\micstudio-fulltest\v1.1.3-baseline'
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$py   = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$ev   = Join-Path $root 'artifacts\fulltest-20261121'
$electron = Join-Path $snap 'node_modules\electron\dist\electron.exe'
$ud   = 'D:\Temp\micstudio-fulltest\userdata-real'
$port = 9421
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
function Write-Utf8NoBom([string]$Path, [String]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}
New-Item -ItemType Directory -Force -Path (Join-Path $ev 'real') | Out-Null
New-Item -ItemType Directory -Force -Path $ud | Out-Null
```

| # | 检查 | 命令 | 期望 |
|---|---|---|---|
| 1 | 设备在位 | `Get-PnpDevice -PresentOnly \| Where-Object InstanceId -match 'VID_0A67' \| Select-Object Status,Class,InstanceId` | HID 与音频各一行，`Status=OK` |
| 2 | 没有别的实例占设备 | `Get-Process electron -ErrorAction SilentlyContinue` | 空；有则 `Stop-Process -Force` |
| 3 | 音频端点 | `Get-PnpDevice -PresentOnly -Class AudioEndpoint \| Where-Object FriendlyName -match 'USB Audio Device' \| Select-Object FriendlyName,Status` | 「麦克风 (USB Audio Device)」在位 |
| 4 | 裸 HID 能枚举到 | `& $py -c "import sys; sys.path.insert(0, r'$root\tools\dfu'); import hidwin; print([ (d['vid'],d['pid']) for d in hidwin.enumerate_hid() if d.get('vid')])"` | 列表里含 `('0x0A67','0x0010')`（`hidwin.py:204-205` 返回**带 0x 前缀**的十六进制字符串；大小写以本机输出为准） |
| 5 | 端口 9421 空闲 | `Get-NetTCPConnection -State Listen -LocalPort 9421 -ErrorAction SilentlyContinue` | 空 |

## 2. R1 只读健康快照

```powershell
& $py (Join-Path $root 'scripts\probes\real8-health.py') r1
$code = $LASTEXITCODE
Copy-Item (Join-Path $root 'artifacts\dfu-check-20261121\health-r1.json') (Join-Path $ev 'real\R1-health.json') -Force
$h = Get-Content (Join-Path $ev 'real\R1-health.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$h.identity | Format-List
$h.counts | Format-List
"EXIT=$code"

# 固件版本独立复核（只读子命令）
$out = & $py (Join-Path $root 'tools\dfu\m001-dfu.py') verify 2>&1
Write-Utf8NoBom (Join-Path $ev 'real\R1-dfu-verify.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$LASTEXITCODE`n")
$out
```

- **判据**：`modelCode=JYM001`、`deviceName=M001`、`firmware=0.0.6.0`、`counts.preset=118`（`config=14`、`info=62`）；全程无超时（脚本内 3 次重试后仍空才算超时，`real8-health.py:100-125`）。
- **不符时**：固件版本不是 `0.0.6.0` → R1 记 `fail` 并**停止 R 系列**，先确认设备是否被别的会话刷过（Q1/S9 场景）；预设区读回不足 118 → 记 `fail`（可能固件未按 V0.3 初始化）。
- 证据：`real/R1-health.json`、`real/R1-dfu-verify.log`。

## 3. R2 自动连接 + 顶栏状态

### 3.1 预热 profile（把通道设成 native 且保留自动连接）

默认 `micstudio.channel` 是 `mock`（`domain/channel-config.ts:54`），不预热就永远不会自动连真机。

```powershell
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
```

> 首次没有可用 CDP 会话，所以用一次性 Electron + `--exec-file` 预热（不需要 CDP）：

```powershell
$warmScript = Join-Path $ev 'real\_r2-warm.js'
Write-Utf8NoBom $warmScript @'
(() => {
  localStorage.setItem('micstudio.channel', 'native');
  localStorage.setItem('micstudio.autoConnect', 'true');
  localStorage.removeItem('micstudio.bridgeUrl');
  return JSON.stringify({ channel: localStorage.getItem('micstudio.channel'), auto: localStorage.getItem('micstudio.autoConnect') });
})()
'@
$env:MICSTUDIO_USER_DATA = $ud
Push-Location $snap
$out = & $electron '.' '--no-sandbox' "--screenshot=$(Join-Path $ev 'real\_r2-warm.png')" "--exec-file=$warmScript" 2>&1
$code = $LASTEXITCODE
Pop-Location
($out | Where-Object { $_ -match '\[probe\]' }) | ForEach-Object { $_ }
"EXIT=$code"
```

- **判据（预热）**：`[probe]` 输出 `{"channel":"native","auto":"true"}`，退出码 0。

### 3.2 冷启动计时 + getDevices 计数

```powershell
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$env:MICSTUDIO_USER_DATA = $ud       # 必须在 Start-Process 之前设，子进程才继承
$t0 = Get-Date
$el = Start-Process -FilePath $electron -WorkingDirectory $snap -PassThru -ArgumentList @(
  '.', '--no-sandbox', "--remote-debugging-port=$port", '--width=1280', '--height=820',
  '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion'
)

$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9421);
  await cdp.waitReady(30000);
  // 装 getDevices 计数器（与 verify-buglist-20261113.mjs:308-316 同款手法）
  await cdp.evaluate("(() => { const hid = navigator.hid; if (!hid) return 'no-hid'; window.__gdc = 0; const orig = hid.getDevices.bind(hid); hid.getDevices = (...a) => { window.__gdc += 1; return orig(...a); }; return 'patched'; })()");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 15000) {
    if (await cdp.evaluate("!!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready')")) { ready = true; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  const msToSync = Date.now() - t0;
  const startCalls = await cdp.evaluate('window.__gdc');
  await new Promise(r => setTimeout(r, 12000));
  const endCalls = await cdp.evaluate('window.__gdc');
  const pill = await cdp.evaluate("JSON.stringify({ sync: document.querySelector('#sync-pill')?.textContent?.trim() ?? null, source: document.querySelector('#source-pill')?.textContent?.trim() ?? null, chip: document.querySelector('#connect-btn')?.className ?? null })");
  await cdp.shot('artifacts/fulltest-20261121/real', 'R2-autoconnect.png');
  console.log(JSON.stringify({ ready, msToSync, startCalls, endCalls, getDevicesIn12s: endCalls - startCalls, pill: JSON.parse(pill) }));
});
'@
$r2 = & $node -e $js 2>&1
Write-Utf8NoBom (Join-Path $ev 'real\R2-autoconnect.json') (($r2 | Out-String))
$r2
"PROCESS_ALIVE=$(-not $el.HasExited)"
```

- **判据**：`ready=true` 且 `msToSync <= 5000`；`getDevicesIn12s == 0`；`pill.sync` 是「已同步」类文案、`pill.source` 不是「演示」。
- **若 `getDevicesIn12s` 为 1–2**：按需求原文记 `fail`，但在 `notes` 里注明实测值与 `AGENTS.md` 描述的「5 s 兜底轮询」是否吻合，供报告裁决（**不要**私自放宽判据）。
- 证据：`real/R2-autoconnect.json`、`real/R2-autoconnect.png`、`$ud\startup.log` 副本 → `real/R2-startup.log`。

## 4. R3 连接 + sync + 自检 3 轮

```powershell
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9421);
  await cdp.waitSync(45000);
  const findSelfCheck = "(() => { const b = Array.from(document.querySelectorAll('.modal button, .device-actions button, button')).find((x) => /\u81ea\u68c0|self.?check/i.test(x.textContent || '')); if (b) b.click(); return b ? 'clicked' : 'not-found'; })()";
  await cdp.evaluate("window.__micstudioGo('device'); true");
  await new Promise(r => setTimeout(r, 800));
  const rounds = [];
  for (let i = 0; i < 3; i += 1) {
    const clicked = await cdp.evaluate(findSelfCheck);
    await new Promise(r => setTimeout(r, 6000));
    const steps = await cdp.evaluate("JSON.stringify(Array.from(document.querySelectorAll('.diag-selfcheck-steps > *')).map((n) => ({ text: n.textContent.trim(), cls: n.className })))");
    const stats = await cdp.evaluate("JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((n) => [n.dataset.stat, n.textContent.trim()])))");
    rounds.push({ i, clicked, steps: JSON.parse(steps), stats: JSON.parse(stats) });
  }
  await cdp.shot('artifacts/fulltest-20261121/real', 'R3-selfcheck.png');
  const pills = await cdp.evaluate("JSON.stringify({ sync: document.querySelector('#sync-pill')?.textContent?.trim() ?? null, syncReady: !!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready') })");
  console.log(JSON.stringify({ rounds, pill: JSON.parse(pills) }));
});
'@
$r3 = & $node -e $js 2>&1
Write-Utf8NoBom (Join-Path $ev 'real\R3-selfcheck.json') (($r3 | Out-String))
$r3
```

- **判据**：3 轮都 `clicked=clicked`；每轮自检 3 步全绿（`steps` 三个元素都带"通过"类，通常包含 `is-ok`/`ok`/`pass`，以脚本输出为准）；三轮结束时 `stats.crc/timeout/retry` 全为 `0`；`pill.syncReady=true`。
- **自检按钮找不到**（`clicked=not-found`）：先 dump 设备抽屉按钮文本定位（`Array.from(document.querySelectorAll('.modal button')).map(b=>b.textContent)`），再改选择器；不得跳过。
- 证据：`real/R3-selfcheck.json`、`real/R3-selfcheck.png`。

## 5. 证据清单与结果 JSON

| 文件 | 覆盖 |
|---|---|
| `real/R1-health.json`、`real/R1-dfu-verify.log` | R1 |
| `real/R2-autoconnect.json`、`real/R2-autoconnect.png`、`real/R2-startup.log` | R2 |
| `real/R3-selfcheck.json`、`real/R3-selfcheck.png` | R3 |
| `real/result-5_1.json` | 三条状态 |

```powershell
$now = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
$r1 = Get-Content (Join-Path $ev 'real\R1-health.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$r2 = Get-Content (Join-Path $ev 'real\R2-autoconnect.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$r3 = Get-Content (Join-Path $ev 'real\R3-selfcheck.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$items = @(
  @{ id='R1'; status=$(if ($r1.identity.firmware -eq '0.0.6.0' -and $r1.counts.preset -eq 118) {'pass'} else {'fail'});
     expected='型号 JYM001、名称 M001、版本 0.0.6.0、118 项预设区可读、无超时';
     actual=("model={0} name={1} fw={2} preset={3}" -f $r1.identity.modelCode, $r1.identity.deviceName, $r1.identity.firmware, $r1.counts.preset);
     evidence=@('artifacts/fulltest-20261121/real/R1-health.json'); ts=$now; durationMs=0; probe='scripts\probes\real8-health.py r1'; notes='' },
  @{ id='R2'; status=$(if ($r2.ready -and $r2.msToSync -le 5000 -and $r2.getDevicesIn12s -eq 0) {'pass'} else {'fail'});
     expected='启动后 ≤5 s 自动连接成功；顶栏「已连接/已同步」；12 s 内 getDevices() 0 次';
     actual=("ready={0} msToSync={1} getDevicesIn12s={2} sync={3}" -f $r2.ready, $r2.msToSync, $r2.getDevicesIn12s, $r2.pill.sync);
     evidence=@('artifacts/fulltest-20261121/real/R2-autoconnect.json','artifacts/fulltest-20261121/real/R2-autoconnect.png'); ts=$now; durationMs=0; probe='fulltest-cdp.mjs (inline)'; notes='' },
  @{ id='R3'; status=$(if ($r3.pill.syncReady -and ($r3.rounds | Where-Object { $_.clicked -ne 'clicked' }).Count -eq 0) {'pass'} else {'fail'});
     expected='连续 3 轮自检 3/3 全绿；crc/timeout/retry 全 0';
     actual=("rounds={0} syncReady={1} stats={2}" -f $r3.rounds.Count, $r3.pill.syncReady, ($r3.rounds[-1].stats | ConvertTo-Json -Compress));
     evidence=@('artifacts/fulltest-20261121/real/R3-selfcheck.json','artifacts/fulltest-20261121/real/R3-selfcheck.png'); ts=$now; durationMs=0; probe='fulltest-cdp.mjs (inline)'; notes='' }
)
$json = @{ stage=5; substage='5_1'; env=@{ snapshot=$snap; gitHead='8b7560e762bc38a9db79c7fcc5fcb5524b966feb'; channel='native'; lang='zh'; userData=$ud; device='M001 0A67:0010 fw 0.0.6.0'; startedAt=$now }; items=$items; notRun=@() }
Write-Utf8NoBom (Join-Path $ev 'real\result-5_1.json') ($json | ConvertTo-Json -Depth 8)
$items | ForEach-Object { '{0} {1}' -f $_.id, $_.status }
```

## 6. 失败处置

| 现象 | 处置 |
|---|---|
| R1 打不开设备 | 有别的进程占着 HID（应用/另一会话）→ 关掉再跑；仍失败记 `blocked`（设备被独占） |
| R1 版本不是 `0.0.6.0` | 记 `fail` 并**停止 R 系列**；向用户确认设备状态（另一会话刷过机？） |
| R2 一直 `ready=false` | ①预热是否真的写了 `native`（看 `R2-startup.log` 里 `channel=`）②`navigator.hid` 是否可用 ③主进程白名单是否放行（`shared/webhid-whitelist.ts`）④设备是否已在 Bootloader |
| R2 `msToSync>5000` | 记 `fail`（需求 ≤5 s）；附 `startup.log` 时间线（`ready` / `window-created` / `[auto-connect]`） |
| R2 `getDevicesIn12s>0` | 记 `fail` 并注明是否与 5 s 兜底吻合；不要擅自放宽 |
| R3 自检按钮找不到 | dump 按钮文本后修选择器（测试资产改动）；不得跳过该项 |
| R3 自检有红步 | 记 P1；把该步文本与诊断卡 `crc/timeout/retry` 一起写进缺陷 |
| 中途掉线 | 按 S10 记 `blocked`；插回等 5 s；仍不行重启应用并重跑本份 |

## 7. 完成定义（DoD）

1. `real/R1-health.json` 三项身份字段与 118/14/62 计数齐全；
2. `real/R2-autoconnect.json` 有 `msToSync`、`getDevicesIn12s`、`pill` 三个量化值；
3. `real/R3-selfcheck.json` 有 3 轮 `rounds` 且每轮 3 个自检步；
4. `real/result-5_1.json` 里 R1/R2/R3 状态齐全（fail 必带缺陷指向，blocked 必带解除条件）；
5. 本份**未对设备做任何写操作**（`real8-health.py` 与 `use 0x13` 只读；如因排障写过，必须立即跑 R12 还原并在此注明）。
