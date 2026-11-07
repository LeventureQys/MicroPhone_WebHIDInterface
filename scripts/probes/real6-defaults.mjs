// 生成「参数表默认值」写入清单（rw 的可调项），供 real6-restore.py 用裸 HID 还原设备状态。
//   node --no-warnings scripts/probes/real6-defaults.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const registers = await import(pathToFileURL(path.join(root, 'src/renderer/src/device/registers.ts')).href);

const rows = [];
for (const spec of registers.REGISTERS) {
  if (spec.region !== 'preset') continue;
  if (spec.access !== 'rw') continue;
  if (spec.kind !== 'scalar') continue;
  rows.push({ addr: spec.addr, field: spec.field, raw: spec.defaultRaw });
}

fs.writeFileSync(path.join(root, 'artifacts/real6/defaults.json'), JSON.stringify(rows, null, 2), 'utf8');
console.log(`defaults ${rows.length} 项`);
