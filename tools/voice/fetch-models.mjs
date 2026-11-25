// 语音链路资产下载器：按 manifest.json 把模型与预编译二进制落到 tools/voice/models/，并校验 SHA256。
// 只用 Node 内置模块：本仓不因下载器引入 npm 依赖（见 SubStage_1.1 §8）。
// 用法见 SubStage_1.1 §4.2：默认「缺什么下什么」，--check 只校验，--record 写回实测哈希，--only 只处理一项。

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** tools/voice/ 目录（manifest.json 所在处）。 */
export const VOICE_ROOT = HERE;
export const MANIFEST_PATH = path.join(HERE, 'manifest.json');

// 7 个资产约 7.5 GB；下载前留出余量，避免下到一半盘满（SubStage_1.1 §5）。
const MIN_FREE_BYTES = 9 * 1024 ** 3;
const REDIRECT_LIMIT = 5;
const PROGRESS_INTERVAL_MS = 5000;
const USER_AGENT = 'micstudio-voice-fetch/1.0';

/** 读取清单。JSON 非法直接抛，不做兜底（SubStage_1.1 §5）。 */
export function readManifestFile(file = MANIFEST_PATH) {
  const text = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(text);
  if (!doc || !Array.isArray(doc.assets)) {
    throw new Error(`${file} 缺少 assets 数组`);
  }
  return doc;
}

/** 清单落盘格式：保持字段顺序、2 空格缩进、UTF-8 无 BOM（SubStage_1.1 §4.2）。 */
export function serializeManifest(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function writeManifestFile(file, doc) {
  fs.writeFileSync(file, serializeManifest(doc), 'utf8');
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** 解包类资产的归档扩展名；extract === 'none' 时返回 null（dest 就是文件本身）。 */
function archiveExt(asset) {
  if (asset.extract === 'zip') return '.zip';
  if (asset.extract === 'tar.bz2') return '.tar.bz2';
  return null;
}

/**
 * 资产在磁盘上的落点。
 * - extract === 'none'：dest 是文件。
 * - 解包类：dest 是目录，原归档留一份在 models/.cache/ 供 --check 复验 SHA256。
 */
export function assetLayout(voiceRoot, asset) {
  const dest = path.resolve(voiceRoot, asset.dest);
  const ext = archiveExt(asset);
  if (!ext) return { kind: 'file', dest, cache: null };
  return { kind: 'dir', dest, cache: path.join(voiceRoot, 'models', '.cache', `${asset.id}${ext}`) };
}

export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function dirHasFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else return true;
    }
  }
  return false;
}

/** 用「字节数 + SHA256」判定一个文件是否合格；清单里没记录的那一项跳过。 */
async function verifyFile(asset, file, { log = () => {} } = {}) {
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing', detail: `文件不存在（${file}）`, bytes: null, sha256: null };
  const bytes = fs.statSync(file).size;
  const actual = await sha256File(file);
  const expectedSha = (asset.sha256 || '').toLowerCase();
  if (asset.size !== null && asset.size !== undefined && bytes !== asset.size) {
    const detail = `size 不匹配（期望 ${asset.size} B，实际 ${bytes} B）`;
    log(`size  ${asset.id}  ${formatBytes(bytes)}  ${detail}`);
    return { ok: false, reason: 'size', detail, bytes, sha256: actual };
  }
  if (expectedSha && actual !== expectedSha) {
    const detail = `sha256 不匹配（期望 ${expectedSha}，实际 ${actual}）`;
    return { ok: false, reason: 'sha256', detail, bytes, sha256: actual };
  }
  if (!expectedSha) {
    log(`  注意：${asset.id} 的 sha256 尚未记录（第一次跑用 --record 写入）`);
  }
  return { ok: true, reason: 'ok', detail: '', bytes, sha256: actual };
}

/** 单项校验：解包类要同时验归档（size/sha256）与解包目录非空。 */
export async function checkAsset(voiceRoot, asset, { log = () => {} } = {}) {
  const layout = assetLayout(voiceRoot, asset);
  if (layout.kind === 'file') {
    return verifyFile(asset, layout.dest, { log });
  }
  if (!fs.existsSync(layout.cache)) {
    return { ok: false, reason: 'missing', detail: `归档不存在（${layout.cache}）`, bytes: null, sha256: null };
  }
  const archive = await verifyFile(asset, layout.cache, { log });
  if (!archive.ok) return archive;
  if (!dirHasFiles(layout.dest)) {
    return {
      ok: false,
      reason: 'missing',
      detail: `解包目录不存在或为空（${layout.dest}）`,
      bytes: archive.bytes,
      sha256: archive.sha256,
    };
  }
  return archive;
}

