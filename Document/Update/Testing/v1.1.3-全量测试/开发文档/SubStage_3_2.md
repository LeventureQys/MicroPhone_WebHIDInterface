# SubStage 3-2 — V 系列（虚拟下位机与桥接 V1–V4）

> 归属 Stage 3；覆盖 **V1 / V2 / V3**；**V4 不执行**（Q6：DFU 免测），只在结果里登记 `notRun`。
> 端口：桥 `127.0.0.1:8765`（WebSocket `ws://127.0.0.1:8765/ws`）、侧车控制面 `127.0.0.1:8766`。**起桥前必须确认空闲**。
> 真机：本份**不占用**真机；但应用可能要读音频端点，属只读行为。

> **执行约定**：本文所有 PowerShell 片段默认在仓库根 `$root` 下执行（`--exec-file` / 相对路径都以它为基准）；需要"在被测树里跑"的命令都显式 `Push-Location $snap`，跑完 `Pop-Location`。
---

## 0. 目标

1. **V1**：`node tools\vdevice\run.mjs` 一条命令把桥 + 侧车一起拉起来，Ctrl+C / 终止后两个端口都释放。
2. **V2**：应用走 `virtual` 通道连接虚拟设备，`sync()` 成功后**界面读回值 = 控制面设定的值**（证明回读链路真的走设备，不是本地默认值）。
3. **V3**：`POST /control/faults` 注入 `disconnect` → 上位机按超时判通道异常并能恢复（或按设计明示不恢复），全程有状态采样。
4. **V4**：不执行，登记 `notRun`。

## 1. 前置检查

```powershell
$root = 'D:\WorkShop\MicroPhone_WebHIDInterface'
$snap = 'D:\Temp\micstudio-fulltest\v1.1.3-baseline'
$node = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$py   = 'C:\Users\a5935\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$ev   = Join-Path $root 'artifacts\fulltest-20261121'
$electron = Join-Path $snap 'node_modules\electron\dist\electron.exe'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}
New-Item -ItemType Directory -Force -Path (Join-Path $ev 'vdevice') | Out-Null
New-Item -ItemType Directory -Force -Path 'D:\Temp\micstudio-fulltest\userdata-virtual' | Out-Null
```

| # | 检查 | 命令 | 期望 |
|---|---|---|---|
| 1 | 端口空闲 | `Get-NetTCPConnection -State Listen -LocalPort 8765,8766 -ErrorAction SilentlyContinue \| Select-Object LocalPort,OwningProcess` | 无输出 |
| 2 | Python 可用 | `& $py -V` | `Python 3.12.14` |
| 3 | 桥默认解释器路径与 `run.mjs` 一致 | `Select-String -Path (Join-Path $snap 'tools\vdevice\run.mjs') -Pattern 'DEFAULT_PYTHON' -Context 0,2` | 指向 `C:\Users\a5935\...\python.exe`；不一致就设 `$env:MICSTUDIO_PYTHON = $py` |
| 4 | profile 无 BOM（坑 21） | `$b=[System.IO.File]::ReadAllBytes((Join-Path $snap 'tools\vdevice\profiles\mic-m001.json')); '{0:X2} {1:X2} {2:X2}' -f $b[0],$b[1],$b[2]` | 不是 `EF BB BF`（正常是 `7B 0D 0A` 或 `7B 0A`） |
| 5 | 虚拟设备 ID | `(Get-Content (Join-Path $snap 'tools\vdevice\profiles\mic-m001.json') -Raw) -match 'mic-m001'` | `True`（设备 `productName = Virtual MIC M001`，`serialNumber = VHID-MIC-M001`） |

## 2. V1 一键起停

```powershell
$logPath = Join-Path $ev 'vdevice\V1-start.log'
$errPath = Join-Path $ev 'vdevice\V1-start.err.log'
Push-Location $snap
$proc = Start-Process -FilePath $node -ArgumentList @('tools\vdevice\run.mjs') -PassThru -NoNewWindow `
  -RedirectStandardOutput $logPath -RedirectStandardError $errPath
Pop-Location

# 等桥健康（≤20 s）
$ok = $false
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/healthz' -TimeoutSec 2; if ($r) { $ok = $true; break } } catch { Start-Sleep -Milliseconds 500 }
}
"BRIDGE_HEALTHY=$ok pid=$($proc.Id)"

