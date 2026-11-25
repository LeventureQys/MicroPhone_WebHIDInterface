/**
 * 质检与分集（SubStage 5.1）：语义一致性回测 → 去重 → 按 kb 键分组切分 → 写数据集与 manifest。
 *
 * 三道关（任务书 §4.4）：
 * 1. 语义一致：`parser.parse(text)` 必须回到核心句的同一条目。回测用**真解析器**
 *    （`tools/voice/parser.py`，3.2 交付，只读）——本文件不重写它的判定逻辑，
 *    否则"回测"就成了自证。Python 侧是一个 `-c` 内联脚本，不落新文件、不加依赖。
 * 2. 去重：`normalize(text)` 后取 sha1，重复只留第一条（按 coreId + 序号排序，确定性）。
 * 3. 分集：kb 键之间用并查集求连通分量（多意图样本把它的每个 op 键连在一起），
 *    按分量的哈希决定 train / holdout——**kb 键交集恒为空**，且天然满足
 *    "holdout 某键 < 3 条就整块回 train"。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CLASSES,
  DATA_DIR,
  DATAGEN_DIR,
  DEFAULT_SEED,
  DIGIT_POLICY,
  loadArtifacts,
  parseCores,
  opSignature,
  unexpressedCellKeys,
  validatePlan,
  VOICE_DIR,
} from './templates.mjs';

export const REJECT_SAMPLE_LIMIT = 3;
const HOLDOUT_RATIO = 0.1;
const HOLDOUT_MIN_ROWS = 3;
export const TEXT_MIN = 3;
export const TEXT_MAX = 30;

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

const PUNCT = /[，,。.、；;：:！!？?“”"'「」『』（）()【】…—\-~· \t\r\n]/gu;

export function normalizeText(text) {
  return String(text)
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(PUNCT, '')
    .toLowerCase();
}

export function sha1Hex(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hasArabicDigit(text) {
  return /[0-9０-９]/.test(text);
}

export function isPunctOnly(text) {
  return normalizeText(text).length === 0;
}

// ---------------------------------------------------------------------------
// 真解析器回测（Python，3.2 交付）
// ---------------------------------------------------------------------------

const PY_BRIDGE = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[3])',
  'import parser as voice_parser',
  'targets = voice_parser.load_targets()',
  'fin = open(sys.argv[1], encoding="utf-8")',
  'fout = open(sys.argv[2], "w", encoding="utf-8")',
  'for line in fin:',
  '    line = line.strip()',
  '    if not line:',
  '        continue',
  '    rec = json.loads(line)',
  '    result = voice_parser.parse(rec["text"], targets=targets)',
  '    fout.write(json.dumps({"id": rec["id"], "result": result}, ensure_ascii=False) + "\\n")',
  'fin.close()',
  'fout.close()',
].join('\n');

export function defaultPythonExe() {
  const candidates = [
    process.env.MICSTUDIO_PYTHON,
    path.join(VOICE_DIR, '.venv', 'Scripts', 'python.exe'),
    path.join(VOICE_DIR, '.venv', 'bin', 'python'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'python';
}

/**
 * 批量回测。返回 `Map<id, result>`，result 为 L1 dict 或 null。
 * 一批喂同一个进程（词表只加载一次）。
 */
