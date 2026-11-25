/**
 * SubStage_5.1 §6 的 8 条单测。**全部离线**：教师是假的（`complete` 注入），
 * 解析器是假的（`parse` 注入），不碰 8769、不碰 `.venv`，因此可以在任何机器上跑。
 *
 * ```powershell
 * node --test tools/voice/test/test_datagen.mjs
 * ```
 *
 * 真解析器的一致性由 `verify.mjs` 的 CLI 把关（那是启动测试，不是单测）：
 * 单测要验的是"闸门逻辑按契约工作"，不是"词表覆盖多少"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CLASSES,
  DIGIT_POLICY,
  UNEXPRESSIBLE_TUNE_CELLS,
  buildCores,
  clarifyPlan,
  eqPlan,
  explainPlan,
  loadArtifacts,
  scenePlan,
  setPlan,
  togglePlan,
  tonePlan,
  tunePlan,
  unexpressedCellKeys,
  unsupportedPlan,
  validatePlan,
} from '../datagen/templates.mjs';
import { splitRows, verifyRows } from '../datagen/verify.mjs';
import { rewriteCores, seedFor } from '../datagen/rewrite.mjs';

const art = loadArtifacts();
const CORE_LIST = buildCores(art);

// ---------------------------------------------------------------------------
// 假件
// ---------------------------------------------------------------------------

/** "完美解析器"：核心句怎么标的，就怎么回，用来单测闸门本身而不是词表 */
function perfectParser(cores) {
  const byId = new Map(cores.map((core) => [core.id, core]));
  return (items) => {
    const out = new Map();
    for (const item of items) {
      const coreId = String(item.id).split('#')[0];
      const core = byId.get(coreId);
      if (!core) {
        out.set(item.id, null);
        continue;
      }
      if (core.cls === 'explain') {
        out.set(item.id, { v: 1, status: 'unsupported', ops: [], say: core.plan.say, confidence: 1 });
      } else if (core.plan.status === 'ok') {
        out.set(item.id, { v: 1, status: 'ok', ops: core.plan.ops, say: core.plan.say, confidence: 1 });
      } else {
        out.set(item.id, null);
      }
    }
    return out;
  };
}

function fakeParserFromTable(table) {
  return (items) => new Map(items.map((item) => [item.id, table.get(item.text) ?? null]));
}

function okResult(ops) {
  return { v: 1, status: 'ok', ops, say: '', confidence: 1 };
}

/** 造一批原始行：模板行 + n 条"教师行"（文本由造词函数给，默认带句号变化避免撞车） */
function rawRowsFor(cores, { perCore = 2, textFor } = {}) {
  const rows = [];
  const numerals = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  for (const core of cores) {
    core.texts.forEach((text) => rows.push({ coreId: core.id, n: 0, src: 'template', text }));
    if (core.rewrite === false) continue;
    for (let n = 0; n < perCore; n += 1) {
      const base = core.texts[0].slice(0, 22);
      const text = textFor ? textFor(core, n, base) : `${base}${numerals[n % 10]}啊`;
      rows.push({ coreId: core.id, n, src: 'teacher', text });
    }
  }
  return rows;
}

