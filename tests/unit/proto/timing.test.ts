import { describe, expect, it } from 'vitest';
import { defaultClock, defaultTimers, TIMING } from '../../../src/renderer/src/device/proto/timing';

/** 设计文档 §5.4.4 原文（刻意内联，不从 TIMING 反读，否则等于自证） */
const EXPECTED_TIMING = {
  requestTimeoutMs: 500,
  requestRetries: 2,
  writeThrottleMs: 120,
  pollIntervalMs: 20,
  pollTimeoutMs: 200,
  inboundWatchdogMs: 2000,
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
};

describe('TIMING', () => {
  it('16 个字段值与设计文档 §5.4.4 逐字一致', () => {
    expect({ ...TIMING }).toEqual(EXPECTED_TIMING);
    expect(Object.keys(TIMING)).toHaveLength(16);
  });

  it('对象被冻结，运行期改不动（C8：时间常量只读且集中）', () => {
    expect(Object.isFrozen(TIMING)).toBe(true);

    expect(() => Object.assign(TIMING, { requestTimeoutMs: 1 })).toThrow(TypeError);
    expect(TIMING.requestTimeoutMs).toBe(500);
  });
});

describe('defaultClock', () => {
  it('走 Date.now：取值落在调用前后的时间戳之间', () => {
    const clock = defaultClock();
    const before = Date.now();
    const now = clock.now();
    const after = Date.now();

    expect(Number.isInteger(now)).toBe(true);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('每次调用返回独立实例', () => {
    expect(defaultClock()).not.toBe(defaultClock());
  });
});

describe('defaultTimers', () => {
  it('setTimeout 在指定毫秒后回调一次', async () => {
    const timers = defaultTimers();
    let fired = 0;

    await new Promise<void>((resolve) => {
      timers.setTimeout(() => {
        fired += 1;
        resolve();
      }, 0);
    });

    expect(fired).toBe(1);
  });

  it('clearTimeout 能取消未触发的定时器', async () => {
    const timers = defaultTimers();
    let fired = 0;

    const handle = timers.setTimeout(() => {
      fired += 1;
    }, 5);
    timers.clearTimeout(handle);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });

    expect(fired).toBe(0);
  });

  it('每次调用返回独立实例', () => {
    expect(defaultTimers()).not.toBe(defaultTimers());
  });
});
