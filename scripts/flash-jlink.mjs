/**
 * 用 SEGGER J-Link（SWD）自动整片刷写 M001 MCU：把 hex 直接烧进 QSPI Flash。
 *
 *   node scripts/flash-jlink.mjs --hex "Document/Update/hardware/v0.0.6/JYM001_Firmware_M001 MCU V0.0.6_2026-11-16_Rev0.hex"
 *   node scripts/flash-jlink.mjs --list            # 只列仿真器，不刷
 *
 * 依据：`Document/Update/Alpha/v1.1.0/真机DFU首刷记录.md` §7 ——
 *   · 器件定义来自厂商 `third_party/设备相关/Release/SEGGER/JLink_696`（JinAudio AP5532/AP5540/AP5980）
 *   · 该 hex 是**整片镜像**：0x0000 Bootloader、0x8000 App、0x38000 状态字 `A5 FF 00 00`，烧完直接进 App
 *   · 接线 GND / RESET / TCK / TMS（RESET 可不接），麦克风 USB 供电、仿真器 USB 接电脑
 *
 * 退出码：0 成功 / 2 找不到 JLink.exe 或器件定义 / 3 没插仿真器 / 4 刷写失败
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const artifacts = path.join(repo, 'artifacts', 'jlink');
const temp = 'D:\\Temp';

const CANDIDATE_JLINK = [
  'D:\\Tools\\JLink696\\JLink.exe',
  'C:\\Program Files\\SEGGER\\JLink\\JLink.exe',
  'C:\\Program Files (x86)\\SEGGER\\JLink\\JLink.exe',
  'C:\\Program Files\\SEGGER\\JLink_V696\\JLink.exe',
];

const DEVICES = ['AP5540', 'AP5532', 'AP5980'];

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

function findJLink() {
  const explicit = arg('jlink');
  if (explicit && existsSync(explicit)) return explicit;
  return CANDIDATE_JLINK.find((candidate) => existsSync(candidate)) ?? null;
}

function run(jlink, scriptText, name) {
  mkdirSync(artifacts, { recursive: true });
  const scriptPath = path.join(temp, `jlink-${name}.jlink`);
  writeFileSync(scriptPath, scriptText, 'ascii');
  const started = Date.now();
  const result = spawnSync(jlink, ['-CommanderScript', scriptPath, '-NoGui', '1', '-ExitOnError', '1'], {
    encoding: 'utf8',
    timeout: 300_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(path.join(artifacts, `${name}.log`), output, 'utf8');
  return { output, status: result.status, elapsedMs: Date.now() - started, scriptPath };
}

function listEmulators(jlink) {
  const result = run(jlink, 'ShowEmuList\nexit\n', 'show-emu');
  // 有仿真器时 Commander 会打印 "Serial number:" 行；没有时脚本段里什么都不打
  const hit = /Serial number|USB address|emulators found:\s*[1-9]/i.test(result.output);
  const lines = result.output
    .split(/\r?\n/)
    .filter((line) => /Serial number|USB address|emulators found/i.test(line))
    .map((line) => line.trim());
  return { ...result, lines, present: hit };
}

const jlink = findJLink();
if (!jlink) {
  console.error('[jlink] 找不到 JLink.exe。先跑：');
  console.error('  third_party\\设备相关\\Release\\JLink_Windows_V696.exe /S /D=D:\\Tools\\JLink696');
  console.error('  node scripts/probes/install-jlink-devices.py   # 合并 JinAudio 器件定义');
  process.exit(2);
}
console.log(`[jlink] JLink.exe = ${jlink}`);

const emu = listEmulators(jlink);
console.log(emu.output.trim());
console.log(`[jlink] 仿真器：${emu.lines.length > 0 ? emu.lines.join(' | ') : '未发现'}`);

if (flag('list')) process.exit(0);

if (emu.lines.length === 0) {
  console.error('[jlink] 没有检测到 J-Link 仿真器：请插上 J-Link（USB），并按 GND/RESET/TCK/TMS 接到板子');
  process.exit(3);
}

const hex = path.resolve(repo, arg('hex', 'Document/Update/hardware/v0.0.6/JYM001_Firmware_M001 MCU V0.0.6_2026-11-16_Rev0.hex'));
if (!existsSync(hex)) {
  console.error(`[jlink] hex 不存在：${hex}`);
  process.exit(2);
}
const preferred = arg('device', DEVICES[0]);
const deviceOrder = [preferred, ...DEVICES.filter((item) => item !== preferred)];
const speed = arg('speed', '4000');
const summary = { hex, speed, attempts: [] };

for (const device of deviceOrder) {
  const script = [
    `device ${device}`,
    'si SWD',
    `speed ${speed}`,
    'connect',
    'erase',
    `loadfile "${hex}"`,
    'verify',
    'r',
    'g',
    'exit',
  ].join('\n');
  console.log(`[jlink] 尝试器件 ${device}（SWD ${speed} kHz）…`);
  const attempt = run(jlink, `${script}\n`, `flash-${device}`);
  const ok = /O\.K\.|Script processing completed/i.test(attempt.output) && !/Failed to|ERROR|could not|not found/i.test(attempt.output);
  summary.attempts.push({ device, ok, status: attempt.status, elapsedMs: attempt.elapsedMs, log: `artifacts/jlink/flash-${device}.log` });
  console.log(attempt.output.trim().split(/\r?\n/).slice(-25).join('\n'));
  if (ok) {
    summary.device = device;
    summary.ok = true;
    break;
  }
  console.log(`[jlink] ${device} 不行，换下一个器件定义`);
}

writeFileSync(path.join(artifacts, 'jlink-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
if (!summary.ok) {
  console.error('[jlink] 刷写失败，详见 artifacts/jlink/*.log');
  process.exit(4);
}
console.log(`[jlink] 完成：器件 ${summary.device}，hex ${path.basename(hex)}`);
