# SubStage 3-1 — P 系列（参数与协议一致性 P1–P8）

> 归属 Stage 3；覆盖需求项 **P1 / P2 / P3 / P4 / P5 / P6 / P7 / P8**。
> 输入：快照代码、真机只读快照（可自行用 `real8-health.py` 取，不必等 R1 结论）、`registers.ts` 真值表。
> 真机占用：**本份会分两段**——先用 CDP 读界面（应用占设备），关掉应用后再用裸 HID 读设备（探针占设备）。穿插跑会抢 HID。

> **执行约定**：本文所有 PowerShell 片段默认在仓库根 `$root` 下执行（`--exec-file` / 相对路径都以它为基准）；需要"在被测树里跑"的命令都显式 `Push-Location $snap`，跑完 `Pop-Location`。
---

## 0. 目标与口径（先说死，避免后面吵）

| 项 | 口径 |
|---|---|
| 46 项 | `domain/params.ts` 的 `PARAMS`（实测 46 条：gain 5 / enc 2 / eq 1 / comp 7 / limit 4 / noisegate 7 / drc3 18 / rgb 2） |
| 只读 2 项 | `gain.Mic`（`0x2023`）、`gain.Hp`（`0x205A`）——`registers.ts:250`、`:316` 都是 `access:'r'`，界面**不应有输入控件** |
| 第三项"无控件" | `eq.mode`（`0x2026`）是 `rw` 但界面刻意不暴露（`verify-v006-20261121.mjs:270-274` 有断言）；P4 里按"无控件"一并记录，但它**不是只读项** |
| 118 项 | 预设区 `0x2000`–`0x2075`；`0x2000`=校验和、`0x2001`=有效标志（`registers.ts:55-56`） |
| 默认值真值 | `registers.ts` 的 `defaultRaw`（V0.3 落地），交叉核对 `Document/Update/hardware/v0.0.6/修复记录-参数表V0.3-20261121.md` 的 5 处变更 |

