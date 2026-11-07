// 第六轮真机联调 · 写入对账：界面写入值 → 寄存器表换算 raw → 与裸 HID 回读比对。
//   node --no-warnings scripts/probes/real6-compare-writes.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const registers = await import(pathToFileURL(path.join(root, 'src/renderer/src/device/registers.ts')).href);
const { findRegister, toRaw } = registers;

const readJson = (file) =>
  JSON.parse(fs.readFileSync(path.join(root, 'artifacts/real6', file), 'utf8').replace(/^\uFEFF/, ''));

const app = readJson('app-write.json');
const raw = readJson('verify-writes.json');
const preset = raw.preset ?? [];
const wordAt = (addr) => preset[addr - 0x2000];

const rows = [];
for (const write of app.writes ?? []) {
  const addr = Number.parseInt(write.addr, 16);
  const spec = findRegister(addr);
  if (!spec) {
    rows.push({ ...write, status: 'missing-register' });
    continue;
  }
  // 写入被 UI 量化后的工程量 → 期望原始值（toRaw 对标量/布尔/枚举都适用：scale=raw 时只做夹紧与取整）
  const expectedRaw = toRaw(spec, write.to);
  const actualRaw = wordAt(addr);
  rows.push({
    id: write.id,
    addr: write.addr,
    field: spec.field,
    control: write.control,
    from: write.from,
    to: write.to,
    expectedRaw,
    actualRaw,
    status: expectedRaw === actualRaw ? 'ok' : 'mismatch',
  });
}

const failures = rows.filter((row) => row.status !== 'ok');
console.log(`== 42 项写入 → 裸 HID 回读：ok ${rows.length - failures.length}/${rows.length} ==`);
for (const row of rows) {
  const mark = row.status === 'ok' ? '✓' : '✗';
  console.log(`  ${mark} ${row.id.padEnd(26)} ${row.addr} ${String(row.from).padStart(7)} → ${String(row.to).padEnd(7)} raw 期望 ${row.expectedRaw} / 实测 ${row.actualRaw}`);
}

const readOnly = app.readOnly ?? [];
console.log('== 只读项（应无控件、不发帧）==');
for (const item of readOnly) {
  const addr = Number.parseInt(item.addr, 16);
  console.log(`  ${item.id} @${item.addr}: controls=${item.controls} raw=${wordAt(addr)}`);
}

const summary = { total: rows.length, ok: rows.length - failures.length, failures, rows, readOnly };
fs.writeFileSync(path.join(root, 'artifacts/real6/compare-writes.json'), JSON.stringify(summary, null, 2), 'utf8');
if (failures.length > 0) process.exitCode = 2;
