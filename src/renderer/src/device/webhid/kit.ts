/**
 * 唯一 import '@webhid-kit' 的地方：把子模块的原生 ESM 收成 ./types.ts 的契约。
 *
 * 上游是第三方代码（third_party/web_hid_utils），这里只做适配不改行为：
 * 虚拟设备走 installVirtualHid 装上的 navigator.hid 替身，真机走原生 navigator.hid。
 */
import {
  BRIDGE_PROTOCOL,
  DEFAULT_BRIDGE_URL,
  VERSION,
  getNativeDevices,
  installVirtualHid,
  isNativeWebHidAvailable,
  requestNativeHidDevice,
  type KitNativeHIDDevice,
} from '@webhid-kit';
import type { WebHidDeviceHandle, WebHidKit, WebHidKitBridge, WebHidUsageFilter } from './types';

/**
 * 真机句柄的身份字段在 `handle.device` 上，`NativeHidHandle` 自己不转发；
 * 会话侧（`device/webhid/session.ts`）按契约直接读 `vendorId/productId`，缺了会抛
 * `Cannot read properties of undefined`，整条真机链路在枚举阶段就断。这里补一层薄适配，
 * 不改子模块（只读引用），方法一律转发到上游句柄，`opened` 用取值器保持实时。
 */
function adaptNativeHandle(handle: KitNativeHIDDevice): WebHidDeviceHandle {
  const raw = handle.device;
  return {
    vendorId: raw.vendorId,
    productId: raw.productId,
    productName: raw.productName ?? '',
    get opened() {
      return handle.opened;
    },
    open: () => handle.open(),
    close: () => handle.close(),
    // 上游 sendReport 内部按 W3C 规则校验 opened，这里不重复判断
    sendReport: (reportId, data) => handle.sendReport(reportId, data),
    addEventListener: (type, listener) => {
      handle.addEventListener(type, listener);
    },
    removeEventListener: (type, listener) => {
      handle.removeEventListener(type, listener);
    },
    decode: (reportType, reportId, data) => handle.decode?.(reportType, reportId, data) ?? { values: {} },
  };
}

export function createWebHidKit(): WebHidKit {
  return {
    version: VERSION,
    bridgeUrl: DEFAULT_BRIDGE_URL,
    bridgeProtocol: BRIDGE_PROTOCOL,

    async installVirtualBridge(url: string): Promise<WebHidKitBridge> {
      const installed = await installVirtualHid({ url });
      return {
        // getAllDevices 是套件的调试扩展：忽略授权集合，把桥上的设备全列出来。
        // 设备页是控制台性质，用不上 requestDevice 的授权流程。
        list: () => installed.hid.getAllDevices() as Promise<WebHidDeviceHandle[]>,
        restore: () => installed.restore(),
      };
    },

    nativeAvailable: () => isNativeWebHidAvailable(),
    nativeDevices: async () => (await getNativeDevices()).map(adaptNativeHandle),
    // 上游 native.js:98 的签名是 requestNativeDevice({ filters, exclusionFilters } = {})；
    // filters 为空时退回不带参调用，保持与改动前逐字一致的行为
    requestNativeDevice: async (filters?: readonly WebHidUsageFilter[]) => {
      const handles = await requestNativeHidDevice(
        filters && filters.length > 0 ? { filters: filters.map((item) => ({ ...item })) } : undefined,
      );
      return handles.map(adaptNativeHandle);
    },
  };
}
