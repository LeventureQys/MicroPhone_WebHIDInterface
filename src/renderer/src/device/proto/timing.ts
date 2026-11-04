export interface Clock {
  now(): number;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * 时序常量表。显式声明成 `number` 而不是让 `Object.freeze` 推字面量类型：
 * 否则单测里 `{ requestTimeoutMs: 5 }` 这种覆盖值通不过类型检查。
 */
export interface Timing {
  requestTimeoutMs: number;
  requestRetries: number;
  writeTimeoutMs: number;
  writeRetries: number;
  writeThrottleMs: number;
  writeSettleMs: number;
  writeGraceMs: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  inboundWatchdogMs: number;
  inboundCheckMs: number;
  syncTimeoutMs: number;
  reconnectDelayMs: number;
  dfuBlockTimeoutMs: number;
  dfuProbeTimeoutMs: number;
  dfuProbeAttempts: number;
  dfuRoundRestarts: number;
  dfuSettleTimeoutMs: number;
  dfuReenumTimeoutMs: number;
  dfuReenumPollMs: number;
  /** 重枚举后、发信息帧前的稳定等待：Bootloader 刚枚举时 USB/Flash 还在初始化 */
  dfuEnterSettleMs: number;
  /** DFU 帧拆成 63 B 报告发送时，报告之间的排空间隔（设备 OUT 只有 4 个槽） */
  dfuReportGapMs: number;
  dfuInfoFrameBytes: number;
  dfuBlockBytes: number;
}

/**
 * 所有超时/周期只从这里取（C8）：单测注入自定义 Clock/Timers 即可驱动超时用例，
 * 不必真的 sleep，也不允许业务代码里写死数字。
 */
export const TIMING: Readonly<Timing> = Object.freeze({
  requestTimeoutMs: 500,
  requestRetries: 2,
  /**
   * 写请求的应答超时。真机写参数后固件会把参数落 Flash，写 Flash 期间主循环不响应 USB，
   * 500 ms（读请求的阈值）会被判成超时并重发——重发又触发一次落盘，表现为"越调越卡"，
   * 严重时连续 3 次超时直接把链路打成 error（真机 2026-10-27 反馈的"调节参数后断连"）。
   * 3000 ms 覆盖一次 4 KB 扇区擦除 + 页写的最坏耗时；读请求仍按 `requestTimeoutMs`。
   */
  writeTimeoutMs: 3000,
  /**
   * 写超时的重发次数（只作用于"写 + 超时"这一组合）。
   * 比 `requestRetries` 少一次：协议没有请求序号，重发写会再触发一次落盘，宁可少重发。
   * 校验错 / 设备地址错仍按 `requestRetries` 重试——那说明设备活着，只是这一帧坏了。
   */
  writeRetries: 1,
  /**
   * 写合并窗口。取 120 ms：R3-6 要求"拖拽 2 秒产生 120 次写调用、实际出帧 ≤ 20"。
   * 窗口数上限 ≈ ceil(T / W) + 1，而 T 是**实际墙钟时长**（调用方逐条 await 时通常略超 2000 ms），
   * 110 ms 时实测上限会顶到 20（余量 0），120 ms 时上限 18–19，留出余量（见设计 §12 R-22）。
   * 120 ms 的合并延迟对人手拖拽不可感，远小于一次 HID 往返的体感阈值。
   */
  writeThrottleMs: 120,
  /**
   * 写回执之后暂停电平轮询的时间。落 Flash 通常发生在回执之后（设备先改 RAM 再持久化），
   * 这期间继续 50 Hz 轮询只会制造超时帧、把设备从 Flash 写里反复拽出来；停 600 ms 让设备写完。
   */
  writeSettleMs: 600,
  /**
   * 写后看门狗宽限：从最后一次写帧发出算起，设备静默这么久不算"掉线"。
   * 覆盖 `writeTimeoutMs × (writeRetries + 1)` 再加一点回包余量；超出后仍静默才升级为通道错误。
   */
  writeGraceMs: 8000,
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
  dfuSettleTimeoutMs: 20000,
  /** 进 DFU / 升级完成后等设备重新枚举的上限（协议 §1：复位后 1–3 s 出现） */
  dfuReenumTimeoutMs: 8000,
  /** 重枚举轮询间隔；`getDevices()` 很便宜，200 ms 足够跟上复位节奏 */
  dfuReenumPollMs: 200,
  /**
   * 重枚举成功后先等 1 s 再发信息帧。真机 App→DFU 的正常路径在设备刚枚举时
   * 写到第 11/44 块就会丢块回执；从拔插后的 Bootloader 直连（已稳定数秒）一次写完。
   * 这段时间让 Bootloader 的 USB/Flash 初始化完成，避免把启动阶段的抖动当成写失败。
   */
  dfuEnterSettleMs: 1000,
  /**
   * 一个 265 B 的块帧要拆成 5 个 63 B 报告，而设备 OUT 环形缓冲只有 4 个槽；
   * 报告之间留 2 ms 让主循环取走上一包，否则第 5 个报告可能被丢掉，表现为块回执超时。
   */
  dfuReportGapMs: 2,
  dfuInfoFrameBytes: 90,
  dfuBlockBytes: 265,
});

export function defaultClock(): Clock {
  return { now: () => Date.now() };
}

/**
 * 单测/联调覆盖时序常量用。
 */
export type TimingOverrides = Partial<Timing>;

/** 定时器是唯一需要宿主能力的出口，集中在这里，上层只认 Timers 接口 */
export function defaultTimers(): Timers {
  return {
    setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    clearTimeout: (handle: unknown): void => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}
