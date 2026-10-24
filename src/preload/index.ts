import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_DFU_CLOSE_BLOCKED,
  IPC_REQUEST_HID_DEVICE,
  IPC_SET_DFU_ACTIVE,
  IPC_SET_HID_WHITELIST,
  PLATFORM_INFO_ARG,
} from '../shared/types';
import type { MicStudioApi, PlatformInfo } from '../shared/types';

/**
 * 版本/区域由主进程经 additionalArguments 注入渲染进程 argv：
 * preload 沙箱里拿不到 app 模块，同步解析 argv 比异步 IPC 更适合"首帧就要显示版本"。
 */
function readPlatformInfo(): PlatformInfo {
  const fallback: PlatformInfo = { platform: process.platform, appVersion: '0.0.0', locale: 'zh-CN' };
  const hit = process.argv.find((item) => item.startsWith(PLATFORM_INFO_ARG));
  if (!hit) {
    console.warn('[preload] platform info argument missing, using fallback');
    return fallback;
  }
  try {
    const raw = JSON.parse(hit.slice(PLATFORM_INFO_ARG.length)) as Partial<PlatformInfo>;
    if (
      typeof raw.platform !== 'string' ||
      typeof raw.appVersion !== 'string' ||
      typeof raw.locale !== 'string'
    ) {
      console.warn('[preload] platform info argument incomplete, using fallback');
      return fallback;
    }
    return { platform: raw.platform, appVersion: raw.appVersion, locale: raw.locale };
  } catch {
    console.warn('[preload] platform info argument is not valid JSON, using fallback');
    return fallback;
  }
}

const info = readPlatformInfo();

const api: MicStudioApi = {
  platform: info.platform,
  appVersion: info.appVersion,
  locale: info.locale,
  requestHidDevice: () => ipcRenderer.invoke(IPC_REQUEST_HID_DEVICE),
  setHidWhitelist: (list) => ipcRenderer.invoke(IPC_SET_HID_WHITELIST, list),
  setDfuActive: (active) => ipcRenderer.invoke(IPC_SET_DFU_ACTIVE, active),
  onDfuCloseBlocked: (cb) => {
    const handler = (): void => cb();
    ipcRenderer.on(IPC_DFU_CLOSE_BLOCKED, handler);
    return () => ipcRenderer.removeListener(IPC_DFU_CLOSE_BLOCKED, handler);
  },
};

contextBridge.exposeInMainWorld('micstudio', api);

// 取证用：确认 preload 真的从 argv 取到了版本/区域（渲染进程控制台会被主进程写进 startup.log）
console.info(`[preload] platform-info platform=${api.platform} appVersion=${api.appVersion} locale=${api.locale}`);
