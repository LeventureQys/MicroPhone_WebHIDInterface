/**
 * 数据构建总入口（SubStage 5.1）：核心句 → 教师改写 → 质检分集 → manifest。
 *
 * ```powershell
 * node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *   --import ./tools/voice/register-loader.mjs tools/voice/datagen/build.mjs --cores-only
 * node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *   --import ./tools/voice/register-loader.mjs tools/voice/datagen/build.mjs --per-core 8 --resume
 * ```
 *
 * 开工前先跑 `emit.mjs --check`（kb → 四份生成物是否有漂移）。本文件消费的是生成物里的
 * 说法与白名单，生成物一旦与 kb 不一致，标签就不再"只来自 kb"，所以这道闸不能省。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CLASSES,
  DATAGEN_DIR,
  DEFAULT_PER_CORE,
  DEFAULT_SEED,
  VOICE_DIR,
  buildCores,
  coreStats,
  loadArtifacts,
  parseCores,
  serializeCores,
} from './templates.mjs';
import {
  formatReport,
  parseViaPython,
  readRawRows,
  verifyRows,
  writeManifest,
} from './verify.mjs';
import {
  DEFAULT_BASE_URL,
  assertTeacherAvailable,
  createLlamaClient,
  rewriteCores,
} from './rewrite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMIT_PATH = path.join(VOICE_DIR, 'emit.mjs');
const LOADER_PATH = path.join(VOICE_DIR, 'register-loader.mjs');

const HELP = `用法：node ... tools/voice/datagen/build.mjs [选项]

  --cores-only        只造核心句（cores.jsonl），不跑教师
  --skip-rewrite      复用已有 raw.jsonl，只重跑质检与分集
  --per-core <n>      每条核心句改几次（默认 ${DEFAULT_PER_CORE}）
  --limit <n>         只跑前 n 条可改写核心句（小样用）
  --resume            断点续跑（跳过 done.txt 里已完成的核心句）
  --seed <n>          切分种子（默认 ${DEFAULT_SEED}）
  --base-url <url>    教师服务（默认 ${DEFAULT_BASE_URL}）
  --only <classes>    只保留这些类别（逗号分隔，调试用；不影响默认全量）
  --no-kb-check       跳过 emit.mjs --check
`;

function parseArgs(argv) {
  const options = {
    coresOnly: false,
    skipRewrite: false,
    perCore: DEFAULT_PER_CORE,
    limit: 0,
    resume: false,
    seed: DEFAULT_SEED,
    baseUrl: DEFAULT_BASE_URL,
    only: null,
    kbCheck: true,
    coresPath: path.join(DATAGEN_DIR, 'cores.jsonl'),
    rawPath: path.join(DATAGEN_DIR, 'raw.jsonl'),
    donePath: path.join(DATAGEN_DIR, 'done.txt'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} 缺少参数`);
      return argv[index];
    };
    if (arg === '--cores-only') options.coresOnly = true;
    else if (arg === '--skip-rewrite') options.skipRewrite = true;
    else if (arg === '--per-core') options.perCore = Number(next());
    else if (arg === '--limit') options.limit = Number(next());
    else if (arg === '--resume') options.resume = true;
    else if (arg === '--seed') options.seed = Number(next());
    else if (arg === '--base-url') options.baseUrl = next();
    else if (arg === '--only') options.only = next().split(',').map((item) => item.trim()).filter(Boolean);
    else if (arg === '--no-kb-check') options.kbCheck = false;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else throw new Error(`未知参数 ${arg}`);
  }
  return options;
}

/** kb 漂移闸：`emit.mjs --check` 退出码 2 = 四份生成物与 kb 不一致 */
function runKbCheck() {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--import',
      // `--import` 只吃 `file://` URL（直接给 `D:\...` 会被当成 d: 协议）；
      // 入口脚本反过来只吃普通路径（给 URL 会走 CJS 解析器）。
      pathToFileURL(LOADER_PATH).href,
      EMIT_PATH,
      '--check',
    ],
    { encoding: 'utf8', cwd: path.resolve(VOICE_DIR, '..', '..') },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    throw new Error(`emit.mjs --check 失败（退出码 ${result.status}）：\n${output}`);
  }
  process.stdout.write(`[build] kb 闸：${output.split('\n').slice(-1)[0]}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.kbCheck) runKbCheck();

  const art = loadArtifacts();
  let cores = buildCores(art);
  if (options.only) cores = cores.filter((core) => options.only.includes(core.cls));

  const stats = coreStats(cores);
  fs.mkdirSync(DATAGEN_DIR, { recursive: true });
  fs.writeFileSync(options.coresPath, serializeCores(cores), 'utf8');
  process.stdout.write(
    `[build] 核心句 ${stats.cores} 条（可改写 ${stats.rewriteable}）、模板行 ${stats.templateTexts}、` +
      `对抗 ${stats.adversarialCores}；类别 ${CLASSES.map((name) => `${name}=${stats.byClass[name] ?? 0}`).join(' ')}\n`,
  );
  process.stdout.write(`[build] 写入 ${options.coresPath}\n`);
  if (options.coresOnly) return 0;

  return runPipeline({ options, art, cores });
}

async function runPipeline({ options, art, cores }) {
  if (!options.skipRewrite) {
    const availability = await assertTeacherAvailable({ baseUrl: options.baseUrl });
    if (!availability.ok) {
      process.stderr.write(
        `[build] 教师服务连不上（${options.baseUrl}）：${availability.detail}\n` +
          '[build] 先起教师服务，或加 --skip-rewrite 复用已有 raw.jsonl\n',
      );
      return 5;
    }
    process.stdout.write(`[build] 教师就绪：${availability.model || options.baseUrl}\n`);
    const rewriteStats = await rewriteCores({
      cores,
      perCore: options.perCore,
      complete: createLlamaClient({ baseUrl: options.baseUrl }),
      outPath: options.rawPath,
      donePath: options.donePath,
      resume: options.resume,
      limit: options.limit,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(
      `[build] 改写：核心句 ${rewriteStats.coresDone} 条（跳过 ${rewriteStats.coresSkipped}）、` +
        `请求 ${rewriteStats.requests} 次、失败 ${rewriteStats.failed}、空串 ${rewriteStats.emptyTexts}、` +
        `耗时 ${rewriteStats.elapsedSeconds.toFixed(0)} s（${rewriteStats.msPerRequest.toFixed(0)} ms/请求）\n`,
    );
    if (rewriteStats.coresSkipped > 0) {
      process.stderr.write('[build] 还有核心句没跑完（--resume 会续），本次产物按已有行生成\n');
    }
  }

  const rawRows = readRawRows(options.rawPath);
  const result = verifyRows({
    cores,
    rawRows,
    art,
    seed: options.seed,
    parse: (items) => parseViaPython(items),
  });
  process.stdout.write(`${formatReport(result)}\n`);
  const { manifestPath, files } = writeManifest(result, {
    art,
    seed: options.seed,
    rawPath: options.rawPath,
  });
  process.stdout.write(
    `[build] 写入 ${files.trainPath}、${files.holdoutPath}、${manifestPath}\n` +
      `[build] train sha256=${files.trainSha256}\n[build] holdout sha256=${files.holdoutSha256}\n`,
  );
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  Promise.resolve()
    .then(main)
    .then(
      (code) => process.exit(code ?? 0),
      (error) => {
        process.stderr.write(`[build] ${error && error.message ? error.message : error}\n`);
        process.exit(1);
      },
    );
}

export { parseArgs as parseBuildArgs, main as runBuild };
