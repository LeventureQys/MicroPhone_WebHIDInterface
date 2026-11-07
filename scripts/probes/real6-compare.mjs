// 第六轮真机联调 · 对账脚本：用 registers.ts（唯一真值表）把裸 HID 原始值反算成
// 界面应显示的值，与 real6-app-params.js 抓到的 DOM 显示值逐项比对。
//
//   node --experimental-strip-types scripts/probes/real6-compare.mjs
//
// 输入：artifacts/real6/registers.json（裸 HID）、artifacts/real6/app-params.json（界面）
// 输出：控制台报告 + artifacts/real6/compare.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const registers = await import(pathToFileURL(path.join(root, 'src/renderer/src/device/registers.ts')).href);
const values = await import(pathToFileURL(path.join(root, 'src/renderer/src/domain/values.ts')).href);

const { findRegister, fromRaw, defaultOf, decodeAsciiWords, EQ_BAND_BASE, EQ_BAND_STRIDE, EQ_BAND_COUNT } = registers;
const { formatValue } = values;

const readJson = (file) =>
  JSON.parse(fs.readFileSync(path.join(root, 'artifacts/real6', file), 'utf8').replace(/^\uFEFF/, ''));
const rawFile = process.argv[2] ?? 'registers.json';
const appFile = process.argv[3] ?? 'app-params.json';
const rawJson = readJson(rawFile);
const appJson = readJson(appFile);

const presetBase = 0x2000;
const preset = rawJson.preset ?? [];
const wordAt = (addr) => preset[addr - presetBase];

/** params.ts 的 42 项 id → 地址（与 src/renderer/src/domain/params.ts 的 SEEDS 一致） */
const SEEDS = [
  ['gain.Mic', 0x2023], ['gain.Hp', 0x205a], ['mic.mute', 0x2022], ['mic.sigMute', 0x2058], ['hp.OnOff', 0x2059],
  ['enc.OnOff', 0x2024], ['enc.Level', 0x2025],
  ['eq.mode', 0x2026],
  ['comp.Enable', 0x204a], ['comp.MakeUpGain', 0x204b], ['comp.Threshold', 0x204c], ['comp.Attack', 0x204d],
  ['comp.Release', 0x204e], ['comp.Rate', 0x204f], ['comp.KneeWidth', 0x2050],
  ['limit.Enable', 0x2051], ['limit.Threshold', 0x2053], ['limit.Attack', 0x2054], ['limit.Release', 0x2055],
  ['noisegate.threshold_db', 0x205b], ['noisegate.ratio', 0x205c], ['noisegate.attack_ms', 0x205d],
  ['noisegate.release_ms', 0x205e], ['noisegate.knee_width_db', 0x205f], ['noisegate.hp_freq', 0x2060],
  ['drc3.fc1', 0x2061], ['drc3.fc2', 0x2062],
  ['drc3.low.preGain', 0x2063], ['drc3.low.threshold', 0x2064], ['drc3.low.attackTime', 0x2065],
  ['drc3.low.releaseTime', 0x2066], ['drc3.low.ratio', 0x2067],
  ['drc3.high.preGain', 0x2068], ['drc3.high.threshold', 0x2069], ['drc3.high.attackTime', 0x206a],
  ['drc3.high.releaseTime', 0x206b], ['drc3.high.ratio', 0x206c],
  ['drc3.mid.preGain', 0x206d], ['drc3.mid.threshold', 0x206e], ['drc3.mid.attackTime', 0x206f],
  ['drc3.mid.releaseTime', 0x2070], ['drc3.mid.ratio', 0x2071],
];

const uiById = new Map((appJson.params ?? []).map((item) => [item.id, item]));
const consoleItems = appJson.console ?? {};
const encItem = (consoleItems.switchItems ?? []).find((item) => (item.text ?? '').includes('环境降噪')) ?? {};
const limitItem = (consoleItems.switchItems ?? []).find((item) => (item.text ?? '').includes('防爆音')) ?? {};

const expectSpec = (addr) => {
  const spec = findRegister(addr);
  if (!spec) throw new Error(`register 0x${addr.toString(16)} missing`);
  return spec;
};
const uiText = (spec, raw) => formatValue({ ...spec, default: defaultOf(spec) }, fromRaw(spec, raw));

const rows = [];
const mismatches = [];
for (const [id, addr] of SEEDS) {
  const spec = expectSpec(addr);
  const raw = wordAt(addr);
  const expectedValue = fromRaw(spec, raw);
  let expectedText = null;
  let actualText = null;
  let status = 'n/a';

  if (id === 'enc.OnOff') {
    expectedText = raw === 1 ? 'checked' : 'unchecked';
    actualText = encItem.checked === true ? 'checked' : 'unchecked';
    status = expectedText === actualText ? 'ok' : 'mismatch';
  } else if (id === 'enc.Level') {
    expectedText = String(raw);
    actualText = String(encItem.active ?? '');
    status = expectedText === actualText ? 'ok' : 'mismatch';
  } else {
    const ui = uiById.get(id);
    if (!ui) {
      status = 'missing-ui';
    } else if (ui.checked !== null && ui.checked !== undefined) {
      expectedText = raw === 1 ? 'checked' : 'unchecked';
      actualText = ui.checked ? 'checked' : 'unchecked';
      status = expectedText === actualText ? 'ok' : 'mismatch';
    } else if (ui.seg !== null && ui.seg !== undefined) {
      expectedText = String(raw);
      actualText = String(ui.seg);
      status = expectedText === actualText ? 'ok' : 'mismatch';
    } else if (id === 'limit.Enable' && !ui.text) {
      expectedText = raw === 1 ? 'checked' : 'unchecked';
      actualText = limitItem.checked ? 'checked' : 'unchecked';
      status = expectedText === actualText ? 'ok' : 'mismatch';
    } else {
      expectedText = uiText(spec, raw);
      actualText = ui.text ?? '';
      status = expectedText === actualText ? 'ok' : 'mismatch';
    }
  }

  const row = { id, addr: `0x${addr.toString(16).toUpperCase().padStart(4, '0')}`, field: spec.field, raw, expectedValue, expectedText, actualText, status };
  rows.push(row);
  if (status !== 'ok') mismatches.push(row);
}

