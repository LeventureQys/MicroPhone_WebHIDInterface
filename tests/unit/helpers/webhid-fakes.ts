import { PAYLOAD_BYTES, splitFrame } from '../../../src/renderer/src/device/protocol';
import { ACK_NO_ERR, encodeAck, encodeRandWrite, encodeSeqWrite } from '../../../src/renderer/src/device/proto/codec';
import {
  FUNC_ACK,
  FUNC_RAND_READ,
  FUNC_RAND_WRITE,
  FUNC_SEQ_READ,
  FUNC_SEQ_WRITE,
  decodeStream,
  encodeFrame,
  type ParamFrame,
} from '../../../src/renderer/src/device/proto/frame';
import { LEVEL_ADDR, PRESET_COUNT, PRESET_START } from '../../../src/renderer/src/device/registers';
import type {
  WebHidDeviceHandle,
  WebHidKit,
  WebHidKitBridge,
  WebHidUsageFilter,
} from '../../../src/renderer/src/device/webhid/types';

export interface SentReport {
  readonly reportId: number;
  readonly data: Uint8Array;
}

/** 设备替身：记录开关次数与出站报告，输入报告由测试显式派发 */
export class FakeHidDevice extends EventTarget implements WebHidDeviceHandle {
  readonly deviceId?: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  opened = false;
  openCount = 0;
  closeCount = 0;

  /** 出站报告（`sendReport` 收到的原始载荷），按发送顺序排列 */
  readonly sent: SentReport[] = [];
  /** 回执报告号，缺省 0x11（IN 报告） */
  replyReportId = 0x11;
  /**
   * 自动回执：拿到一包出站载荷后返回整帧应答字节（null = 不回）。
   * 同步回执与设备固件的"收到即答"一致，也便于单测用假定时器精确推进。
   */
  responder: ((reportId: number, data: Uint8Array) => Uint8Array | null) | null = null;

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

  async sendReport(reportId: number, data: Uint8Array): Promise<void> {
    const copy = Uint8Array.from(data);
    this.sent.push({ reportId, data: copy });
    const reply = this.responder?.(reportId, copy) ?? null;
    if (reply === null) return;
    // 应答整帧按 63 B 切包，逐包走 inputreport（与桥接/真机的分片行为一致）
    for (const report of splitFrame(reply, PAYLOAD_BYTES)) {
      this.emitInputReport(this.replyReportId, [...report]);
    }
  }

  /** 只回最后一条出站报告的载荷头，便于断言"发了几帧、最后一帧是什么" */
  lastSent(): SentReport | null {
    return this.sent.length === 0 ? null : this.sent[this.sent.length - 1];
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
  /** 每次真机请求收到的 filters 入参（不传记为 undefined） */
  requestedFilters: Array<readonly WebHidUsageFilter[] | undefined> = [];

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

  async requestNativeDevice(filters?: readonly WebHidUsageFilter[]): Promise<WebHidDeviceHandle[]> {
    this.requestedFilters.push(filters);
    return this.options.requestResult ?? [];
  }
}

/** 等一轮宏任务：会话内的 setTimeout 合并渲染都在这之后 */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * 假设备寄存器表：型号码 JYM001、固件 1.2.3 build 45、VID/PID、SN、通讯错误
 * 与整段预设（含电平寄存器与 EQ 第 1 段），够 `ParamSession.sync()` 走通。
 */
export function createFakeRegisters(): Map<number, number> {
  const map = new Map<number, number>();
  // ModelCode 三个字 → 'JYM001'
  map.set(0x0000, 0x4a59);
  map.set(0x0001, 0x4d30);
  map.set(0x0002, 0x3031);
  // DeviceName 前两个字 → 'MIC'
  map.set(0x0003, 0x4d49);
  map.set(0x0004, 0x4300);
  // Firmware 1.2.3 build 45
  map.set(0x000b, 1);
  map.set(0x000c, 2);
  map.set(0x000d, 3);
  map.set(0x000e, 45);
  map.set(0x000f, 1);
  map.set(0x0016, 0x0a67);
  map.set(0x0017, 0x0010);
  for (let index = 0; index < 4; index += 1) map.set(0x001e + index, 0x4142);
  map.set(0x1007, 3);

  for (let addr = PRESET_START; addr < PRESET_START + PRESET_COUNT; addr += 1) map.set(addr, 0);
  map.set(0x2023, 100); // gain.Mic（只读）
  map.set(0x2024, 0); // enc.OnOff
  map.set(0x2025, 2); // enc.Level
  map.set(0x205a, 88); // gain.Hp（只读）
  map.set(0x205b, 21); // noisegate.threshold_db raw → -70 dB
  map.set(LEVEL_ADDR, 128); // 电平中段
  // EQ 第 1 段：enable 1 / HPF / 50 Hz / raw 300 → -2 dB / Q 0.7
  map.set(0x2027, 1);
  map.set(0x2028, 4);
  map.set(0x2029, 50);
  map.set(0x202a, 300);
  map.set(0x202b, 7);
  return map;
}

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const merged = new Uint8Array(head.length + tail.length);
  merged.set(head, 0);
  merged.set(tail, head.length);
  return merged;
}

/**
 * 给假设备接上参数协议：解析出站帧、按寄存器表回 ACK / 读应答。
 * 应答与真实固件一样"收到即答"，跨包的长帧由内部缓冲拼接。
 */
export function bindRegisterDevice(device: FakeHidDevice, registers: Map<number, number>): void {
  let inbound = new Uint8Array(0);

  const replyTo = (frame: ParamFrame): Uint8Array | null => {
    const data = frame.data;
    const word = (offset: number): number => ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0);
    switch (frame.func) {
      case FUNC_SEQ_READ: {
        const start = word(0);
        const count = word(2);
        const values: number[] = [];
        for (let index = 0; index < count; index += 1) values.push(registers.get(start + index) ?? 0);
        return encodeFrame(FUNC_SEQ_READ, encodeSeqWrite(start, values));
      }
      case FUNC_RAND_READ: {
        const entries: Array<{ addr: number; raw: number }> = [];
        for (let offset = 0; offset + 1 < data.length; offset += 2) {
          const addr = word(offset);
          entries.push({ addr, raw: registers.get(addr) ?? 0 });
        }
        return encodeFrame(FUNC_RAND_READ, encodeRandWrite(entries));
      }
      case FUNC_SEQ_WRITE: {
        const start = word(0);
        const count = word(2);
        for (let index = 0; index < count; index += 1) {
          registers.set(start + index, word(4 + index * 2));
        }
        return encodeFrame(FUNC_ACK, encodeAck(ACK_NO_ERR));
      }
      case FUNC_RAND_WRITE: {
        for (let offset = 0; offset + 3 < data.length; offset += 4) {
          registers.set(word(offset), word(offset + 2));
        }
        return encodeFrame(FUNC_ACK, encodeAck(ACK_NO_ERR));
      }
      default:
        return null;
    }
  };

  device.responder = (_reportId, payload) => {
    const merged = concatBytes(inbound, payload);
    const result = decodeStream(merged);
    inbound = result.rest;
    let out: Uint8Array | null = null;
    for (const frame of result.frames) {
      const bytes = replyTo(frame);
      if (bytes === null) continue;
      out = out === null ? bytes : concatBytes(out, bytes);
    }
    return out;
  };
}
