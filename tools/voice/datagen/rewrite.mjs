/**
 * 教师改写（SubStage 5.1）：调 `llama-server`（Qwen3-8B-Q4_K_M，端口 8769）把核心句改写成
 * 更像人话的说法，**只产出 `text`**——`plan` 一律由 `templates.mjs` 从 kb 生成（纪律 1）。
 *
 * 三条落地细节：
 * - 采样固定 `temperature 0.9 / top_p 0.95 / n_predict 40`，每条请求带 `seed = f(coreId, n)`；
 *   种子只取决于"哪条核心句的第几次"，与跑了几次、跑没跑过无关 → 断点续跑与一次跑完逐字节一致；
 * - 断点续跑：`done.txt` 记已完成的核心句 id，`--resume` 跳过；一个核心句的 n 条结果先在内存里
 *   凑齐再**整块追加**，崩在中间不会留下半截行；
 * - 只用 `/completion`（裸 prompt），不走 chat 模板：Qwen3 默认开思考，chat 路径下会先吐
 *   `reasoning_content` 再吐 `content`，而裸 completion 不吃模板，结构性没有思考阶段
 *   （服务端另外仍带 `--reasoning-budget 0 --chat-template-kwargs {"enable_thinking":false}`）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { DATAGEN_DIR, DEFAULT_PER_CORE, parseCores } from './templates.mjs';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8769';
export const DEFAULT_PER_CORE_LIMIT = DEFAULT_PER_CORE;

/**
 * 前缀固定 → llama.cpp 的前缀缓存能命中，单条请求从 ~1.2 s 降到 ~0.6 s。
 *
 * 四条硬要求是照着实测的两类翻车写的（见报告 §rejected）：
 * ① 教师爱把"有点"吃掉 → 档位从 slight 变 medium；
 * ② 教师爱补一句"听起来很清晰" → 多出 clarity，解析器判成两个 op。
 * 示例三条用来锚住语气，也让模型知道"可以加口头语，但不能加新听感"。
 */
export const PROMPT_PREFIX = [
  '你在为语音调参助手做语料扩写。用户会说一句关于麦克风音色的话，请把它换成另一种中文口语说法。',
  '硬要求：',
  '一、只改句式和语气词，不要新增、删除或替换任何描述声音感受的词；',
  '二、原句里的"有点、稍微、一点儿、很、特别、非常、太、超"必须原样保留；',
  '三、不要提到原句没有的其它听感（原句只说闷，就别提亮、清晰、齿音）；',
  '四、只输出改写后的句子，不要解释、不要引号、不要阿拉伯数字，三到三十个字。',
  '',
  '示例：',
  '原句：声音有点闷',
  '改写：这个声音听着有点闷啊',
  '原句：齿音重',
  '改写：我这边齿音重，麻烦帮我压一压',
  '原句：声音小',
  '改写：感觉声音小，你能帮我弄弄吗',
].join('\n');

