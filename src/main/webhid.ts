import type { Session } from 'electron';

/**
 * Alpha 阶段只注册策略，不打开设备选择器。联调阶段在这里接入
 * 设备过滤（vendorId/productId）与选择器 UI。
 */
export function installWebHidHandlers(session: Session): void {
  session.setPermissionCheckHandler((_contents, permission) => permission === 'hid');
  session.setDevicePermissionHandler((details) => details.deviceType === 'hid');
  session.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    // Alpha：不自动选设备，回调空参数表示取消选择
    callback();
  });
}