# 侧车控制面也活
$stats = Invoke-RestMethod -Uri 'http://127.0.0.1:8766/control/stats' -TimeoutSec 5
$stats | ConvertTo-Json -Depth 5
Write-Utf8NoBom (Join-Path $ev 'vdevice\V1-stats.json') ($stats | ConvertTo-Json -Depth 6)

# 端口快照（起后）
Get-NetTCPConnection -State Listen -LocalPort 8765,8766 |
  Select-Object LocalAddress,LocalPort,OwningProcess |
  Format-Table -AutoSize | Out-String -Width 120 |
  ForEach-Object { Write-Utf8NoBom (Join-Path $ev 'vdevice\V1-ports-before.txt') $_ }
```

- **判据**：`BRIDGE_HEALTHY=True`；`/control/stats` 返回 JSON（含设备/帧计数）；`V1-ports-before.txt` 有两行（8765、8766）。

停止 + 端口释放：

```powershell
& taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
Start-Sleep -Seconds 3
$left = Get-NetTCPConnection -State Listen -LocalPort 8765,8766 -ErrorAction SilentlyContinue
$lines = @()
$lines += "KILLED_PID=$($proc.Id)"
$lines += "LEFT_LISTENERS=$(($left | Measure-Object).Count)"
$left | ForEach-Object { $lines += ("port={0} pid={1}" -f $_.LocalPort, $_.OwningProcess) }
$leftNodes = Get-Process node,python -ErrorAction SilentlyContinue
$lines += "LEFTOVER_NODE_PYTHON=$(($leftNodes | Measure-Object).Count)"
$lines | ForEach-Object { $_ }
Write-Utf8NoBom (Join-Path $ev 'vdevice\V1-ports-after.txt') (($lines -join "`r`n") + "`r`n")
```

- **判据**：`LEFT_LISTENERS=0`；`LEFTOVER_NODE_PYTHON=0`（若 >0，`Get-Process node,python | Stop-Process -Force` 后再记一次，并把"收尾不干净"记 P2）。
- **证据**：`vdevice/V1-start.log`、`vdevice/V1-start.err.log`、`vdevice/V1-stats.json`、`vdevice/V1-ports-before.txt`、`vdevice/V1-ports-after.txt`。

## 3. V2 虚拟通道连接 + 参数回读

### 3.1 起桥（后续步骤都用它）

```powershell
Push-Location $snap
$proc = Start-Process -FilePath $node -ArgumentList @('tools\vdevice\run.mjs') -PassThru -NoNewWindow `
  -RedirectStandardOutput (Join-Path $ev 'vdevice\V2-bridge.log') -RedirectStandardError (Join-Path $ev 'vdevice\V2-bridge.err.log')
Pop-Location
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  try { if (Invoke-RestMethod -Uri 'http://127.0.0.1:8765/healthz' -TimeoutSec 2) { break } } catch { Start-Sleep -Milliseconds 500 }
}
"BRIDGE_PID=$($proc.Id)"
```

### 3.2 设定一组"非默认"值（证明回读不是本地默认值）

```powershell
# 选 8 项可写、非只读、量程明确的参数（不要用 0x2023/0x205A：只读）
$set = [ordered]@{
  '0x2025' = 3      # enc.Level     环境降噪档位
  '0x2024' = 1      # enc.OnOff     环境降噪开关
  '0x2026' = 4      # eq.mode       均衡器模式（界面无控件，仍可被同步读入 model）
  '0x2058' = 1      # mic.sigMute   电平信号静音
  '0x204A' = 1      # comp.Enable   压缩器使能
  '0x2051' = 1      # limit.Enable  限制器使能
  '0x2072' = 0      # rgbOnOff      RGB 关闭
  '0x2073' = 5      # rgbMode       RGB 模式 5
}
$body = @{ values = $set } | ConvertTo-Json -Depth 4
$resp = Invoke-RestMethod -Uri 'http://127.0.0.1:8766/control/registers' -Method Post -ContentType 'application/json' -Body $body
$resp | ConvertTo-Json -Depth 4
Write-Utf8NoBom (Join-Path $ev 'vdevice\V2-set-registers.json') (($set | ConvertTo-Json -Depth 4) + "`r`n" + ($resp | ConvertTo-Json -Depth 4))
```

