/**
 * SubStage 5.3 §6：评测指标单测（离线，不碰服务、不联网、不读模型）。
 *
 * ```
 * node --test tools/voice/test/test_eval.mjs
 * ```
 *
 * 六组用例对着任务书 §6 的六条写：
 *   1. `actionSetF1`：完全匹配 / 多一个 op / 少一个 op / 空对空；
 *   2. `refusalRecall` 与 `overRefusal` 各一例，分母 0 返回 0（不是 NaN）；
 *   3. `value` 容差：`eq.band6.gain` 3 对 3.5 通过、3 对 4 不通过；
 *   4. `strengthAcc`：medium 对 slight 不计入分子、medium 对 medium 计入；
 *   5. `compare.mjs` 四条择优规则各触发一次（含"P95 高 12% 降级"）；
 *   6. `config.json` 写入：`tier` 只能是三个值之一。
 *
 * 另加若干"防回归"用例（holdout 固定顺序、音频用例挑选确定、数字接地、L1 校验）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  numberGrounded, sampleF1, matchOps, summarize, validateL1, directionAudit, percentile,
} from '../eval/metrics.mjs';
import {
  checkComparable, choose, buildConfig, tierGate, writeConfig, reproDiff, GATE, modelFileName,
} from '../eval/compare.mjs';
import { loadHoldout, parseHoldout, pickAudioRows, coverageOf, categoryOf } from '../eval/holdout.mjs';
import { lastJsonLine, parseShimLine, TIERS, TIER_NAMES, stamp } from '../eval/run.mjs';
import { resolveTier, scoreCases } from '../eval/audio.mjs';
import { readWavInfo } from '../eval/make-audio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function tune(target, direction, strength) {
  return { kind: 'tune', target, direction, strength };
}

function row(overrides = {}) {
  return {
    id: 'h000001',
    kb: 'muddiness:less:medium',
    text: '声音有点闷',
    expected: { v: 1, status: 'ok', ops: [tune('muddiness', 'less', 'medium')], say: '', confidence: 1 },
    actual: { v: 1, status: 'ok', ops: [tune('muddiness', 'less', 'medium')], say: '', confidence: 1 },
    ms: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. actionSetF1
// ---------------------------------------------------------------------------

test('1a actionSetF1：完全匹配 = 1', () => {
  const expected = [tune('brightness', 'more', 'slight')];
  const actual = [tune('brightness', 'more', 'slight')];
  assert.equal(sampleF1(expected, actual).f1, 1);
  const metrics = summarize([row({ expected: { ...row().expected, ops: expected }, actual: { ...row().actual, ops: actual } })]);
  assert.equal(metrics.actionSetF1, 1);
});

test('1b actionSetF1：多一个 op → 精确率下降（召回仍 1）', () => {
  const expected = [tune('brightness', 'more', 'slight')];
  const actual = [tune('brightness', 'more', 'slight'), tune('muddiness', 'less', 'medium')];
  const score = sampleF1(expected, actual);
  assert.equal(score.recall, 1);
  assert.equal(score.precision, 0.5);
  assert.ok(score.f1 < 1);
});

test('1c actionSetF1：少一个 op → 召回下降（精确率仍 1）', () => {
  const expected = [tune('brightness', 'more', 'slight'), tune('muddiness', 'less', 'medium')];
  const actual = [tune('brightness', 'more', 'slight')];
  const score = sampleF1(expected, actual);
  assert.equal(score.precision, 1);
  assert.equal(score.recall, 0.5);
  assert.ok(score.f1 < 1);
});

test('1d actionSetF1：空期望对空输出 = 1，空期望对多动作 = 0', () => {
  assert.equal(sampleF1([], []).f1, 1);
  assert.equal(sampleF1([], [tune('gate', 'less', 'slight')]).f1, 0);
  assert.equal(sampleF1([tune('gate', 'less', 'slight')], []).f1, 0);
});

test('1e actionSetF1：方向反了不算命中（但 target 相同）', () => {
  const expected = [tune('brightness', 'less', 'medium')];
  const actual = [tune('brightness', 'more', 'medium')];
  const { missedExpected, extraActual } = matchOps(expected, actual);
  assert.equal(missedExpected.length, 1);
  assert.equal(extraActual.length, 1);
  assert.equal(sampleF1(expected, actual).f1, 0);
});

test('1f actionSetF1 宏平均：两样本（1 与 0）→ 0.5', () => {
  const metrics = summarize([
    row(),
    row({
      id: 'h000002',
      actual: { ...row().actual, ops: [tune('warmth', 'more', 'medium')] },
    }),
  ]);
  assert.equal(metrics.actionSetF1, 0.5);
});

// ---------------------------------------------------------------------------
// 2. 拒绝 / 过度拒绝
// ---------------------------------------------------------------------------

test('2a refusalRecall：范围外样本被判 unsupported 才算命中', () => {
  const unsupported = { v: 1, status: 'unsupported', ops: [], say: '', confidence: 1 };
  const metrics = summarize([
    row({ expected: unsupported, actual: unsupported }),
    row({ id: 'h2', expected: unsupported, actual: { ...unsupported, status: 'ok', ops: [tune('gate', 'less', 'slight')] } }),
  ]);
  assert.equal(metrics.refusalSamples, 2);
  assert.equal(metrics.refusalRecall, 0.5);
  assert.equal(metrics.refusalMeasurable, true);
});

test('2b overRefusal：支持类样本被判 unsupported 才算过度拒绝', () => {
  const metrics = summarize([
    row(),
    row({ id: 'h2', actual: { v: 1, status: 'unsupported', ops: [], say: '', confidence: 1 } }),
  ]);
  assert.equal(metrics.overRefusalSamples, 2);
  assert.equal(metrics.overRefusal, 0.5);
});

test('2c 分母为 0 时返回 0，不是 NaN', () => {
  const metrics = summarize([row()]);
  assert.equal(metrics.refusalRecall, 0);
  assert.equal(metrics.refusalSamples, 0);
  assert.equal(metrics.refusalMeasurable, false);
  assert.ok(!Number.isNaN(metrics.refusalRecall));
  assert.ok(!Number.isNaN(metrics.overRefusal));
  const empty = summarize([]);
  assert.equal(empty.refusalRecall, 0);
  assert.equal(empty.overRefusal, 0);
  assert.equal(empty.actionSetF1, 0);
});

// ---------------------------------------------------------------------------
// 3. value 容差
// ---------------------------------------------------------------------------

test('3a eq.band6.gain 容差 ±0.6：期望 3、实际 3.5 通过', () => {
  const expected = [{ kind: 'set', param: 'eq.band6.gain', value: 3 }];
  const actual = [{ kind: 'set', param: 'eq.band6.gain', value: 3.5 }];
  assert.equal(matchOps(expected, actual).pairs.length, 1);
});

test('3b eq.band6.gain 容差 ±0.6：期望 3、实际 4 不通过', () => {
  const expected = [{ kind: 'set', param: 'eq.band6.gain', value: 3 }];
  const actual = [{ kind: 'set', param: 'eq.band6.gain', value: 4 }];
  assert.equal(matchOps(expected, actual).pairs.length, 0);
  assert.equal(sampleF1(expected, actual).f1, 0);
});

test('3c 非增益 set 参数没有容差（band4.freq 250 对 251 不通过）', () => {
  const expected = [{ kind: 'set', param: 'eq.band4.freq', value: 250 }];
  const actual = [{ kind: 'set', param: 'eq.band4.freq', value: 251 }];
  assert.equal(matchOps(expected, actual).pairs.length, 0);
});

test('3d 数字接地：原话里有的数值才算接地', () => {
  assert.equal(numberGrounded('把第三段增益调到6', 6), true);
  assert.equal(numberGrounded('把第七段增益调到-3', -3), true);
  assert.equal(numberGrounded('把第七段增益调到负3', -3), true);
  assert.equal(numberGrounded('把第三段增益调到6', 4), false);
  assert.equal(numberGrounded('调到 13', 3), false);
  assert.equal(numberGrounded('调到 4.5', 4), false);
});

test('3e groundingAcc：输出里的 set 数值都能在原话找到才是 1', () => {
  const grounded = summarize([row({
    text: '把第三段增益调到6',
    expected: { v: 1, status: 'ok', ops: [{ kind: 'set', param: 'eq.band3.gain', value: 6 }], say: '', confidence: 1 },
    actual: { v: 1, status: 'ok', ops: [{ kind: 'set', param: 'eq.band3.gain', value: 6 }], say: '', confidence: 1 },
  })]);
  assert.equal(grounded.groundingSamples, 1);
  assert.equal(grounded.groundingAcc, 1);
  const ungrounded = summarize([row({
    text: '把第三段增益调到6',
    expected: { v: 1, status: 'ok', ops: [{ kind: 'set', param: 'eq.band3.gain', value: 6 }], say: '', confidence: 1 },
    actual: { v: 1, status: 'ok', ops: [{ kind: 'set', param: 'eq.band3.gain', value: 9 }], say: '', confidence: 1 },
  })]);
  assert.equal(ungrounded.groundingAcc, 0);
  assert.equal(ungrounded.groundingOps, 1);
  assert.equal(ungrounded.groundingOpsGrounded, 0);
});

// ---------------------------------------------------------------------------
// 4. strengthAcc
// ---------------------------------------------------------------------------

test('4a strengthAcc：medium 对 slight 不计入分子，medium 对 medium 计入', () => {
  const miss = summarize([row({
    actual: { ...row().actual, ops: [tune('muddiness', 'less', 'slight')] },
  })]);
  assert.equal(miss.strengthSamples, 1);
  assert.equal(miss.strengthAcc, 0);
  const hit = summarize([row()]);
  assert.equal(hit.strengthSamples, 1);
  assert.equal(hit.strengthAcc, 1);
});

test('4b strengthAcc：目标没命中时不计入分母', () => {
  const metrics = summarize([row({
    actual: { ...row().actual, ops: [tune('warmth', 'more', 'medium')] },
  })]);
  assert.equal(metrics.strengthSamples, 0);
  assert.equal(metrics.strengthAcc, 0);
});

// ---------------------------------------------------------------------------
// 5. compare.mjs 四条规则
// ---------------------------------------------------------------------------

function metrics(overrides = {}) {
  return {
    samples: 501,
    validRate: 1,
    actionSetF1: 0.9,
    precision: 0.9,
    recall: 0.9,
    refusalRecall: 1,
    refusalSamples: 10,
    refusalMeasurable: true,
    overRefusal: 0,
    strengthAcc: 0.9,
    groundingAcc: 1,
    p50Ms: 100,
    p95Ms: 200,
    errors: 0,
    ...overrides,
  };
}

test('5a 规则 1：门禁基本项不满足的档不进候选', () => {
  const decision = choose({
    base: metrics({ actionSetF1: 0.5 }),
    'base-fs': metrics({ actionSetF1: 0.88 }),
    ft: metrics({ actionSetF1: 0.95, overRefusal: 0.2 }),
    'ft-fs': metrics({ actionSetF1: 0.4 }),
  });
  assert.equal(decision.chosen, 'base-fs');
  assert.equal(decision.gates.ft.qualified, false, '过度拒绝 0.2 > 0.05 应判不合格');
  assert.equal(decision.gates.base.qualified, false, 'F1 0.5 < 0.85 应判不合格');
  assert.equal(decision.gates['base-fs'].qualified, true);
});

test('5b 规则 2：合格档里取 F1 最高者（四档）', () => {
  const decision = choose({
    base: metrics({ actionSetF1: 0.7 }),
    'base-fs': metrics({ actionSetF1: 0.87 }),
    ft: metrics({ actionSetF1: 0.91 }),
    'ft-fs': metrics({ actionSetF1: 0.9 }),
  });
  assert.equal(decision.chosen, 'ft');
  assert.match(decision.reason, /0\.91/);
  assert.equal(decision.pairs['ft-base'], 0.21);
  assert.equal(decision.pairs['ft-fs-base-fs'], 0.03);
});

test('5c 规则 3：最高者 P95 比 base-fs 高 12% → 降级选 base-fs', () => {
  const decision = choose({
    base: metrics({ actionSetF1: 0.7 }),
    'base-fs': metrics({ actionSetF1: 0.87, p95Ms: 200 }),
    ft: metrics({ actionSetF1: 0.95, p95Ms: 224 }),
    'ft-fs': metrics({ actionSetF1: 0.8, p95Ms: 210 }),
  });
  assert.equal(decision.chosen, 'base-fs');
  assert.match(decision.reason, /降级/);
  // 差 8% 不降级
  const keep = choose({
    base: metrics({ actionSetF1: 0.7 }),
    'base-fs': metrics({ actionSetF1: 0.87, p95Ms: 200 }),
    ft: metrics({ actionSetF1: 0.95, p95Ms: 216 }),
    'ft-fs': metrics({ actionSetF1: 0.8, p95Ms: 210 }),
  });
  assert.equal(keep.chosen, 'ft');
});

test('5d refusalRecall 不可测时门禁记 null（不算通过也不算不通过）', () => {
  const gate = tierGate(metrics({ refusalSamples: 0, refusalMeasurable: false, refusalRecall: 0 }));
  assert.equal(gate.refusalRecall, null);
  assert.equal(gate.measurable.refusalRecall, false);
  assert.equal(gate.qualified, true);
});

test('5e 全员不达标时仍然给出一个档，并说明"相对最好"', () => {
  const decision = choose({
    base: metrics({ actionSetF1: 0.4 }),
    'base-fs': metrics({ actionSetF1: 0.5 }),
    ft: metrics({ actionSetF1: 0.6 }),
    'ft-fs': metrics({ actionSetF1: 0.55 }),
  });
  assert.equal(decision.chosen, 'ft');
  assert.equal(decision.gates.ft.qualified, false);
  assert.ok(decision.notes.some((note) => note.includes('门禁')));
});

test('5f F1 平手时按 ft > ft-fs > base-fs > base 取一个', () => {
  const same = metrics({ actionSetF1: 0.9 });
  const decision = choose({
    base: metrics({ actionSetF1: 0.9 }),
    'base-fs': metrics({ actionSetF1: 0.9 }),
    ft: metrics({ actionSetF1: 0.9 }),
    'ft-fs': metrics({ actionSetF1: 0.9 }),
  });
  assert.equal(decision.chosen, 'ft');
  assert.ok(decision.notes.some((note) => note.includes('平手')));
  const noFt = choose({
    base: metrics({ actionSetF1: 0.9 }),
    'base-fs': metrics({ actionSetF1: 0.9 }),
    ft: metrics({ actionSetF1: 0.2 }),
    'ft-fs': metrics({ actionSetF1: 0.2 }),
  });
  assert.equal(noFt.chosen, 'base-fs');
  void same;
});

test('5g 四档不可比：缺档 / limit 不同 / holdout 哈希不同 / commit 不同都要报出来', () => {
  const report = (limit, sha, commit = 'abc') => ({
    holdout: { limit, sha256: sha, firstId: 'h000001' },
    commit,
  });
  const same = checkComparable({
    base: report(501, 'x'), 'base-fs': report(501, 'x'), ft: report(501, 'x'), 'ft-fs': report(501, 'x'),
  });
  assert.equal(same.ok, true);
  const badLimit = checkComparable({
    base: report(501, 'x'), 'base-fs': report(100, 'x'), ft: report(501, 'x'), 'ft-fs': report(501, 'x'),
  });
  assert.equal(badLimit.ok, false);
  assert.match(badLimit.problems.join('；'), /limit/);
  const badSha = checkComparable({
    base: report(501, 'x'), 'base-fs': report(501, 'y'), ft: report(501, 'x'), 'ft-fs': report(501, 'x'),
  });
  assert.equal(badSha.ok, false);
  const badCommit = checkComparable({
    base: report(501, 'x', 'a'), 'base-fs': report(501, 'x', 'b'), ft: report(501, 'x'), 'ft-fs': report(501, 'x'),
  });
  assert.equal(badCommit.ok, false);
  const missing = checkComparable({ base: report(501, 'x') });
  assert.equal(missing.ok, false);
});

test('5h 复现性：指标差 ≤ 1 个百分点算通过', () => {
  const make = (f1) => ({
    base: { modes: { llm: { metrics: metrics({ actionSetF1: f1 }) } } },
    'base-fs': { modes: { llm: { metrics: metrics({ actionSetF1: 0.8 }) } } },
    ft: { modes: { llm: { metrics: metrics({ actionSetF1: 0.9 }) } } },
    'ft-fs': { modes: { llm: { metrics: metrics({ actionSetF1: 0.85 }) } } },
  });
  const same = reproDiff(make(0.9), make(0.9), 'llm');
  assert.equal(same.worst, 0);
  assert.equal(same.withinOnePoint, true);
  const drift = reproDiff(make(0.9), make(0.875), 'llm');
  assert.equal(drift.withinOnePoint, false);
});

// ---------------------------------------------------------------------------
// 6. config.json
// ---------------------------------------------------------------------------

test('6a config.json：tier 仍是三值，evalTier 记四选一，model 是对应的 GGUF 文件名', () => {
  for (const tier of TIER_NAMES) {
    const config = buildConfig(tier);
    assert.ok(['base', 'fewshot', 'ft'].includes(config.tier), 'tier 必须落在设计文档的三值里');
    assert.equal(config.evalTier, tier);
    assert.equal(config.model, modelFileName(tier));
    assert.equal(config.model, path.basename(TIERS[tier].gguf));
  }
  assert.equal(buildConfig('ft').model, 'Qwen3-1.7B-ft-Q4_K_M.gguf');
  assert.equal(buildConfig('ft-fs').model, 'Qwen3-1.7B-ft-Q4_K_M.gguf');
  assert.equal(buildConfig('base-fs').model, 'Qwen3-1.7B-Q4_K_M.gguf');
  assert.equal(buildConfig('base-fs').tier, 'fewshot');
  assert.equal(buildConfig('ft-fs').tier, 'ft');
  // 纯 system 的两档落地后形态等价于带 few-shot 的那档（生产 llm.py 恒带 few-shot）
  assert.match(buildConfig('ft').servingNote, /ft-fs/);
});

test('6b config.json：写入磁盘后能读回，非法 tier 被拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-eval-config-'));
  const file = path.join(dir, 'config.json');
  writeConfig(buildConfig('base-fs'), file);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.tier, 'fewshot');
  assert.equal(parsed.evalTier, 'base-fs');
  assert.equal(parsed.model, 'Qwen3-1.7B-Q4_K_M.gguf');
  assert.throws(() => buildConfig('teacher'), /tier/);
  assert.throws(() => writeConfig({ tier: 'ft-fs', model: 'x' }, path.join(dir, 'bad.json')), /base\|fewshot\|ft/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 防回归：holdout 顺序、音频用例挑选、L1 校验、输出解析
// ---------------------------------------------------------------------------

test('holdout：--limit 取固定前 N 条，顺序与文件一致', () => {
  const holdout = loadHoldout({ limit: 5 });
  assert.equal(holdout.rows.length, 5);
  assert.equal(holdout.rows[0].id, holdout.all[0].id);
  assert.equal(holdout.rows[4].id, holdout.all[4].id);
  assert.ok(holdout.count >= 100);
  assert.match(holdout.sha256, /^[0-9a-f]{64}$/);
  const twice = loadHoldout({ limit: 5 });
  assert.deepEqual(twice.rows.map((item) => item.id), holdout.rows.map((item) => item.id));
});

test('holdout：坏行直接报错，不静默跳过', () => {
  assert.throws(() => parseHoldout('{"id":"x"}\n'), /缺 text/);
  assert.throws(() => parseHoldout('not json\n'), /不是合法 JSON/);
});

test('音频用例：确定性挑选，覆盖尽量多的类别', () => {
  const holdout = loadHoldout();
  const first = pickAudioRows(holdout.rows, 30);
  const second = pickAudioRows(holdout.rows, 30);
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
  assert.equal(first.length, 30);
  const categories = coverageOf(first);
  assert.ok(Object.keys(categories).length >= 4, `类别覆盖：${JSON.stringify(categories)}`);
  assert.equal(categoryOf('set:eq.band3.gain:null'), 'set');
});

test('L1 校验：合法 plan 通过，非法 plan 给出原因', () => {
  assert.equal(validateL1(row().expected).ok, true);
  assert.equal(validateL1({ ...row().expected, v: 2 }).ok, false);
  assert.equal(validateL1({ ...row().expected, status: 'maybe' }).ok, false);
  assert.equal(validateL1({ v: 1, status: 'ok', ops: [], say: '', confidence: 1 }).ok, true);
  const tooMany = { ...row().expected, ops: new Array(5).fill(tune('gate', 'less', 'slight')) };
  assert.equal(validateL1(tooMany).ok, false);
  assert.equal(validateL1({ ...row().expected, ops: [{ kind: 'tune', target: 'nope', direction: 'less', strength: 'medium' }] }).ok, false);
  // 顶层附加键放行（设计文档 §3.10.1：plan 顶层可带 text）
  assert.equal(validateL1({ ...row().expected, text: '原话' }).ok, true);
  assert.equal(validateL1(null).ok, false);
});

test('directionAudit：整组方向反过来时能看出来', () => {
  const audit = directionAudit([
    row({ actual: { ...row().actual, ops: [tune('muddiness', 'more', 'medium')] } }),
    row({ id: 'h2', actual: { ...row().actual, ops: [tune('muddiness', 'more', 'medium')] } }),
  ]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].opposite, 2);
  assert.equal(audit[0].agree, 0);
});

test('percentile：最近秩口径', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([], 0.95), 0);
});

test('解析：pipeline 输出的最后一行 JSON 与 eval-shim 自述行', () => {
  const stdout = 'noise\n{"turn":"t-1","total_ms":9.4}\n';
  assert.equal(lastJsonLine(stdout).turn, 't-1');
  assert.equal(lastJsonLine('garbage'), null);
  const stderr = '[pipeline] 预热完成 8069ms\n[eval-shim] promptMode=system fewshots=0 systemSha256=abc123 systemChars=6286\n';
  assert.deepEqual(parseShimLine(stderr), {
    promptMode: 'system', fewshotCount: 0, systemSha256: 'abc123', systemChars: 6286,
  });
  assert.equal(parseShimLine('nothing'), null);
});

test('audio：e2eSuccess 要求 applied 且动作集完全一致', () => {
  const expectedById = new Map([['h000001', { plan: row().expected, kb: 'muddiness:less:medium' }]]);
  const applied = scoreCases([{
    id: 'h000001', status: 'applied', plan: row().actual, segments: { total: 30, asr: 20 }, hMs: 10,
  }], expectedById);
  assert.equal(applied.e2eSuccess, 1);
  const mismatch = scoreCases([{
    id: 'h000001', status: 'applied', plan: { ...row().actual, ops: [tune('muddiness', 'more', 'medium')] }, segments: {}, hMs: null,
  }], expectedById);
  assert.equal(mismatch.e2eSuccess, 0);
  const notApplied = scoreCases([{
    id: 'h000001', status: 'needs_confirm', plan: row().actual, segments: {}, hMs: null,
  }], expectedById);
  assert.equal(notApplied.e2eSuccess, 0);
});

test('audio：没给 --tier 时读 tools/voice/config.json', () => {
  const resolved = resolveTier(null);
  assert.ok(TIER_NAMES.includes(resolved.tier));
  assert.ok(typeof resolved.source === 'string');
  assert.equal(resolveTier('base').tier, 'base');
});

test('run.mjs：时间戳形如 yyyyMMdd-HHmmss', () => {
  assert.match(stamp(new Date(2026, 10, 24, 15, 4, 5)), /^20261124-150405$/);
});

test('make-audio：readWavInfo 能从入库 wav 读出 16 kHz/单声道/16 bit', () => {
  const wav = path.join(HERE, 'data', 'wake-sentence.wav');
  const info = readWavInfo(wav);
  assert.equal(info.rate, 16000);
  assert.equal(info.channels, 1);
  assert.equal(info.bits, 16);
  assert.ok(info.durationMs > 500);
});

test('门禁阈值与任务书一致（改阈值必须先改任务书）', () => {
  assert.equal(GATE.actionSetF1, 0.85);
  assert.equal(GATE.refusalRecall, 0.95);
  assert.equal(GATE.overRefusal, 0.05);
  assert.equal(GATE.e2e, 0.7);
  assert.equal(GATE.p95Regression, 0.1);
});