/** 去掉教师可能加的引号、句末标点、"改写：" 前缀 */
export function cleanTeacherText(raw) {
  let text = String(raw ?? '').replace(/[\r\n]+/gu, ' ').trim();
  text = text.replace(/^(改写|回答|输出|答案)[：:]\s*/u, '');
  text = text.replace(/^["'“”‘’「」『』]+/u, '').replace(/["'“”‘’「」『』]+$/u, '');
  text = text.replace(/[。．.，,！!？?；;~…]+$/u, '');
  return text.trim();
}

export function buildPrompt(text, prefix = PROMPT_PREFIX) {
  return `${prefix}\n原句：${text}\n改写：`;
}

/** 每条请求的种子只取决于 (coreId, n)：续跑与一次跑完得到同一串种子 */
export function seedFor(coreId, n) {
  const digest = crypto.createHash('sha1').update(`${coreId}#${n}`, 'utf8').digest();
  const value = digest.readUInt32BE(0) % 2147483647;
  return value === 0 ? 1 : value;
}

/** llama-server 客户端。`fetchImpl` 可注入（单测用假教师，不联网） */
export function createLlamaClient({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120000,
  retries = 2,
} = {}) {
  return async function complete(prompt, { seed } = {}) {
    const body = {
      prompt,
      temperature: 0.9,
      top_p: 0.95,
      n_predict: 40,
      seed: seed ?? 0,
      stop: ['\n'],
      cache_prompt: true,
      stream: false,
    };
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetchImpl(`${baseUrl}/completion`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const content = typeof payload?.content === 'string' ? payload.content : '';
        const reasoning = typeof payload?.reasoning_content === 'string' ? payload.reasoning_content : '';
        if (content.trim().length === 0 && reasoning.length > 0) {
          throw new Error('教师只回了 reasoning_content（思考模式没关）');
        }
        return content;
      } catch (error) {
        lastError = error;
        if (attempt === retries) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    throw lastError ?? new Error('教师请求失败');
  };
}

export async function assertTeacherAvailable({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
  try {
    const response = await fetchImpl(`${baseUrl}/props`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    const payload = await response.json();
    const model = String(payload?.model_path ?? payload?.model ?? '');
    return { ok: true, model };
  } catch (error) {
    return { ok: false, detail: error && error.message ? error.message : String(error) };
  }
}

/** 从 raw.jsonl 读回已有行（续跑时用于统计与自检） */
export function readRawLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

export function readDone(file) {
  if (!fs.existsSync(file)) return new Set();
  return new Set(
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

/**
 * 跑改写。返回统计：请求数、失败数、耗时、每条请求毫秒。
 *
 * @param {object} options
 * @param {Array} options.cores 核心句
 * @param {number} options.perCore 每条核心句要几次改写
 * @param {(prompt: string, meta: {seed: number}) => Promise<string>} options.complete 教师客户端
 * @param {string} options.outPath raw.jsonl
 * @param {string} options.donePath done.txt
 * @param {boolean} [options.resume]
 * @param {number} [options.limit] 只跑前 N 条可改写核心句（小样用）
 * @param {(line: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {(text: string) => string} [options.clean] 清洗教师输出
 */
export async function rewriteCores({
  cores,
  perCore = DEFAULT_PER_CORE_LIMIT,
  startN = 0,
  complete,
  outPath,
  donePath,
  resume = false,
  limit = 0,
  log = () => {},
  now = () => Date.now(),
  clean = (text) => String(text ?? '').trim(),
}) {
  const candidates = cores.filter((core) => core.texts.length > 0);
  const rewriteable = candidates.filter((core) => core.rewrite !== false);
  const picked = new Set((limit > 0 ? rewriteable.slice(0, limit) : rewriteable).map((core) => core.id));
  // 不走教师的核心句（set / 频点寻址）也要把模板行写进 raw.jsonl，否则这两类会整类丢失
  const scoped = candidates.filter((core) => core.rewrite === false || picked.has(core.id));

  const done = resume ? readDone(donePath) : new Set();
  if (!resume) {
    fs.writeFileSync(outPath, '', 'utf8');
    fs.writeFileSync(donePath, '', 'utf8');
  } else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    if (!fs.existsSync(outPath)) fs.writeFileSync(outPath, '', 'utf8');
    if (!fs.existsSync(donePath)) fs.writeFileSync(donePath, '', 'utf8');
  }
  fs.mkdirSync(path.dirname(donePath), { recursive: true });

  const started = now();
  let requests = 0;
  let failed = 0;
  let coresDone = 0;
  let emptyTexts = 0;

  for (const core of scoped) {
    if (done.has(core.id)) continue;
    const lines = [];
    for (const text of core.texts) {
      lines.push(JSON.stringify({ coreId: core.id, n: 0, src: 'template', text }));
    }
    let wroteTeacherRow = false;
    for (let n = startN; core.rewrite !== false && n < perCore; n += 1) {
      const seed = seedFor(core.id, n);
      let raw = '';
      try {
        raw = await complete(buildPrompt(core.texts[0]), { seed, coreId: core.id, n });
        requests += 1;
      } catch (error) {
        failed += 1;
        log(`[rewrite] ${core.id}#${n} 请求失败：${error && error.message ? error.message : error}`);
        continue;
      }
      const text = clean(raw);
      if (text.length === 0) {
        emptyTexts += 1;
        continue;
      }
      lines.push(JSON.stringify({ coreId: core.id, n, src: 'teacher', text }));
      wroteTeacherRow = true;
    }
    fs.appendFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
    fs.appendFileSync(donePath, `${core.id}\n`, 'utf8');
    coresDone += 1;
    if (coresDone % 25 === 0) {
      const elapsed = (now() - started) / 1000;
      const rate = requests === 0 ? 0 : elapsed / requests;
      log(
        `[rewrite] 已完成 ${coresDone}/${scoped.length} 条核心句，` +
          `请求 ${requests}（失败 ${failed}、空 ${emptyTexts}），` +
          `${elapsed.toFixed(0)} s，${(rate * 1000).toFixed(0)} ms/请求`,
      );
    }
    if (core.rewrite !== false && !wroteTeacherRow) {
      log(`[rewrite] 警告：${core.id} 的 ${perCore} 次改写全部为空（任务书 §5）`);
    }
  }

  // 收尾把 raw.jsonl 重排成规范顺序（核心句 id 升序，模板行在教师行之前，n 升序）。
  // 没有这一步，`--resume` 的产物会与"一次跑完"只差行序：补跑的核心句被追加到文件末尾，
  // 而一次跑完时它们夹在中间——任务书 §5 要求两者逐字节一致，所以顺序必须与处理顺序无关。
  normalizeRawFile(outPath);

  const elapsed = (now() - started) / 1000;
  return {
    coresTotal: scoped.length,
    coresDone,
    coresSkipped: scoped.length - coresDone,
    requests,
    failed,
    emptyTexts,
    elapsedSeconds: elapsed,
    msPerRequest: requests === 0 ? 0 : (elapsed * 1000) / requests,
    outPath,
    donePath,
  };
}

/** 行序归一化：`(coreId, src=template 在前, n)`，同一 (coreId, n, src) 只留第一条 */
export function normalizeRawFile(outPath) {
  if (!fs.existsSync(outPath)) return 0;
  const rows = fs
    .readFileSync(outPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    const key = `${row.coreId}#${row.src}#${row.n}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  unique.sort((a, b) => {
    if (a.coreId !== b.coreId) return a.coreId < b.coreId ? -1 : 1;
    const rankA = a.src === 'template' ? -1 : a.n;
    const rankB = b.src === 'template' ? -1 : b.n;
    return rankA - rankB;
  });
  fs.writeFileSync(outPath, `${unique.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return unique.length;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `用法：node tools/voice/datagen/rewrite.mjs [选项]

  --in <path>         核心句（默认 artifacts/voice/datagen/cores.jsonl）
  --out <path>        改写产物（默认 artifacts/voice/datagen/raw.jsonl）
  --done <path>       断点记录（默认 artifacts/voice/datagen/done.txt）
  --per-core <n>      每条核心句改几次（默认 ${DEFAULT_PER_CORE_LIMIT}）
  --start-n <n>       从第 n 次开始要（补跑用：已有 n&lt;startN 的行不动）
  --limit <n>         只跑前 n 条可改写核心句（小样用，0 = 全跑）
  --base-url <url>    教师服务（默认 ${DEFAULT_BASE_URL}）
  --resume            跳过 done.txt 里已完成的核心句
`;

function parseArgs(argv) {
  const options = {
    inPath: path.join(DATAGEN_DIR, 'cores.jsonl'),
    outPath: path.join(DATAGEN_DIR, 'raw.jsonl'),
    donePath: path.join(DATAGEN_DIR, 'done.txt'),
    perCore: DEFAULT_PER_CORE_LIMIT,
    startN: 0,
    limit: 0,
    baseUrl: DEFAULT_BASE_URL,
    resume: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} 缺少参数`);
      return argv[index];
    };
    if (arg === '--in') options.inPath = path.resolve(next());
    else if (arg === '--out') options.outPath = path.resolve(next());
    else if (arg === '--done') options.donePath = path.resolve(next());
    else if (arg === '--per-core') options.perCore = Number(next());
    else if (arg === '--start-n') options.startN = Number(next());
    else if (arg === '--limit') options.limit = Number(next());
    else if (arg === '--base-url') options.baseUrl = next();
    else if (arg === '--resume') options.resume = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else throw new Error(`未知参数 ${arg}`);
  }
  if (!Number.isInteger(options.perCore) || options.perCore < 1) throw new Error('--per-core 必须是 ≥1 的整数');
  if (!Number.isInteger(options.startN) || options.startN < 0) throw new Error('--start-n 必须是 ≥0 的整数');
  if (options.startN >= options.perCore) throw new Error('--start-n 必须小于 --per-core');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cores = parseCores(fs.readFileSync(options.inPath, 'utf8'));

  const availability = await assertTeacherAvailable({ baseUrl: options.baseUrl });
  if (!availability.ok) {
    process.stderr.write(
      `[rewrite] 教师服务连不上（${options.baseUrl}）：${availability.detail}\n` +
        '[rewrite] 先起教师：tools\\voice\\models\\llama\\llama-server.exe -m models\\teacher\\Qwen3-8B-Q4_K_M.gguf\n' +
        '          --host 127.0.0.1 --port 8769 -t 12 -c 2048 -np 1 --jinja -ngl 0 --reasoning-budget 0\n',
    );
    return 5;
  }
  process.stdout.write(`[rewrite] 教师就绪：${availability.model || options.baseUrl}\n`);

  const stats = await rewriteCores({
    cores,
    perCore: options.perCore,
    startN: options.startN,
    complete: createLlamaClient({ baseUrl: options.baseUrl }),
    outPath: options.outPath,
    donePath: options.donePath,
    resume: options.resume,
    limit: options.limit,
    log: (line) => process.stdout.write(`${line}\n`),
    clean: cleanTeacherText,
  });

  process.stdout.write(
    `[rewrite] 核心句 ${stats.coresDone} 条（跳过 ${stats.coresSkipped}），请求 ${stats.requests} 次，` +
      `失败 ${stats.failed}、空串 ${stats.emptyTexts}；耗时 ${stats.elapsedSeconds.toFixed(0)} s，` +
      `${stats.msPerRequest.toFixed(0)} ms/请求（每千次约 ${(stats.msPerRequest / 1000).toFixed(1)} s 的倒数见报告）\n`,
  );
  return stats.failed > 0 && stats.requests === 0 ? 5 : 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`[rewrite] ${error && error.message ? error.message : error}\n`);
      process.exit(1);
    },
  );
}