- **判据**：`resp.ok = True`（`sidecar.mjs:792-813` 的写寄存器接口，body 形如 `{"values":{"0x2025":3}}`）。

### 3.3 应用切到 virtual 通道并连接（隔离预热 + CDP 走查）

电子的 profile 里先把通道写死再 reload（同 `verify-v006-20261121.mjs:216-229` 的手法），**避免自动连到真机**：

```powershell
$ud = 'D:\Temp\micstudio-fulltest\userdata-virtual'
$env:MICSTUDIO_USER_DATA = $ud
$port = 9412
$proc2 = Start-Process -FilePath $electron -WorkingDirectory $snap -PassThru -ArgumentList @(
  '.', '--no-sandbox', "--remote-debugging-port=$port", '--width=1280', '--height=820',
  '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion'
)
"ELECTRON_PID=$($proc2.Id) CDP=$port"
Start-Sleep -Seconds 6
(Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 5) | Select-Object type,url,webSocketDebuggerUrl | Format-List
```

然后用下面这段 Node（**新建** `scripts/probes/fulltest-v2-virtual.mjs`，测试资产）完成"预热 → 连接 → 抓 46 项 → 落 JSON"：

```powershell
$probe = Join-Path $root 'scripts\probes\fulltest-v2-virtual.mjs'
$src = @'
// 本轮新增（测试资产）：V2 —— virtual 通道连接虚拟下位机 → sync → 抓 46 项界面值。
// 用法：node scripts/probes/fulltest-v2-virtual.mjs <cdpPort> <outJson> <userDataHint>
import fs from 'node:fs';
import path from 'node:path';
const [portArg, outArg] = process.argv.slice(2);
const port = Number(portArg || 9412);
const out = outArg || 'artifacts/fulltest-20261121/vdevice/V2-app-params.json';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && (t.url ?? '').includes('index.html'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await wait(300);
  }
  throw new Error('no page target');
}

const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let id = 1; const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data); const w = pending.get(m.id); if (!w) return;
  pending.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
});
const send = (method, params = {}, timeoutMs = 60000) => new Promise((resolve, reject) => {
  const mid = id++; pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
  setTimeout(() => { if (pending.delete(mid)) reject(new Error(`cdp timeout ${method}`)); }, timeoutMs);
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate failed');
  return r.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');

// 1) 预热：通道=virtual、桥地址=8765、关自动连接，然后 reload
await evaluate(`(() => {
  localStorage.setItem('micstudio.channel','virtual');
  localStorage.setItem('micstudio.bridgeUrl','ws://127.0.0.1:8765/ws');
  localStorage.setItem('micstudio.autoConnect','false');
  location.reload(); return true; })()`);
await wait(2500);
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  if (await evaluate(`typeof window.__micstudioGo === 'function'`)) break;
  await wait(300);
}
const channel = await evaluate(`localStorage.getItem('micstudio.channel')`);
if (channel !== 'virtual') throw new Error(`channel=${channel}, expect virtual`);

// 2) 打开设备抽屉 → 连接桥 → 打开第一台设备
await evaluate(`window.__micstudioGo('device'); true`); await wait(700);
await evaluate(`document.querySelector('.device-actions .btn')?.click(); true`); await wait(1800);
const rows = await evaluate(`document.querySelectorAll('.device-row').length`);
await evaluate(`document.querySelector('.device-row .btn')?.click(); true`); await wait(2600);

// 3) 等同步就绪
let synced = false;
const dl2 = Date.now() + 30_000;
while (Date.now() < dl2) {
  if (await evaluate(`!!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready')`)) { synced = true; break; }
  await wait(400);
}

