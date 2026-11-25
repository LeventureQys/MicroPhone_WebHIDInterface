/**
 * 契约与知识本体的生成器（Alpha v1.3.0 / SubStage 3.1）。
 *
 * 唯一真值在 `contract/kb.ts`（+ 从它投影出来的 `contract/targets.ts`、`contract/schemas.ts`）。
 * 本脚本把真值写成 4 个**提交进仓库的生成物**：
 *
 *   schema/voice-plan.schema.json   L1 的 JSON Schema（给 llama.cpp 的 response_format）
 *   schema/targets.json             词表投影（Python 侧读这个 + lexicons/zh.json）
 *   gen/rules.json                  规则表（Node 执行器读这个）
 *   lexicons/zh.json                规则解析词表（**不手写**，手改会被 --check 打回）
 *
 * 三种模式：
 *
 *   emit.mjs            写 4 个文件，打印 `emitted 4 files (...)`，退出码 0
 *   emit.mjs --check    只比较不写；有差异时打印前 20 行 diff，退出码 2
 *   emit.mjs --audit    抽样 100 条"说法 → 期望 plan"，打印未命中的条目（给 3.2 / 5.1 用）
 *
 * 只用 `node:fs` / `node:path` / `node:url`：不加依赖（任务书 §8）。
 *
 * 运行方式（不带 loader 会 import 失败——`src/**` 的 import 省略扩展名）：
 *
 *   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *        --import ./tools/voice/register-loader.mjs tools/voice/emit.mjs [--check|--audit]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/** 生成物清单：key 是模式内的名字，value 是仓库内路径 */
const OUTPUT_FILES = {
  schema: path.join(HERE, 'schema', 'voice-plan.schema.json'),
  targets: path.join(HERE, 'schema', 'targets.json'),
  rules: path.join(HERE, 'gen', 'rules.json'),
  lexicons: path.join(HERE, 'lexicons', 'zh.json'),
};

const IMPORT_HINT = [
  '导入 contract/*.ts 或 src/renderer/src/domain/*.ts 失败。',
  '原始错误：',
  '',
  '请检查：①命令是否带 --experimental-strip-types；',
  '        ②是否带 --import ./tools/voice/register-loader.mjs；',
  '        ③当前目录是否为仓库根（loader 按相对路径注册）。',
].join('\n');

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function unique(list) {
  return [...new Set(list)];
}

function rel(file) {
  return path.relative(REPO, file).replace(/\\/g, '/');
}

function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function toJsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 位置式 diff：够用来指着看"哪一行开始不一样"，不做 LCS */
function firstDiffLines(expected, actual, limit) {
  const expectedLines = expected.split('\n');
  const actualLines = (actual ?? '').split('\n');
  const out = [];
  const total = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < total && out.length < limit; index += 1) {
    if (expectedLines[index] === actualLines[index]) continue;
    out.push(`@@ 第 ${index + 1} 行`);
    out.push(`- 生成值: ${expectedLines[index] === undefined ? '<无>' : expectedLines[index]}`);
    out.push(`+ 磁盘值: ${actualLines[index] === undefined ? '<无>' : actualLines[index]}`);
  }
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// 生成物 1：schema/voice-plan.schema.json
// ---------------------------------------------------------------------------

function buildPlanSchema(schemas) {
  return schemas.voicePlanSchema();
}

// ---------------------------------------------------------------------------
// 生成物 2：schema/targets.json
// ---------------------------------------------------------------------------

/** 每个维度的全部说法（aliases + 两侧 directionWord），去重后给 Python 侧做提示词/校验 */
function buildAliasMap(kb) {
  const map = {};
  for (const dimension of kb.DIMENSIONS) {
    map[dimension.id] = unique([
      ...dimension.aliases,
      ...dimension.directionWord.more,
      ...dimension.directionWord.less,
    ]);
  }
  return map;
}

function buildBandsJson(kb) {
  return kb.BANDS.map((band) => ({ band: band.band, centerHz: band.centerHz, kind: band.kind }));
}

