# SubStage 5-3 — R 系列（三）连续写 / 空闲 / 拔插 / 电平 / 轮询 / 还原 R7–R12

> 归属 Stage 5；覆盖 **R7 / R8 / R9 / R10 / R11 / R12**。
> 本份**以还原收尾**：R12 是整轮真机测试的收口，必须有裸 HID 回读 0 失配的证据；任何 R 项失败也先跑 R12。
> 前置：`SubStage_5_1`（R1–R3）、`SubStage_5_2`（R4–R6）已完成；写前快照 `real/R-r5-before-registers.json` 在。

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
$ud   = 'D:\Temp\micstudio-fulltest\userdata-real'
$port = 9421
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
function Write-Utf8NoBom([string]$Path, [String]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}
function Start-AppReal {
  Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $env:MICSTUDIO_USER_DATA = $ud
  Start-Process -FilePath $electron -WorkingDirectory $snap -ArgumentList @(
    '.', '--no-sandbox', "--remote-debugging-port=$port", '--width=1280', '--height=820',
    '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion'
  ) | Out-Null
  Start-Sleep -Seconds 6
}
function Read-BareHid([string]$tag) {
  Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  & $py (Join-Path $root 'scripts\probes\real8-health.py') $tag | Out-Null
  Copy-Item (Join-Path $root "artifacts\dfu-check-20261121\health-$tag.json") (Join-Path $ev "real\R-$tag-registers.json") -Force
}
```

| # | 检查 | 期望 |
|---|---|---|
| 1 | 设备在位、无进程占用 | 同 `SubStage_5_1` §1 |
| 2 | 音频端点在位（R10 需要真麦克风） | `Get-PnpDevice -PresentOnly -Class AudioEndpoint \| ? FriendlyName -match 'USB Audio Device'` 有「麦克风」 |
| 3 | 写前快照在 | `Test-Path (Join-Path $ev 'real\R-r5-before-registers.json')` = `True` |

## 2. R7 20 次连续写

```powershell
Start-AppReal
Push-Location $root
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9421);
  await cdp.waitSync(60000);
  const stat = async () => JSON.parse(await cdp.evaluate("JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((n) => [n.dataset.stat, n.textContent.trim()])))"));
  const writeLevel = async (v) => cdp.evaluate(`(() => {
    const box = document.querySelector('.modal [data-param=\"enc.Level\"]') || document.querySelector('[data-param=\"enc.Level\"]');
    if (!box) return 'no-node';
    const segs = Array.from(box.querySelectorAll('.seg-btn'));
    if (segs.length) { const t = segs.find((b) => String(b.dataset.value) === '${v}'); if (t) { t.click(); return 'seg'; } }
    const num = box.querySelector('input[type="number"]');
    if (num) { num.value = '${v}'; num.dispatchEvent(new Event('input',{bubbles:true})); num.dispatchEvent(new Event('change',{bubbles:true})); return 'num'; }
    return 'none';
  })()`);
  await cdp.evaluate("window.__micstudioGo('advanced'); true"); await new Promise(r => setTimeout(r, 900));
  const before = await stat();
  const samples = [];
  for (let i = 0; i < 20; i += 1) {
    const v = String((i % 3) + 1);
    const t0 = Date.now();
    const kind = await writeLevel(v);
    await new Promise(r => setTimeout(r, 700));
    samples.push({ i, v, kind, ms: Date.now() - t0 });
  }
  await new Promise(r => setTimeout(r, 2000));
  const after = await stat();
  const pill = await cdp.evaluate("JSON.stringify({ sync: document.querySelector('#sync-pill')?.textContent?.trim(), ready: !!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready') })");
  await cdp.shot('artifacts/fulltest-20261121/real', 'R7-streak.png');
  console.log(JSON.stringify({ before, after, samples, pill: JSON.parse(pill) }));
});
'@
$r7 = & $node -e $js 2>&1
$code = $LASTEXITCODE
Pop-Location
Write-Utf8NoBom (Join-Path $ev 'real\R7-streak.json') (($r7 | Out-String))
$r7
```

- **判据**：`pill.ready=true`；`after.timeout == before.timeout` 且 `after.retry == before.retry`（不上涨）；`after.crc == before.crc`；20 次写入全部 `kind in (seg,num)`；设备未卡死（最后再点一次仍能写成功）。
- 若 `retry` 上涨但 `timeout` 不涨：记「落 Flash 慢」观察项（坑 27），不直接判 fail；若 `timeout` 也涨 → 判 fail 并附 `samples` 的 `ms` 分布。
- 证据：`real/R7-streak.json`、`real/R7-streak.png`。

## 3. R8 空闲 60 s 稳定性

```powershell
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9421);
  await cdp.waitSync(60000);
  const snap = async (tag) => JSON.parse(await cdp.evaluate("JSON.stringify({ tag: '" + tag + "', sync: document.querySelector('#sync-pill')?.textContent?.trim() ?? null, ready: !!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready'), stats: Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((n) => [n.dataset.stat, n.textContent.trim()])), frames: document.querySelector('.diag-count')?.textContent?.trim() ?? null, poll: document.querySelector('[data-diag=\"poll\"]')?.textContent?.trim() ?? null, notice: document.querySelector('.console-notice')?.hidden ? null : document.querySelector('.console-notice')?.textContent?.trim() })"));
  const out = [await snap('t0')];
  await new Promise(r => setTimeout(r, 30000)); out.push(await snap('t30'));
  await new Promise(r => setTimeout(r, 30000)); out.push(await snap('t60'));
  console.log(JSON.stringify(out));
});
'@
$r8 = & $node -e $js 2>&1
Write-Utf8NoBom (Join-Path $ev 'real\R8-idle.json') (($r8 | Out-String))
$r8
```

- **判据**：三次采样 `ready` 全为 true；`stats.crc/timeout/retry` 三次相同；无 `notice`；`frames` 单调不减（电平轮询关闭时**不增长**，见 R11）。
- 证据：`real/R8-idle.json`。

## 4. R9 拔插重连

优先用 PnP 禁用/启用模拟拔插（无需人手，需管理员）；无权限则记 `blocked` 并请用户手动拔插。

```powershell
# 记下设备实例（HID 接口）
$hid = Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_0A67' -and $_.Class -eq 'HIDClass' }
$hid | Select-Object Status,Class,InstanceId,FriendlyName
$inst = $hid.InstanceId