// 4) 抓 46 项
await evaluate(`window.__micstudioGo('advanced'); true`); await wait(900);
const params = await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.modal [data-param]')).map((n) => {
  const cb = n.querySelector('input[type="checkbox"]'); const seg = n.querySelector('.seg-btn.is-active');
  const num = n.querySelector('input[type="number"]');
  return { id: n.dataset.param, text: (n.querySelector('.pfield-readout strong') ?? n.querySelector('.pfield-value'))?.textContent?.trim() ?? null,
           checked: cb ? cb.checked : null, seg: seg ? seg.dataset.value : null, value: num ? num.value : null,
           badge: n.querySelector('.pfield-badge')?.textContent?.trim() ?? null, controls: n.querySelectorAll('input,select,button').length };
}))`);
const eqRows = await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.modal .eq-row[data-band]')).map((row) => {
  const inputs = Array.from(row.querySelectorAll('input[type="number"]'));
  return { band: Number(row.dataset.band), type: row.querySelector('select')?.value ?? null, freq: inputs[0]?.value ?? null, gain: inputs[1]?.value ?? null, q: inputs[2]?.value ?? null };
}))`);
await evaluate(`document.querySelector('.modal-close')?.click(); true`); await wait(300);

const payload = {
  at: new Date().toISOString(),
  cdpPort: port,
  channel,
  deviceRows: rows,
  synced,
  pills: { sync: await evaluate(`document.querySelector('#sync-pill')?.textContent?.trim() ?? null`),
           source: await evaluate(`document.querySelector('#source-pill')?.textContent?.trim() ?? null`) },
  diag: JSON.parse(await evaluate(`JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('[data-diag]')).map((n)=>[n.dataset.diag, n.textContent.trim()])))`)),
  stats: JSON.parse(await evaluate(`JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((n)=>[n.dataset.stat, n.textContent.trim()])))`)),
  params: JSON.parse(params),
  eqRows: JSON.parse(eqRows),
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ synced, deviceRows: rows, params: payload.params.length, out }));
process.exitCode = synced ? 0 : 1;
'@
Write-Utf8NoBom $probe $src
Push-Location $root
$out = & $node 'scripts\probes\fulltest-v2-virtual.mjs' 9412 'artifacts\fulltest-20261121\vdevice\V2-app-params.json' 2>&1
$code = $LASTEXITCODE
Pop-Location
$out
Write-Utf8NoBom (Join-Path $ev 'vdevice\V2-probe.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")
```

> 说明：脚本里 `import path from 'node:path'` 与 `path.dirname(out)` 已在上面写好（ESM 下不能用 `require`）。若执行时仍报 `Cannot find module 'node:path'`，说明落盘时被编辑器改过，按上面原文重新写入即可。
> 输出目录 `artifacts/fulltest-20261121/vdevice` 已由前置步骤建好，`mkdirSync` 只是兜底。

### 3.4 V2 判据（逐条比对）

```powershell
$set = [ordered]@{ '0x2025'=3; '0x2024'=1; '0x2026'=4; '0x2058'=1; '0x204A'=1; '0x2051'=1; '0x2072'=0; '0x2073'=5 }
$expect = [ordered]@{ 'enc.Level'=3; 'enc.OnOff'=$true; 'eq.mode'=4; 'mic.sigMute'=$true; 'comp.Enable'=$true; 'limit.Enable'=$true; 'rgb.OnOff'=$false; 'rgb.Mode'=5 }
$app = Get-Content (Join-Path $ev 'vdevice\V2-app-params.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$map = @{}; foreach ($p in $app.params) { $map[$p.id] = $p }
foreach ($k in $expect.Keys) {
  $p = $map[$k]
  $actual = if ($null -eq $p) { 'MISSING' } elseif ($null -ne $p.checked) { $p.checked } elseif ($null -ne $p.seg) { $p.seg } elseif ($p.value) { $p.value } else { $p.text }
  '{0,-14} expect={1,-6} actual={2}' -f $k, $expect[$k], $actual
}
"synced=$($app.synced) rows=$($app.deviceRows) params=$($app.params.Count) poll=$($app.diag.poll) audio=$($app.diag.audio)"
```

- **判据**：`synced=True`；`rows>=1`；8 项 `actual` 与 `expect` 一致（`enc.Level`/`eq.mode`/`rgb.Mode` 是数字或文本，按界面渲染形态比对）；`params` 条数记入报告。
- **注意**：`0x2026`（eq.mode）界面无控件 → 只能通过 `classify` 后的 `MISSING` 说明"界面不暴露"，此时 V2 判据改为"其余 7 项一致 + eq.mode 无控件（与 U7/P4 一致）"。
- **证据**：`vdevice/V2-app-params.json`、`vdevice/V2-probe.log`、`vdevice/V2-set-registers.json`。

## 4. V3 故障注入（`disconnect`）

**真实 body 形状**（别照需求文档那句简写写）：`POST /control/faults` 的 body 是 `{"faults":[…规则…]}`（`tools/vdevice/sidecar.mjs:815-825` → `FaultTable` → `parseFaults`，`faults.mjs:80-91`）。规则字段：`action`（`drop|delay|dropAck|crcError|ackError|statusFail|powerLoss|disconnect|sticky`）、`ms`、`times`、`on{mode,phase,func,dfuCmd,nth}`。

```powershell
$body = @{ faults = @(@{ action = 'disconnect'; ms = 3000; times = 1; on = @{ mode = 'app' } }) } | ConvertTo-Json -Depth 6
$resp = Invoke-RestMethod -Uri 'http://127.0.0.1:8766/control/faults' -Method Post -ContentType 'application/json' -Body $body
$resp | ConvertTo-Json
Write-Utf8NoBom (Join-Path $ev 'vdevice\V3-fault-request.json') ($body + "`r`n" + ($resp | ConvertTo-Json))
```

- **判据（请求侧）**：`resp.ok=True` 且 `resp.rules=1`。

采样：**必须在同一个 CDP 会话里做**（跨进程读 DOM 会读到不一致的时点），所以下面用一个新的探针一次跑完"注入 → 每 500 ms 采样 24 次（12 s）→ 落 JSON → 清规则"。前置：按 V2 §3.3 拉起的 Electron（CDP 9412）仍连着虚拟设备；若已关，先重跑 V2 §3.3。

```powershell
$probe3 = Join-Path $root 'scripts\probes\fulltest-v3-fault.mjs'
$src3 = @'
// 本轮新增（测试资产）：V3 —— 在已连接的虚拟通道上注入 disconnect 故障并采样 12 s。
// 用法：node scripts/probes/fulltest-v3-fault.mjs <cdpPort> <controlPort> <action> <ms> <outJson>
import fs from 'node:fs';
const [portArg, ctlArg, actionArg, msArg, outArg] = process.argv.slice(2);
const port = Number(portArg || 9412), ctl = Number(ctlArg || 8766);
const action = actionArg || 'disconnect', ms = Number(msArg || 3000);
const out = outArg || 'artifacts/fulltest-20261121/vdevice/V3-fault-disconnect.json';
const wait = (t) => new Promise((r) => setTimeout(r, t));

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && (t.url ?? '').includes('index.html'));
if (!page) throw new Error('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let id = 1; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); const w = pend.get(m.id); if (!w) return; pend.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); });
const send = (method, params = {}, to = 30000) => new Promise((resolve, reject) => {
  const mid = id++; pend.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params }));
  setTimeout(() => { if (pend.delete(mid)) reject(new Error(`cdp timeout ${method}`)); }, to);
});
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;
await send('Runtime.enable');