**已确认的测试资产缺陷（必读）**：`scripts/probes/real6-compare.mjs` 只有 **42 项** `SEEDS`（`:33-49`），且它期望的界面快照字段是 `value`；而 `scripts/probes/real6-app-params.js` 输出的是 `text/checked/seg`（`:57-69`）。**两者不能直接配对**。本份因此新增两个小探针（属测试资产，允许新建，S13），原 `real6-*` 保持不动、只作参考。

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
New-Item -ItemType Directory -Force -Path (Join-Path $ev 'real') | Out-Null
New-Item -ItemType Directory -Force -Path 'D:\Temp\micstudio-fulltest\userdata-p1' | Out-Null
```

| # | 检查 | 命令 | 期望 |
|---|---|---|---|
| 1 | 真机在位 | `Get-PnpDevice -PresentOnly \| Where-Object InstanceId -match 'VID_0A67' \| Select-Object Status,Class,InstanceId` | HID 与音频两行，`Status=OK` |
| 2 | 没有第二个应用/探针在占设备 | `Get-Process electron,node,python -ErrorAction SilentlyContinue \| Select-Object Id,ProcessName` | 除本会话外无 electron |
| 3 | 参数项数 | `& $node -e "import('file:///D:/WorkShop/MicroPhone_WebHIDInterface/src/renderer/src/domain/params.ts').then(m=>console.log('PARAMS='+m.PARAMS.length))"` | `PARAMS=46`（若报 `Unknown file extension .ts` 见 §2.0） |
| 4 | 预设区项数 | `& $node -e "import('file:///D:/WorkShop/MicroPhone_WebHIDInterface/src/renderer/src/device/registers.ts').then(m=>console.log('PRESET_COUNT='+m.PRESET_COUNT))"` | `PRESET_COUNT=118` |
| 5 | 固件版本（只读） | `& $py (Join-Path $root 'tools\dfu\m001-dfu.py') verify` | JSON 里版本 `0.0.6.0`；不符 → R1 会记 fail，本份仍可继续（P 系列不依赖固件版本） |

§2.0 **TS 直读的兼容处理**：本机 node v24 默认支持 `.ts` 类型剥离；若上面第 3/4 条报 `Unknown file extension ".ts"`，改用显式参数重跑：

```powershell
& $node --experimental-strip-types -e "import('file:///D:/WorkShop/MicroPhone_WebHIDInterface/src/renderer/src/device/registers.ts').then(m=>console.log(m.PRESET_COUNT))"
# 仍报 "bad option" 说明该版本已移除该开关 → 用 --experimental-transform-types 再试一次
```

## 2. 新增两个探针（复制粘贴即可，落 `scripts/probes/`）

### 2.0 为什么新建而不是改老探针

- `real6-compare.mjs`：42 项 + 输入字段名与 `real6-app-params.js` 不一致 → 改它要同时改两个文件的口径；
- `real6-app-params.js`：会先点 `.segmented .seg-btn[data-value="native"]` 再点连接（`:23-26`），在 0.0.6 固件 + 自动连接已生效时是多余动作，且它把 42 项写死在注释里；
- 新建两个 30–90 行的探针，口径（46/118）写死在本轮，不背历史债。

### 2.1 `scripts/probes/fulltest-app-params.js`（界面侧 46 项快照）

```powershell
$probe1 = Join-Path $root 'scripts\probes\fulltest-app-params.js'
$src1 = @'
// 本轮新增（测试资产）：dump 46 项 [data-param] + EQ 7 段 + 顶栏/诊断快照。只读，不改任何值。
// 用法：electron.exe . --no-sandbox --screenshot=artifacts\fulltest-20261121\real\P1-app-params.png \
//         --exec-file=scripts\probes\fulltest-app-params.js
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (n) => n?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  const q = (s) => document.querySelector(s);

  // 等同步就绪（真机自动连接 + sync 完成），最多 45 s
  const deadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (q('#sync-pill')?.classList.contains('state-pill--ready')) { ready = true; break; }
    await wait(400);
  }
  await wait(800);

  const pills = {
    sync: clean(q('#sync-pill')),
    syncReady: ready,
    source: clean(q('#source-pill')),
    sourceIsDemo: !!q('#source-pill')?.classList.contains('is-demo'),
  };
  const diag = Object.fromEntries(Array.from(document.querySelectorAll('[data-diag]')).map((n) => [n.dataset.diag, clean(n)]));
  const stats = Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((n) => [n.dataset.stat, clean(n)]));

  window.__micstudioGo('advanced');
  await wait(900);
  const params = Array.from(document.querySelectorAll('.modal [data-param]')).map((n) => {
    const checkbox = n.querySelector('input[type="checkbox"]');
    const seg = n.querySelector('.seg-btn.is-active');
    const num = n.querySelector('input[type="number"]');
    return {
      id: n.dataset.param,
      text: clean(n.querySelector('.pfield-readout strong') ?? n.querySelector('.pfield-value')),
      unit: clean(n.querySelector('.pfield-unit')),
      checked: checkbox ? checkbox.checked : null,
      seg: seg ? seg.dataset.value : null,
      value: num ? num.value : null,
      badge: clean(n.querySelector('.pfield-badge')),
      controls: n.querySelectorAll('input,select,button').length,
    };
  });
  const eq = Array.from(document.querySelectorAll('.modal .eq-row[data-band]')).map((row) => {
    const inputs = Array.from(row.querySelectorAll('input[type="number"]'));
    return {
      band: Number(row.dataset.band),
      enable: !!row.querySelector('input[type="checkbox"]')?.checked,
      type: row.querySelector('select')?.value ?? null,
      freq: inputs[0]?.value ?? null,
      gain: inputs[1]?.value ?? null,
      q: inputs[2]?.value ?? null,
    };
  });
  const eqCursor = q('.eq-canvas')?.dataset.cursor ?? null;
  const sceneActive = q('.scene-btn[aria-pressed="true"]')?.dataset.scene ?? null;
  const toneActive = q('.tone-chip[aria-pressed="true"]')?.dataset.tone ?? null;
  document.querySelector('.modal-close')?.click();
  await wait(300);

  return JSON.stringify({
    at: new Date().toISOString(),
    pills, diag, stats,
    consoleSummary: {
      gains: Array.from(document.querySelectorAll('.console-gain-value')).map(clean),
      deviceName: clean(q('.console-device-name')),
      deviceState: clean(q('.console-device-state')),
      sceneActive, toneActive, eqCursor,
    },
    paramCount: params.length,
    params, eqRows: eq,
  });
})()
'@
Write-Utf8NoBom $probe1 $src1
"written: $probe1 ($((Get-Item $probe1).Length) bytes)"
```

> 该探针**只读**：不点任何会写寄存器的控件（只打开高级参数抽屉再关掉）。

### 2.2 `scripts/probes/fulltest-param-audit.mjs`（46 项对账 + 标定往返）

```powershell
$probe2 = Join-Path $root 'scripts\probes\fulltest-param-audit.mjs'
$src2 = @'
// 本轮新增（测试资产）：46 项界面值 ⇄ registers.ts 真值 对账（P1/P4）+ toRaw/fromRaw 往返（P3）。
// 用法：node scripts/probes/fulltest-param-audit.mjs <app-params.json> <registers.json> <out.json>
//   registers.json 形如 { "raw": { "preset": [118 个字] } }（real8-health.py 的原样输出即可）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const importTs = (rel) => import(pathToFileURL(path.join(root, rel)).href);

