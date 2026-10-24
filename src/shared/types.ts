export type Lang = 'zh' | 'en';

export interface PlatformInfo {
  platform: string;
  appVersion: string;
  locale: string;
}

export interface HidDeviceRequestResult {
  ok: boolean;
  reason?: string;
}

export interface HidUsageEntry {
  readonly usagePage: number;
  readonly usage: number;
}

export interface HidWhitelist {
  readonly entries: readonly HidUsageEntry[];
  readonly vids: readonly number[];
  readonly pids: readonly number[];
}

/** 主进程用于匹配的设备描述，从 Electron 的 HIDDevice 归一而来 */
export interface HidDeviceDescriptor {
  readonly vendorId: number;
  readonly productId: number;
  readonly collections: readonly HidUsageEntry[];
}

export interface MicStudioApi {
  readonly platform: string;
  readonly appVersion: string;
  readonly locale: string;
  requestHidDevice(): Promise<HidDeviceRequestResult>;
  setHidWhitelist(list: HidWhitelist): Promise<void>;
  setDfuActive(active: boolean): Promise<void>;
  /** 升级期间用户点关闭时触发；返回退订函数 */
  onDfuCloseBlocked(cb: () => void): () => void;
}

declare global {
  interface Window {
    micstudio?: MicStudioApi;
  }
}

export const IPC_REQUEST_HID_DEVICE = 'micstudio:request-hid-device';
export const IPC_GET_PLATFORM_INFO = 'micstudio:get-platform-info';
export const IPC_SET_HID_WHITELIST = 'micstudio:set-hid-whitelist';
export const IPC_SET_DFU_ACTIVE = 'micstudio:set-dfu-active';
export const IPC_DFU_CLOSE_BLOCKED = 'micstudio:dfu-close-blocked';

/** 主进程经 webPreferences.additionalArguments 注入渲染进程 argv 的参数前缀 */
export const PLATFORM_INFO_ARG = '--micstudio-platform-info=';
