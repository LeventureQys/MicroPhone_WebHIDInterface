/**
 * SubStage 5.3 §4.4：用 SAPI 合成音频级评测 wav（16 kHz / 16 bit / 单声道，前置唤醒词）。
 *
 * ```
 * node tools/voice/eval/make-audio.mjs [--budget 30] [--out artifacts/voice/wav/eval] [--force]
 * ```
 *
 * 为什么走 PowerShell 而不是 `tts.py`
 * ----------------------------------
 * 设计文档 §3.10.1 记录了实测：本机 Python 子进程是 Low 完整性级别，SAPI `Speak()` 抛
 * "没有当前安全设置可用的语音"（2.1 / 4.3 都撞过）。而 `System.Speech` 在**当前用户级别的
 * PowerShell** 里可用（本机实测 `Microsoft Huihui Desktop` 合成成功），所以这里用
 * `powershell.exe -EncodedCommand` 合成：命令行用 base64(UTF-16LE) 传，中文与引号都不会被吞；
 * 待合成文本另存 UTF-8 临时文件，由脚本 `ReadAllText` 读入。
 *
 * 文本 = `小唐小唐，` + holdout 原句（§4.4）。用例挑选见 `holdout.mjs:pickAudioRows`（确定、不随机）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { DEFAULT_HOLDOUT, REPO_ROOT, loadHoldout, pickAudioRows } from './holdout.mjs';

export const WAKE_PREFIX = '小唐小唐，';
export const DEFAULT_BUDGET = 30;
export const DEFAULT_WAV_DIR = path.join(REPO_ROOT, 'artifacts', 'voice', 'wav', 'eval');
export const DEFAULT_VOICE = 'Microsoft Huihui Desktop';

export const EXIT_OK = 0;
export const EXIT_ARGS = 2;
export const EXIT_TTS = 3;

export function parseArgs(argv = []) {
  const options = {
    budget: DEFAULT_BUDGET,
    out: DEFAULT_WAV_DIR,
    force: false,
    holdout: DEFAULT_HOLDOUT,
    voice: DEFAULT_VOICE,
  };
  const takeValue = (index, flag) => {
    const value = argv[index];
    if (value === undefined) throw new Error(`${flag} 需要一个值`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--budget') options.budget = Number.parseInt(takeValue((index += 1), '--budget'), 10);
    else if (arg === '--out') options.out = takeValue((index += 1), '--out');
    else if (arg === '--holdout') options.holdout = takeValue((index += 1), '--holdout');
    else if (arg === '--voice') options.voice = takeValue((index += 1), '--voice');
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isInteger(options.budget) || options.budget < 1) throw new Error('--budget 必须是正整数');
  options.out = path.resolve(options.out);
  return options;
}

/** 找 PowerShell：`MICSTUDIO_PS` → 系统自带 5.1 → PATH 里的 powershell/pwsh（与 voice.cmd 同序） */
export function resolvePowerShell() {
  const candidates = [
    process.env.MICSTUDIO_PS,
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    'pwsh.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) || candidate.includes('/')) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  return null;
}

/** 读 wav 头，确认 16 kHz / 16 bit / 单声道（合成完就校验，别把参数错的 wav 带进评测） */
export function readWavInfo(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE');
  }
  let offset = 12;
  let info = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      info = {
        format: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        rate: buffer.readUInt32LE(offset + 12),
        bits: buffer.readUInt16LE(offset + 22),
      };
    }
    if (id === 'data') {
      const frames = size / Math.max(1, (info?.channels ?? 1) * ((info?.bits ?? 16) / 8));
      return { ...info, bytes: buffer.length, dataBytes: size, durationMs: Math.round((frames / (info?.rate ?? 16000)) * 1000) };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('wav 里没有 data 块');
}

function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * 合成一句：先写 UTF-8 文本文件，再用 `-EncodedCommand` 跑 SAPI 脚本。
 * 返回 `{ok, stderr}`；失败原因原样带回（Low 完整性级别会在这里暴露成"没有可用的语音"）。
 */