function selectAssets(doc, only) {
  if (!only || only.length === 0) return doc.assets.slice();
  const wanted = new Set(only);
  for (const id of wanted) {
    if (!doc.assets.some((asset) => asset.id === id)) throw new Error(`未知资产 id：${id}`);
  }
  const picked = doc.assets.filter((asset) => wanted.has(asset.id));
  if (picked.length !== wanted.size) throw new Error(`资产 id 重复：${only.join(', ')}`);
  return picked;
}

/**
 * 逐项校验并打印一行一项：
 *   ok  llama-cpp  23.9 MB  sha256 匹配
 * 退出码语义见 SubStage_1.1 §4.2：0 全好 / 2 有缺。
 */
export async function checkAssets({ voiceRoot = HERE, doc = readManifestFile(), only = [], log = console.log } = {}) {
  const assets = selectAssets(doc, only);
  const results = [];
  for (const asset of assets) {
    const result = await checkAsset(voiceRoot, asset, { log });
    result.id = asset.id;
    results.push(result);
    const size = formatBytes(result.bytes);
    if (result.ok) {
      log(`ok  ${asset.id}  ${size}  sha256 匹配`);
    } else if (result.reason === 'missing') {
      log(`missing  ${asset.id}  ${size}  ${result.detail}`);
    } else if (result.reason === 'size') {
      log(`size  ${asset.id}  ${size}  ${result.detail}`);
    } else {
      log(`sha256  ${asset.id}  ${size}  ${result.detail}`);
    }
  }
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    log(`校验失败：${failed.length} 项（${failed.map((result) => result.id).join(', ')}）`);
    return { code: 2, results };
  }
  log(`校验通过：${results.length} 项资产全部就绪`);
  return { code: 0, results };
}

function openStream(url, redirectsLeft = REDIRECT_LIMIT) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(
      url,
      { headers: { 'user-agent': USER_AGENT, accept: '*/*', 'accept-encoding': 'identity' } },
      (response) => {
        const status = response.statusCode || 0;
        const location = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('重定向次数过多'));
            return;
          }
          openStream(new URL(location, url).toString(), redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        resolve(response);
      },
    );
    request.setTimeout(60000, () => request.destroy(new Error('连接超时（60 s 没有响应）')));
    request.on('error', reject);
  });
}

