/**
 * 耐久测试结果分析：读 endurance-<mode>.jsonl / .json，生成可直接贴进报告的汇总。
 *
 *   node scripts/probes/fulltest-endurance-analyze.mjs [--out=<证据目录>]
 *
 * 输出：analysis.md（人读）+ analysis.json（机读）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = 'D:\\WorkShop\\MicroPhone_WebHIDInterface';
const args = new Map(
  process.argv.slice(2).map((item) => {
    const match = item.match(/^--([^=]+)=(.*)$/);
    return match ? [match[1], match[2]] : [item, ''];
  }),
);
const outDir = args.get('out') ? path.resolve(args.get('out')) : path.join(repo, 'artifacts', 'fulltest-20261121', 'endurance');

function loadJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function num(value) {
  const parsed = Number(String(value ?? '0').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function slope(points, key) {
  const valid = points.filter((item) => Number.isFinite(item[key]));
  if (valid.length < 3) return null;
  const meanX = valid.reduce((sum, item) => sum + item.elapsedMin, 0) / valid.length;
  const meanY = valid.reduce((sum, item) => sum + item[key], 0) / valid.length;
  let numerator = 0;
  let denominator = 0;
  for (const item of valid) {
    numerator += (item.elapsedMin - meanX) * (item[key] - meanY);
    denominator += (item.elapsedMin - meanX) ** 2;
  }
  return denominator === 0 ? null : numerator / denominator;
}

function analyzeMode(mode) {
  const samples = loadJsonl(path.join(outDir, `endurance-${mode}.jsonl`)).filter((item) => item.type === 'sample');
  const events = loadJsonl(path.join(outDir, `endurance-${mode}.jsonl`)).filter((item) => item.type === 'event');
  const summaryFile = path.join(outDir, `endurance-${mode}.json`);
  const summary = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8').replace(/^\uFEFF/, '')) : null;
  if (samples.length === 0) {
    return { mode, missing: true, events: events.slice(-10) };
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const notReady = samples.filter((item) => !item.ready);
  const errorTone = samples.filter((item) => item.tone === 'error');
  const notices = samples.filter((item) => Boolean(item.notice));
  const heaps = samples.map((item) => item.heapMB).filter((value) => Number.isFinite(value));
  // status.nodes 在采样时固定是“设备抽屉打开”的结构（采样必须先读诊断卡），
  // 口径一致；Memory.getDOMCounters 的 domNodes 统计含尚未 GC 的 detached 节点，
  // 会随“开/关抽屉”锯齿波动，只作辅助参考。
  const nodes = samples.map((item) => item.nodes).filter((value) => Number.isFinite(value));
  const domCounts = samples.map((item) => item.domNodes).filter((value) => Number.isFinite(value));
  const listeners = samples.map((item) => item.listeners).filter((value) => Number.isFinite(value));
  const statsDelta = {
    out: num(last.stats?.out) - num(first.stats?.out),
    in: num(last.stats?.in) - num(first.stats?.in),
    crc: num(last.stats?.crc) - num(first.stats?.crc),
    timeout: num(last.stats?.timeout) - num(first.stats?.timeout),
    retry: num(last.stats?.retry) - num(first.stats?.retry),
    dropped: num(last.stats?.dropped) - num(first.stats?.dropped),
  };
  const eventKinds = {};
  for (const event of events) eventKinds[event.kind] = (eventKinds[event.kind] ?? 0) + 1;
  const anomalies = [];
  if (notReady.length > 0) anomalies.push(`采样中出现 ${notReady.length} 次非 ready（首次 t=${notReady[0].elapsedMin}m，末次 t=${notReady[notReady.length - 1].elapsedMin}m）`);
  if (errorTone.length > 0) anomalies.push(`采样中出现 ${errorTone.length} 次 tone=error`);
  if (notices.length > 0) anomalies.push(`采样中出现 ${notices.length} 次 console notice：${[...new Set(notices.map((item) => item.notice).filter(Boolean))].slice(0, 3).join(' | ')}`);
  if (statsDelta.crc > 0) anomalies.push(`CRC 错误增加 ${statsDelta.crc}`);
  if (statsDelta.timeout > 0) anomalies.push(`超时增加 ${statsDelta.timeout}`);
  if (statsDelta.retry > 0) anomalies.push(`重试增加 ${statsDelta.retry}`);
  if ((summary?.restarts ?? 0) > 0) anomalies.push(`发生 ${summary.restarts} 次重启`);
  const heapSlope = slope(samples.map((item) => ({ elapsedMin: item.elapsedMin, heapMB: item.heapMB })), 'heapMB');
  if (heapSlope !== null && heapSlope > 0.5) anomalies.push(`JS 堆线性增长 ${heapSlope.toFixed(2)} MB/min（>0.5 视为疑似泄漏）`);
  if (nodes.length >= 2 && nodes[0] > 0 && Math.abs(nodes[nodes.length - 1] - nodes[0]) / nodes[0] > 0.1) {
    anomalies.push(`DOM 节点数变化 ${nodes[0]} → ${nodes[nodes.length - 1]}（>10%）`);
  }
  if (summary?.errors?.length) anomalies.push(`未捕获异常 ${summary.errors.length} 条`);
  const osFile = path.join(outDir, `os-${mode}.jsonl`);
  const osSamples = existsSync(osFile) ? loadJsonl(osFile) : [];
  return {
    mode,
    samples: samples.length,
    durationMin: summary?.durationMin ?? last.elapsedMin,
    phases: [...new Set(events.filter((item) => item.kind === 'phase').map((item) => item.phase))],
    eventKinds,
    restarts: summary?.restarts ?? 0,
    errors: summary?.errors ?? [],
    actions: summary?.actions ?? null,
    writeLatency: summary?.writeLatency ?? null,
    selfCheck: summary?.selfCheckDuration ?? null,
    statsDelta,
    readyRate: samples.length ? Number(((samples.length - notReady.length) / samples.length).toFixed(4)) : null,
    heap: {
      first: heaps[0] ?? null,
      last: heaps[heaps.length - 1] ?? null,
      max: heaps.length ? Math.max(...heaps) : null,
      slopePerMin: heapSlope === null ? null : Number(heapSlope.toFixed(3)),
    },
    nodes: { first: nodes[0] ?? null, last: nodes[nodes.length - 1] ?? null, max: nodes.length ? Math.max(...nodes) : null },
    listeners: { first: listeners[0] ?? null, last: listeners[listeners.length - 1] ?? null },
    os: osSamples,
    finalRestore: summary?.finalRestore ?? null,
    anomalies,
    first,
    last,
  };
}

const modes = ['real', 'mock'].map((mode) => analyzeMode(mode));
const md = [];
md.push('# 耐久测试分析（自动生成）');
md.push('');
md.push(`生成时间：${new Date().toISOString()}`);
md.push('');
for (const item of modes) {
  md.push(`## ${item.mode === 'real' ? '真机 M001' : 'mock UI 高频'}（${item.mode}）`);
  md.push('');
  if (item.missing) {
    md.push('**未找到样本**（任务未完成或未启动）。');
    md.push('');
    continue;
  }
  md.push(`- 时长：**${item.durationMin} 分钟**，采样 **${item.samples}** 次，阶段 ${item.phases.join(' → ')}`);
  md.push(`- 链路 ready 率：**${(item.readyRate * 100).toFixed(2)}%**；重启 **${item.restarts}** 次；未捕获异常 **${item.errors.length}** 条`);
  md.push(`- 诊断计数增量：crc **+${item.statsDelta.crc}** / timeout **+${item.statsDelta.timeout}** / retry **+${item.statsDelta.retry}** / dropped **+${item.statsDelta.dropped}** / 帧 out **+${item.statsDelta.out}** in **+${item.statsDelta.in}**`);
  md.push(`- JS 堆：${item.heap.first} → ${item.heap.last} MB（max ${item.heap.max}），线性斜率 **${item.heap.slopePerMin} MB/min**`);
  md.push(`- DOM 节点：${item.nodes.first} → ${item.nodes.last}（max ${item.nodes.max}）；监听器：${item.listeners.first} → ${item.listeners.last}`);
  if (item.actions) md.push(`- 动作：抽屉 ${item.actions.drawers} / 场景 ${item.actions.scenes} / 写入 ${item.actions.writes} / 自检 ${item.actions.selfChecks} / 语言 ${item.actions.languages} / 截图 ${item.actions.screenshots}`);
  if (item.writeLatency?.count) md.push(`- 写帧时延：${item.writeLatency.count} 次，min ${item.writeLatency.minMs} / avg ${item.writeLatency.avgMs} / max ${item.writeLatency.maxMs} ms`);
  if (item.selfCheck?.count) md.push(`- 自检：${item.selfCheck.count} 次，min ${item.selfCheck.minMs} / avg ${item.selfCheck.avgMs} / max ${item.selfCheck.maxMs} ms，失败 ${item.selfCheck.failures}`);
  if (item.finalRestore) md.push(`- 收尾还原：${item.finalRestore.mismatches === 0 ? '裸 HID 回读 0 失配' : JSON.stringify(item.finalRestore)}`);
  if (item.os.length) {
    const firstOs = item.os[0];
    const lastOs = item.os[item.os.length - 1];
    md.push(`- 进程内存（外部采样 ${item.os.length} 次）：${firstOs.workingSetMB ?? '?'} → ${lastOs.workingSetMB ?? '?'} MB，进程数 ${firstOs.processes ?? '?'} → ${lastOs.processes ?? '?'}`);
  }
  md.push('');
  md.push(item.anomalies.length === 0 ? '**异常：无。**' : `**异常/观察：**\n${item.anomalies.map((line) => `- ${line}`).join('\n')}`);
  md.push('');
  md.push(`事件计数：${JSON.stringify(item.eventKinds)}`);
  md.push('');
  md.push('| 采样点 | 时间(min) | sync | tone | heap(MB) | nodes | out/in | crc/timeout/retry |');
  md.push('|---|---|---|---|---|---|---|---|');
  for (const sample of [item.first, ...(item.samples > 2 ? [item.last] : [])]) {
    if (!sample) continue;
    md.push(`| ${sample === item.first ? '首' : '末'} | ${sample.elapsedMin} | ${sample.sync} | ${sample.tone} | ${sample.heapMB} | ${sample.nodes} | ${sample.stats?.out}/${sample.stats?.in} | ${sample.stats?.crc}/${sample.stats?.timeout}/${sample.stats?.retry} |`);
  }
  md.push('');
}

const verdict = {
  generatedAt: new Date().toISOString(),
  modes,
  overall: modes.every((item) => !item.missing && item.restarts === 0 && item.anomalies.length === 0) ? 'pass' : 'review',
};
writeFileSync(path.join(outDir, 'analysis.md'), `${md.join('\n')}\n`, 'utf8');
writeFileSync(path.join(outDir, 'analysis.json'), `${JSON.stringify(verdict, null, 1)}\n`, 'utf8');
console.log(md.join('\n'));