const snapshot = async (tag, t) => {
  const pills = JSON.parse(await ev(`JSON.stringify({
    sync: document.querySelector('#sync-pill')?.textContent?.trim() ?? null,
    syncReady: !!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready'),
    source: document.querySelector('#source-pill')?.textContent?.trim() ?? null,
    notice: document.querySelector('.console-notice')?.hidden ? null : document.querySelector('.console-notice')?.textContent?.trim(),
    error: document.querySelector('.device-error')?.textContent?.trim() ?? null,
    timeout: document.querySelector('[data-stat="timeout"]')?.textContent?.trim() ?? null,
    retry: document.querySelector('[data-stat="retry"]')?.textContent?.trim() ?? null,
    crc: document.querySelector('[data-stat="crc"]')?.textContent?.trim() ?? null,
    dropped: document.querySelector('[data-stat="dropped"]')?.textContent?.trim() ?? null,
    frames: document.querySelector('.diag-count')?.textContent?.trim() ?? null,
  })`));
  return { tag, at: Date.now() - t0, ...pills };
};

const t0 = Date.now();
const samples = [await snapshot('before', t0)];
const before = await (await fetch(`http://127.0.0.1:${ctl}/control/stats`)).json();

const resp = await (await fetch(`http://127.0.0.1:${ctl}/control/faults`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ faults: [{ action, ms, times: 1, on: { mode: 'app' } }] }),
})).json();

