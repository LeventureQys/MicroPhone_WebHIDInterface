/** 参数 → 字节的映射待 HID 报告描述符确认，Alpha 只落常量与帧形状，不写编码函数 */

export const HID_REPORT_ID = 0;
export const MAX_PAYLOAD = 64;

export interface HidFrame {
  reportId: number;
  payload: Uint8Array;
}
