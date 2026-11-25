/**
 * SubStage 5.3 §4.3：三档对照 → 择优 → 写 `tools/voice/config.json`。
 *
 * ```
 * node tools/voice/eval/compare.mjs [--out artifacts/voice] [--dir <用哪个目录的 latest>]
 *                                   [--mode llm|pipeline] [--repro <另一目录>] [--dry-run]
 * ```
 *
 * 四条规则（严格按序，任务书 §4.3）：
 *   1. 门禁基本项不满足（`refusalRecall ≥ 0.95`、`overRefusal ≤ 0.05`）→ 该档不合格；
 *   2. 合格档里取 `actionSetF1` 最高者；
 *   3. 若最高者 P95 比 `fewshot` 高 > 10% → 降级选 `fewshot`；
 *   4. 写 `tools/voice/config.json` 的 `tier` 字段（`scripts/voice.ps1 server` 未给 `--model` 时读它）。
 *
 * 两处任务书没写、这里必须自己定的口径（都写进报告的 `notes`）：
 *   - **门禁用哪个模式**：默认 `llm`（只有它量到模型；`pipeline` 模式 100% 走规则层，
 *     三档必然同值）。`--mode pipeline` 只用于取证对照。
 *   - **`refusalRecall` 分母为 0**（本 holdout 没有 `status=unsupported` 样本）：门禁该项记 `null`
 *     + `measurable.refusalRecall=false`，不当作"不满足"，也不当作"通过"。
 *   - 合格档为空时（例如全部 F1 不达标）仍然写出 `tier`（产品要能起服务），
 *     但 `qualified=false`，并在 `reason` 里说明"无档达标，按 F1 取最高"。
 *
 * 退出码：0 成功 / 2 参数错 / 4 三档不可比（limit 或 holdout 哈希不同）/ 5 报告缺失
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT, VOICE_DIR } from './holdout.mjs';
import { latestReportPath, printMetricsTable, readLatestReport, writeCompareReport, relative } from './report.mjs';
import { TIERS, TIER_NAMES, stamp } from './run.mjs';

export const CONFIG_PATH = path.join(VOICE_DIR, 'config.json');
export const DEFAULT_OUT = path.join(REPO_ROOT, 'artifacts', 'voice');

export const GATE = Object.freeze({
  actionSetF1: 0.85,
  refusalRecall: 0.95,
  overRefusal: 0.05,
  e2e: 0.70,
  p95Regression: 0.10,
});

export const EXIT_OK = 0;
export const EXIT_ARGS = 2;
export const EXIT_INCOMPARABLE = 4;
export const EXIT_MISSING = 5;

/**
 * `tier → gguf 文件名`（`config.json.model` 就是这个名字，设计文档 §3.10.1）
 *
 * 四档里 `base`/`base-fs` 用原始权重、`ft`/`ft-fs` 用学生模型。
 */
export function modelFileName(tier) {
  if (!TIER_NAMES.includes(tier)) throw new Error(`tier 只能是 ${TIER_NAMES.join('|')}，收到 ${tier}`);
  return path.basename(TIERS[tier].gguf);
}

/** 四档 → 设计文档 §3.10.1 的三值 `tier`（`voice.ps1` 只认这三个） */
export const SERVING_TIER = Object.freeze({
  base: 'base',
  'base-fs': 'fewshot',
  ft: 'ft',
  'ft-fs': 'ft',
});

/**
 * 平手时的偏好顺序：先学生模型（R-13 微调进主线），同模型再优先 few-shot 版
 * （生产侧 `llm.py` 的 system 恒带 few-shot，见设计文档 §3.10.1 的实施回填）。
 */
export const TIE_PRIORITY = Object.freeze(['ft', 'ft-fs', 'base-fs', 'base']);

/** 规则 3 的延迟基准：3.3 的默认形态（base + few-shot） */
export const P95_BASELINE = 'base-fs';