function buildTargetsJson(kb, targets) {
  return {
    v: 1,
    tuneTargets: [...targets.TUNE_TARGETS],
    toggleTargets: [...targets.TOGGLE_TARGETS],
    strengths: [...kb.STRENGTHS],
    directions: [...kb.DIRECTIONS],
    scenes: [...kb.SCENE_IDS],
    tones: [...kb.TONE_IDS],
    paramIds: [...targets.PARAM_IDS],
    aliases: buildAliasMap(kb),
    wakePrefixes: [...kb.WAKE_PREFIXES],
    bands: buildBandsJson(kb),
    explainOnly: kb.EXPLAIN_ONLY.map((item) => ({
      id: item.id,
      nameZh: item.nameZh,
      aliases: [...item.aliases],
      explain: item.explain,
    })),
    scenarios: kb.SCENARIOS.map((scenario) => ({
      id: scenario.id,
      nameZh: scenario.nameZh,
      aliases: [...scenario.aliases],
      baseScene: scenario.baseScene,
    })),
  };
}

// ---------------------------------------------------------------------------
// 生成物 3：gen/rules.json
// ---------------------------------------------------------------------------

function buildRulesByStrength(cell) {
  return {
    slight: cell.slight.map((action) => ({ ...action })),
    medium: cell.medium.map((action) => ({ ...action })),
    strong: cell.strong.map((action) => ({ ...action })),
  };
}

function buildEqDeltas(kb) {
  const out = {};
  for (const field of ['gain', 'q', 'freqPct']) {
    out[field] = {
      more: buildRulesByStrength(kb.EQ_DELTAS[field].more),
      less: buildRulesByStrength(kb.EQ_DELTAS[field].less),
    };
  }
  return out;
}

function buildRulesJson(kb, targets) {
  const dims = kb.DIMENSIONS.map((dimension) => ({
    id: dimension.id,
    nameZh: dimension.nameZh,
    writable: [...dimension.writable],
    aliasSide: kb.ALIAS_SIDE[dimension.id],
    more: buildRulesByStrength(dimension.rules.more),
    less: buildRulesByStrength(dimension.rules.less),
  }));
  const toggle = {};
  for (const target of targets.TOGGLE_TARGETS) {
    const rule = kb.TOGGLE_RULES[target];
    toggle[target] = {
      on: rule.on.map((action) => ({ ...action })),
      off: rule.off.map((action) => ({ ...action })),
    };
  }
  return {
    v: 1,
    strengths: [...kb.STRENGTHS],
    directions: [...kb.DIRECTIONS],
    dims,
    toggle,
    eqDeltas: buildEqDeltas(kb),
    turnCaps: { ...kb.TURN_CAPS },
    bands: buildBandsJson(kb),
    conditionals: kb.CONDITIONAL_ACTIONS.map((conditional) => ({
      target: conditional.target,
      direction: conditional.direction,
      when: { id: conditional.when.id, atOrBelow: conditional.when.atOrBelow },
      then: conditional.then.map((action) => ({ ...action })),
    })),
    scenarios: kb.SCENARIOS.map((scenario) => ({
      id: scenario.id,
      baseScene: scenario.baseScene,
      patch: scenario.patch.map((action) => ({ ...action })),
    })),
  };
}

// ---------------------------------------------------------------------------
// 生成物 4：lexicons/zh.json
// ---------------------------------------------------------------------------

/**
 * `entries`：13 维度 × 2 方向。
 *
 * 顺序很重要：**非主方向排在前面**。主方向的说法是短词（"闷"、"亮"），非主方向的说法
 * 更长更具体（"闷一点"、"再亮一点"）。解析器按条目顺序取第一个命中，先长后短才能让
 * "闷一点"落到 `muddiness.more` 而不是被"闷"吞掉（SubStage 3.2 §4.1 的歧义消解优先级）。
 */