export function parseViaPython(items, { python = defaultPythonExe(), workDir, batch = 4000 } = {}) {
  const out = new Map();
  if (items.length === 0) return out;
  const dir = workDir ?? path.join(DATAGEN_DIR, '.parse');
  fs.mkdirSync(dir, { recursive: true });

  for (let offset = 0; offset < items.length; offset += batch) {
    const slice = items.slice(offset, offset + batch);
    const inFile = path.join(dir, 'parse-in.jsonl');
    const outFile = path.join(dir, 'parse-out.jsonl');
    fs.writeFileSync(
      inFile,
      slice.map((item) => JSON.stringify({ id: item.id, text: item.text })).join('\n') + '\n',
      'utf8',
    );
    const run = spawnSync(python, ['-c', PY_BRIDGE, inFile, outFile, VOICE_DIR], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (run.error) throw new Error(`无法启动解析器回测（${python}）：${run.error.message}`);
    if (run.status !== 0) {
      const detail = String(run.stderr || run.stdout || '').trim().slice(-2000);
      throw new Error(`parser.py 回测失败（退出码 ${run.status}）：${detail}`);
    }
    const lines = fs.readFileSync(outFile, 'utf8').split('\n').filter((line) => line.trim().length > 0);
    for (const line of lines) {
      const rec = JSON.parse(line);
      out.set(rec.id, rec.result);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 语义一致性比对
// ---------------------------------------------------------------------------

function signatureList(ops) {
  return (ops ?? []).map(opSignature).sort();
}

/**
 * 期望对照实际。返回 {ok} 或 {ok:false, reason, detail}。
 * - explainOnly（`cls==='explain'`）：期望 `status:'unsupported'` 且 `say` 等于 kb 的解释句；
 * - 范围外 / 模糊：期望解析器**未命中**（`null`，运行时交给 LLM 层）；
 * - 其余：期望 `status:'ok'` 且 op 签名逐项相同（多意图按多重集比较）。
 */
export function compareParse(plan, actual, { cls } = {}) {
  if (cls === 'explain') {
    if (!actual) return { ok: false, reason: 'parse-none', detail: '期望 explainOnly 命中，实际未命中' };
    if (actual.status !== 'unsupported') {
      return { ok: false, reason: 'status-mismatch', detail: `期望 unsupported，实际 ${actual.status}` };
    }
    if ((actual.ops ?? []).length > 0) {
      return { ok: false, reason: 'ops-mismatch', detail: `期望无 ops，实际 ${signatureList(actual.ops).join(';')}` };
    }
    if (actual.say !== plan.say) {
      return { ok: false, reason: 'say-mismatch', detail: `期望「${plan.say}」，实际「${actual.say}」` };
    }
    return { ok: true };
  }

  if (plan.status === 'unsupported' || plan.status === 'clarify') {
    if (actual) {
      return {
        ok: false,
        reason: 'unexpected-hit',
        detail: `期望未命中，实际命中 ${signatureList(actual.ops).join(';') || actual.status}`,
      };
    }
    return { ok: true };
  }

  if (!actual) return { ok: false, reason: 'parse-none', detail: '期望命中，实际未命中' };
  if (actual.status !== 'ok') {
    return { ok: false, reason: 'status-mismatch', detail: `期望 ok，实际 ${actual.status}` };
  }
  const want = signatureList(plan.ops);
  const got = signatureList(actual.ops);
  if (want.length !== got.length || want.some((sig, index) => sig !== got[index])) {
    return { ok: false, reason: 'ops-mismatch', detail: `期望 ${want.join(' ; ')}，实际 ${got.join(' ; ')}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 分集（并查集 + 分量哈希）
// ---------------------------------------------------------------------------

class UnionFind {
  constructor() {
    this.parent = new Map();
  }

  find(key) {
    if (!this.parent.has(key)) {
      this.parent.set(key, key);
      return key;
    }
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cursor = key;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor);
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }
}

/**
 * 按 kb 键连通分量切分。同一条目（含多意图样本牵到的所有条目）整体进同一 split，
 * 因此 train 与 holdout 的 kb 键交集必然为空。
 */
export function splitRows(rows, { seed = DEFAULT_SEED, ratio = HOLDOUT_RATIO } = {}) {
  const uf = new UnionFind();
  const keysOf = (row) => (row.leakKeys && row.leakKeys.length > 0 ? row.leakKeys : [row.kb]);
  for (const row of rows) {
    const keys = keysOf(row);
    for (const key of keys) uf.find(key);
    for (let index = 1; index < keys.length; index += 1) uf.union(keys[0], keys[index]);
  }

  const components = new Map();
  for (const row of rows) {
    const root = uf.find(keysOf(row)[0]);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(row);
  }

  const ordered = [...components.entries()]
    .map(([root, items]) => ({
      root,
      items,
      keys: [...new Set(items.flatMap(keysOf))].sort(),
      rank: sha1Hex(`${seed}:${root}`),
    }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));

  const targetHold = Math.round(rows.length * ratio);
  let holdCount = 0;
  const holdoutRoots = new Set();
  for (const component of ordered) {
    if (component.items.length < HOLDOUT_MIN_ROWS) continue; // 太小的键整块留 train（任务书 §5）
    if (holdCount + component.items.length > targetHold) continue;
    holdoutRoots.add(component.root);
    holdCount += component.items.length;
  }

  for (const row of rows) {
    row.split = holdoutRoots.has(uf.find(keysOf(row)[0])) ? 'holdout' : 'train';
  }

  const splitKeys = { train: new Set(), holdout: new Set() };
  for (const row of rows) {
    for (const key of keysOf(row)) splitKeys[row.split].add(key);
  }
  return {
    components: ordered.length,
    holdoutComponents: holdoutRoots.size,
    splitKeys: {
      train: [...splitKeys.train].sort(),
      holdout: [...splitKeys.holdout].sort(),
    },
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function rowKey(row) {
  // 模板行与改写行的 n 都从 0 起，必须带 src 才不会在回测结果里撞 id
  return `${row.coreId}#${row.src === 'template' ? 't' : 'r'}${row.n}`;
}

/**
 * @param {object} options
 * @param {Array} options.cores 核心句（模板定义）
 * @param {Array} options.rawRows 待检行（`{coreId, n, src, text}`）
 * @param {(items: {id: string, text: string}[]) => Map<string, any>} options.parse 回测器
 * @param {object} options.art `loadArtifacts()` 的返回值（plan 自检用）
 * @param {number} [options.seed]
 */
export function verifyRows({ cores, rawRows, parse, art, seed = DEFAULT_SEED }) {
  const byId = new Map(cores.map((item) => [item.id, item]));
  const rejected = [];
  const accepted = [];
  const reject = (row, reason, detail) => rejected.push({
    coreId: row.coreId,
    n: row.n,
    src: row.src,
    text: row.text,
    reason,
    detail,
  });

  const candidates = rawRows
    .map((row, index) => ({ ...row, order: index }))
    .sort((a, b) => (a.coreId < b.coreId ? -1 : a.coreId > b.coreId ? 1 : a.n - b.n));

  const toParse = [];
  for (const row of candidates) {
    const item = byId.get(row.coreId);
    if (!item) {
      reject(row, 'unknown-core', `核心句 ${row.coreId} 不存在`);
      continue;
    }
    row.core = item;
    if (typeof row.text !== 'string' || row.text.length === 0 || isPunctOnly(row.text)) {
      reject(row, 'empty', '空串或纯标点');
      continue;
    }
    if (row.src !== 'template' && hasArabicDigit(row.text)) {
      reject(row, 'has-digit', `含阿拉伯数字：${row.text}`);
      continue;
    }
    const length = [...row.text].length;
    if (length < TEXT_MIN) {
      reject(row, 'too-short', `${length} 字`);
      continue;
    }
    if (length > TEXT_MAX) {
      reject(row, 'too-long', `${length} 字：${row.text}`);
      continue;
    }
    const planCheck = validatePlan(item.plan, art, { allowLongSay: item.cls === 'explain' });
    if (!planCheck.ok) {
      reject(row, 'plan-invalid', planCheck.errors.join('; '));
      continue;
    }
    toParse.push({ id: rowKey(row), text: row.text, row });
  }

  const parsed = parse(toParse.map((entry) => ({ id: entry.id, text: entry.text })));

  for (const entry of toParse) {
    const row = entry.row;
    const verdict = compareParse(row.core.plan, parsed.get(entry.id) ?? null, { cls: row.core.cls });
    if (!verdict.ok) {
      reject(row, verdict.reason, verdict.detail ?? '');
      continue;
    }
    accepted.push(row);
  }

  // 去重（按 coreId + n 的确定性顺序，先到先留）
  const seen = new Map();
  const unique = [];
  for (const row of accepted) {
    const key = sha1Hex(normalizeText(row.text));
    if (seen.has(key)) continue;
    seen.set(key, row);
    unique.push(row);
  }
  const deduped = accepted.length - unique.length;

  const rows = unique.map((row) => ({
    coreId: row.coreId,
    n: row.n,
    src: row.src,
    text: row.text,
    cls: row.core.cls,
    kb: row.core.kb,
    leakKeys: row.core.leakKeys ?? [row.core.kb],
    adversarial: Boolean(row.core.adversarial),
    plan: row.core.plan,
    scene: row.core.plan.ops.find((op) => op.kind === 'scene')?.scene ?? null,
  }));

  const split = splitRows(rows, { seed });
  rows.sort((a, b) => {
    if (a.split !== b.split) return a.split === 'train' ? -1 : 1;
    if (a.coreId !== b.coreId) return a.coreId < b.coreId ? -1 : 1;
    return a.n - b.n;
  });
  const counters = { train: 0, holdout: 0 };
  for (const row of rows) {
    counters[row.split] += 1;
    row.id = `${row.split === 'train' ? 't' : 'h'}${String(counters[row.split]).padStart(6, '0')}`;
  }

  return { rows, rejected, deduped, split, stats: summarize(rows, rejected, deduped) };
}

export function summarize(rows, rejected, deduped) {
  const counts = { train: 0, holdout: 0, total: rows.length, rejected: rejected.length, deduped };
  const byClass = Object.fromEntries(CLASSES.map((name) => [name, 0]));
  const byClassSplit = Object.fromEntries(CLASSES.map((name) => [name, { train: 0, holdout: 0 }]));
  let adversarial = 0;
  const kbKeys = new Set();
  for (const row of rows) {
    counts[row.split] += 1;
    byClass[row.cls] = (byClass[row.cls] ?? 0) + 1;
    byClassSplit[row.cls][row.split] += 1;
    if (row.adversarial) adversarial += 1;
    for (const key of row.leakKeys ?? [row.kb]) kbKeys.add(key);
  }
  const reasons = new Map();
  for (const item of rejected) {
    const bucket = reasons.get(item.reason) ?? { reason: item.reason, count: 0, samples: [] };
    bucket.count += 1;
    if (bucket.samples.length < REJECT_SAMPLE_LIMIT) {
      bucket.samples.push({ text: item.text, detail: item.detail });
    }
    reasons.set(item.reason, bucket);
  }
  const rejectedTop = [...reasons.values()]
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1));
  const accepted = rows.length;
  const attempts = accepted + rejected.length + deduped;
  return {
    counts,
    byClass,
    byClassSplit,
    adversarial,
    adversarialRatio: rows.length === 0 ? 0 : adversarial / rows.length,
    kbKeys: [...kbKeys].sort(),
    rejectedTop,
    semanticConsistency: attempts === 0 ? 1 : accepted / attempts,
  };
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

export function toJsonl(rows) {
  return rows
    .map((row) => JSON.stringify({
      id: row.id,
      text: row.text,
      src: row.src,
      kb: row.kb,
      plan: row.plan,
      split: row.split,
      scene: row.scene,
    }))
    .join('\n') + (rows.length > 0 ? '\n' : '');
}

export function writeDataset(rows, outDir = DATA_DIR) {
  fs.mkdirSync(outDir, { recursive: true });
  const trainText = toJsonl(rows.filter((row) => row.split === 'train'));
  const holdoutText = toJsonl(rows.filter((row) => row.split === 'holdout'));
  const trainPath = path.join(outDir, 'train.jsonl');
  const holdoutPath = path.join(outDir, 'holdout.jsonl');
  fs.writeFileSync(trainPath, trainText, 'utf8');
  fs.writeFileSync(holdoutPath, holdoutText, 'utf8');
  return {
    trainPath,
    holdoutPath,
    trainSha256: sha256Text(trainText),
    holdoutSha256: sha256Text(holdoutText),
  };
}

/** 教师模型的 SHA256 从 1.1 的清单里取（5 GB 全量哈希太慢；清单里的 size 用于交叉校验） */
export function teacherStamp({ manifestPath = path.join(VOICE_DIR, 'manifest.json'), modelPath } = {}) {
  const model = modelPath ?? path.join(VOICE_DIR, 'models', 'teacher', 'Qwen3-8B-Q4_K_M.gguf');
  const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const asset = doc.assets.find((item) => item.id === 'qwen3-8b-teacher');
  if (!asset) throw new Error('tools/voice/manifest.json 里没有 qwen3-8b-teacher');
  const size = fs.existsSync(model) ? fs.statSync(model).size : 0;
  if (size !== asset.size) throw new Error(`教师模型体积不符（${size} != ${asset.size}）`);
  return `${path.basename(model)}@${String(asset.sha256).slice(0, 16)}`;
}

/** 四个生成物的 sha256（kbSha256 = 知识本体导出的这一组文件的联合指纹） */
export function kbFingerprint(files) {
  const parts = [files.lexicon, files.rules, files.targets, files.planSchema].map((file) => {
    const bytes = fs.readFileSync(file);
    return `${path.basename(file)}:${sha256Text(bytes.toString('utf8'))}`;
  });
  return { sha256: sha256Text(parts.join('\n')), parts };
}

export function defaultCreatedAt(rawPath) {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch) return new Date(Number(epoch) * 1000).toISOString();
  if (rawPath && fs.existsSync(rawPath)) return fs.statSync(rawPath).mtime.toISOString();
  return new Date(0).toISOString();
}

/**
 * manifest.json（任务书 §4.5）。`createdAt` 取输入 raw.jsonl 的 mtime（不是"现在"），
 * 这样同一份输入重跑两次，manifest 除 `counts` 外也逐字节一致。
 */
export function buildManifest(result, { art, seed, rawPath, outDir = DATA_DIR }) {
  const files = writeDataset(result.rows, outDir);
  const fingerprint = kbFingerprint(art.files);
  return {
    manifest: {
      v: 1,
      createdAt: defaultCreatedAt(rawPath),
      seed,
      kbSha256: fingerprint.sha256,
      teacher: teacherStamp(),
      counts: result.stats.counts,
      byClass: result.stats.byClass,
      splitKeys: result.split.splitKeys,
      adversarial: { rows: result.stats.adversarial, ratio: Number(result.stats.adversarialRatio.toFixed(4)) },
      // 数字口径（见 templates.mjs 的 DIGIT_POLICY 注释）：教师行零阿拉伯数字，set / 频点走模板
      digitPolicy: { ...DIGIT_POLICY },
      // 78 格里词表表达不出来的那一格（`harshness.more.medium`，三条说法全自带"一点"）
      unexpressedCells: unexpressedCellKeys(),
      semanticConsistency: Number(result.stats.semanticConsistency.toFixed(4)),
      rejectedTop: result.stats.rejectedTop.slice(0, 10),
      files: {
        train: { path: 'tools/voice/data/train.jsonl', rows: result.stats.counts.train, sha256: files.trainSha256 },
        holdout: {
          path: 'tools/voice/data/holdout.jsonl',
          rows: result.stats.counts.holdout,
          sha256: files.holdoutSha256,
        },
      },
    },
    files,
    fingerprint,
  };
}

export function writeManifest(result, options) {
  const { manifest, files } = buildManifest(result, options);
  const manifestPath = path.join(options.outDir ?? DATA_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, manifestPath, files };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `用法：node tools/voice/datagen/verify.mjs [选项]

  --cores <path>     核心句（默认 artifacts/voice/datagen/cores.jsonl）
  --raw <path>       待检行（默认 artifacts/voice/datagen/raw.jsonl）
  --out-dir <dir>    数据集目录（默认 tools/voice/data）
  --seed <n>         切分种子（默认 ${DEFAULT_SEED}）
  --python <path>    解析器用的 python（默认 tools/voice/.venv/Scripts/python.exe）
  --dry-run          只打印报告，不写 data/*
`;

function parseArgs(argv) {
  const options = {
    coresPath: path.join(DATAGEN_DIR, 'cores.jsonl'),
    rawPath: path.join(DATAGEN_DIR, 'raw.jsonl'),
    outDir: DATA_DIR,
    seed: DEFAULT_SEED,
    python: defaultPythonExe(),
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} 缺少参数`);
      return argv[index];
    };
    if (arg === '--cores') options.coresPath = path.resolve(next());
    else if (arg === '--raw') options.rawPath = path.resolve(next());
    else if (arg === '--out-dir') options.outDir = path.resolve(next());
    else if (arg === '--seed') options.seed = Number(next());
    else if (arg === '--python') options.python = next();
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else throw new Error(`未知参数 ${arg}`);
  }
  return options;
}

export function readRawRows(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const rec = JSON.parse(line);
      return { coreId: rec.coreId, n: Number(rec.n ?? 0), src: rec.src ?? 'teacher', text: rec.text ?? '' };
    });
}

export function formatReport(result) {
  const { stats } = result;
  const lines = [];
  lines.push(`[verify] 类别：${CLASSES.map((name) => `${name}=${stats.byClass[name] ?? 0}`).join(' ')}`);
  lines.push(
    `[verify] 归一化尝试 ${stats.counts.total + stats.counts.rejected + stats.counts.deduped} 条：` +
      `保留 ${stats.counts.total}、丢弃 ${stats.counts.rejected}、去重 ${stats.counts.deduped}`,
  );
  lines.push(
    `[verify] train=${stats.counts.train} holdout=${stats.counts.holdout} ` +
      `对抗样本=${stats.adversarial}（${(stats.adversarialRatio * 100).toFixed(1)}%）`,
  );
  lines.push(`[verify] 语义一致率 ${(stats.semanticConsistency * 100).toFixed(2)}%`);
  if (result.split) {
    const { train, holdout } = result.split.splitKeys;
    const overlap = train.filter((key) => holdout.includes(key));
    lines.push(
      `[verify] 分组 ${result.split.components} 个，holdout 占 ${result.split.holdoutComponents} 个；` +
        `kb 键 train=${train.length} holdout=${holdout.length} 交集=${overlap.length}`,
    );
  }
  stats.rejectedTop.slice(0, 10).forEach((bucket, index) => {
    lines.push(`[verify] rejected[${index + 1}] ${bucket.reason} × ${bucket.count}`);
    bucket.samples.forEach((sample) => {
      lines.push(`           「${sample.text}」${sample.detail ? ` → ${sample.detail}` : ''}`);
    });
  });
  if (stats.rejectedTop.length === 0) lines.push('[verify] rejected: 无');
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const art = loadArtifacts();
  const cores = parseCores(fs.readFileSync(options.coresPath, 'utf8'));
  const rawRows = readRawRows(options.rawPath);
  const result = verifyRows({
    cores,
    rawRows,
    art,
    seed: options.seed,
    parse: (items) => parseViaPython(items, { python: options.python }),
  });
  process.stdout.write(`${formatReport(result)}\n`);

  if (options.dryRun) return 0;

  const { manifestPath, files } = writeManifest(result, {
    art,
    seed: options.seed,
    rawPath: options.rawPath,
    outDir: options.outDir,
  });
  process.stdout.write(`[verify] 写入 ${files.trainPath}、${files.holdoutPath}、${manifestPath}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`[verify] ${error && error.message ? error.message : error}\n`);
      process.exit(1);
    },
  );
}
