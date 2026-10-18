import { contextBridge, ipcRenderer } from 'electron';
import { IPC_REQUEST_HID_DEVICE } from '../shared/types';

contextBridge.exposeInMainWorld('micstudio', {
  platform: process.platform,
  appVersion: '1.0.0-alpha.0',
  locale: 'zh-CN',
  requestHidDevice: (): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IPC_REQUEST_HID_DEVICE),
});