function buildLexiconEntries(kb) {
  const entries = [];
  for (const dimension of kb.DIMENSIONS) {
    const primary = kb.ALIAS_SIDE[dimension.id];
    const other = primary === 'more' ? 'less' : 'more';
    entries.push({
      target: dimension.id,
      direction: other,
      words: unique(dimension.directionWord[other]),
    });
    entries.push({
      target: dimension.id,
      direction: primary,
      words: unique([...dimension.aliases, ...dimension.directionWord[primary]]),
    });
  }
  return entries;
}

function toPattern(words) {
  return words.join('|');
}

function buildLexicon(kb, targets) {
  const entries = buildLexiconEntries(kb).map((entry) => ({
    pattern: toPattern(entry.words),
    target: entry.target,
    direction: entry.direction,
  }));
  const switches = [];
  for (const target of targets.TOGGLE_TARGETS) {
    const words = kb.SWITCH_WORDS[target];
    switches.push({ pattern: toPattern(words.on), target, on: true });
    switches.push({ pattern: toPattern(words.off), target, on: false });
  }
  const scenes = kb.SCENE_IDS.map((scene) => ({
    pattern: toPattern(kb.SCENE_WORDS[scene]),
    scene,
  }));
  const scenarios = kb.SCENARIOS.map((scenario) => ({
    pattern: toPattern(scenario.aliases),
    scenario: scenario.id,
  }));
  const tones = kb.TONE_IDS.map((tone) => ({
    pattern: toPattern(kb.TONE_WORDS[tone]),
    tone,
  }));
  const explainOnly = kb.EXPLAIN_ONLY.map((item) => ({
    pattern: toPattern(item.aliases),
    id: item.id,
  }));
  return {
    v: 1,
    strengthWords: {
      slight: [...kb.STRENGTH_WORDS.slight],
      strong: [...kb.STRENGTH_WORDS.strong],
    },
    entries,
    switches,
    scenes,
    scenarios,
    tones,
    explainOnly,
    undo: kb.UNDO_WORDS.join('|'),
    confirm: kb.CONFIRM_WORDS.join('|'),
    bandParam: kb.BAND_PARAM_PATTERN,
    hzParam: kb.HZ_PATTERN,
  };
}

// ---------------------------------------------------------------------------
// 校验（任务书 §5 的每一种情况都抛 KbError，退出码 1）
// ---------------------------------------------------------------------------