function miniCore(overrides) {
  return {
    id: 'c9001',
    cls: 'tune',
    family: 'test',
    kb: 'muddiness:less:medium',
    leakKeys: ['muddiness:less:medium'],
    plan: tunePlan(art, { target: 'muddiness', direction: 'less', strength: 'medium' }),
    texts: ['声音有点闷'],
    rewrite: true,
    adversarial: false,
    ...overrides,
  };
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// 1. 模板生成：78 个 tune 格全覆盖（除词表不可表达的 1 格）
// ---------------------------------------------------------------------------

test('1. tune 核心句覆盖 13 维度 × 2 方向 × 3 档', () => {
  const cells = new Map();
  for (const core of CORE_LIST) {
    if (core.cls !== 'tune' || !core.family.startsWith('tune.')) continue;
    cells.set(core.family, (cells.get(core.family) ?? 0) + core.texts.length);
  }
  const expected = [];
  for (const dim of art.dims) {
    for (const direction of art.directions) {
      for (const strength of art.strengths) {
        expected.push(`tune.${dim.id}.${direction}.${strength}`);
      }
    }
  }
  assert.equal(expected.length, 78, '13 × 2 × 3 应为 78 格');
  const missing = expected.filter((key) => !cells.has(key) && !UNEXPRESSIBLE_TUNE_CELLS.includes(key));
  assert.deepEqual(missing, [], `缺少的格子：${missing.join(',')}`);
  const thin = [...cells.entries()].filter(([, count]) => count < 3);
  assert.deepEqual(thin, [], `每格至少 3 条不同表述，实为：${JSON.stringify(thin)}`);
  // 唯一例外：harshness.more 的三条说法都自带"一点"，medium 档词表里不可表达
  assert.ok(UNEXPRESSIBLE_TUNE_CELLS.every((key) => expected.includes(key)));
  assert.equal(cells.size + UNEXPRESSIBLE_TUNE_CELLS.length, 78);
  // 例外清单只有这一格，且 manifest 里写成 `<target>.<direction>.<strength>`
  assert.equal(UNEXPRESSIBLE_TUNE_CELLS.length, 1);
  assert.deepEqual(unexpressedCellKeys(), ['harshness.more.medium']);
  // 数字口径写死（任务书 2026-11-24 裁决 1）
  assert.deepEqual({ ...DIGIT_POLICY }, {
    teacher: 'no-arabic-digits',
    set: 'template-only',
    eqCenterHz: 'template-only',
  });
});

// ---------------------------------------------------------------------------
// 2. 改写结果含阿拉伯数字 → 丢弃（has-digit）
// ---------------------------------------------------------------------------

test('2. 含阿拉伯数字的改写句被丢弃并记为 has-digit', () => {
  const core = miniCore();
  const table = new Map([
    ['声音闷一点', okResult(core.plan.ops)],
    ['声音闷3分贝', okResult(core.plan.ops)],
  ]);
  const result = verifyRows({
    cores: [core],
    art,
    rawRows: [
      { coreId: core.id, n: 0, src: 'teacher', text: '声音闷一点' },
      { coreId: core.id, n: 1, src: 'teacher', text: '声音闷3分贝' },
    ],
    parse: fakeParserFromTable(table),
  });
  assert.equal(result.stats.counts.total, 1);
  const reasons = result.stats.rejectedTop.map((bucket) => bucket.reason);
  assert.ok(reasons.includes('has-digit'), `rejected 里应有 has-digit，实为 ${reasons.join(',')}`);
  assert.equal(result.rows[0].text, '声音闷一点');
});

// ---------------------------------------------------------------------------
// 3. 语义不一致（教师把"闷"改写成"亮"）→ 丢弃并计入 rejected
// ---------------------------------------------------------------------------

test('3. 语义不一致的改写句被丢弃并计入 rejected', () => {
  const core = miniCore();
  const wrong = okResult([{ kind: 'tune', target: 'brightness', direction: 'more', strength: 'medium' }]);
  const table = new Map([['声音更亮了', wrong]]);
  const result = verifyRows({
    cores: [core],
    art,
    rawRows: [{ coreId: core.id, n: 0, src: 'teacher', text: '声音更亮了' }],
    parse: fakeParserFromTable(table),
  });
  assert.equal(result.stats.counts.total, 0);
  assert.equal(result.stats.counts.rejected, 1);
  assert.equal(result.stats.rejectedTop[0].reason, 'ops-mismatch');
  assert.equal(result.stats.semanticConsistency, 0);
});

// ---------------------------------------------------------------------------
// 4. 去重：同一句重复 3 次只留 1 条
// ---------------------------------------------------------------------------

test('4. 同一句重复三次只留一条（deduped=2）', () => {
  const core = miniCore();
  const accepted = okResult(core.plan.ops);
  // 三句归一化后相同：空白与句末标点由 normalizeText 抹掉（任务书 §4.4 第 2 条）
  const table = new Map([
    ['声音有点发闷', accepted],
    ['声音有点发闷。', accepted],
    ['声音 有点发闷', accepted],
  ]);
  const result = verifyRows({
    cores: [core],
    art,
    rawRows: [
      { coreId: core.id, n: 0, src: 'teacher', text: '声音有点发闷' },
      { coreId: core.id, n: 1, src: 'teacher', text: '声音有点发闷。' },
      { coreId: core.id, n: 2, src: 'teacher', text: '声音 有点发闷' },
    ],
    parse: fakeParserFromTable(table),
  });
  assert.equal(result.stats.counts.total, 1);
  assert.equal(result.deduped, 2);
});

// ---------------------------------------------------------------------------
// 5. 分集：train 与 holdout 的 kb 键交集为空
// ---------------------------------------------------------------------------

test('5. 分集按 kb 键分组，train/holdout 键交集为空', () => {
  const result = verifyRows({
    cores: CORE_LIST,
    art,
    rawRows: rawRowsFor(CORE_LIST, { perCore: 2 }),
    parse: perfectParser(CORE_LIST),
    seed: 20261124,
  });
  assert.ok(result.stats.counts.train > 0 && result.stats.counts.holdout > 0);
  const { train, holdout } = result.split.splitKeys;
  const overlap = train.filter((key) => holdout.includes(key));
  assert.deepEqual(overlap, [], `交集应为空，实为 ${overlap.join(',')}`);
  // 反向再验一遍行级：任何一行的任一 leakKey 都不得出现在对侧
  const sideOf = new Map();
  for (const row of result.rows) {
    for (const key of row.leakKeys) {
      const seen = sideOf.get(key);
      assert.ok(seen === undefined || seen === row.split, `kb 键 ${key} 跨了 split`);
      sideOf.set(key, row.split);
    }
  }
  // holdout 里每个键的样本数 ≥ 3（太小的键整块回 train）
  const holdCounts = new Map();
  for (const row of result.rows.filter((item) => item.split === 'holdout')) {
    for (const key of row.leakKeys) holdCounts.set(key, (holdCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of holdCounts) {
    assert.ok(count >= 3, `holdout 键 ${key} 只有 ${count} 条`);
  }
  // 同 seed 重跑一次，行级切分一致（可复现）
  const again = verifyRows({
    cores: CORE_LIST,
    art,
    rawRows: rawRowsFor(CORE_LIST, { perCore: 2 }),
    parse: perfectParser(CORE_LIST),
    seed: 20261124,
  });
  assert.deepEqual(
    again.rows.map((row) => [row.text, row.split]),
    result.rows.map((row) => [row.text, row.split]),
  );
});

// ---------------------------------------------------------------------------
// 6. --resume：跑一半中断再续跑，产物哈希与一次跑完相同
// ---------------------------------------------------------------------------

test('6. 断点续跑与一次跑完的 raw.jsonl 逐字节一致', async () => {
  const cores = CORE_LIST.slice(0, 40).map((core) => ({ ...core, rewrite: true }));
  const dir = makeTempDir('voice-resume-');
  const complete = async (prompt, { seed }) => {
    // 假教师：输出由 (prompt, seed) 决定，确定性
    const digest = crypto.createHash('sha1').update(`${prompt}|${seed}`).digest('hex').slice(0, 6);
    return `改写${digest}`;
  };

  const fullOut = path.join(dir, 'full.jsonl');
  const fullDone = path.join(dir, 'full-done.txt');
  const full = await rewriteCores({
    cores,
    perCore: 2,
    complete,
    outPath: fullOut,
    donePath: fullDone,
    resume: false,
    now: () => 0,
  });
  assert.equal(full.coresDone, cores.length);

  const partOut = path.join(dir, 'part.jsonl');
  const partDone = path.join(dir, 'part-done.txt');
  const firstHalf = cores.slice(0, 20).map((core) => core.id);
  await rewriteCores({
    cores: cores.filter((core) => firstHalf.includes(core.id)),
    perCore: 2,
    complete,
    outPath: partOut,
    donePath: partDone,
    resume: false,
    now: () => 0,
  });
  const resumed = await rewriteCores({
    cores,
    perCore: 2,
    complete,
    outPath: partOut,
    donePath: partDone,
    resume: true,
    now: () => 0,
  });
  assert.equal(resumed.coresSkipped, 20);
  assert.equal(resumed.coresDone, 20);

  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(hash(partOut), hash(fullOut), '续跑产物必须与一次跑完逐字节一致');
  // 种子只取决于 (coreId, n)：续跑前后同一格拿到同一个种子
  assert.equal(seedFor('c0001', 3), seedFor('c0001', 3));
  assert.notEqual(seedFor('c0001', 3), seedFor('c0001', 4));
});

// ---------------------------------------------------------------------------
// 7. plan 结构自检：8 种 kind 各一条合法 + 3 条非法
// ---------------------------------------------------------------------------

test('7. plan 自检：8 种 op 全合法，3 条非法样本被拒', () => {
  const legal = [
    tunePlan(art, { target: 'brightness', direction: 'more', strength: 'slight' }),
    eqPlan(art, { band: 4, field: 'gain', direction: 'less', strength: 'medium' }),
    eqPlan(art, { centerHz: 4000, field: 'q', direction: 'more', strength: 'strong' }),
    togglePlan(art, { target: 'gate', on: false }),
    setPlan(art, { param: 'eq.band6.gain', value: 3, band: 6, field: 'gain' }),
    scenePlan(art, { scene: 'game' }),
    tonePlan(art, { tone: 'warm' }),
    { v: 1, status: 'ok', ops: [{ kind: 'undo' }], say: '撤销刚才那一步', confidence: 1 },
  ];
  assert.equal(legal.length, 8);
  legal.forEach((plan, index) => {
    const check = validatePlan(plan, art);
    assert.ok(check.ok, `第 ${index + 1} 条合法样本被判非法：${check.errors.join('; ')}`);
  });
  // 8 种 kind 都出现过
  const kinds = new Set();
  for (const plan of legal) for (const op of plan.ops) kinds.add(op.kind);
  assert.deepEqual([...kinds].sort(), ['eq', 'scene', 'set', 'toggle', 'tone', 'tune', 'undo']);

  const illegal = [
    { v: 1, status: 'ok', ops: [{ kind: 'tune', target: 'loudnesss', direction: 'more', strength: 'slight' }], say: 'x', confidence: 1 },
    { v: 1, status: 'ok', ops: [], say: 'x', confidence: 1 },
    { v: 1, status: 'ok', ops: [{ kind: 'set', param: 'gain.Mic', value: 1 }], say: 'x', confidence: 1 },
  ];
  illegal.forEach((plan, index) => {
    const check = validatePlan(plan, art);
    assert.equal(check.ok, false, `第 ${index + 1} 条非法样本没被拒`);
    assert.ok(check.errors.length > 0);
  });
  // explainOnly 的解释句按 3.2 §10 不截断，但普通 plan 卡 30 字
  const explain = explainPlan(art, { id: 'echo' });
  assert.ok(validatePlan(explain, art, { allowLongSay: true }).ok);
});

// ---------------------------------------------------------------------------
// 8. 对抗样本占比在 8%–12%
// ---------------------------------------------------------------------------

test('8. 对抗样本占比落在 8%–12%', () => {
  const result = verifyRows({
    cores: CORE_LIST,
    art,
    rawRows: rawRowsFor(CORE_LIST, { perCore: 2 }),
    parse: perfectParser(CORE_LIST),
    seed: 20261124,
  });
  const ratio = result.stats.adversarialRatio;
  assert.ok(ratio >= 0.08 && ratio <= 0.12, `对抗样本占比 ${(ratio * 100).toFixed(2)}% 不在 8%–12%`);
  // 8 类都非空
  for (const name of CLASSES) {
    assert.ok((result.stats.byClass[name] ?? 0) > 0, `类别 ${name} 为空`);
  }
  // 每行 plan 都合法（任务书 §4.1）
  let checked = 0;
  for (const row of result.rows) {
    const check = validatePlan(row.plan, art, { allowLongSay: row.kb.startsWith('outofscope:echo') || row.kb.startsWith('outofscope:plosive') || row.kb.startsWith('outofscope:hum') || row.kb.startsWith('outofscope:bgm') });
    assert.ok(check.ok, `${row.id} 的 plan 不合法：${check.errors.join('; ')}`);
    checked += 1;
  }
  assert.equal(checked, result.rows.length);
  // clarify / 范围外 标签形态
  assert.equal(unsupportedPlan().status, 'unsupported');
  assert.equal(clarifyPlan().status, 'clarify');
  assert.deepEqual(clarifyPlan().ops, []);
});
