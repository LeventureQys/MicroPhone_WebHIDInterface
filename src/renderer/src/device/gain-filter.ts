/**
 * 只读增益显示去抖。
 *
 * 真机 `0x2023`（麦克风增益）/ `0x205A`（耳机增益）是设备 ADC 检出的实时值，
 * 同一档位连续回读会差 1–3；界面每收到一帧就覆盖，数字看起来一直在跳
 * （2026-11-13 反馈：“上位机显示的耳机音量会跳动”）。
 *
 * 这里只处理显示值：取最近 `WINDOW` 次的中间值，并加 `DEADBAND` 死区。
 * 一两次采样抖动被中位数吃掉，真实换档 2–3 帧后跟上；设备侧不做任何写入。
 */
const WINDOW = 5;
/** 与上次显示值相差不超过这个数就不改显示（ADC 抖动幅度按 ±1 计） */
const DEADBAND = 1;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export class ReadonlyGainFilter {
  private readonly windows = new Map<string, number[]>();
  private readonly shown = new Map<string, number>();

  /** 重新连接时清空：上一台设备的采样不能带进新一轮 */
  reset(): void {
    this.windows.clear();
    this.shown.clear();
  }

  /** 收到一次回读 / 设备上报，返回界面应该显示的值 */
  accept(id: string, value: number): number {
    if (!Number.isFinite(value)) return value;
    const window = [...(this.windows.get(id) ?? []), value].slice(-WINDOW);
    this.windows.set(id, window);

    const previous = this.shown.get(id);
    if (previous === undefined) {
      this.shown.set(id, value);
      return value;
    }

    const center = median(window);
    const next = Math.abs(center - previous) <= DEADBAND ? previous : center;
    this.shown.set(id, next);
    return next;
  }
}
