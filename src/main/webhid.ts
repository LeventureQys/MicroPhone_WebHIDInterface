import type { HIDDevice, Session } from 'electron';
import type { HidDeviceDescriptor, HidUsageEntry, HidWhitelist } from '../shared/types';
import { DEFAULT_HID_WHITELIST, isEmptyWhitelist, shouldAllowSelection } from '../shared/webhid-whitelist';

export interface WebHidHandlerOptions {
  /** 白名单由主进程内存持有，每次选择设备时现取（IPC 随时可更新） */
  readonly getWhitelist?: () => HidWhitelist;
}

/**
 * Electron 33 的 HIDDevice 只有 deviceId / 名称 / VID / PID / 序列号，没有 usage page。
 * usage 过滤在渲染进程：requestDevice({filters}) 由 Chromium 浏览器进程先筛一遍，
 * 主进程只做 VID/PID 复核；将来 Electron 若在设备上暴露 collections，这里自动带进描述符。
 */
function toDescriptor(device: HIDDevice): HidDeviceDescriptor {
  const collections = (device as { collections?: unknown }).collections;
  return {
    vendorId: device.vendorId,
    productId: device.productId,
    collections: Array.isArray(collections) ? (collections as HidUsageEntry[]) : [],
  };
}

/**
 * 真机通道放行策略：白名单放行才回调 deviceId，否则回调空参数（取消）。
 * 不弹窗、不抛错——选择器必须由渲染进程用户手势驱动（R9-1）。
 */
export function installWebHidHandlers(session: Session, options?: WebHidHandlerOptions): void {
  session.setPermissionCheckHandler((_contents, permission) => permission === 'hid');
  session.setDevicePermissionHandler((details) => details.deviceType === 'hid');
  session.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const list = options?.getWhitelist?.() ?? DEFAULT_HID_WHITELIST;
    const device = details.deviceList.find((item) => shouldAllowSelection(list, toDescriptor(item)));
    if (device) {
      console.info('[webhid] allowed device', { vendorId: device.vendorId, productId: device.productId });
      callback(device.deviceId);
      return;
    }
    console.info('[webhid] selection cancelled', { whitelistEmpty: isEmptyWhitelist(list) });
    callback();
  });
}