export function parseArgs(argv = []) {
  const options = { out: DEFAULT_OUT, dir: null, mode: 'llm', repro: null, dryRun: false };
  const takeValue = (index, flag) => {
    const value = argv[index];
    if (value === undefined) throw new Error(`${flag} 需要一个值`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') options.out = takeValue((index += 1), '--out');
    else if (arg === '--dir') options.dir = takeValue((index += 1), '--dir');
    else if (arg === '--mode') options.mode = takeValue((index += 1), '--mode');
    else if (arg === '--repro') options.repro = takeValue((index += 1), '--repro');
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!['llm', 'pipeline'].includes(options.mode)) throw new Error('--mode 只能是 llm|pipeline');
  options.out = path.resolve(options.out);
  options.dir = path.resolve(options.dir ?? path.join(options.out, 'latest'));
  if (options.repro) options.repro = path.resolve(options.repro);
  return options;
}

// ---------------------------------------------------------------------------
// 纯函数：可单测
// ---------------------------------------------------------------------------

/**
 * 三档是否来自同一次评测条件（§5「三档用了不同的 --limit 立即报错」）。
 * 返回 `{ok, problems}`；`problems` 直接进报告。
 */
export function checkComparable(reports) {
  const problems = [];
  const present = TIER_NAMES.filter((tier) => reports[tier]);
  if (present.length < TIER_NAMES.length) {
    problems.push(`缺档：${TIER_NAMES.filter((tier) => !reports[tier]).join(',')}`);
    return { ok: false, problems };
  }
  const limits = new Set(present.map((tier) => reports[tier].holdout?.limit));
  if (limits.size > 1) {
    problems.push(
      `三档 --limit 不同：${present.map((tier) => `${tier}=${reports[tier].holdout?.limit}`).join(' ')}`,
    );
  }
  const hashes = new Set(present.map((tier) => reports[tier].holdout?.sha256));
  if (hashes.size > 1) problems.push('三档 holdout 不是同一份（sha256 不同）');
  const firstIds = new Set(present.map((tier) => reports[tier].holdout?.firstId));
  if (firstIds.size > 1) problems.push('三档的第一条 id 不同（顺序不一致）');
  const commits = new Set(present.map((tier) => reports[tier].commit ?? 'null'));
  if (commits.size > 1) problems.push(`三档不在同一 commit：${[...commits].join(' / ')}`);
  return { ok: problems.length === 0, problems };
}

/** 单档门禁：`null` 表示该指标不可测（分母 0），既不算通过也不算不通过 */
export function tierGate(metrics) {
  if (!metrics) return { actionSetF1: null, refusalRecall: null, overRefusal: null, qualified: false };
  const refusalMeasurable = Boolean(metrics.refusalMeasurable) && (metrics.refusalSamples ?? 0) > 0;
  const gate = {
    actionSetF1: metrics.actionSetF1 >= GATE.actionSetF1,
    refusalRecall: refusalMeasurable ? metrics.refusalRecall >= GATE.refusalRecall : null,
    overRefusal: metrics.overRefusal <= GATE.overRefusal,
    measurable: { refusalRecall: refusalMeasurable },
  };
  gate.qualified = gate.actionSetF1 !== false
    && gate.refusalRecall !== false
    && gate.overRefusal !== false;
  return gate;
}

/**
 * 四条择优规则（纯函数：输入四档指标，输出结论）。
 *
 * `p95` 用 `metrics.p95Ms`；规则 3 的基准是 `base-fs`（3.3 的默认形态）。
 * 另外给出同提示词的两组对照差值（`ft`−`base`、`ft-fs`−`base-fs`），主判据是前者。
 */
export function choose(metricsByTier) {
  const notes = [];
  const gates = {};
  for (const tier of TIER_NAMES) gates[tier] = tierGate(metricsByTier[tier]);

  const qualified = TIER_NAMES.filter((tier) => gates[tier].qualified);
  const f1 = (tier) => metricsByTier[tier]?.actionSetF1 ?? 0;
  let pool = qualified;
  if (pool.length === 0) {
    notes.push('无档满足门禁基本项（F1/拒绝/过度拒绝），按 F1 取最高者——结论只能算"相对最好"');
    pool = TIER_NAMES.filter((tier) => metricsByTier[tier]);
  }
  if (pool.length === 0) return { chosen: null, reason: '四份指标都为空，无法择优', gates, notes };

  const bestF1 = Math.max(...pool.map((tier) => f1(tier)));
  let winners = pool.filter((tier) => Math.abs(f1(tier) - bestF1) < 1e-9);
  if (winners.length > 1) {
    const preferred = TIE_PRIORITY.find((tier) => winners.includes(tier)) ?? winners[0];
    notes.push(
      `F1 平手（${winners.join('/')} 都是 ${bestF1.toFixed(4)}），按偏好顺序 ` +
        `${TIE_PRIORITY.join(' > ')} 取 ${preferred}`,
    );
    winners = [preferred];
  }
  let chosen = winners[0];
  const baselineP95 = metricsByTier[P95_BASELINE]?.p95Ms ?? 0;
  const chosenP95 = metricsByTier[chosen]?.p95Ms ?? 0;
  const ratio = baselineP95 > 0 ? chosenP95 / baselineP95 : 1;
  if (chosen !== P95_BASELINE && ratio > 1 + GATE.p95Regression) {
    notes.push(
      `${chosen} P95 ${chosenP95.toFixed(1)} ms 比 ${P95_BASELINE} ${baselineP95.toFixed(1)} ms 高 ` +
        `${((ratio - 1) * 100).toFixed(1)}%（> 10%）→ 规则 3 降级选 ${P95_BASELINE}`,
    );
    chosen = P95_BASELINE;
  }

  const parts = [];
  parts.push(
    `F1 ${f1(chosen).toFixed(4)}（${TIER_NAMES.map((tier) => `${tier} ${f1(tier).toFixed(4)}`).join(' / ')}）`,
  );
  const gateText = [];
  for (const [key, value] of Object.entries(gates[chosen] ?? {})) {
    if (key === 'qualified' || key === 'measurable') continue;
    gateText.push(`${key}=${value === null ? '不可测' : value ? '通过' : '未通过'}`);
  }
  parts.push(gateText.join(' '));
  if (baselineP95 > 0) {
    parts.push(
      `P95 ${chosenP95.toFixed(1)} ms 对 ${P95_BASELINE} ${baselineP95.toFixed(1)} ms（` +
        `${ratio - 1 >= 0 ? '+' : ''}${((ratio - 1) * 100).toFixed(1)}%）`,
    );
  }
  const pairs = [
    ['ft', 'base'],
    ['ft-fs', 'base-fs'],
  ];
  for (const [left, right] of pairs) {
    if (!metricsByTier[left] || !metricsByTier[right]) continue;
    const delta = metricsByTier[left].actionSetF1 - metricsByTier[right].actionSetF1;
    parts.push(`${left} 对 ${right} F1 ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`);
  }
  return {
    chosen,
    reason: parts.join('；') + (notes.length ? `；${notes.join('；')}` : ''),
    gates,
    notes,
    pairs: Object.fromEntries(pairs.map(([left, right]) => [
      `${left}-${right}`,
      metricsByTier[left] && metricsByTier[right]
        ? Math.round((metricsByTier[left].actionSetF1 - metricsByTier[right].actionSetF1) * 10000) / 10000
        : null,
    ])),
  };
}

/** 复现性：同一 commit 两次跑，各指标差的最大绝对值（百分点） */
export function reproDiff(current, other, mode) {
  const keys = ['validRate', 'actionSetF1', 'refusalRecall', 'overRefusal', 'strengthAcc', 'groundingAcc'];
  const rows = [];
  let worst = 0;
  for (const tier of TIER_NAMES) {
    const a = current[tier]?.modes?.[mode]?.metrics;
    const b = other[tier]?.modes?.[mode]?.metrics;
    if (!a || !b) continue;
    const deltas = {};
    for (const key of keys) {
      if (!Number.isFinite(a[key]) || !Number.isFinite(b[key])) continue;
      const delta = Math.abs(a[key] - b[key]);
      deltas[key] = Math.round(delta * 10000) / 10000;
      worst = Math.max(worst, delta);
    }
    rows.push({ tier, deltas, p50: [a.p50Ms, b.p50Ms], p95: [a.p95Ms, b.p95Ms] });
  }
  return { rows, worst, withinOnePoint: worst <= 0.01 };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * `config.json`（设计文档 §3.10.1 的契约是 `{"tier","model"}`，`tier` 只认三值）。
 *
 * 四档择优之后：
 *   - `tier` 仍是三值（`voice.ps1` 读它挑 GGUF）：`ft`/`ft-fs` → `ft`，`base-fs` → `fewshot`，`base` → `base`；
 *   - `evalTier` 记四选一的真实结果（评测口径）；
 *   - 生产侧 `llm.py` 的 system 恒带 5 条 few-shot，所以 `ft` 落地后的形态等价于 `ft-fs`，
 *     这条写进 `servingNote`，避免"选了 ft 却以为线上不带 few-shot"。
 */
export function buildConfig(chosen) {
  if (!TIER_NAMES.includes(chosen)) throw new Error(`tier 只能是 ${TIER_NAMES.join('|')}，收到 ${chosen}`);
  const tier = SERVING_TIER[chosen];
  const promptInProduction = TIERS[chosen].promptMode === 'fewshot' ? 'fewshot' : 'fewshot（llm.py 默认恒带 5 条）';
  return {
    v: 1,
    tier,
    evalTier: chosen,
    model: modelFileName(chosen),
    promptMode: promptInProduction,
    chosenAt: new Date().toISOString(),
    source: 'tools/voice/eval/compare.mjs',
    servingNote: chosen === 'ft' || chosen === 'base'
      ? `评测用的是纯 system；线上 pipeline.py → llm.py 恒带 few-shot，落地形态等价于 ${chosen}-fs`
      : '评测与线上提示词一致（system + 5 条 few-shot）',
  };
}

export function writeConfig(config, file = CONFIG_PATH) {
  if (!['base', 'fewshot', 'ft'].includes(config.tier)) {
    throw new Error(`config.json 的 tier 只能是 base|fewshot|ft（设计文档 §3.10.1），收到 ${config.tier}`);
  }
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return file;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[compare] ${error.message}`);
    return EXIT_ARGS;
  }
  if (options.help) {
    console.log(
      '用法：node tools/voice/eval/compare.mjs [--out artifacts/voice] [--dir <latest 目录>]\n' +
        '        [--mode llm|pipeline] [--repro <另一个目录>] [--dry-run]',
    );
    return EXIT_OK;
  }

  const reports = {};
  const missing = [];
  for (const tier of TIER_NAMES) {
    const file = path.join(options.dir, `eval-${tier}.json`);
    if (!fs.existsSync(file)) {
      missing.push(relative(file));
      continue;
    }
    reports[tier] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  if (missing.length > 0) {
    console.error(`[compare] 缺报告：${missing.join(' , ')}`);
    console.error('[compare] 先跑：node tools/voice/eval/run.mjs --tier base|base-fs|ft|ft-fs');
    return EXIT_MISSING;
  }

  const comparable = checkComparable(reports);
  if (!comparable.ok) {
    console.error(`[compare] 四档不可比：${comparable.problems.join('；')}`);
    return EXIT_INCOMPARABLE;
  }

  const metricsByTier = {};
  for (const tier of TIER_NAMES) {
    metricsByTier[tier] = reports[tier]?.modes?.[options.mode]?.metrics ?? null;
  }
  const missingMode = TIER_NAMES.filter((tier) => !metricsByTier[tier]);
  if (missingMode.length > 0) {
    console.error(`[compare] 有档没跑 ${options.mode} 模式：${missingMode.join(',')}`);
    return EXIT_MISSING;
  }

  // 择优只在 llm 模式上做：`pipeline` 模式四档同值（规则层 100% 命中），选不出东西
  const decision = choose(metricsByTier);
  const chosenPipelineGate = tierGate(reports[decision.chosen]?.modes?.pipeline?.metrics ?? null);

  // 音频级（有就并进门禁，没有就记 null）
  let audio = null;
  const audioFile = path.join(options.dir, 'eval-audio.json');
  if (fs.existsSync(audioFile)) {
    audio = JSON.parse(fs.readFileSync(audioFile, 'utf8'));
  }
  const e2eGate = audio ? audio.e2eSuccess >= GATE.e2e : null;

  // pipeline 模式对照（同一批报告里的另一份口径）
  const pipelineMetrics = {};
  for (const tier of TIER_NAMES) pipelineMetrics[tier] = reports[tier]?.modes?.pipeline?.metrics ?? null;
  const pipelineDecision = Object.values(pipelineMetrics).every(Boolean) ? choose(pipelineMetrics) : null;

  const repro = options.repro ? (() => {
    const other = {};
    for (const tier of TIER_NAMES) {
      const file = path.join(options.repro, `eval-${tier}.json`);
      if (fs.existsSync(file)) other[tier] = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    return reproDiff(reports, other, options.mode);
  })() : null;

  const table = TIER_NAMES.map((tier) => ({
    tier,
    mode: options.mode,
    model: reports[tier]?.model?.gguf ?? null,
    promptMode: reports[tier]?.model?.promptMode ?? null,
    f1: metricsByTier[tier].actionSetF1,
    actionSetF1: metricsByTier[tier].actionSetF1,
    precision: metricsByTier[tier].precision,
    recall: metricsByTier[tier].recall,
    validRate: metricsByTier[tier].validRate,
    refusalRecall: metricsByTier[tier].refusalRecall,
    refusalSamples: metricsByTier[tier].refusalSamples,
    overRefusal: metricsByTier[tier].overRefusal,
    strengthAcc: metricsByTier[tier].strengthAcc,
    groundingAcc: metricsByTier[tier].groundingAcc,
    p50Ms: metricsByTier[tier].p50Ms,
    p95Ms: metricsByTier[tier].p95Ms,
    errors: metricsByTier[tier].errors,
    qualified: decision.gates[tier]?.qualified ?? false,
    f1Pipeline: pipelineMetrics[tier]?.actionSetF1 ?? null,
    p95Pipeline: pipelineMetrics[tier]?.p95Ms ?? null,
    routeStats: reports[tier]?.modes?.pipeline?.routeStats ?? null,
  }));

  const report = {
    v: 1,
    kind: 'eval-compare',
    ts: stamp(new Date()),
    chosen: decision.chosen,
    reason: decision.reason,
    // 门禁按**产品交付形态**（pipeline 模式）判：F1/过度拒绝看真实链路，
    // 但报告里同时给 llm 模式的门禁，避免把"规则层拿分"读成"模型变好"
    gate: {
      actionSetF1: chosenPipelineGate.actionSetF1 ?? null,
      refusalRecall: chosenPipelineGate.refusalRecall ?? null,
      overRefusal: chosenPipelineGate.overRefusal ?? null,
      e2e: e2eGate,
    },
    gateBasis: 'pipeline',
    gateLlm: {
      actionSetF1: decision.gates[decision.chosen]?.actionSetF1 ?? null,
      refusalRecall: decision.gates[decision.chosen]?.refusalRecall ?? null,
      overRefusal: decision.gates[decision.chosen]?.overRefusal ?? null,
    },
    gateThresholds: GATE,
    gatesByTier: decision.gates,
    gatesPipelineByTier: Object.fromEntries(TIER_NAMES.map((tier) => [tier, tierGate(pipelineMetrics[tier])])),
    notes: decision.notes,
    pairs: decision.pairs,
    qualified: Boolean(decision.gates[decision.chosen]?.qualified),
    table,
    pipelineCheck: pipelineDecision
      ? {
          chosen: pipelineDecision.chosen,
          reason: pipelineDecision.reason,
          metrics: pipelineMetrics,
          note: 'pipeline 模式四档同值：holdout 由 kb 派生，规则层词表也来自同一份 kb（kb→数据集→解析器闭环），' +
            '因此这是"同源性上限"，不代表真实用户语言；四档取舍不看这一列',
          routeStats: Object.fromEntries(TIER_NAMES.map((tier) => [
            tier,
            reports[tier]?.modes?.pipeline?.routeStats ?? null,
          ])),
        }
      : null,
    audio: audio
      ? {
          ts: audio.ts,
          tier: audio.tier,
          e2eSuccess: audio.e2eSuccess,
          cases: audio.cases?.length ?? 0,
          segments: audio.segments ?? null,
        }
      : null,
    audit: {
      chosen: decision.chosen,
      direction: reports[decision.chosen]?.modes?.[options.mode]?.audit ?? null,
      directionFewshot: reports.fewshot?.modes?.[options.mode]?.audit ?? null,
      directionPipeline: reports[decision.chosen]?.modes?.pipeline?.audit ?? null,
    },
    repro,
    comparable,
    sources: Object.fromEntries(TIER_NAMES.map((tier) => [
      tier,
      {
        ts: reports[tier].ts,
        report: reports[tier].latestOf ?? null,
        holdout: reports[tier].holdout,
        model: reports[tier].model,
        optionLimit: reports[tier].options?.limit,
      },
    ])),
  };

  printMetricsTable(`[compare] 四档指标（mode=${options.mode}，择优基准）`, table);
  if (pipelineDecision) {
    console.log('\n[compare] pipeline 模式（规则层优先；四档同值 = 同源性上限，不作择优依据）');
    for (const tier of TIER_NAMES) {
      const metrics = pipelineMetrics[tier];
      console.log(
        `  ${tier.padEnd(8)} F1=${metrics.actionSetF1.toFixed(4)} ` +
          `route=${JSON.stringify(reports[tier]?.modes?.pipeline?.routeStats ?? {})} ` +
          `P95=${metrics.p95Ms.toFixed(1)}ms`,
      );
    }
    console.log(`  → pipeline 模式按 F1 择优（会全平手）：${pipelineDecision.chosen}`);
  }
  if (audio) {
    console.log(`\n[compare] 音频级：tier=${audio.tier} e2e=${audio.e2eSuccess.toFixed(4)}（门禁 ≥ ${GATE.e2e}）`);
  } else {
    console.log('\n[compare] 音频级：还没有 eval-audio.json（先跑 audio.mjs）');
  }
  if (repro) {
    console.log(
      `\n[compare] 复现性：最大指标差 ${(repro.worst * 100).toFixed(2)} 个百分点 ` +
        `（门禁 ≤ 1）${repro.withinOnePoint ? ' 通过' : ' 未通过'}`,
    );
  }
  console.log(`\n[compare] 择优：${decision.chosen}（llm 模式；pipeline 模式门禁：` +
    `F1=${chosenPipelineGate.actionSetF1 === null ? '不可测' : chosenPipelineGate.actionSetF1 ? '通过' : '未通过'}）`);
  console.log(`[compare] 理由：${decision.reason}`);
  if (decision.pairs) {
    console.log(
      `[compare] 同提示词对照：ft−base=${decision.pairs['ft-base']} ` +
        `ft-fs−base-fs=${decision.pairs['ft-fs-base-fs']}`,
    );
  }

  const written = writeCompareReport(report, options.out);
  console.log(`[compare] 报告：${relative(written.report)}`);

  if (options.dryRun) {
    console.log('[compare] --dry-run：不写 tools/voice/config.json');
  } else {
    const config = buildConfig(decision.chosen);
    const file = writeConfig(config);
    console.log(`[compare] 已写 ${relative(file)}：${JSON.stringify({ tier: config.tier, model: config.model })}`);
  }
  return EXIT_OK;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`[compare] 未捕获异常：${error?.stack ?? error}`);
    process.exit(1);
  });
}