/** 单流下载到 <file>.part，长度对得上才改名；失败保留不了半包。 */
export async function downloadFile(url, file, { log = console.log } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.part`;
  const response = await openStream(url);
  const total = Number(response.headers['content-length'] || 0);
  const startedAt = Date.now();
  let received = 0;
  let markAt = startedAt;
  let markBytes = 0;
  response.on('data', (chunk) => {
    received += chunk.length;
    const now = Date.now();
    if (now - markAt >= PROGRESS_INTERVAL_MS) {
      const speed = (received - markBytes) / ((now - markAt) / 1000);
      log(`  进度 ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ''}  ${formatBytes(speed)}/s`);
      markAt = now;
      markBytes = received;
    }
  });
  try {
    await pipeline(response, fs.createWriteStream(part));
  } catch (error) {
    fs.rmSync(part, { force: true });
    throw error;
  }
  if (total && received !== total) {
    fs.rmSync(part, { force: true });
    throw new Error(`下载不完整（期望 ${total} B，实际 ${received} B）`);
  }
  fs.renameSync(part, file);
  return { bytes: received, ms: Date.now() - startedAt };
}

function tarExecutable() {
  const candidate = path.join(process.env.SystemRoot || 'C:\\Windows', 'system32', 'tar.exe');
  return fs.existsSync(candidate) ? candidate : 'tar';
}

function runTar(args) {
  const result = spawnSync(tarExecutable(), args, { stdio: 'inherit', windowsHide: true });
  return result.status === 0;
}

function expandZipFallback(archive, destDir) {
  // bsdtar 认不出的 zip（少见）回退到 PowerShell 的 Expand-Archive。
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  const script = `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destDir)} -Force`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { stdio: 'inherit', windowsHide: true },
  );
  return result.status === 0;
}

function moveEntry(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  try {
    fs.renameSync(from, to);
  } catch {
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * tar.bz2 解包会多一层同名目录，必须拍平到 models/kws/（SubStage_1.1 §4.2）。
 * 只有「唯一顶层且是目录」时才剥掉它，避免把 zip 根级散文件误当一层。
 */
export function flattenSingleRootDir(sourceDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const roots = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.name !== '__MACOSX' && entry.name !== '.DS_Store');
  const base = roots.length === 1 && roots[0].isDirectory() ? path.join(sourceDir, roots[0].name) : sourceDir;
  for (const name of fs.readdirSync(base)) {
    moveEntry(path.join(base, name), path.join(destDir, name));
  }
}

async function extractAsset(voiceRoot, asset, layout, { log = console.log } = {}) {
  const scratch = `${layout.dest}.extract-${process.pid}`;
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  try {
    log(`  解压 ${path.basename(layout.cache)} -> ${path.relative(voiceRoot, layout.dest)}`);
    if (asset.extract === 'tar.bz2') {
      if (!runTar(['-x', '-f', layout.cache, '-C', scratch])) throw new Error(`解压失败：${layout.cache}`);
      flattenSingleRootDir(scratch, layout.dest);
      return;
    }
    const ok = runTar(['-x', '-f', layout.cache, '-C', scratch]) || expandZipFallback(layout.cache, scratch);
    if (!ok) throw new Error(`解压失败：${layout.cache}`);
    flattenSingleRootDir(scratch, layout.dest);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function downloadWithFallback(asset, target, { log = console.log, verify = true } = {}) {
  const sources = [asset.url];
  if (asset.mirror) sources.push(asset.mirror); // mirror === null 时不重试（SubStage_1.1 §4.2）
  for (const source of sources) {
    log(`  下载 ${asset.id}  <- ${source}`);
    try {
      const { bytes, ms } = await downloadFile(source, target, { log });
      const verified = verify ? await verifyFile(asset, target, { log }) : { ok: true, sha256: await sha256File(target) };
      if (!verified.ok) {
        fs.rmSync(target, { force: true });
        log(`校验失败：${asset.id}（期望 ${asset.sha256 || '未记录'}，实际 ${verified.sha256}）`);
        return false;
      }
      log(`  下载完成 ${formatBytes(bytes)}  用时 ${(ms / 1000).toFixed(1)} s`);
      return true;
    } catch (error) {
      log(`  ${source} 失败：${error.message}`);
    }
  }
  log(`下载失败：${asset.id} ${asset.url}`);
  return false;
}

/**
 * 缺什么下什么：先验已有归档/文件，不合格重下，解包类再补解压。
 * verify=false 供 --record 用：清单里的 size/sha256 正是要被实测值覆盖的对象，不能拿它卡自己。
 */
export async function ensureAsset(voiceRoot, asset, { log = console.log, verify = true } = {}) {
  const layout = assetLayout(voiceRoot, asset);
  const payload = layout.kind === 'file' ? layout.dest : layout.cache;
  let ready = false;
  if (fs.existsSync(payload)) {
    if (verify) {
      const verified = await verifyFile(asset, payload, { log });
      ready = verified.ok;
      if (!ready) {
        log(`  校验不合格，重新下载：${asset.id}`);
        fs.rmSync(payload, { force: true });
      }
    } else {
      ready = true;
    }
  }
  if (!ready) {
    ready = await downloadWithFallback(asset, payload, { log, verify });
    if (!ready) return false;
  }
  if (layout.kind === 'dir' && !dirHasFiles(layout.dest)) {
    await extractAsset(voiceRoot, asset, layout, { log });
  }
  if (fs.existsSync(payload) && (layout.kind === 'file' || dirHasFiles(layout.dest))) {
    log(`ok  ${asset.id}  ${path.relative(voiceRoot, layout.kind === 'file' ? layout.dest : layout.cache)}`);
    return true;
  }
  log(`下载失败：${asset.id} ${asset.url}`);
  return false;
}

function hasFreeSpace(root, { log = console.log } = {}) {
  const probe = path.join(root, 'models');
  fs.mkdirSync(probe, { recursive: true });
  const stats = fs.statfsSync(probe);
  const free = Number(stats.bavail) * Number(stats.bsize);
  if (free < MIN_FREE_BYTES) {
    log(`磁盘空间不足：${path.parse(probe).root} 只剩 ${formatBytes(free)}，需要 ≥ 9 GB（SubStage_1.1 §5）`);
    return false;
  }
  return true;
}

function needsFetch(voiceRoot, assets) {
  return assets.some((asset) => {
    const layout = assetLayout(voiceRoot, asset);
    if (layout.kind === 'file') return !fs.existsSync(layout.dest);
    return !fs.existsSync(layout.cache) || !dirHasFiles(layout.dest);
  });
}

/** 下载后把实测 size/sha256 写回 manifest.json（SubStage_1.1 §4.2）。 */
export async function recordAssets({
  voiceRoot = HERE,
  manifestPath = MANIFEST_PATH,
  doc = readManifestFile(manifestPath),
  only = [],
  log = console.log,
} = {}) {
  const assets = selectAssets(doc, only);
  let failed = 0;
  for (const asset of assets) {
    const done = await ensureAsset(voiceRoot, asset, { log, verify: false });
    if (!done) {
      failed += 1;
      continue;
    }
    const layout = assetLayout(voiceRoot, asset);
    const payload = layout.kind === 'file' ? layout.dest : layout.cache;
    const bytes = fs.statSync(payload).size;
    const sha256 = await sha256File(payload);
    asset.size = bytes;
    asset.sha256 = sha256;
    log(`record  ${asset.id}  ${bytes} B  ${sha256}`);
  }
  writeManifestFile(manifestPath, doc);
  log(`写回 ${path.relative(process.cwd(), manifestPath) || manifestPath}`);
  return failed;
}

function parseArgs(args) {
  let mode = 'fetch';
  const only = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--check') mode = 'check';
    else if (arg === '--record') mode = 'record';
    else if (arg === '--help' || arg === '-h') mode = 'help';
    else if (arg === '--only') {
      const value = args[index + 1];
      if (!value) throw new Error('--only 需要一个资产 id');
      only.push(value);
      index += 1;
    } else if (arg.startsWith('--only=')) {
      const value = arg.slice('--only='.length);
      if (!value) throw new Error('--only 需要一个资产 id');
      only.push(value);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (mode === 'check' && args.includes('--record')) throw new Error('--check 与 --record 不能同时使用');
  return { mode, only };
}

function printUsage(log) {
  log('用法：node tools/voice/fetch-models.mjs [--check | --record] [--only <id>]');
  log('  无参数    缺什么下什么（先 url，失败再 mirror），下完解包，最后逐项校验');
  log('  --check   只校验：存在 / 字节数 / SHA256');
  log('  --record  下载后把实测 size 与 sha256 写回 manifest.json');
  log('  --only id 只处理一个资产（可重复）');
}

export async function main(argv = process.argv, { voiceRoot = HERE, manifestPath = MANIFEST_PATH, log = console.log } = {}) {
  const args = argv.slice(2);
  const { mode, only } = parseArgs(args);
  if (mode === 'help') {
    printUsage(log);
    return 0;
  }
  const doc = readManifestFile(manifestPath);

  if (mode === 'check') {
    const { code } = await checkAssets({ voiceRoot, doc, only, log });
    return code;
  }

  if (mode === 'record') {
    log(`记录实测 size/sha256 -> ${manifestPath}`);
    const failed = await recordAssets({ voiceRoot, manifestPath, doc, only, log });
    const { code } = await checkAssets({ voiceRoot, doc: readManifestFile(manifestPath), only, log });
    return failed > 0 || code !== 0 ? 2 : 0;
  }

  const assets = selectAssets(doc, only);
  if (needsFetch(voiceRoot, assets) && !hasFreeSpace(voiceRoot, { log })) return 2;
  let failed = 0;
  for (const asset of assets) {
    const startedAt = Date.now();
    const done = await ensureAsset(voiceRoot, asset, { log });
    if (!done) {
      failed += 1;
      continue;
    }
    log(`  用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
  }
  const { code } = await checkAssets({ voiceRoot, doc, only, log });
  return failed > 0 || code !== 0 ? 2 : 0;
}

const invokedFromCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedFromCli) {
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[fetch-models] ${error.message || String(error)}`);
      process.exitCode = 2;
    });
}