// ---- EQ 7 段表 ----
const eqRows = [];
for (const ui of appJson.eqRows ?? []) {
  const band = Number(ui.band);
  for (const field of ['type', 'freq', 'gain', 'q']) {
    const addr = EQ_BAND_BASE + band * EQ_BAND_STRIDE + ['enable', 'type', 'freq', 'gain', 'q'].indexOf(field);
    const spec = expectSpec(addr);
    const raw = wordAt(addr);
    const expected = field === 'type' ? String(raw) : String(fromRaw(spec, raw));
    const actual = String(ui[field]);
    if (Number(expected) !== Number(actual)) {
      eqRows.push({ band, field, addr: `0x${addr.toString(16).toUpperCase()}`, raw, expected, actual });
    }
  }
}

// ---- 信息区 / 配置区 ----
const infoWords = rawJson.info ?? [];
const configWords = rawJson.config ?? [];
const infoText = (addr, words) => decodeAsciiWords(infoWords.slice(addr, addr + words));
const info = {
  model: infoText(0x0000, 3),
  name: infoText(0x0003, 8),
  firmware: `${infoWords[11]}.${infoWords[12]}.${infoWords[13]}.${infoWords[14]}`,
  vid: `0x${infoWords[22].toString(16).toUpperCase().padStart(4, '0')}`,
  pid: `0x${infoWords[23].toString(16).toUpperCase().padStart(4, '0')}`,
  serialRaw: infoWords.slice(0x1e, 0x1e + 32).every((word) => word === 0xffff) ? 'all-0xFFFF' : infoText(0x1e, 32),
  nonZero: infoWords.filter((word) => word !== 0).length,
};
const config = {
  heartbeat: configWords[0], unitAddr: configWords[1], presetCount: configWords[2], startupNo: configWords[3],
  saveNo: configWords[4], loadNo: configWords[5], deleteNo: configWords[6], comErrAck: configWords[7],
  presetValidFlag: wordAt(0x2001), checksum: wordAt(0x2000),
};

// ---- 设备默认值 vs 参数表默认值（只比标量/枚举/字符串行）----
const defaults = [];
for (const spec of registers.REGISTERS) {
  if (spec.region !== 'preset') continue;
  if (spec.access !== 'rw') continue; // 只读项是设备实时值（如 MIC/耳机增益），没有"默认值"语义
  if (spec.kind === 'reserved' || spec.kind === 'checksum' || spec.kind === 'live') continue;
  const raw = wordAt(spec.addr);
  if (raw !== spec.defaultRaw) {
    defaults.push({
      addr: `0x${spec.addr.toString(16).toUpperCase()}`,
      field: spec.field,
      raw,
      tableDefault: spec.defaultRaw,
      engineering: fromRaw(spec, raw),
      tableEngineering: fromRaw(spec, spec.defaultRaw),
    });
  }
}

// ---- 汇总 ----
const summary = {
  params: { total: rows.length, ok: rows.filter((row) => row.status === 'ok').length, mismatches },
  eq: { totalBands: (appJson.eqRows ?? []).length, mismatches: eqRows },
  info,
  config,
  firmwareDiffFromTable: defaults,
  capacity: rawJson.capacity,
  illegal: rawJson.illegal,
  level: rawJson.level,
  unsolicited: rawJson.unsolicited,
  writeLatency: rawJson.writeLatency,
  tableDefaults: {
    model: 'JYM001',
    presetName: 'M001',
    eqFreqs: [0, 1, 2, 3, 4, 5, 6].map((band) => registers.findRegister(EQ_BAND_BASE + band * EQ_BAND_STRIDE + 2)?.defaultRaw),
  },
};
fs.writeFileSync(path.join(root, 'artifacts/real6/compare.json'), JSON.stringify(summary, null, 2), 'utf8');

console.log('== 42 项界面值 ⇄ 寄存器真值 ==');
console.log(`ok ${summary.params.ok}/${summary.params.total}`);
for (const item of mismatches) {
  console.log(`  ✗ ${item.id} @${item.addr} raw=${item.raw} 期望=${item.expectedText} 实际=${item.actualText}`);
}
console.log('== EQ 7 段 ==');
console.log(eqRows.length === 0 ? '  全部一致' : JSON.stringify(eqRows));
console.log('== 信息区 ==');
console.log(info);
console.log('== 配置区 ==');
console.log(config);
console.log(`== 固件默认值 vs 参数表默认值：${defaults.length} 处不一致 ==`);
for (const item of defaults) {
  console.log(`  ${item.addr} ${item.field}: 设备 raw=${item.raw}（${item.engineering}） 表 default=${item.tableDefault}（${item.tableEngineering}）`);
}
console.log('== 容量/非法地址 ==');
console.log(JSON.stringify(summary.capacity));
console.log(JSON.stringify(summary.illegal));
console.log('== 电平 ==', (summary.level ?? []).join(','));
console.log('== 主动上报 ==', JSON.stringify(summary.unsolicited));
console.log('== 写时延 ==', JSON.stringify(summary.writeLatency));