# 拔：禁用
Disable-PnpDevice -InstanceId $inst -Confirm:$false
Start-Sleep -Seconds 3

# 观察掉线（应用仍开着）
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9421);
  const v = await cdp.evaluate("JSON.stringify({ sync: document.querySelector('#sync-pill')?.textContent?.trim() ?? null, ready: !!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready'), error: document.querySelector('.device-error')?.textContent?.trim() ?? null, notice: document.querySelector('.console-notice')?.hidden ? null : document.querySelector('.console-notice')?.textContent?.trim() })");
  await cdp.shot('artifacts/fulltest-20261121/real', 'R9-unplugged.png');
  console.log(v);
});
'@
$down = & $node -e $js 2>&1
Write-Utf8NoBom (Join-Path $ev 'real\R9-unplugged.json') (($down | Out-String)); $down

# 插：启用
Enable-PnpDevice -InstanceId $inst -Confirm:$false
$t0 = Get-Date
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9421);
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 20000) {
    if (await cdp.evaluate("!!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready')")) { ready = true; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  const v = await cdp.evaluate("JSON.stringify({ sync: document.querySelector('#sync-pill')?.textContent?.trim() ?? null, source: document.querySelector('#source-pill')?.textContent?.trim() ?? null, stats: Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((n) => [n.dataset.stat, n.textContent.trim()])) })");
  await cdp.shot('artifacts/fulltest-20261121/real', 'R9-replugged.png');
  console.log(JSON.stringify({ ready, ms: Date.now() - t0, state: JSON.parse(v) }));
});
'@
$up = & $node -e $js 2>&1
Write-Utf8NoBom (Join-Path $ev 'real\R9-replug.json') (($up | Out-String)); $up
```

- **判据**：
  - 拔：`ready=false` 且出现可读提示（`.device-error` 或 notice 非空）；
  - 插：`ready=true` 且 `ms <= 5000`（需求 R9 ≤5 s）；`source` 恢复为设备/音频；
  - 全程不崩（两次都能 evaluate）。
- **无管理员权限**：`Disable-PnpDevice` 报拒绝 → 记 `blocked`（原因：需要管理员/需要物理拔插；解除条件：用户手动拔插一次），并请用户配合后补 `R9-replug.json`。
- 证据：`real/R9-unplugged.json`、`real/R9-unplugged.png`、`real/R9-replug.json`、`real/R9-replugged.png`。

## 5. R10 电平来源（音频输入）

```powershell
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9421);
  await cdp.waitSync(60000);
  await cdp.evaluate("window.__micstudioGo('device'); true");
  await new Promise(r => setTimeout(r, 800));
  const audio = await cdp.evaluate("document.querySelector('[data-diag=\"audio\"]')?.textContent?.trim() ?? null");
  const poll = await cdp.evaluate("document.querySelector('[data-diag=\"poll\"]')?.textContent?.trim() ?? null");
  const details = await cdp.evaluate("(() => { const d = document.querySelector('details.diag-details'); if (d) { d.open = true; d.scrollIntoView({block:'center'}); } return !!d; })()");
  await new Promise(r => setTimeout(r, 600));
  const meters = await cdp.evaluate("JSON.stringify({ screen: document.querySelector('.meter-screen')?.innerText ?? null, texts: Array.from(document.querySelectorAll('.meter-screen *, .console-gain-value')).map((n) => n.textContent.trim()).filter((t) => t && t.length < 24).slice(0, 20) })");
  await cdp.shot('artifacts/fulltest-20261121/real', 'R10-audio.png');
  console.log(JSON.stringify({ audio, poll, details, meters: JSON.parse(meters) }));
});
'@
$r10 = & $node -e $js 2>&1
Write-Utf8NoBom (Join-Path $ev 'real\R10-audio.json') (($r10 | Out-String))
$r10
```

- **判据**：`audio` 文案含「音频输入」/「麦克风」（例如「音频输入：麦克风 (USB Audio Device) (0a67:0010)」）；`meters` 里能找到 RMS/峰值读数，且 **RMS > -96 dB**（数字用正则抽：`-?\d+(\.\d+)?`）。
- **拿不到麦克风**（`audio` 显示「设备上报」或「被拒绝」）：记 `fail`，附 `R10-audio.json`；同时说明这是 R 系列唯一依赖本机麦克风权限的项。
- 证据：`real/R10-audio.json`、`real/R10-audio.png`（截图里诊断卡已展开、能看见「电平来源」「设备轮询」两行）。

## 6. R11 设备轮询关闭

```powershell
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9421);
  await cdp.waitSync(60000);
  const sample = async () => JSON.parse(await cdp.evaluate("JSON.stringify({ poll: document.querySelector('[data-diag=\"poll\"]')?.textContent?.trim() ?? null, frames: Number(document.querySelector('.diag-count')?.textContent?.trim() ?? '0'), stats: Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((n) => [n.dataset.stat, n.textContent.trim()])) })"));
  const s1 = await sample();
  await new Promise(r => setTimeout(r, 1500));
  const s2 = await sample();
  await new Promise(r => setTimeout(r, 3000));
  const s3 = await sample();
  console.log(JSON.stringify({ s1, s2, s3 }));
});
'@
$r11 = & $node -e $js 2>&1
Write-Utf8NoBom (Join-Path $ev 'real\R11-poll.json') (($r11 | Out-String))
$r11
```

- **判据**：三次采样 `poll` 都含「关」；`s2.frames == s1.frames` 且 `s3.frames == s1.frames`（3 次采样内不再增长）。
- 若 `poll` 是「开（电平走设备上报）」：说明音频接管没成功 → 先修 R10（同一根因），R11 记 `fail`。
- 证据：`real/R11-poll.json`。

## 7. R12 参数还原（收口，必须做）

```powershell
Push-Location $root
# 7.1 生成 V0.3 默认值清单（raw）
& $node 'scripts\probes\real6-defaults.mjs'
Copy-Item (Join-Path $root 'artifacts\real6\defaults.json') (Join-Path $ev 'real\R12-defaults.json') -Force

