/**
 * 真实子模块的接线测试：@webhid-kit 别名必须解析到 third_party 里的原生 ESM。
 * 这里刻意不 mock——上游换实现或换导出，本测试先红。
 */
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_PROTOCOL,
  DEFAULT_BRIDGE_URL,
  DeviceCodec,
  VERSION,
  bytesToHex,
  computeLayout,
  hexToBytes,
  parseReportDescriptor,
  toW3CCollections,
} from '@webhid-kit';
import { createWebHidKit } from '../../src/renderer/src/device/webhid/kit';

/** 键盘 + 5 个 LED 的最小描述符：input 16 bit = 2 B，output 8 bit = 1 B */
const KEYBOARD_DESCRIPTOR = `
  05 01 09 06 A1 01
    05 07 19 E0 29 E7 15 00 25 01 75 01 95 08 81 02
    95 01 75 08 81 01
    05 08 19 01 29 05 95 05 75 01 91 02
    95 01 75 03 91 01
  C0
`;

describe('@webhid-kit wiring', () => {
  it('exposes the version and bridge contract the device page renders', () => {
    expect(VERSION).toBe('1.0.0');
    expect(DEFAULT_BRIDGE_URL).toBe('ws://127.0.0.1:8765/ws');
    expect(BRIDGE_PROTOCOL).toBe('webhid-bridge.v1');
  });

  it('parses a report descriptor and computes byte lengths', () => {
    const collections = parseReportDescriptor(hexToBytes(KEYBOARD_DESCRIPTOR));
    expect(collections).toHaveLength(1);

    const layout = computeLayout(collections);
    expect(layout.usesReportIds).toBe(false);
    expect(layout.input['0'].byteLength).toBe(2);
    expect(layout.output['0'].byteLength).toBe(1);
  });

  it('strips the *Signed extension from the W3C view', () => {
    const collections = parseReportDescriptor(hexToBytes(KEYBOARD_DESCRIPTOR));
    expect(JSON.stringify(toW3CCollections(collections))).not.toContain('Signed');
  });

  it('encodes and decodes named fields bit by bit', () => {
    const layout = computeLayout(parseReportDescriptor(hexToBytes(KEYBOARD_DESCRIPTOR)));
    const codec = new DeviceCodec(layout);

    expect(codec.fieldKeys('output', 0)).toEqual(['8:1', '8:2', '8:3', '8:4', '8:5']);

    const bytes = codec.encode('output', 0, { values: { '8:1': 1, '8:2': 1 } });
    expect(bytesToHex(bytes)).toBe('03');

    const decoded = codec.decode('output', 0, bytes);
    expect(decoded.values['8:1']).toBe(1);
    expect(decoded.values['8:3']).toBe(0);
    expect(decoded.byteLength).toBe(1);
  });

  it('wires the app facade onto the real kit', () => {
    const kit = createWebHidKit();
    expect(kit.version).toBe(VERSION);
    expect(kit.bridgeUrl).toBe(DEFAULT_BRIDGE_URL);
    expect(kit.bridgeProtocol).toBe(BRIDGE_PROTOCOL);
    // happy-dom 没有 navigator.hid，真机通道应当自报不可用而不是抛错
    expect(kit.nativeAvailable()).toBe(false);
  });
});
