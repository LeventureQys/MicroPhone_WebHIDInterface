import type {
  WebHidDeviceHandle,
  WebHidKit,
  WebHidKitBridge,
} from '../../../src/renderer/src/device/webhid/types';

/** 设备替身：记录开关次数，输入报告由测试显式派发 */
export class FakeHidDevice extends EventTarget implements WebHidDeviceHandle {
  readonly deviceId?: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  opened = false;
  openCount = 0;
  closeCount = 0;

  constructor(init: {
    deviceId?: string;
    vendorId?: number;
    productId?: number;
    productName?: string;
  } = {}) {
    super();
    this.deviceId = init.deviceId;
    this.vendorId = init.vendorId ?? 0x1234;
    this.productId = init.productId ?? 0x5678;
    this.productName = init.productName ?? 'Fake HID';
  }

  async open(): Promise<void> {
    this.openCount += 1;
    this.opened = true;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.opened = false;
  }

  decode(_reportType: string, _reportId: number, data: Uint8Array): { values: Record<string, number> } {
    return { values: { '1:48': data[0] ?? 0 } };
  }

  emitInputReport(reportId: number, bytes: number[]): void {
    this.dispatchEvent(
      new CustomEvent('inputreport', { detail: { reportId, data: Uint8Array.from(bytes) } }),
    );
  }
}

export interface FakeKitOptions {
  readonly devices?: FakeHidDevice[];
  readonly nativeDevices?: FakeHidDevice[];
  readonly nativeAvailable?: boolean;
  readonly requestResult?: FakeHidDevice[];
  readonly failInstall?: Error;
  readonly failNativeList?: Error;
}

/** 套件替身：不碰 WebSocket / navigator.hid */
export class FakeKit implements WebHidKit {
  readonly version = '0.0.0-test';
  readonly bridgeUrl = 'ws://127.0.0.1:8765/ws';
  readonly bridgeProtocol = 'webhid-bridge.v1';

  installedUrls: string[] = [];
  restoreCount = 0;
  listCount = 0;

  constructor(private readonly options: FakeKitOptions = {}) {}

  async installVirtualBridge(url: string): Promise<WebHidKitBridge> {
    this.installedUrls.push(url);
    if (this.options.failInstall) throw this.options.failInstall;
    const devices = this.options.devices ?? [];
    return {
      list: async () => {
        this.listCount += 1;
        return devices;
      },
      restore: () => {
        this.restoreCount += 1;
      },
    };
  }

  nativeAvailable(): boolean {
    return this.options.nativeAvailable ?? false;
  }

  async nativeDevices(): Promise<WebHidDeviceHandle[]> {
    if (this.options.failNativeList) throw this.options.failNativeList;
    return this.options.nativeDevices ?? [];
  }

  async requestNativeDevice(): Promise<WebHidDeviceHandle[]> {
    return this.options.requestResult ?? [];
  }
}

/** 等一轮宏任务：会话内的 setTimeout 合并渲染都在这之后 */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