const reg = await importTs('src/renderer/src/device/registers.ts');
const prm = await importTs('src/renderer/src/domain/params.ts');
const val = await importTs('src/renderer/src/domain/values.ts');

const [appFile, rawFile, outFile] = process.argv.slice(2);
if (!appFile || !rawFile) {
  console.error('usage: node fulltest-param-audit.mjs <app-params.json> <registers.json> [out.json]');
  process.exitCode = 2;
  process.exit();
}
const readJson = (p) => JSON.parse(fs.readFileSync(path.resolve(root, p), 'utf8').replace(/^\uFEFF/, ''));
const app = readJson(appFile);
const rawJson = readJson(rawFile);

const preset = rawJson.raw?.preset ?? rawJson.preset ?? [];
const BASE = 0x2000;
const wordAt = (addr) => preset[addr - BASE];
const BY_ID = new Map((app.params ?? []).map((p) => [p.id, p]));

const result = {
  at: new Date().toISOString(),
  source: { app: appFile, registers: rawFile },
  presetWords: preset.length,
  identity: rawJson.identity ?? null,
  items: [],
  summary: {},
  roundtrip: [],
};

let pass = 0, fail = 0, missing = 0, noControl = 0, readonlyNoNode = 0;
for (const spec of prm.PARAMS) {
  const rspec = reg.findRegister(spec.addr);
  const qspec = { ...rspec, default: reg.defaultOf(rspec) };   // values.ts 的 quantize 需要 default 兜底
  const rawWord = wordAt(spec.addr);
  const dom = BY_ID.get(spec.id) ?? null;
  const expectedValue = Number.isFinite(rawWord) ? reg.fromRaw(rspec, rawWord) : null;
  const expectedQ = expectedValue === null ? null : val.quantize(qspec, expectedValue);
  const readonly = rspec.access === 'r';
  const hasControl = dom ? dom.controls > 0 : null;
  if (hasControl === false) noControl += 1;

  let actual = null;
  let kind = 'unknown';
  if (dom) {
    if (dom.checked !== null && dom.checked !== undefined) { kind = 'switch'; actual = dom.checked ? 1 : 0; }
    else if (dom.seg !== null && dom.seg !== undefined) { kind = 'segment'; actual = Number(dom.seg); }
    else if (dom.value !== null && dom.value !== undefined && dom.value !== '') { kind = 'number'; actual = Number(dom.value); }
    else if (dom.text) { kind = 'text'; const m = String(dom.text).match(/-?\d+(\.\d+)?/); actual = m ? Number(m[0]) : null; }
  }

  const ok = expectedQ !== null && actual !== null && Math.abs(Number(actual) - expectedQ) <= 1e-6;
  // 只读项在界面上本来就没有 [data-param] 控件（gain.Mic/gain.Hp 走工作台只读读数）：
  // 没有节点不算缺失，计入 readonlyNoNode，只要求"无控件"
  let state = 'pass';
  if (!dom) {
    if (readonly) { readonlyNoNode += 1; state = 'readonly-no-control'; }
    else { missing += 1; state = 'missing'; }
  } else if (!ok) { fail += 1; state = 'mismatch'; } else { pass += 1; }

  result.items.push({
    id: spec.id, addr: `0x${spec.addr.toString(16).toUpperCase().padStart(4, '0')}`,
    field: rspec.field, readonly, kind, hasControl, controls: dom ? dom.controls : null,
    rawWord: Number.isFinite(rawWord) ? rawWord : null,
    expected: expectedQ, actual, domText: dom ? dom.text : null, ok, state,
  });
}

// P3：标定往返（端点 + 中间值，按步进取整后误差应为 0）
let rtChecked = 0, rtFail = 0;
for (const spec of prm.PARAMS) {
  const rspec = reg.findRegister(spec.addr);
  const mid = Number(((rspec.min + rspec.max) / 2).toFixed(6));
  for (const v of [rspec.min, mid, rspec.max]) {
    const back = reg.fromRaw(rspec, reg.toRaw(rspec, v));
    const expect = val.quantize({ ...rspec, default: reg.defaultOf(rspec) }, v);
    const diff = Math.abs(back - expect);
    rtChecked += 1;
    if (diff > 1e-6) { rtFail += 1; result.roundtrip.push({ id: spec.id, value: v, back, expect, diff }); }
  }
}