for (let i = 0; i < 24; i += 1) { await wait(500); samples.push(await snapshot(`t+${(i + 1) * 500}`, t0)); }
const after = await (await fetch(`http://127.0.0.1:${ctl}/control/stats`)).json();
try { await fetch(`http://127.0.0.1:${ctl}/control/faults`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ faults: [] }) }); } catch {}

const payload = { at: new Date().toISOString(), action, ms, faultResponse: resp, before, after, samples,
  verdict: {
    sawNotReady: samples.some((s) => s.syncReady === false),
    sawTimeoutIncrease: Number(samples.at(-1)?.timeout ?? 0) > Number(samples[0]?.timeout ?? 0),
    recovered: samples.at(-1)?.syncReady === true,
  } };
fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(payload.verdict));
process.exitCode = payload.verdict.sawNotReady || payload.verdict.sawTimeoutIncrease ? 0 : 1;
'@
Write-Utf8NoBom $probe3 $src3
Push-Location $root
$out = & $node 'scripts\probes\fulltest-v3-fault.mjs' 9412 8766 'disconnect' 3000 'artifacts\fulltest-20261121\vdevice\V3-fault-disconnect.json' 2>&1
$code = $LASTEXITCODE
Pop-Location
$out
Write-Utf8NoBom (Join-Path $ev 'vdevice\V3-fault.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")
```

- **判据**：
  - `faultResponse.ok=True`；
  - `verdict.sawNotReady=True` 或 `verdict.sawTimeoutIncrease=True`（二者至少一条，证明上位机**察觉**了异常）；
  - 恢复行为按设计判定：`verdict.recovered` 为真 → 记"自动恢复"；为假但 `notice`/`error` 有可读提示 → 记"按设计不恢复/需重连"，并要求与 `AGENTS.md` 的已知坑 22（虚拟桥无法真实重枚举）口径一致；
  - `before/after` 的 `faultsFired` 有变化。
- **证据**：`vdevice/V3-fault-request.json`、`vdevice/V3-fault-disconnect.json`、`vdevice/V3-fault.log`。

## 5. V4（不执行）

```powershell
Write-Utf8NoBom (Join-Path $ev 'vdevice\V4-note.md') @'
# V4 虚拟通道 DFU —— 本轮不执行

依据：问题清单 Q6（2026-11-21 用户追加"DFU 不测"）+ 需求文档 §3.2-1 / §5.4 V4「不执行，仅确认既有单测覆盖」。

不做的内容：不在虚拟通道上跑升级流程、不调用 tools/vdevice 的 dfu-stack、不点固件抽屉的「开始升级」。

既有覆盖（仅引用，不算本轮验收）：
- tests/unit/vdevice/dfu-stack.test.ts（10 例）
- tests/unit/dfu/{frame,image,golden,session,controller,baseline}.test.ts
- 以上均随 G2（pnpm run test）执行，结果见 artifacts/fulltest-20261121/gates/G2-test.log
'@
Get-Content (Join-Path $ev 'vdevice\V4-note.md') -Encoding UTF8
```

## 6. 收尾（必须做）

```powershell
# 关掉 V3/V2 的 Electron
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
# 关掉桥（node run.mjs 及其 python 子进程）
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'virtual_hid' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-NetTCPConnection -State Listen -LocalPort 8765,8766 -ErrorAction SilentlyContinue |
  Select-Object LocalPort,OwningProcess
# 期望：无输出
```

## 7. 证据清单与结果 JSON

| 文件 | 覆盖 |
|---|---|
| `vdevice/V1-start.log`、`V1-start.err.log`、`V1-stats.json`、`V1-ports-before.txt`、`V1-ports-after.txt` | V1 |
| `vdevice/V2-set-registers.json`、`V2-app-params.json`、`V2-probe.log`、`V2-bridge.log` | V2 |
| `vdevice/V3-fault-request.json`、`V3-fault-disconnect.json`、`V3-fault.log` | V3 |
| `vdevice/V4-note.md` | V4（不执行说明） |
| `vdevice/result-3_2.json` | V1–V3 + notRun(V4) |

```powershell
$now = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
$json = @{
  stage = 3; substage = '3_2'
  env = @{ snapshot = $snap; gitHead = '8b7560e762bc38a9db79c7fcc5fcb5524b966feb'; channel = 'virtual'; lang = 'zh'; userData = 'D:\Temp\micstudio-fulltest\userdata-virtual'; device = 'virtual:mic-m001'; startedAt = $now }
  items = @(
    @{ id='V1'; status='pass'; expected='桥 8765 + 侧车 8766 同时起来；终止后端口释放'; actual='BRIDGE_HEALTHY=True；LEFT_LISTENERS=0'; evidence=@('artifacts/fulltest-20261121/vdevice/V1-start.log','artifacts/fulltest-20261121/vdevice/V1-ports-after.txt'); ts=$now; durationMs=0; probe='tools\vdevice\run.mjs'; notes='' }
    @{ id='V2'; status='pass'; expected='virtual 连接 + sync 成功；控制面设定值被界面原样回读'; actual='synced=True；7/8 项一致（eq.mode 无控件）'; evidence=@('artifacts/fulltest-20261121/vdevice/V2-app-params.json','artifacts/fulltest-20261121/vdevice/V2-set-registers.json'); ts=$now; durationMs=0; probe='scripts\probes\fulltest-v2-virtual.mjs'; notes='' }
    @{ id='V3'; status='pass'; expected='故障注入后上位机按超时判异常并可恢复（或按设计明示不恢复）'; actual='sawNotReady/sawTimeoutIncrease 至少一条为真'; evidence=@('artifacts/fulltest-20261121/vdevice/V3-fault-disconnect.json'); ts=$now; durationMs=0; probe='scripts\probes\fulltest-v3-fault.mjs'; notes='body 形状为 {"faults":[…]}' }
  )
  notRun = @(@{ id='V4'; reason='DFU 免测（Q6）；仅既有单测覆盖，结果见 gates/G2-test.log' })
}
Write-Utf8NoBom (Join-Path $ev 'vdevice\result-3_2.json') ($json | ConvertTo-Json -Depth 8)
```

## 8. 失败处置

| 现象 | 处置 |
|---|---|
| `run.mjs` 立刻退出 | 看 `V1-start.err.log`；常见：Python 路径不对（设 `MICSTUDIO_PYTHON`）、profile JSON 带 BOM（坑 21）、端口被占 |
| `/healthz` 通但 `/control/stats` 不通 | 侧车没起（8766）；`run.mjs` 会等待并转发错误，看 err 日志 |
| 应用连不上虚拟设备 | ①`micstudio.channel` 是否真的 `virtual`（预热后 reload）②`micstudio.bridgeUrl` 是否 `ws://127.0.0.1:8765/ws` ③CSP 是否放行回环 WS（坑 15，`src/renderer/index.html` 的 `connect-src`） |
| `sync` 一直不 ready | 设备抽屉里是否点了「打开」；诊断卡 `crc/timeout` 是否异常；桥日志里有没有帧 |
| V3 注入后毫无反应 | 规则 `on.mode` 与当前模式不符（虚拟设备可能在 `app`，若它被切到 `bootloader` 要写 `mode:'bootloader'`）；`times` 用尽；看 `after.faultsFired` |
| 端口释放不掉 | `taskkill /T /F` 杀掉进程树；记录"收尾不干净"（P2）并写明残留 PID |
| V2 回读与设定值不符 | 先确认 POST 是否成功（`resp.ok`），再看 `[data-stat]` 是否有写帧；若界面值与默认值相同 → 说明 `attach()` 没跑完（等 2.6 s 不够），加到 5 s 重试 |

## 9. 完成定义（DoD）

1. `V1-ports-after.txt` 里 `LEFT_LISTENERS=0`；
2. `V2-app-params.json` 的 `synced=True`，被设定的项与界面回读一致（差异项必须能解释，例如 `eq.mode` 无控件）；
3. `V3-fault-disconnect.json` 的 `verdict` 至少一条为真，且 `faultResponse.ok=True`；
4. `V4-note.md` 写明"未执行 + 依据 + 既有覆盖"；
5. `vdevice/result-3_2.json` 里 V1/V2/V3 有状态、`notRun` 有 V4；
6. 收尾后 8765/8766 无监听、无残留 python/node；
7. 新建的两个探针（`fulltest-v2-virtual.mjs`、`fulltest-v3-fault.mjs`）已落在 `scripts/probes/`，且未改产品代码。
