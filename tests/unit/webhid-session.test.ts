import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebHidSession, errorKeyOf } from '../../src/renderer/src/device/webhid/session';
import type { WebHidReportSample } from '../../src/renderer/src/device/webhid/types';
import { FakeHidDevice, FakeKit, flush } from './helpers/webhid-fakes';

function sessionWith(kit: FakeKit): WebHidSession {
  return new WebHidSession({ kit });
}

describe('WebHidSession', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('starts idle on the virtual channel with the kit default bridge URL', () => {
    const kit = new FakeKit();
    const session = sessionWith(kit);
    const state = session.getState();

    expect(state.status).toBe('idle');
    expect(state.mode).toBe('virtual');
    expect(state.bridgeUrl).toBe(kit.bridgeUrl);
    expect(state.devices).toHaveLength(0);
    expect(state.lastReport).toBeNull();
    expect(session.kitVersion).toBe(kit.version);
    expect(session.bridgeProtocol).toBe(kit.bridgeProtocol);
  });

  it('connects to the bridge and lists every device on it', async () => {
    const devices = [new FakeHidDevice({ deviceId: 'gamepad', productName: 'Virtual Gamepad' })];
    const kit = new FakeKit({ devices });
    const session = sessionWith(kit);

    await session.connect('virtual');

    expect(kit.installedUrls).toEqual([kit.bridgeUrl]);
    const state = session.getState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.devices).toEqual([
      {
        id: 'gamepad',
        mode: 'virtual',
        productName: 'Virtual Gamepad',
        vendorId: 0x1234,
        productId: 0x5678,
        opened: false,
      },
    ]);
  });

  it('reports a bridge failure as an error state instead of throwing', async () => {
    const kit = new FakeKit({ failInstall: new Error('cannot connect to ws://127.0.0.1:8765/ws') });
    const session = sessionWith(kit);

    await expect(session.connect('virtual')).resolves.toBeUndefined();

    const state = session.getState();
    expect(state.status).toBe('error');
    expect(state.errorCode).toBe('bridge');
    expect(state.error).toContain('cannot connect');
    expect(state.devices).toHaveLength(0);
  });

  it('flags the native channel as unavailable when navigator.hid is missing', async () => {
    const session = sessionWith(new FakeKit({ nativeAvailable: false }));

    await session.connect('native');

    const state = session.getState();
    expect(state.status).toBe('error');
    expect(state.errorCode).toBe('nativeUnavailable');
    expect(state.mode).toBe('native');
  });

  it('lists native devices and synthesises stable ids', async () => {
    const devices = [new FakeHidDevice({ productName: 'Mic 9000', vendorId: 0x046d, productId: 0x0a01 })];
    const kit = new FakeKit({ nativeAvailable: true, nativeDevices: devices });
    const session = sessionWith(kit);

    await session.connect('native');
    const first = session.getState().devices[0];
    expect(first.id).toBe('native-046d-0a01-0');
    expect(first.mode).toBe('native');
    expect(first.productName).toBe('Mic 9000');

    await session.refresh();
    expect(session.getState().devices[0].id).toBe(first.id);
  });

  it('opens a device and decodes its input reports', async () => {
    const device = new FakeHidDevice({ deviceId: 'echo', productName: 'Echo' });
    const session = sessionWith(new FakeKit({ devices: [device] }));
    const seen: WebHidReportSample[] = [];
    session.onReport((sample) => seen.push(sample));

    await session.connect('virtual');
    await session.openDevice('echo');

    expect(device.openCount).toBe(1);
    expect(session.getState().devices[0].opened).toBe(true);

    device.emitInputReport(3, [0x7f, 0x01]);

    expect(seen).toHaveLength(1);
    expect(seen[0].deviceId).toBe('echo');
    expect(seen[0].reportId).toBe(3);
    expect(seen[0].hex).toBe('7F 01');
    expect(seen[0].values).toEqual({ '1:48': 0x7f });
    expect(session.getState().lastReport?.hex).toBe('7F 01');
    expect(session.recentReports()).toHaveLength(1);
  });

  it('ignores reports from devices it did not open and stops after close', async () => {
    const device = new FakeHidDevice({ deviceId: 'echo' });
    const session = sessionWith(new FakeKit({ devices: [device] }));
    let count = 0;
    session.onReport(() => {
      count += 1;
    });

    await session.connect('virtual');
    // 没 openDevice，监听尚未挂上
    device.emitInputReport(1, [0x01]);
    expect(count).toBe(0);

    await session.openDevice('echo');
    device.emitInputReport(1, [0x01]);
    expect(count).toBe(1);

    await session.closeDevice('echo');
    device.emitInputReport(1, [0x01]);
    expect(count).toBe(1);
    expect(device.closeCount).toBe(1);
  });

  it('keeps raw hex when the device codec throws', async () => {
    const device = new FakeHidDevice({ deviceId: 'broken' });
    device.decode = () => {
      throw new Error('descriptor mismatch');
    };
    const session = sessionWith(new FakeKit({ devices: [device] }));
    await session.connect('virtual');
    await session.openDevice('broken');

    device.emitInputReport(2, [0xaa]);
    const last = session.getState().lastReport;
    expect(last?.hex).toBe('AA');
    expect(last?.values).toEqual({});
  });

  it('restores the polyfill and closes opened devices on disconnect', async () => {
    const device = new FakeHidDevice({ deviceId: 'gamepad' });
    const kit = new FakeKit({ devices: [device] });
    const session = sessionWith(kit);

    await session.connect('virtual');
    await session.openDevice('gamepad');
    await session.disconnect();

    expect(device.closeCount).toBe(1);
    expect(kit.restoreCount).toBe(1);
    const state = session.getState();
    expect(state.status).toBe('idle');
    expect(state.devices).toHaveLength(0);
    expect(state.lastReport).toBeNull();
  });

  it('reconnects to the other channel without leaking the previous bridge', async () => {
    const kit = new FakeKit({
      devices: [new FakeHidDevice({ deviceId: 'gamepad' })],
      nativeAvailable: true,
      nativeDevices: [new FakeHidDevice({ productName: 'Hardware', vendorId: 0x1, productId: 0x2 })],
    });
    const session = sessionWith(kit);

    await session.connect('virtual');
    await session.connect('native');

    expect(kit.restoreCount).toBe(1);
    const state = session.getState();
    expect(state.mode).toBe('native');
    expect(state.devices[0].productName).toBe('Hardware');
  });

  it('reports a cancelled native device request', async () => {
    const kit = new FakeKit({ nativeAvailable: true, nativeDevices: [], requestResult: [] });
    const session = sessionWith(kit);
    await session.connect('native');

    await session.requestNativeDevice();

    expect(session.getState().errorCode).toBe('noSelection');
  });

  it('accepts devices granted by the native picker', async () => {
    const granted = new FakeHidDevice({ productName: 'Mic 9000', vendorId: 0x046d, productId: 0x0a01 });
    const kit = new FakeKit({ nativeAvailable: true, nativeDevices: [], requestResult: [granted] });
    const session = sessionWith(kit);
    await session.connect('native');
    expect(session.getState().devices).toHaveLength(0);

    await session.requestNativeDevice();

    expect(session.getState().devices).toHaveLength(1);
    expect(session.getState().error).toBeNull();
  });

  it('normalises the bridge URL and ignores blanks', () => {
    const session = sessionWith(new FakeKit());

    session.setBridgeUrl('   ');
    expect(session.getState().bridgeUrl).toBe('ws://127.0.0.1:8765/ws');

    session.setBridgeUrl('  ws://127.0.0.1:9999/ws  ');
    expect(session.getState().bridgeUrl).toBe('ws://127.0.0.1:9999/ws');
  });

  it('notifies subscribers on change and honours unsubscribe', async () => {
    const session = sessionWith(new FakeKit({ devices: [] }));
    const seen: string[] = [];
    const off = session.onChange((state) => seen.push(state.status));

    await session.connect('virtual');
    expect(seen).toEqual(['connecting', 'ready']);

    off();
    await session.disconnect();
    await flush();
    expect(seen).toEqual(['connecting', 'ready']);
  });

  it('dispose closes opened devices and restores the bridge', async () => {
    const device = new FakeHidDevice({ deviceId: 'gamepad' });
    const kit = new FakeKit({ devices: [device] });
    const session = sessionWith(kit);

    await session.connect('virtual');
    await session.openDevice('gamepad');

    session.dispose();

    expect(device.closeCount).toBe(1);
    expect(kit.restoreCount).toBe(1);
  });

  it('maps error codes to i18n keys', () => {
    expect(errorKeyOf('nativeUnavailable')).toBe('device.error.nativeUnavailable');
    expect(errorKeyOf('bridge')).toBe('device.error.bridge');
    expect(errorKeyOf(null)).toBe('device.error.unknown');
  });
});