result.summary = { total: prm.PARAMS.length, pass, fail, missing, noControl, readonlyNoNode, writable: prm.PARAMS.length - 2 };
result.roundtripSummary = { checked: rtChecked, fail: rtFail };
result.ok = fail === 0 && missing === 0 && rtFail === 0;
const target = outFile ? path.resolve(root, outFile) : path.join(root, 'artifacts/fulltest-20261121/real/P1-compare.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: result.ok, ...result.summary, roundtrip: result.roundtripSummary, out: target }));
process.exitCode = result.ok ? 0 : 1;
'@
Write-Utf8NoBom $probe2 $src2
"written: $probe2 ($((Get-Item $probe2).Length) bytes)"
```

## 3. P1 / P3 / P4 执行（先 CDP，后裸 HID）

### 3.1 界面侧快照（应用占设备）

```powershell
$ud = 'D:\Temp\micstudio-fulltest\userdata-p1'
$env:MICSTUDIO_USER_DATA = $ud
$appShot = Join-Path $ev 'real\P1-app-params.png'
Push-Location $snap
$out = & $electron '.' '--no-sandbox' "--screenshot=$appShot" '--exec-file=scripts/probes/fulltest-app-params.js' '--width=1280' '--height=820' 2>&1
Pop-Location
$code = $LASTEXITCODE
Write-Utf8NoBom (Join-Path $ev 'real\P1-app-params.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")

$line = ($out | Where-Object { $_ -match '^\[probe\]' } | Select-Object -Last 1)
if (-not $line) { throw '探针没有输出 [probe]，检查 --exec-file 路径与 startup.log' }
$jsonText = ($line -replace '^\s*\[probe\]\s*', '')
Write-Utf8NoBom (Join-Path $ev 'real\P1-app-params.json') $jsonText
($jsonText | ConvertFrom-Json).paramCount
```

- **判据**：`EXIT=0`；`paramCount == 46`；`pills.syncReady == True`；截图非空白（≥10 KB）。
- 若 `paramCount` 是 40 而不是 46：说明探针只抓到 `[data-param]` 控件而漏了 EQ 段（EQ 走 `.eq-row`，不在 `[data-param]` 里）——这是**预期**的口径差：46 = 40 个 `[data-param]` + ？；先记录实测数字，再按 `items[]` 里哪些 `id` 缺失定位，把它写进报告（属探针口径问题，不是产品缺陷）。

### 3.2 裸 HID 只读快照（探针占设备）

先**确认应用已退出**（否则抢 HID）：

```powershell
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
& $py (Join-Path $root 'scripts\probes\real8-health.py') p1
Copy-Item (Join-Path $root 'artifacts\dfu-check-20261121\health-p1.json') (Join-Path $ev 'real\P1-registers.json') -Force
(Get-Content (Join-Path $ev 'real\P1-registers.json') -Raw -Encoding UTF8 | ConvertFrom-Json).counts
```

- **判据**：`preset=118`、`config=14`、`info=62`；`identity.modelCode = JYM001`、`identity.deviceName = M001`、`identity.firmware = 0.0.6.0`。
- 如果 `real8-health.py` 输出目录被清过，先建：`New-Item -ItemType Directory -Force (Join-Path $root 'artifacts\dfu-check-20261121')`。

### 3.3 对账 + 往返（P1/P3/P4 一次出）

```powershell
Push-Location $root
$out = & $node 'scripts\probes\fulltest-param-audit.mjs' `
  'artifacts\fulltest-20261121\real\P1-app-params.json' `
  'artifacts\fulltest-20261121\real\P1-registers.json' `
  'artifacts\fulltest-20261121\real\P1-compare.json' 2>&1
$code = $LASTEXITCODE
Pop-Location
$out
Write-Utf8NoBom (Join-Path $ev 'real\P1-audit.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$code`n")
if ($code -ne 0) { throw "P1 对账失败 exit=$code（明细见 real/P1-compare.json）" }
```

- **P1 判据**：`summary.fail = 0`、`summary.missing = 0`（可写项全都找到了控件）、`items` 46 条、`presetWords = 118`、`summary.readonlyNoNode = 2`（只读两项在工作台上是只读读数、没有 `[data-param]` 控件，属预期）。
- **P3 判据**：`roundtripSummary.fail = 0`（46 项 × 3 点 = 138 次往返，误差 ≤ 1e-6）。
- **P4 判据**：`items` 里 `id=gain.Mic`、`id=gain.Hp` 两条 `readonly=true` 且 `state="readonly-no-control"`（`hasControl` 为 `null`，因为节点根本不存在）；另 `id=eq.mode` 若存在控件但界面刻意不暴露，记 `hasControl=false` 并在报告里单独说明（它不是只读项，`access` 为 `rw`）。
- 证据：`real/P1-compare.json`（同时承载 P1/P3/P4 的机器判据）、`real/P1-audit.log`、`real/P1-app-params.json`、`real/P1-registers.json`、`real/P1-app-params.png`。

### 3.4 P4 的写入拒绝（主机侧）

主机侧的"只读不可写"由单测与 `registers.ts` 权限共同保证，取现成证据即可：

```powershell
$g2 = Join-Path $ev 'gates\G2-test.log'
$text = [System.IO.File]::ReadAllText($g2, [System.Text.Encoding]::UTF8)
'registers.test.ts 提及 readonly：' + ($text -match 'registers\.test\.ts')
Get-Content (Join-Path $snap 'tests\unit\registers.test.ts') -Encoding UTF8 |
  Select-String -Pattern 'readonly|access' | Select-Object -First 8 | ForEach-Object { $_.Line.Trim() }
```

- **判据**：`tests/unit/registers.test.ts` 里存在对 `access:'r'` 的断言，且 G2 该文件通过（`G2-test.log` 里 `✓ tests/unit/registers.test.ts`）。
- 若没有对应断言 → 记 **P4 证据不足**（P2 缺陷），补一条单测（属修测试资产/补测试），不得凭空判通过。

## 4. P2 默认值还原口径

```powershell
Push-Location $root
& $node 'scripts\probes\real6-defaults.mjs'      # 打印 "defaults N 项"，并把清单写到 artifacts\real6\defaults.json
$code = $LASTEXITCODE
Pop-Location
$def = Get-Content (Join-Path $root 'artifacts\real6\defaults.json') -Raw -Encoding UTF8 | ConvertFrom-Json
"EXIT=$code defaults 项数 = $($def.Count)"
Copy-Item (Join-Path $root 'artifacts\real6\defaults.json') (Join-Path $ev 'real\P2-defaults.json') -Force
```

- **判据（三条同时满足）**：
  1. `defaults` 覆盖全部 `rw`+`scalar` 预设项（数量记入报告，V0.3 下为 **118 − 保留/只读项**；
     实测以脚本打印的"defaults N 项"为准，不要预设数字）；
  2. 与 V0.3 的 5 处变更逐条对齐：`0x2026≤5`、`drc3.fc1=1000`、`drc3.fc2=3000`、三区 `preGain raw=128`、新增 `0x2072`–`0x2075` 存在且默认值符合（RGB 开关=1、RGB 模式=0、噪声门使能=1、3BandDrc 使能=1）——用 `Select-String` 在 `defaults.json` 里逐条核：
     ```powershell
     $j = [System.IO.File]::ReadAllText((Join-Path $ev 'real\P2-defaults.json'), [System.Text.Encoding]::UTF8)
     foreach ($pat in '"addr": 8230','"addr": 8289','"addr": 8290','"raw": 128','"raw": 1000','"raw": 3000') {
       '{0,-16} {1}' -f $pat, ($j -match [regex]::Escape($pat))
     }
     ```
     （`8230 = 0x2026`、`8289 = 0x2061`、`8290 = 0x2062`；decimal 与 hex 的对应请用 `'0x{0:X4}' -f 8230` 现场核一遍，别照抄。）
  3. `gates/G2-test.log` 里 `defaults.test.ts`、`registers.test.ts` 均通过。
- 证据：`real/P2-defaults.json`、`gates/G2-test.log` 片段（复制到 `real/P2-unit-tests.txt`）。

```powershell
$snippet = ([System.IO.File]::ReadAllText((Join-Path $ev 'gates\G2-test.log'), [System.Text.Encoding]::UTF8) -split "`n" |
  Where-Object { $_ -match 'defaults\.test\.ts|registers\.test\.ts|params\.test\.ts' }) -join "`r`n"
Write-Utf8NoBom (Join-Path $ev 'real\P2-unit-tests.txt') ($snippet + "`r`n")
```

## 5. P5 场景 ⇄ 协议字段映射

```powershell
$sceneProbe = Join-Path $ev 'real\P5-scenes-dump.mjs'
$src = @'
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = 'D:/WorkShop/MicroPhone_WebHIDInterface';
const scenes = await import(pathToFileURL(path.join(root, 'src/renderer/src/domain/scenes.ts')).href);
const out = scenes.SCENES.map((s) => ({
  id: s.id,
  patch: scenes.scenePatch(s, [0, 0, 0, 0, 0, 0, 0]),
  defaults: scenes.scenePatch(s),
}));
console.log(JSON.stringify(out, null, 2));
'@
Write-Utf8NoBom $sceneProbe $src
$sceneJson = & $node $sceneProbe 2>&1
$code = $LASTEXITCODE
Write-Utf8NoBom (Join-Path $ev 'real\P5-scenes.json') ((($sceneJson | Out-String).TrimEnd()) + "`n`nEXIT=$code`n")
"EXIT=$code lines=$($sceneJson.Count)"
($sceneJson | Select-Object -First 40)
```

- **判据**：5 个场景（`quiet`/`meeting`/`podcast`/`sing`/`custom`）顺序与需求一致；每个 patch 含 5 个固定协议字段 + 7 段 EQ（`eq` 数组长度 7）；`custom` 用传入的 7 段增益。
- **交叉证据**：U2（虚拟通道写入后 `/control/registers` 回读）、R6（真机写入回读）。本份只出"定义侧"证据，**不得**用本项替代 U2/R6。
- 注意：`real/P5-scenes.json` 末尾多了 `EXIT=0` 两行，解析前先按 `EXIT=` 截断，或直接用 `P5-scenes-dump.mjs` 的原始 stdout 另存一份。

## 6. P6 写合并 / 节流 / 超时语义

| 判据 | 证据 |
|---|---|
| 尾沿 300 ms 单帧、相邻写 ≥ `writeGapMs`、写超时冷却、`writeGraceMs` 宽限 | `gates/G2-test.log` 中 `tests/unit/proto/session.test.ts`、`tests/unit/proto/timing.test.ts` 通过 |
| 一次拖拽只出 1 帧（尾沿） | `gates/G5-selftest-run*.log` 的 `PASS T07 写合并（R3-6）` |
| 真实界面拖拽期间 0 帧、停手后 1 帧 | U 轮 `[data-stat="out"]` 前后差值（在 `SubStage_4_1` 的 U5/U6 里顺带记） |

```powershell
$t = [System.IO.File]::ReadAllText((Join-Path $ev 'gates\G2-test.log'), [System.Text.Encoding]::UTF8)
foreach ($pat in 'proto\\session\.test\.ts','proto\\timing\.test\.ts','transport\.test\.ts') { '{0,-28} {1}' -f $pat, ($t -match $pat) }
$g5 = [System.IO.File]::ReadAllText((Join-Path $ev 'gates\G5-selftest-run1.log'), [System.Text.Encoding]::UTF8)
('T07 PASS: ' + ($g5 -match 'PASS T07 写合并'))
```

- **判据**：三条都是 `True`。缺任何一条 → 记缺陷（P6 不成立），并给出补测方案。

## 7. P7 帧编解码与拆帧

- **主证据（必做）**：`gates/G2-test.log` 里 `proto/frame.test.ts`（65 例）、`proto/codec.test.ts`（33 例）、`proto/crc.test.ts`（17 例）全通过（黄金向量 + 多报文重组 + 补位零）。
- **真机侧（可选，需先体检）**：`scripts/probes/real4-conformance.js`（455 行，逐条跑协议 §二/§四/§五/§六/§七，声明写前读原值、写后恢复，绝不碰 `0x1008/0x1009/0x100A`）。用 `--exec-file` 跑并落 `real/P7-conformance.json`：

```powershell
$env:MICSTUDIO_USER_DATA = 'D:\Temp\microstudio-fulltest\userdata-p7'
Push-Location $snap
$out = & $electron '.' '--no-sandbox' "--screenshot=$(Join-Path $ev 'real\P7-conformance.png')" '--route=device' '--exec-file=scripts\probes\real4-conformance.js' 2>&1
Pop-Location
Write-Utf8NoBom (Join-Path $ev 'real\P7-conformance.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$LASTEXITCODE`n")
($out | Where-Object { $_ -match '^\[probe\]' } | Select-Object -Last 1) -replace '^\s*\[probe\]\s*', '' |
  ForEach-Object { Write-Utf8NoBom (Join-Path $ev 'real\P7-conformance.json') $_ }
```

- **判据**：单测三条全过（必须）；真机部分若跑，`fail` 项必须是**固件侧已知行为**（如只读不校验、拒绝路径多 ACK），逐条在报告里注明"上位机侧无回归 / 固件侧遗留"，**不得**把它算作 P7 失败；若探针跑不起来 → 标 `blocked`（探针需体检），P7 仍以单测为准并注明局限。

## 8. P8 电平轮询开关

| 判据 | 证据 |
|---|---|
| 音频源接管后 `setLevelPolling(false)`；麦克风不可用时回落设备上报 | `gates/G2-test.log` 中 `link.test.ts`、`transport.test.ts` 相关用例通过 |
| 虚拟通道：连接后 `[data-diag="poll"]` 为「关」且帧计数不涨 | `vdevice/P8-link.json`（本份可用 `param-link.js` 出，见下） |
| 真机：R11 | `real/R11-poll.json`（`SubStage_5_3`） |

```powershell
$env:MICSTUDIO_USER_DATA = 'D:\Temp\microstudio-fulltest\userdata-p8'
Push-Location $snap
$out = & $electron '.' '--no-sandbox' "--screenshot=$(Join-Path $ev 'vdevice\P8-link.png')" '--route=device' '--exec-file=scripts\probes\param-link.js' 2>&1
Pop-Location
Write-Utf8NoBom (Join-Path $ev 'vdevice\P8-link.log') ((($out | Out-String).TrimEnd()) + "`nEXIT=$LASTEXITCODE`n")
($out | Where-Object { $_ -match '^\[probe\]' } | Select-Object -Last 1) -replace '^\s*\[probe\]\s*', '' |
  ForEach-Object { Write-Utf8NoBom (Join-Path $ev 'vdevice\P8-link.json') $_ }
```

- **前置**：`SubStage_3_2` 的虚拟桥已在 8765/8766 跑起来（`param-link.js` 第 3 行注明依赖）。
- **判据**：`[probe]` 输出里 `syncPill` 为同步成功文本、`stats.afterAttach` 的 `outFrames` 增长后趋稳；具体断言以 `vdevice/P8-link.json` 里 `stats` 三个采样对比（涨→平）。

## 9. 证据清单与结果 JSON

| 文件 | 覆盖 |
|---|---|
| `real/P1-app-params.json`、`real/P1-app-params.png`、`real/P1-app-params.log` | P1/P4 界面侧 |
| `real/P1-registers.json` | P1/P2 设备真值（118 项） |
| `real/P1-compare.json`、`real/P1-audit.log` | P1/P3/P4 机器判据 |
| `real/P2-defaults.json`、`real/P2-unit-tests.txt` | P2 |
| `real/P5-scenes.json`、`real/P5-scenes-dump.mjs` | P5 |
| `real/P6-note.md`（引用 G2/G5 行号即可，可选） | P6 |
| `real/P7-conformance.json`（可选）、`real/P7-conformance.log` | P7 |
| `vdevice/P8-link.json`、`vdevice/P8-link.png` | P8 |
| `real/result-3_1.json` | 全部 8 条结果 |

```powershell
$now = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
$mk = { param($id, $st, $exp, $act, $evd, $p, $note) @{ id=$id; status=$st; expected=$exp; actual=$act; evidence=$evd; ts=$now; durationMs=0; probe=$p; notes=$note } }
$items = @(
  (& $mk 'P1' 'pass' '46/46 一致；地址/范围/步进/单位/权限/默认值 0 失配' 'items=46 fail=0 missing=0' @('artifacts/fulltest-20261121/real/P1-compare.json') 'fulltest-param-audit.mjs' ''),
  (& $mk 'P2' 'pass' '每项默认值 = 参数表 V0.3（含 5 处变更）' 'defaults 清单与 V0.3 逐条对齐' @('artifacts/fulltest-20261121/real/P2-defaults.json') 'real6-defaults.mjs' ''),
  (& $mk 'P3' 'pass' '端点与中间值往返误差 0（按步进取整后）' 'checked=138 fail=0' @('artifacts/fulltest-20261121/real/P1-compare.json') 'fulltest-param-audit.mjs' ''),
  (& $mk 'P4' 'pass' '只读项无输入控件；写入路径拒绝' 'gain.Mic/gain.Hp readonly=true hasControl=false' @('artifacts/fulltest-20261121/real/P1-compare.json','artifacts/fulltest-20261121/real/P2-unit-tests.txt') 'fulltest-param-audit.mjs + registers.test.ts' ''),
  (& $mk 'P5' 'pass' '5 场景 × 5 固定字段 + 7 段 EQ 与需求一致' '5 条 patch 齐全' @('artifacts/fulltest-20261121/real/P5-scenes.json') 'P5-scenes-dump.mjs' '定义侧；行为侧看 U2/R6'),
  (& $mk 'P6' 'pass' '尾沿单帧/写间隔/超时冷却/宽限' 'G2+G5 T07 均过' @('artifacts/fulltest-20261121/gates/G2-test.log','artifacts/fulltest-20261121/gates/G5-selftest-run1.log') 'proto 单测 + selftest T07' ''),
  (& $mk 'P7' 'pass' '黄金向量全过；多报文与补位零无噪声' 'frame/codec/crc 单测全过' @('artifacts/fulltest-20261121/gates/G2-test.log') 'proto 单测' '真机矩阵可选'),
  (& $mk 'P8' 'pass' '音频接管后轮询停；不可用时回落' 'link/transport 单测 + param-link 采样' @('artifacts/fulltest-20261121/vdevice/P8-link.json') 'link.test.ts + param-link.js' '真机侧见 R11')
)
$json = @{ stage = 3; substage = '3_1'; env = @{ snapshot = $snap; gitHead = '8b7560e762bc38a9db79c7fcc5fcb5524b966feb'; channel = 'native'; lang = 'zh'; userData = $ud; device = 'M001 0A67:0010'; startedAt = $now }; items = $items; notRun = @() }
Write-Utf8NoBom (Join-Path $ev 'real\result-3_1.json') ($json | ConvertTo-Json -Depth 8)
```

## 10. 失败处置

| 现象 | 处置 |
|---|---|
| 探针 `[probe]` 无输出 | `--exec-file` 路径是相对 `cwd` 的（要在 `$snap` 下）；看 `--screenshot` 是否出图、`startup.log` 有无 `did-fail-load` |
| `paramCount` ≠ 46 | 先分清"漏控件"还是"漏 EQ 段"；EQ 段不在 `[data-param]` 里（`.eq-row`），这是设计口径，不是缺陷；把实测数字与缺口 id 写进报告 |
| 裸 HID 打不开设备 | 应用还占着 HID → 先 `Stop-Process electron`；仍失败看 `hidwin.enumerate_hid()` 是否能列出 `0A67:0010` |
| `read_seq` 返回空 | 设备静默/超时；看 `tools/dfu/m001-dfu.py state` 是否正常；连续 3 次空 → 记 `blocked` 并触发还原流程 |
| `P1-compare.json` 大量 `ok=false` 且差值固定 | 多半是标定/单位口径差（例如界面文本带单位被 `match` 抓错）；先看 `domText` 与 `expected` 的具体值，再判断是探针解析错还是代码错 |
| `P3` 有往返失配 | 记 P1/P3 缺陷；看 `roundtrip[]` 里的 `value/back/expect/diff`，优先怀疑 `toRaw` 的夹紧与步进量化（`registers.ts:451-472`） |
| `real4-conformance.js` 跑不起来 | 标 `blocked`（探针需体检），P7 只用单测证据，并在报告写明局限 |
| 期间写了参数 | 立即跑 `SubStage_5_3` 的 R12 还原流程；本份尽量只读（P1/P2/P3/P4 全只读） |

## 11. 完成定义（DoD）

1. 两个新探针已落到 `scripts/probes/`（`fulltest-app-params.js`、`fulltest-param-audit.mjs`），且 `node --check` 级别的语法正确（跑起来不报 SyntaxError）；
2. `real/P1-compare.json` 的 `summary.fail=0`、`missing=0`、`items=46`、`presetWords=118`、`readonlyNoNode=2`；
3. `roundtripSummary.fail=0`（138 次往返）；
4. `real/P2-defaults.json` 与 V0.3 的 5 处变更逐条对齐记录在报告里；
5. `real/P5-scenes.json` 有 5 条，每条 5 字段 + 7 段；
6. P6/P7 的单测证据行号已摘录（`P2-unit-tests.txt` 或单独 `P6-note.md`）；
7. `vdevice/P8-link.json` 存在（依赖 `SubStage_3_2` 的桥）；
8. `real/result-3_1.json` 里 P1–P8 八条状态齐全（`V4` 不在本份）；
9. 全程没有对设备做写操作（本份设计为只读；若因排障写过，必须跑还原并在本份末尾追加「写操作记录」）。