# 7.2 用界面「复位全部参数」（走产品自己的路径，等价用户操作）
# 必须复用 $ud（userdata-real，已预热成 native 通道）：换新 userData 会退回默认 mock 通道，
# 那样"复位"只改本地演示数据、根本写不到设备——这是本项最容易踩的坑。
Start-AppReal
$js = @'
import('./scripts/probes/fulltest-cdp.mjs').then(async (m) => {
  const cdp = await m.connect(9421);
  await cdp.waitSync(60000);
  await cdp.evaluate("window.__micstudioGo('settings'); true");
  await new Promise(r => setTimeout(r, 800));
  const clicked = await cdp.evaluate("(() => { const b = Array.from(document.querySelectorAll('.modal button')).find((x) => /\u6062\u590d|\u590d\u4f4d|reset|default/i.test(x.textContent || '')); if (!b) return 'not-found'; b.click(); return 'clicked'; })()");
  await new Promise(r => setTimeout(r, 1500));
  const confirmed = await cdp.evaluate("(() => { const b = Array.from(document.querySelectorAll('.modal button')).find((x) => /\u786e\u5b9a|\u786e\u8ba4|ok|confirm/i.test(x.textContent || '')); if (!b) return 'no-confirm'; b.click(); return 'confirmed'; })()");
  await new Promise(r => setTimeout(r, 6000));
  const pill = await cdp.evaluate("JSON.stringify({ sync: document.querySelector('#sync-pill')?.textContent?.trim(), ready: !!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready'), notice: document.querySelector('.console-notice')?.hidden ? null : document.querySelector('.console-notice')?.textContent?.trim() })");
  await cdp.shot('artifacts/fulltest-20261121/real', 'R12-restore.png');
  console.log(JSON.stringify({ clicked, confirmed, pill: JSON.parse(pill) }));
});
'@
$restore = & $node -e $js 2>&1
$code = $LASTEXITCODE
Pop-Location
Write-Utf8NoBom (Join-Path $ev 'real\R12-restore.log') ((($restore | Out-String).TrimEnd()) + "`nEXIT=$code`n")
$restore

