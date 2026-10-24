/**
 * 故障注入规则表（R7-4）：纯匹配逻辑，动作的实际执行在侧车。
 *
 * 规则按数组顺序匹配，首条命中即返回；`nth` 计的是"同一规则第几次遇到匹配的帧"，
 * 所以计数器必须留在表里而不是规则里 —— 规则本身是可序列化的配置。
 */

export const ACTIONS = Object.freeze([
  'drop',
  'delay',
  'dropAck',
  'crcError',
  'ackError',
  'statusFail',
  'powerLoss',
  'disconnect',
  'sticky',
]);

const MODES = Object.freeze(['app', 'bootloader', 'any']);
const PHASES = Object.freeze(['info', 'block', 'any']);
const MAX_TOTAL_MS = 600_000;
const DEFAULT_DELAY_MS = 200;
const DEFAULT_DISCONNECT_MS = 300;
const ACK_CODE_MAX = 5;

/**
 * 命中后由侧车改写/丢弃回执的动作，与"喂之前拦截"的动作分开。
 *
 * `statusFail` 改的是 DFU 状态帧（`CMD 0x0B`）的 STATUS 字节：复现"设备自己算完累加校验和、
 * 发现不符回 0x04"（R6-7 / 验收 A30）。它与 `ackError` 语义不同：ACK 表示整帧被丢弃、
 * Flash 指针没前进；状态帧表示那一块**已经被处理过**，上位机只能中止或整轮重来。
 */
export const REPLY_ACTIONS = Object.freeze(['dropAck', 'crcError', 'ackError', 'statusFail', 'sticky']);
const DELAYED_ACTIONS = Object.freeze(['delay', 'disconnect']);

function requireInteger(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer in ${min}..${max}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function normalizeOn(raw, where) {
  if (raw === undefined) return { mode: 'any', phase: 'any', func: undefined, dfuCmd: undefined, nth: undefined };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where}.on must be an object`);
  const mode = raw.mode === undefined ? 'any' : raw.mode;
  if (!MODES.includes(mode)) throw new Error(`${where}.on.mode must be one of ${MODES.join('|')}, got ${JSON.stringify(raw.mode)}`);
  const phase = raw.phase === undefined ? 'any' : raw.phase;
  if (!PHASES.includes(phase)) throw new Error(`${where}.on.phase must be one of ${PHASES.join('|')}, got ${JSON.stringify(raw.phase)}`);
  const func = raw.func === undefined ? undefined : requireInteger(raw.func, 0, 0x7f, `${where}.on.func`);
  const dfuCmd = raw.dfuCmd === undefined ? undefined : requireInteger(raw.dfuCmd, 0, 0x7f, `${where}.on.dfuCmd`);
  // nth: 0 没有意义（规则永远不命中），当成配置错误而不是静默忽略
  const nth = raw.nth === undefined ? undefined : requireInteger(raw.nth, 1, Number.MAX_SAFE_INTEGER, `${where}.on.nth`);
  return { mode, phase, func, dfuCmd, nth };
}

function normalizeRule(raw, index) {
  const where = `faults[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} must be an object`);
  if (!ACTIONS.includes(raw.action)) {
    throw new Error(`${where}.action must be one of ${ACTIONS.join('|')}, got ${JSON.stringify(raw.action)}`);
  }
  const on = normalizeOn(raw.on, where);
  const times = raw.times === undefined ? 1 : requireInteger(raw.times, 0, Number.MAX_SAFE_INTEGER, `${where}.times`);
  const rule = { on, action: raw.action, times, ms: undefined, code: undefined };
  // ms / code 只在各自动作里有意义，但配置里多写不报错：手写脚本常照抄整条形状
  if (raw.ms !== undefined) rule.ms = requireInteger(raw.ms, 0, MAX_TOTAL_MS, `${where}.ms`);
  if (raw.code !== undefined) rule.code = requireInteger(raw.code, 0, ACK_CODE_MAX, `${where}.code`);
  if (DELAYED_ACTIONS.includes(raw.action) && rule.ms === undefined) {
    rule.ms = raw.action === 'delay' ? DEFAULT_DELAY_MS : DEFAULT_DISCONNECT_MS;
  }
  if (raw.action === 'ackError' && rule.code === undefined) {
    throw new Error(`${where}.code is required for ackError`);
  }
  return rule;
}

/** 校验并归一故障规则；不合法抛 Error（信息里带索引），侧车据此回 400 */
export function parseFaults(raw) {
  if (!Array.isArray(raw)) throw new Error('faults must be an array');
  return raw.map((entry, index) => normalizeRule(entry, index));
}

function onMatches(on, context) {
  if (on.mode !== 'any' && on.mode !== context.mode) return false;
  if (on.phase !== 'any' && on.phase !== context.phase) return false;
  if (on.func !== undefined && on.func !== context.func) return false;
  if (on.dfuCmd !== undefined && on.dfuCmd !== context.dfuCmd) return false;
  return true;
}

export class FaultTable {
  #rules = [];
  #seen = [];
  #used = [];
  #fired = 0;

  constructor(rules = []) {
    this.set(rules);
  }

  /** 整体替换规则表并清零计数（控制面 POST /control/faults 用） */
  set(rules = []) {
    this.#rules = parseFaults(rules);
    this.#seen = this.#rules.map(() => 0);
    this.#used = this.#rules.map(() => 0);
    this.#fired = 0;
    return this.#rules.length;
  }

  size() {
    return this.#rules.length;
  }

  /**
   * @param {{mode?: string, func?: number, dfuCmd?: number, phase?: string}} ctx
   * @returns {null | {on: object, action: string, times: number, ms?: number, code?: number}}
   */
  match(ctx) {
    if (!ctx || typeof ctx !== 'object') return null;
    for (let index = 0; index < this.#rules.length; index += 1) {
      const rule = this.#rules[index];
      if (!onMatches(rule.on, ctx)) continue;
      this.#seen[index] += 1;
      if (rule.on.nth !== undefined && this.#seen[index] < rule.on.nth) continue;
      if (rule.times !== 0 && this.#used[index] >= rule.times) continue;
      return rule;
    }
    return null;
  }

  /** 命中后调用，推进 times 计数；返回该规则是否已用尽 */
  consume(rule) {
    const index = this.#rules.indexOf(rule);
    if (index < 0) return true;
    this.#used[index] += 1;
    this.#fired += 1;
    return rule.times !== 0 && this.#used[index] >= rule.times;
  }

  reset() {
    this.#seen = this.#rules.map(() => 0);
    this.#used = this.#rules.map(() => 0);
    this.#fired = 0;
  }

  /** 已触发的规则命中次数（控制面 stats.faultsFired） */
  fired() {
    return this.#fired;
  }
}
