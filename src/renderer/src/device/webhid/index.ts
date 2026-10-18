/**
 * WebHID 组件入口。
 *
 * 依赖方向：ui/views/device-view.ts → 本模块 → kit.ts → third_party/web_hid_utils。
 * 任何业务代码都不要直接 import '@webhid-kit'，也不要直接 import 本模块以外的子模块路径。
 */
export type {
  WebHidDeviceHandle,
  WebHidDeviceSummary,
  WebHidErrorCode,
  WebHidKit,
  WebHidKitBridge,
  WebHidMode,
  WebHidReportSample,
  WebHidSessionState,
  WebHidStatus,
} from './types';

export { CHANGE_EVENT, REPORT_EVENT, WebHidSession, errorKeyOf } from './session';
export type { WebHidSessionOptions } from './session';

export { createWebHidKit } from './kit';

import { createWebHidKit } from './kit';
import { WebHidSession } from './session';

/** 装配好的会话：虚拟桥接 + 真机两条通道，桥接地址取套件默认值 */
export function createWebHidSession(options: { bridgeUrl?: string } = {}): WebHidSession {
  return new WebHidSession({ kit: createWebHidKit(), bridgeUrl: options.bridgeUrl });
}
