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

/** 除 HID 之外还要放行的权限：真机固件不上报电平，界面要从同一台设备的音频输入算 */
const ALLOWED_PERMISSIONS = new Set(['hid', 'media', 'clipboard-sanitized-write', 'clipboard-read']);

/**
 * 真机通道放行策略：白名单放行才回调 deviceId，否则回调空参数（取消）。
 * 不弹窗、不抛错——选择器必须由渲染进程用户手势驱动（R9-1）。
 *
 * 同时放行麦克风：真机固件不上报 `0x2057`（恒 0），电平条改由同一台设备的音频输入算，
 * 渲染进程要能 `getUserMedia`。只放音频、不放摄像头。
 */
export function installWebHidHandlers(session: Session, options?: WebHidHandlerOptions): void {
  session.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission as string));
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const name = permission as string;
    if (!ALLOWED_PERMISSIONS.has(name)) {
      callback(false);
      return;
    }
    if (name !== 'media') {
      callback(true);
      return;
    }
    const types = (details as { mediaTypes?: readonly string[] } | undefined)?.mediaTypes ?? [];
    // 只放麦克风：摄像头 / 屏幕共享一律拒绝
    callback(types.length === 0 || types.includes('audio'));
  });
  // 真机设备列表（getDevices）按这个放行；自动连接依赖它
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