function validateKnowledge(kb, targets) {
  if (kb.DIMENSIONS.length !== 13) {
    throw new kb.KbError(`DIMENSIONS 应为 13，实际 ${kb.DIMENSIONS.length}`);
  }
  const paramIds = new Set(targets.PARAM_IDS);
  const seenIds = new Set();
  const wordOwner = new Map();
  for (const dimension of kb.DIMENSIONS) {
    if (seenIds.has(dimension.id)) {
      throw new kb.KbError(`维度 id 重复：${dimension.id}`);
    }
    seenIds.add(dimension.id);
    if (dimension.aliases.length < 6) {
      throw new kb.KbError(`维度 ${dimension.id} 的 aliases 只有 ${dimension.aliases.length} 条（要求 ≥ 6）`);
    }
    for (const direction of kb.DIRECTIONS) {
      for (const strength of kb.STRENGTHS) {
        const cell = dimension.rules[direction][strength];
        if (!Array.isArray(cell) || cell.length === 0) {
          throw new kb.KbError(`维度 ${dimension.id} 的 rules.${direction}.${strength} 为空（每一档都要有动作）`);
        }
      }
    }
    for (const id of dimension.writable) {
      if (!paramIds.has(id)) {
        throw new kb.KbError(`维度 ${dimension.id} 的 writable 含不在 PARAM_IDS 的 id：${id}`);
      }
    }
    for (const word of [
      ...dimension.aliases,
      ...dimension.directionWord.more,
      ...dimension.directionWord.less,
    ]) {
      const owner = wordOwner.get(word);
      if (owner !== undefined && owner !== dimension.id) {
        throw new kb.KbError(`说法 "${word}" 同时出现在 ${owner} 与 ${dimension.id}（词表会歧义）`);
      }
      wordOwner.set(word, dimension.id);
    }
  }
  if (kb.EXPLAIN_ONLY.length < 4) {
    throw new kb.KbError(`EXPLAIN_ONLY 应为 ≥ 4，实际 ${kb.EXPLAIN_ONLY.length}`);
  }
  if (kb.SCENARIOS.length !== 8) {
    throw new kb.KbError(`SCENARIOS 应为 8，实际 ${kb.SCENARIOS.length}`);
  }
  const sceneIds = new Set(kb.SCENE_IDS);
  for (const scenario of kb.SCENARIOS) {
    if (!sceneIds.has(scenario.baseScene)) {
      throw new kb.KbError(`场景 ${scenario.id} 的 baseScene 不在内置场景里：${scenario.baseScene}`);
    }
    for (const action of scenario.patch) {
      const id = kb.paramIdOfAction(action);
      if (!paramIds.has(id)) {
        throw new kb.KbError(`场景 ${scenario.id} 的补丁含不在 PARAM_IDS 的 id：${id}`);
      }
    }
  }
  if (kb.BANDS.length !== 7) {
    throw new kb.KbError(`BANDS 应为 7，实际 ${kb.BANDS.length}`);
  }
  const toggleIds = new Set(targets.TOGGLE_TARGETS);
  for (const conditional of kb.CONDITIONAL_ACTIONS) {
    if (!seenIds.has(conditional.target)) {
      throw new kb.KbError(`条件动作指向未知维度：${conditional.target}`);
    }
    for (const action of conditional.then) {
      const id = kb.paramIdOfAction(action);
      if (!paramIds.has(id)) {
        throw new kb.KbError(`条件动作 ${conditional.target} 含不在 PARAM_IDS 的 id：${id}`);
      }
    }
  }
  for (const target of toggleIds) {
    if (kb.SWITCH_WORDS[target].on.length === 0 || kb.SWITCH_WORDS[target].off.length === 0) {
      throw new kb.KbError(`开关 ${target} 的正/反说法为空`);
    }
  }
}

// ---------------------------------------------------------------------------
// 三种模式
// ---------------------------------------------------------------------------

function runEmit(outputs, kb, targets) {
  const aliasCount = new Set(Object.values(buildAliasMap(kb)).flat()).size;
  for (const [key, file] of Object.entries(OUTPUT_FILES)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, outputs[key], 'utf8');
  }
  console.log(
    `emitted 4 files (dims=${kb.DIMENSIONS.length}, explain=${kb.EXPLAIN_ONLY.length}, ` +
      `scenarios=${kb.SCENARIOS.length}, aliases=${aliasCount}, paramIds=${targets.PARAM_IDS.length})`,
  );
  return 0;
}

function runCheck(outputs) {
  let dirty = 0;
  for (const [key, file] of Object.entries(OUTPUT_FILES)) {
    const actual = readTextOrNull(file);
    const expected = outputs[key];
    if (actual === expected) {
      console.log(`ok    ${rel(file)}`);
      continue;
    }
    dirty += 1;
    console.log(`diff  ${rel(file)}`);
    for (const line of firstDiffLines(expected, actual, 20)) console.log(line);
  }
  if (dirty === 0) {
    console.log('emit --check: 4 个生成物与 kb 一致');
    return 0;
  }
  console.log(`emit --check: ${dirty} 个生成物与 kb 不一致，重跑 emit.mjs 重新生成`);
  return 2;
}

/** 均匀抽样（下标等距取，保证 13 个维度都被覆盖，可复现） */
function sampleEvenly(pool, count) {
  if (pool.length <= count) return [...pool];
  const step = pool.length / count;
  const out = [];
  for (let index = 0; index < count; index += 1) out.push(pool[Math.floor(index * step)]);
  return out;
}

