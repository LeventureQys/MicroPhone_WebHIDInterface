/** 厂商 HID 通道：Usage Page 0xFF01 / Usage 0x01，OUT 0x51 / IN 0x11（各 63 字节载荷） */
export const REPORT_ID_OUT = 0x51;
export const REPORT_ID_IN = 0x11;
/** 描述符里声明但本版本不用的短报告 */
export const REPORT_ID_OUT_SHORT = 0x50;
export const REPORT_ID_IN_SHORT = 0x10;
export const PAYLOAD_BYTES = 63;
export const MAX_FRAME_BYTES = 512;
export const UNIT_ID = 0x00;

export interface ReportIds {
  readonly out: number;
  readonly in: number;
}

export const DEFAULT_REPORT_IDS: ReportIds = Object.freeze({ out: REPORT_ID_OUT, in: REPORT_ID_IN });

/**
 * 把一整帧切成若干定长载荷，最后一包右侧补 0x00。
 *
 * 只补 0x00：对端靠 Len 判定帧尾，补 0xFF / 0xC4 会在载荷尾部拼出假帧（C1）。
 * 每包都是新分配缓冲，既不与入参共享，也不与其它包共享，调用方可安全地把包交给 HID 队列。
 * 空输入返回空数组——"什么都没发"的错误文案归传输层，本函数不臆造。
 */
export function splitFrame(bytes: Uint8Array, payloadBytes: number = PAYLOAD_BYTES): Uint8Array[] {
  if (!Number.isInteger(payloadBytes) || payloadBytes <= 0) {
    throw new RangeError(`payloadBytes must be a positive integer, got ${payloadBytes}`);
  }
  const reports: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += payloadBytes) {
    const report = new Uint8Array(payloadBytes);
    report.set(bytes.subarray(offset, Math.min(offset + payloadBytes, bytes.length)));
    reports.push(report);
  }
  return reports;
}
