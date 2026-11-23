/**
 * v1.1.3 全量测试 P 系列：界面参数 / 寄存器真值 / 参数表 V0.3 三方对账。
 *
 * 不是产品代码，也不是单测：直接 import 被测模块（registers.ts / params.ts /
 * scenes.ts / quick-controls.ts），与 openpyxl 导出的参数表 JSON 逐项比对。
 * 由 esbuild 打包后运行：
 *
 *   node <esbuild> scripts/probes/fulltest-p-truth.ts --bundle --format=cjs --platform=node
 *        --outfile=D:\Temp\fulltest\p-truth.cjs
 *   node D:\Temp\fulltest\p-truth.cjs artifacts/fulltest-20261121/gates/param-table-v03.json
 */
import { readFileSync } from 'node:fs';
import {
  PRESET_COUNT,
  REGISTERS,
  defaultOf,
  findRegister,
  fromRaw,
  toRaw,
  type RegisterSpec,
} from '../../src/renderer/src/device/registers';
import { PARAMS } from '../../src/renderer/src/domain/params';
import { SCENES, scenePatch, matchScene } from '../../src/renderer/src/domain/scenes';
import { EQ_PRESETS } from '../../src/renderer/src/domain/quick-controls';

interface Check {
  id: string;
  ok: boolean;
  detail?: unknown;
}

interface XlsxRow {
  sheet: string;
  addr: number;
  row: string[];
}

const checks: Check[] = [];
const mismatches: unknown[] = [];
const labelOnly: unknown[] = [];

function check(id: string, ok: boolean, detail?: unknown): void {
  checks.push({ id, ok, detail });
}

function norm(text: string): string {
  return text
    .replace(/\([^)]*\)/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/[\s\-_/．.]/g, '')
    .toLowerCase();
}

function parseRange(raw: string): { min: number; max: number } | null {
  const match = raw.replace(/\s+/g, '').match(/^[[(]([-\d.]+),([-\d.]+)[\])]$/);
  if (!match) return null;
  return { min: Number(match[1]), max: Number(match[2]) };
}

function num(text: string): number | null {
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : null;
}

function compareRegister(spec: RegisterSpec, row: XlsxRow): void {
  const cells = row.row;
  const xName = `${cells[3] ?? ''}${cells[4] ?? ''}${cells[5] ?? ''}`;
  const xDefault = num(cells[6] ?? '');
  const xRange = parseRange(cells[7] ?? '');
  const xStep = (cells[8] ?? '').trim() === '' ? 1 : num(cells[8]);
  const xUnit = (cells[9] ?? '').trim();
  const xNote = `${cells[10] ?? ''} ${cells[11] ?? ''}`;
  const problems: string[] = [];

  // 名称：只做宽松包含（参数表把模块名/域名拆成 3 列，中文名也常有后缀）
  const nSpec = norm(spec.name);
  const nX = norm(xName);
  if (nSpec && nX && !nSpec.includes(nX) && !nX.includes(nSpec)) problems.push(`name: ${spec.name} != ${xName}`);

  if (xRange) {
    if (spec.min !== xRange.min) problems.push(`min: ${spec.min} != ${xRange.min}`);
    if (spec.max !== xRange.max) problems.push(`max: ${spec.max} != ${xRange.max}`);
  } else if ((cells[7] ?? '').trim() !== '') {
    // [1,N] 这类未定值范围，实现按 0..0xFFFF 兜底
    const rawRange = (cells[7] ?? '').trim();
    const reservedRow = spec.kind === 'reserved' && rawRange === '0';
    if (!reservedRow && !/^\[\d+,[Nn]\]$/.test(rawRange)) problems.push(`range unparsed: ${cells[7]}`);
  }

  // 枚举行的步进在参数表里写 0；registers.ts 对所有枚举统一填 1（RegisterSpec.step 注释：
  // 「枚举与字符串填 1，保留项填 0」）。这是既定解释，不算失配。
  const enumRow = /Type|Mode|Enable|OnOff|MIC|Mute|ValidFlag|Level|DFU|ReInit|Flag/i.test(xName) && xStep === 0;
  if (xStep !== null && spec.step !== xStep && !enumRow) problems.push(`step: ${spec.step} != ${xStep}`);
  if (xUnit !== spec.unit) problems.push(`unit: ${spec.unit} != ${xUnit}`);

  if (spec.kind === 'scalar' || spec.kind === 'live') {
    if (xDefault !== null && spec.defaultRaw !== xDefault) problems.push(`defaultRaw: ${spec.defaultRaw} != ${xDefault}`);
  }

  if (/只读/.test(xNote) && spec.access !== 'r') problems.push(`access: ${spec.access} != r (表内只读)`);
  if (/可读写|读写|readwrite/i.test(xNote) && spec.access !== 'rw') problems.push(`access: ${spec.access} != rw (表内可写)`);

  if (problems.length > 0) {
    const hard = problems.filter((item) => !item.startsWith('name:'));
    if (hard.length > 0) mismatches.push({ addr: `0x${spec.addr.toString(16).toUpperCase()}`, name: spec.name, problems: hard });
    else labelOnly.push({ addr: `0x${spec.addr.toString(16).toUpperCase()}`, name: spec.name, label: xName });
  }
}

