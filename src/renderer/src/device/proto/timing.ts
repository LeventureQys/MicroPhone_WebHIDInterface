export interface Clock {
  now(): number;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * 所有超时/周期只从这里取（C8）：单测注入自定义 Clock/Timers 即可驱动超时用例，
 * 不必真的 sleep，也不允许业务代码里写死数字。
 */
export const TIMING = Object.freeze({
  requestTimeoutMs: 500,
  requestRetries: 2,
  /**
   * 写合并窗口。取 120 ms：R3-6 要求"拖拽 2 秒产生 120 次写调用、实际出帧 ≤ 20"。
   * 窗口数上限 ≈ ceil(T / W) + 1，而 T 是**实际墙钟时长**（调用方逐条 await 时通常略超 2000 ms），
   * 110 ms 时实测上限会顶到 20（余量 0），120 ms 时上限 18–19，留出余量（见设计 §12 R-22）。
   * 120 ms 的合并延迟对人手拖拽不可感，远小于一次 HID 往返的体感阈值。
   */
  writeThrottleMs: 120,
  pollIntervalMs: 20,
  pollTimeoutMs: 200,
  /**
   * 入站看门狗：轮询开着却连续这么久收不到任何 IN 报告，就判定设备已静默。
   * 轮询超时按 S-f 只丢本次、不报错，所以"拔线"只有这层能识别（R5-3）。
   */
  inboundWatchdogMs: 2000,
  /** 看门狗的检查周期；取 1/4 阈值，判定延迟最多 2.5 s */
  inboundCheckMs: 500,
  syncTimeoutMs: 3000,
  reconnectDelayMs: 500,
  dfuBlockTimeoutMs: 1500,
  dfuProbeTimeoutMs: 1500,
  dfuProbeAttempts: 3,
  dfuRoundRestarts: 3,
  dfuSettleTimeoutMs: 10000,
  dfuInfoFrameBytes: 90,
  dfuBlockBytes: 265,
});

export function defaultClock(): Clock {
  return { now: () => Date.now() };
}

/** 定时器是唯一需要宿主能力的出口，集中在这里，上层只认 Timers 接口 */
export function defaultTimers(): Timers {
  return {
    setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    clearTimeout: (handle: unknown): void => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}