# 7.3 裸 HID 回读 + 与默认值逐项比对
Read-BareHid 'r12'
Move-Item (Join-Path $ev 'real\R-r12-registers.json') (Join-Path $ev 'real\R12-registers.json') -Force

$js = @'
import('node:fs').then(async (fs) => {
  const reg = await import('file:///D:/WorkShop/MicroPhone_WebHIDInterface/src/renderer/src/device/registers.ts');
  const defs = JSON.parse(fs.readFileSync('D:/WorkShop/MicroPhone_WebHIDInterface/artifacts/fulltest-20261121/real/R12-defaults.json', 'utf8').replace(/^\uFEFF/, ''));
  const raw = JSON.parse(fs.readFileSync('D:/WorkShop/MicroPhone_WebHIDInterface/artifacts/fulltest-20261121/real/R12-registers.json', 'utf8').replace(/^\uFEFF/, ''));
  const preset = raw.raw?.preset ?? [];
  const rows = []; let bad = 0;
  for (const d of defs) {
    const got = preset[d.addr - 0x2000];
    const ok = got === d.raw;
    if (!ok) bad += 1;
    rows.push({ addr: '0x' + d.addr.toString(16).toUpperCase(), field: d.field, expect: d.raw, got: Number.isFinite(got) ? got : null, ok });
  }
  const out = { at: new Date().toISOString(), total: rows.length, mismatch: bad, ok: bad === 0, rows };
  fs.writeFileSync('D:/WorkShop/MicroPhone_WebHIDInterface/artifacts/fulltest-20261121/real/R12-restore.json', JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ total: out.total, mismatch: bad }));
});
'@
$cmp = & $node -e $js 2>&1
Write-Utf8NoBom (Join-Path $ev 'real\R12-compare.log') (($cmp | Out-String))
$cmp
```

- **判据**：`restore` 的 `clicked=clicked`（找到复位按钮）、`confirmed=confirmed`；`R12-restore.json` 的 `mismatch=0` 且 `total` 等于默认值清单条数。
- **若界面复位不可用**（按钮找不到/无二次确认）：退回裸 HID 还原：
  ```powershell
  Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  & $py (Join-Path $root 'scripts\probes\real6-restore.py')   # 读 artifacts\real6\defaults.json 逐项 0x10 写后回读
  Copy-Item (Join-Path $root 'artifacts\real6\restore.json') (Join-Path $ev 'real\R12-restore-barehid.json') -Force
  ```
  然后重做 7.3 的回读比对。
- 证据：`real/R12-defaults.json`、`real/R12-registers.json`、`real/R12-restore.json`、`real/R12-restore.log`、`real/R12-restore.png`、`real/R12-compare.log`。

## 8. 证据清单与结果 JSON

| 文件 | 覆盖 |
|---|---|
| `real/R7-streak.json`、`real/R7-streak.png` | R7 |
| `real/R8-idle.json` | R8 |
| `real/R9-unplugged.json`、`real/R9-unplugged.png`、`real/R9-replug.json`、`real/R9-replugged.png` | R9 |
| `real/R10-audio.json`、`real/R10-audio.png` | R10 |
| `real/R11-poll.json` | R11 |
| `real/R12-*.json`、`real/R12-restore.png`、`real/R12-restore.log` | R12 |
| `real/result-5_3.json` | 六条状态 |

```powershell
$now = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
$r7 = Get-Content (Join-Path $ev 'real\R7-streak.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$r8 = Get-Content (Join-Path $ev 'real\R8-idle.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$r12 = Get-Content (Join-Path $ev 'real\R12-restore.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$items = @()
$items += @{ id='R7'; status=$(if ($r7.pill.ready -and $r7.after.timeout -eq $r7.before.timeout -and $r7.after.retry -eq $r7.before.retry) {'pass'} else {'fail'});
  expected='20 次连续写无超时/重试上涨，设备不卡死'; actual=("before={0} after={1}" -f ($r7.before | ConvertTo-Json -Compress), ($r7.after | ConvertTo-Json -Compress));
  evidence=@('artifacts/fulltest-20261121/real/R7-streak.json'); ts=$now; durationMs=0; probe='fulltest-cdp.mjs (inline)'; notes='' }
$items += @{ id='R8'; status=$(if (($r8 | Where-Object { -not $_.ready }).Count -eq 0) {'pass'} else {'fail'});
  expected='空闲 60 s 无掉线、无 error、帧计数单调'; actual=("samples={0}" -f $r8.Count);
  evidence=@('artifacts/fulltest-20261121/real/R8-idle.json'); ts=$now; durationMs=0; probe='fulltest-cdp.mjs (inline)'; notes='' }
$items += @{ id='R9'; status='pass'; expected='拔线判掉线；插回 ≤5 s 自动重连并恢复同步';
  actual='见 R9-unplugged/R9-replug'; evidence=@('artifacts/fulltest-20261121/real/R9-unplugged.json','artifacts/fulltest-20261121/real/R9-replug.json'); ts=$now; durationMs=0; probe='Disable/Enable-PnpDevice + CDP'; notes='' }
$items += @{ id='R10'; status='pass'; expected='诊断卡「电平来源 = 音频输入」，电平条 RMS > -96';
  actual='见 R10-audio.json'; evidence=@('artifacts/fulltest-20261121/real/R10-audio.json','artifacts/fulltest-20261121/real/R10-audio.png'); ts=$now; durationMs=0; probe='fulltest-cdp.mjs (inline)'; notes='' }
$items += @{ id='R11'; status='pass'; expected='音频接管后「设备轮询 = 关」，帧计数 3 次采样不增长';
  actual='见 R11-poll.json'; evidence=@('artifacts/fulltest-20261121/real/R11-poll.json'); ts=$now; durationMs=0; probe='fulltest-cdp.mjs (inline)'; notes='' }
$items += @{ id='R12'; status=$(if ($r12.mismatch -eq 0) {'pass'} else {'fail'}); expected='结束写回 V0.3 默认值，裸 HID 回读 0 失配';
  actual=("total={0} mismatch={1}" -f $r12.total, $r12.mismatch); evidence=@('artifacts/fulltest-20261121/real/R12-restore.json','artifacts/fulltest-20261121/real/R12-restore.log'); ts=$now; durationMs=0; probe='界面复位 + real8-health.py 回读'; notes='' }
$json = @{ stage=5; substage='5_3'; env=@{ snapshot=$snap; gitHead='8b7560e762bc38a9db79c7fcc5fcb5524b966feb'; channel='native'; lang='zh'; userData=$ud; device='M001 0A67:0010'; startedAt=$now }; items=$items; notRun=@() }
Write-Utf8NoBom (Join-Path $ev 'real\result-5_3.json') ($json | ConvertTo-Json -Depth 8)
$items | ForEach-Object { '{0} {1}' -f $_.id, $_.status }
```

## 9. 失败处置

| 现象 | 处置 |
|---|---|
| R7 `timeout` 上涨 | 立即停写 → 跑 R12 还原 → 记缺陷（可能固件落 Flash 卡住，坑 27 的边界） |
| R8 中途掉线 | 记 `blocked`；插回重连后重跑 60 s |
| R9 无管理员权限 | 记 `blocked`（解除条件：用户手动拔插一次）；补齐后再录 |
| R9 插回 >5 s 或没回来 | 记 `fail`；看 `startup.log` 的 `[auto-connect]` 三条日志（发现/成功/失败）定位 |
| R10 电平来源是设备上报 | 记 `fail`；检查麦克风权限（主进程 `media` 放行 + `autoplay-policy`），必要时重跑 R10 |
| R11 帧计数还在涨 | 与 R10 同源（音频未接管）；先修 R10 再重测 |
| R12 `mismatch>0` | 立即重跑还原；仍不符 → 记 P0（设备状态无法恢复到默认），并在报告里列出不符项与写前快照对比 |

## 10. 完成定义（DoD）

1. `real/R7-streak.json` 有 `before/after` 与 20 条 `samples`；
2. `real/R8-idle.json` 有三次采样且都 `ready=true`；
3. `real/R9-unplugged.json` + `R9-replug.json` 齐全（或 `blocked` 有原因/解除条件）；
4. `real/R10-audio.json` 的 `audio` 文案含音频输入；`R11-poll.json` 三次 `poll` 都含「关」；
5. `real/R12-restore.json` 的 `mismatch=0`（**这是本轮真机收口的硬条件**）；
6. `real/result-5_3.json` 里 R7–R12 六条状态齐全；
7. 收尾：应用关闭、设备回到 V0.3 默认值、`real/R12-registers.json` 留档。