function main(): void {
  const tablePath = process.argv[2];
  const table = JSON.parse(readFileSync(tablePath, 'utf8')) as { rows: XlsxRow[] };
  const byAddr = new Map<number, XlsxRow>();
  for (const row of table.rows) byAddr.set(row.addr, row);

  // ---- 结构 ---------------------------------------------------------------
  const info = REGISTERS.filter((item) => item.region === 'info');
  const config = REGISTERS.filter((item) => item.region === 'config');
  const preset = REGISTERS.filter((item) => item.region === 'preset');
  check('寄存器总数 194（信息 62 + 配置 14 + 预设 118）', REGISTERS.length === 194 && info.length === 62 && config.length === 14 && preset.length === 118, {
    total: REGISTERS.length,
    info: info.length,
    config: config.length,
    preset: preset.length,
  });
  check('预设区 118 项且止于 0x2075', PRESET_COUNT === 118 && preset[preset.length - 1]?.addr === 0x2075, {
    count: PRESET_COUNT,
    last: `0x${(preset[preset.length - 1]?.addr ?? 0).toString(16)}`,
  });
  check('界面参数 46 项', PARAMS.length === 46, { count: PARAMS.length });
  check('参数表导出 194 行（62 + 14 + 118）', table.rows.length === 194, { rows: table.rows.length });

  const missingInTable = REGISTERS.filter((item) => !byAddr.has(item.addr)).map((item) => item.addr);
  const missingInCode = table.rows.filter((row) => !findRegister(row.addr)).map((row) => row.addr);
  check('地址集合双向一致（代码 ⇄ 参数表）', missingInTable.length === 0 && missingInCode.length === 0, {
    missingInTable,
    missingInCode,
  });

  const addrSet = new Set(REGISTERS.map((item) => item.addr));
  check('寄存器地址无重复', addrSet.size === REGISTERS.length, { unique: addrSet.size });

  // ---- 逐项对账 -----------------------------------------------------------
  for (const spec of REGISTERS) {
    const row = byAddr.get(spec.addr);
    if (row) compareRegister(spec, row);
  }
  check('寄存器逐项对账（范围/步进/单位/默认值/权限）0 失配', mismatches.length === 0, {
    mismatches: mismatches.length,
    sample: mismatches.slice(0, 12),
    labelOnly: labelOnly.length,
    labelSample: labelOnly.slice(0, 5),
  });

  // ---- 46 项界面参数 ⇄ 寄存器 -------------------------------------------------
  const paramProblems: unknown[] = [];
  for (const param of PARAMS) {
    const spec = findRegister(param.addr);
    if (!spec) {
      paramProblems.push({ id: param.id, problem: 'register missing' });
      continue;
    }
    if (param.min !== spec.min || param.max !== spec.max || param.step !== spec.step) {
      paramProblems.push({ id: param.id, problem: 'range/step drift' });
    }
    if (param.unit !== spec.unit) paramProblems.push({ id: param.id, problem: `unit ${param.unit} != ${spec.unit}` });
    if (Math.abs(param.default - defaultOf(spec)) > 1e-9) paramProblems.push({ id: param.id, problem: 'default drift' });
    if (param.readonly !== (spec.access === 'r')) paramProblems.push({ id: param.id, problem: 'readonly drift' });
  }
  const paramAddrs = new Set(PARAMS.map((item) => item.addr));
  check('46 项界面参数全部命中寄存器且范围/步进/单位/默认值/权限一致', paramProblems.length === 0 && paramAddrs.size === 46, {
    problems: paramProblems,
    uniqueAddrs: paramAddrs.size,
  });

  // ---- V0.3 新增 4 项 ---------------------------------------------------------
  const newAddrs = [0x2072, 0x2073, 0x2074, 0x2075];
  check(
    'V0.3 新增 0x2072–0x2075 既有寄存器也有界面参数',
    newAddrs.every((addr) => findRegister(addr) && PARAMS.some((item) => item.addr === addr)),
    newAddrs.map((addr) => `0x${addr.toString(16)}:${PARAMS.find((item) => item.addr === addr)?.id ?? 'MISSING'}`),
  );

  // ---- P3 标定往返 -----------------------------------------------------------
  const roundtrip: unknown[] = [];
  for (const param of PARAMS) {
    const spec = findRegister(param.addr);
    if (!spec || spec.access === 'r' || spec.step <= 0) continue;
    const samples = [spec.min, (spec.min + spec.max) / 2, spec.max];
    for (const value of samples) {
      const raw = toRaw(spec, value);
      const back = fromRaw(spec, raw);
      const clamped = Math.min(spec.max, Math.max(spec.min, value));
      const expected = Math.min(
        spec.max,
        Math.max(spec.min, spec.min + Math.round((clamped - spec.min) / spec.step - 1e-9) * spec.step),
      );
      const tolerance = Math.max(1e-6, spec.step / 1e6);
      if (Math.abs(back - expected) > tolerance) {
        roundtrip.push({ id: param.id, value, raw, back, expected, delta: back - expected });
      }
    }
  }
  check('P3 标定往返（每项 min/中点/max，按步进量化后误差 ≤ 1e-6）', roundtrip.length === 0, {
    failures: roundtrip.slice(0, 12),
    count: roundtrip.length,
  });

  // ---- P4 只读项 -------------------------------------------------------------
  const readonly = PARAMS.filter((item) => item.readonly).map((item) => item.id);
  check('P4 只读参数恰为 gain.Mic / gain.Hp 两项', readonly.length === 2 && readonly.includes('gain.Mic') && readonly.includes('gain.Hp'), { readonly });

  // ---- P2 默认值 -------------------------------------------------------------
  const defaultProblems: unknown[] = [];
  for (const param of PARAMS) {
    const spec = findRegister(param.addr);
    if (!spec) continue;
    if (Math.abs(param.default - defaultOf(spec)) > 1e-9) defaultProblems.push({ id: param.id, param: param.default, register: defaultOf(spec) });
  }
  check('P2 每项界面默认值 = registers.defaultOf（参数表原始默认值按标定换算）', defaultProblems.length === 0, { problems: defaultProblems });

  // ---- P5 场景 ---------------------------------------------------------------
  const expectOrder = ['quiet', 'meeting', 'podcast', 'sing', 'custom'];
  check('P5 场景顺序 安静房间→会议→播客→唱歌→自定义', SCENES.map((item) => item.id).join(',') === expectOrder.join(','), { order: SCENES.map((item) => item.id) });
  const sceneProblems: unknown[] = [];
  for (const scene of SCENES) {
    const patch = scenePatch(scene, [0, 1, 2, 3, 4, 5, 6]);
    if (patch.gains.length !== 7) sceneProblems.push({ scene: scene.id, problem: `gains=${patch.gains.length}` });
    for (const [id, value] of Object.entries(patch.params)) {
      const param = PARAMS.find((item) => item.id === id);
      if (!param) {
        sceneProblems.push({ scene: scene.id, problem: `unknown param ${id}` });
        continue;
      }
      if (value < param.min || value > param.max) sceneProblems.push({ scene: scene.id, id, value, range: [param.min, param.max] });
    }
    const expectedKeys = [
      'noisegate.threshold_db',
      'noisegate.Enable',
      'comp.Threshold',
      'enc.OnOff',
      'enc.Level',
      'limit.Enable',
      'drc3.Enable',
    ];
    for (const key of expectedKeys) {
      if (!(key in patch.params)) sceneProblems.push({ scene: scene.id, problem: `missing ${key}` });
    }
    // 场景写入后再匹配回来
    const merged: Record<string, number> = { ...patch.params };
    const bands = patch.gains.map((gain, index) => ({
      id: index,
      enabled: (merged['band1.enable'] ?? 1) === 1,
      type: 0,
      freq: [50, 20000, 215, 1000, 2000, 5000, 10000][index],
      gain,
      q: 1,
    }));
    const matched = matchScene(merged, bands, [0, 1, 2, 3, 4, 5, 6], scene.tone);
    if (matched !== scene.id) sceneProblems.push({ scene: scene.id, problem: `matchScene=${matched}` });
  }
  check('P5 五个场景的字段集 / 7 段 EQ / 取值范围 / 反查高亮全部自洽', sceneProblems.length === 0, { problems: sceneProblems });

  // ---- 汇总 -----------------------------------------------------------------
  const failed = checks.filter((item) => !item.ok);
  const summary = { passed: checks.length - failed.length, failed: failed.length, total: checks.length };
  process.stdout.write(
    `${JSON.stringify({ summary, checks, mismatches, params: PARAMS, eqPresets: EQ_PRESETS }, null, 1)}\n`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main();
