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
} from '@webhid-kit';
import type { WebHidDeviceHandle, WebHidKit, WebHidKitBridge, WebHidUsageFilter } from './types';

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
    nativeDevices: () => getNativeDevices() as Promise<WebHidDeviceHandle[]>,
    // 上游 native.js:98 的签名是 requestNativeDevice({ filters, exclusionFilters } = {})；
    // filters 为空时退回不带参调用，保持与改动前逐字一致的行为
    requestNativeDevice: (filters?: readonly WebHidUsageFilter[]) =>
      requestNativeHidDevice(
        filters && filters.length > 0 ? { filters: filters.map((item) => ({ ...item })) } : undefined,
      ) as Promise<WebHidDeviceHandle[]>,
  };
}