export function synthesize({ text, outFile, voice = DEFAULT_VOICE, powerShell = resolvePowerShell(), tmpDir = os.tmpdir() }) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const textFile = path.join(tmpDir, `voice-eval-text-${process.pid}-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(textFile, text, 'utf8');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Speech',
    `$text = [System.IO.File]::ReadAllText('${textFile.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8)`,
    '$syn = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$syn.SelectVoice('${voice.replace(/'/g, "''")}')`,
    '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(' +
      '16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, ' +
      '[System.Speech.AudioFormat.AudioChannel]::Mono)',
    `$syn.SetOutputToWaveFile('${outFile.replace(/'/g, "''")}', $fmt)`,
    '$syn.Speak($text)',
    '$syn.Dispose()',
    'Write-Output OK',
  ].join('\r\n');
  return new Promise((resolve) => {
    const child = spawn(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      try { fs.unlinkSync(textFile); } catch { /* 临时文件删不掉不影响结果 */ }
      resolve({ ok: false, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      try { fs.unlinkSync(textFile); } catch { /* 同上 */ }
      const exists = fs.existsSync(outFile) && fs.statSync(outFile).size > 44;
      resolve({ ok: code === 0 && exists, stdout, stderr, code });
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[make-audio] ${error.message}`);
    return EXIT_ARGS;
  }
  if (options.help) {
    console.log('用法：node tools/voice/eval/make-audio.mjs [--budget 30] [--out artifacts/voice/wav/eval] [--force] [--voice <名字>]');
    return EXIT_OK;
  }
  const powerShell = resolvePowerShell();
  if (!powerShell) {
    console.error('[make-audio] 找不到 PowerShell，无法走 SAPI 合成');
    return EXIT_TTS;
  }

  const holdout = loadHoldout({ file: options.holdout });
  const picked = pickAudioRows(holdout.rows, options.budget);
  fs.mkdirSync(options.out, { recursive: true });

  const manifest = {
    v: 1,
    kind: 'eval-wav-manifest',
    createdAt: new Date().toISOString(),
    source: path.relative(REPO_ROOT, options.holdout).replace(/\\/g, '/'),
    holdoutSha256: holdout.sha256,
    budget: options.budget,
    wakePrefix: WAKE_PREFIX,
    voice: options.voice,
    powerShell,
    cases: [],
  };

  let failed = 0;
  for (const [index, row] of picked.entries()) {
    const outFile = path.join(options.out, `${row.id}.wav`);
    const sentence = `${WAKE_PREFIX}${row.text}`;
    const entry = { id: row.id, kb: row.kb, text: row.text, sentence, wav: path.basename(outFile) };
    if (!options.force && fs.existsSync(outFile) && fs.statSync(outFile).size > 44) {
      entry.reused = true;
    } else {
      const result = await synthesize({ text: sentence, outFile, voice: options.voice, powerShell });
      if (!result.ok) {
        failed += 1;
        entry.error = 'E_TTS';
        entry.detail = String(result.stderr ?? '').split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
        console.error(`[make-audio] ${row.id} 合成失败：${entry.detail || '(无 stderr)'}`);
      }
    }
    if (!entry.error) {
      try {
        const info = readWavInfo(outFile);
        entry.rate = info.rate;
        entry.channels = info.channels;
        entry.bits = info.bits;
        entry.durationMs = info.durationMs;
        entry.bytes = info.bytes;
        if (info.rate !== 16000 || info.channels !== 1 || info.bits !== 16) {
          entry.error = 'E_WAV_FORMAT';
          failed += 1;
        }
      } catch (error) {
        entry.error = 'E_WAV';
        entry.detail = error.message;
        failed += 1;
      }
    }
    manifest.cases.push(entry);
    if ((index + 1) % 5 === 0 || index + 1 === picked.length) {
      console.error(`[make-audio] ${index + 1}/${picked.length} 条（失败 ${failed}）`);
    }
  }

  const ok = manifest.cases.filter((item) => !item.error);
  manifest.ok = ok.length;
  manifest.failed = failed;
  manifest.totalMs = ok.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
  const manifestFile = path.join(options.out, 'manifest.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(
    `[make-audio] ${ok.length}/${manifest.cases.length} 条就绪，失败 ${failed} 条，平均 ` +
      `${ok.length ? Math.round(manifest.totalMs / ok.length) : 0} ms/条`,
  );
  console.log(`[make-audio] 清单：${path.relative(REPO_ROOT, manifestFile).replace(/\\/g, '/')}`);
  if (ok.length === 0) {
    console.error('[make-audio] 一条都没合成出来：SAPI 在本机不可用（原因见每条 error.detail）');
    return EXIT_TTS;
  }
  return EXIT_OK;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`[make-audio] 未捕获异常：${error?.stack ?? error}`);
    process.exit(1);
  });
}
