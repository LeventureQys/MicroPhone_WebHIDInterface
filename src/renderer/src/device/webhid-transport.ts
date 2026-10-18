// TODO(联调): 用 navigator.hid 实现 open/write，帧编码见 protocol.ts
import type { LevelFrame, ParamWrite, Transport, TransportState } from './transport';

export const WEBHID_NOT_IMPLEMENTED = 'webhid transport not implemented in alpha';

function notImplemented(): never {
  throw new Error(WEBHID_NOT_IMPLEMENTED);
}

/**
 * Alpha 只定契约：方法体一律抛错，由调用方（AppStore / main）捕获并转为 state 'error'。
 * 不实现字节编解码，参数 → 字节的映射待 HID 报告描述符确认。
 */
export class WebHidTransport implements Transport {
  readonly kind = 'webhid' as const;

  async open(): Promise<void> {
    notImplemented();
  }

  async close(): Promise<void> {
    notImplemented();
  }

  state(): TransportState {
    return notImplemented();
  }

  write(_updates: readonly ParamWrite[]): void {
    notImplemented();
  }

  onLevels(_cb: (frame: LevelFrame) => void): () => void {
    return notImplemented();
  }

  onStateChange(_cb: (state: TransportState) => void): () => void {
    return notImplemented();
  }
}
