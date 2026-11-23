/**
 * M001 刷写基线（2026-11-21 真机 5 次实测后固定）。
 *
 * 这里断言的是"刷写逻辑"里**允许被拿来调的每一个旋钮**。它们不再是随手可改的调参：
 * 改任何一个都必须同时更新
 * `Document/Update/hardware/v0.0.6/固件刷写基线-SOP-20261121.md`
 * 与本节注释里的实测依据，否则下一轮复测的结论就没法与 2026-11-21 的 3/5 基线对比。
 *
 * 2026-11-21 实测（界面 DFU，V0.0.6 同版重刷 5 次）：
 * - R1 21.6 s 成功、R2 22.1 s 成功、R5 21.3 s 成功（均为 658/658 块）
 * - R3 挂死在块 365/658、R4 挂死在块 652/658 —— 两次都导致设备主循环死亡、必须拔插
 * - 结论：失败与节奏无关（两个失败点相差 287 块），是设备侧 Bootloader 擦写问题；
 *   所以**不要再靠调这些参数去"求稳"**，改它们只会让基线失去可比性。
 */
import { describe, expect, it } from 'vitest';
import { BLOCK_BYTES, APP_MAX_BYTES } from '../../../src/renderer/src/device/dfu/image';
import { TIMING } from '../../../src/renderer/src/device/proto/timing';
import { PAYLOAD_BYTES } from '../../../src/renderer/src/device/protocol';

/** 帧头 3 + ADDR 1 + CMD 1 + 载荷 2（DFU_CMD+CHIP_ID）+ CRC 2 */
const BLOCK_FRAME_OVERHEAD = 9;

describe('M001 刷写基线（固定值，改动必须同步 SOP）', () => {
  it('1. 块尺寸：256 B 数据 → 265 B 帧 → 5 条 63 B 报告（设备 OUT 只有 4 槽）', () => {
    expect(BLOCK_BYTES).toBe(256);
    expect(TIMING.dfuBlockBytes).toBe(BLOCK_BYTES + BLOCK_FRAME_OVERHEAD);
    expect(PAYLOAD_BYTES).toBe(63);
    // 265 = 4×63 + 13 → 必须发 5 条报告；这也是"报告间留 2 ms"的由来
    expect(Math.ceil(TIMING.dfuBlockBytes / PAYLOAD_BYTES)).toBe(5);
  });

  it('2. 节奏：报告间隔 2 ms、进 DFU 后稳定 1 s 再发信息帧', () => {
    // 报告间隔 2 ms：不留会被设备 4 槽 OUT 丢掉第 5 包，表现为块回执超时（第五轮已定）
    expect(TIMING.dfuReportGapMs).toBe(2);
    // 重枚举后 1 s：设备刚枚举就写会在第 11/44 块丢回执（第五轮已定）
    expect(TIMING.dfuEnterSettleMs).toBe(1000);
  });

  it('3. 超时与重试：块/探测 1.5 s、探测 3 次、整轮最多 3 次、发帧上限 5 s', () => {
    expect(TIMING.dfuBlockTimeoutMs).toBe(1500);
    expect(TIMING.dfuProbeTimeoutMs).toBe(1500);
    expect(TIMING.dfuProbeAttempts).toBe(3);
    // 整轮重来 = 重发信息帧（设备侧会再次预写 END_FAIL），所以轮数是安全上限而不是手段
    expect(TIMING.dfuRoundRestarts).toBe(3);
    // 2026-11-21 R3：设备挂死后 sendReport 不返回，没有这个上限会话会永久卡死
    expect(TIMING.dfuSendTimeoutMs).toBe(5000);
  });

  it('4. 收尾：重枚举 8 s / 20 ms 轮询、settling 20 s', () => {
    expect(TIMING.dfuReenumTimeoutMs).toBe(8000);
    expect(TIMING.dfuReenumPollMs).toBe(200);
    expect(TIMING.dfuSettleTimeoutMs).toBe(20000);
  });

  it('5. 容量上限：App 区 0x30000（超了会写穿状态字与信息区，只能 SWD 救）', () => {
    expect(APP_MAX_BYTES).toBe(0x30000);
    // V0.0.6 包 168392 B / 658 块，离上限还有 28 KB 余量
    expect(0x30000 - 168392).toBeGreaterThan(0);
  });

  it('6. 单块最坏耗时上限：一轮 658 块的超时预算（用于判断"卡住"是否合理）', () => {
    const worstPerBlock = TIMING.dfuBlockTimeoutMs;
    const roundBudget = 658 * worstPerBlock;
    // 整轮都超时也只是 16 分钟；实际 success/失败观测在 20–22 s 与 73 s 两档
    expect(roundBudget).toBe(987000);
    expect(roundBudget / 1000 / 60).toBeLessThan(20);
  });
});
