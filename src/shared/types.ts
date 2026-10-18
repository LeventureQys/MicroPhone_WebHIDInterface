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

export interface MicStudioApi {
  readonly platform: string;
  readonly appVersion: string;
  readonly locale: string;
  requestHidDevice(): Promise<HidDeviceRequestResult>;
}

declare global {
  interface Window {
    micstudio?: MicStudioApi;
  }
}

export const IPC_REQUEST_HID_DEVICE = 'micstudio:request-hid-device';
