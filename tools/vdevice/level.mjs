/**
 * 电平发生器（R5/R7）：正弦 / 阶跃 / 静音三种模式驱动 0x2057。
 *
 * 值域按寄存器定义夹在 0..256（device-stack 里 micLevel 的 raw 范围），
 * 时间轴由调用方传 now，测试里可以喂假时钟而不等真实时间。
 */

export const PATTERNS = Object.freeze(['sine', 'step', 'silence']);
export const DEFAULT_PERIOD_MS = 2000;
export const DEFAULT_STEP_VALUE = 128;
export const LEVEL_MIN = 0;
export const LEVEL_MAX = 256;
const MAX_PERIOD_MS = 3_600_000;

function requireInteger(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer in ${min}..${max}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function clamp(value) {
  if (value < LEVEL_MIN) return LEVEL_MIN;
  if (value > LEVEL_MAX) return LEVEL_MAX;
  return value;
}

export class LevelSource {
  #pattern = 'step';
  #periodMs = DEFAULT_PERIOD_MS;
  #min = LEVEL_MIN;
  #max = LEVEL_MAX;
  #value = DEFAULT_STEP_VALUE;

  /**
   * @param {{pattern?: 'sine'|'step'|'silence', periodMs?: number, min?: number, max?: number, value?: number}} opts
   */
  constructor(opts = {}) {
    this.set(opts);
  }

  /** 控制面改模式；返回改完后的快照 */
  set(opts = {}) {
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) throw new Error('level options must be an object');
    if (opts.pattern !== undefined) {
      if (!PATTERNS.includes(opts.pattern)) {
        throw new Error(`pattern must be one of ${PATTERNS.join('|')}, got ${JSON.stringify(opts.pattern)}`);
      }
      this.#pattern = opts.pattern;
    }
    if (opts.periodMs !== undefined) this.#periodMs = requireInteger(opts.periodMs, 1, MAX_PERIOD_MS, 'periodMs');
    if (opts.min !== undefined) this.#min = requireInteger(opts.min, LEVEL_MIN, LEVEL_MAX, 'min');
    if (opts.max !== undefined) this.#max = requireInteger(opts.max, LEVEL_MIN, LEVEL_MAX, 'max');
    if (this.#min > this.#max) throw new Error(`min ${this.#min} must not exceed max ${this.#max}`);
    if (opts.value !== undefined) this.#value = requireInteger(opts.value, LEVEL_MIN, LEVEL_MAX, 'value');
    return this.snapshot();
  }

  /** 当前电平原始值（0..256 的整数） */
  value(now = Date.now()) {
    if (this.#pattern === 'silence') return LEVEL_MIN;
    if (this.#pattern === 'step') return clamp(this.#value);
    const phase = (2 * Math.PI * now) / this.#periodMs;
    const raw = this.#min + ((this.#max - this.#min) * (1 + Math.sin(phase))) / 2;
    return clamp(Math.round(raw));
  }

  snapshot() {
    return { pattern: this.#pattern, periodMs: this.#periodMs, min: this.#min, max: this.#max, value: this.#value };
  }
}