function runAudit(kb, targets) {
  const entries = buildLexiconEntries(kb);
  const explained = kb.EXPLAIN_ONLY;
  const pool = [];
  for (const entry of entries) {
    for (const word of entry.words) {
      pool.push({ utterance: word, target: entry.target, direction: entry.direction });
    }
  }
  const sample = sampleEvenly(pool, 100);
  const misses = [];
  const explainHits = [];
  let matched = 0;
  for (const item of sample) {
    const explanation = explained.find((dim) => dim.aliases.some((word) => item.utterance.includes(word)));
    if (explanation) {
      explainHits.push({ utterance: item.utterance, id: explanation.id });
      continue;
    }
    const hit = entries.find((entry) => entry.words.some((word) => item.utterance.includes(word)));
    if (hit && hit.target === item.target && hit.direction === item.direction) {
      matched += 1;
      continue;
    }
    misses.push({
      utterance: item.utterance,
      expected: `${item.target}/${item.direction}`,
      hit: hit ? `${hit.target}/${hit.direction}` : '未命中',
    });
  }

  const counts = {
    entries: entries.length,
    switches: buildLexicon(kb, targets).switches.length,
    scenes: kb.SCENE_IDS.length,
    scenarios: kb.SCENARIOS.length,
    tones: kb.TONE_IDS.length,
    explainOnly: kb.EXPLAIN_ONLY.length,
  };
  const lexiconTotal =
    counts.entries + counts.switches + counts.scenes + counts.scenarios + counts.tones + counts.explainOnly;
  const aliasTotal = new Set(Object.values(buildAliasMap(kb)).flat()).size;

  console.log(
    `audit: entries=${counts.entries} switches=${counts.switches} scenes=${counts.scenes} ` +
      `scenarios=${counts.scenarios} tones=${counts.tones} explainOnly=${counts.explainOnly} total=${lexiconTotal}`,
  );
  console.log(`audit: aliases=${aliasTotal}（要求 ≥ 100）；说法池=${pool.length}，抽样=${sample.length}`);
  console.log(`audit: 命中 ${matched} / ${sample.length}，未命中 ${misses.length}`);

  for (const item of explainHits.slice(0, 20)) {
    console.log(`  [explainOnly 优先] "${item.utterance}" → ${item.id}（按设计不写参数，不算未命中）`);
  }
  misses.slice(0, 20).forEach((item, index) => {
    console.log(`  miss[${index + 1}] "${item.utterance}" → 期望 ${item.expected}，命中 ${item.hit}`);
  });
  return 0;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function loadContracts() {
  try {
    const kb = await import('./contract/kb.ts');
    const targets = await import('./contract/targets.ts');
    const schemas = await import('./contract/schemas.ts');
    return { kb, targets, schemas };
  } catch (error) {
    console.error(IMPORT_HINT);
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const known = new Set(['--check', '--audit']);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0 || args.length > 1) {
    console.error(`用法：node ... tools/voice/emit.mjs [--check|--audit]（收到：${args.join(' ') || '<无参数>'}）`);
    return 1;
  }

  const { kb, targets, schemas } = await loadContracts();
  try {
    validateKnowledge(kb, targets);
  } catch (error) {
    if (error instanceof kb.KbError) {
      console.error(`知识本体不自洽：${error.message}`);
      return 1;
    }
    throw error;
  }

  if (args[0] === '--audit') return runAudit(kb, targets);

  const outputs = {
    schema: toJsonText(buildPlanSchema(schemas)),
    targets: toJsonText(buildTargetsJson(kb, targets)),
    rules: toJsonText(buildRulesJson(kb, targets)),
    lexicons: toJsonText(buildLexicon(kb, targets)),
  };
  if (args[0] === '--check') return runCheck(outputs);
  return runEmit(outputs, kb, targets);
}

try {
  const code = await main();
  process.exit(code);
} catch (error) {
  console.error(`emit 失败：${error && error.stack ? error.stack : String(error)}`);
  process.exit(1);
}
