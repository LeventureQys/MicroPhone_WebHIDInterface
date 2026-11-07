/**
 * 后台自动连接（VID 0x0A67 / PID 0x0010）的行为用例。
 *
 * 用窄结构接口的假实现：不碰 `navigator.hid`、不真等 1.5 s（`tickOnce()` 单拍驱动）。
 */
import { describe, expect, it } from 'vitest';
import { AutoConnector, type AutoConnectLink, type AutoConnectSession } from '../../src/renderer/src/device/auto-connect';
import type { LinkState } from '../../src/renderer/src/device/link';
import type { Timers } from '../../src/renderer/src/device/proto/timing';
import type { WebHidDeviceSummary, WebHidMode, WebHidSessionState } from '../../src/renderer/src/device/webhid/types';

const VID = 0x0a67;
const PID = 0x0010;

/** 只排程不执行的 Timer：测试里手动调 `tickOnce()`，避免真定时器在断言后偷偷跑 */
function idleTimers(): Timers {
  return { setTimeout: () => 0, clearTimeout: () => undefined };
}

function summary(overrides: Partial<WebHidDeviceSummary> = {}): WebHidDeviceSummary {
  return {
    id: 'native-0a67-0010-0',
    mode: 'native',
    productName: 'M001',
    vendorId: VID,
    productId: PID,
    opened: false,
    ...overrides,
  };
}

class FakeSession implements AutoConnectSession {
  probes: WebHidDeviceSummary[] = [];
  devices: WebHidDeviceSummary[] = [];
  status: WebHidSessionState['status'] = 'idle';
  mode: WebHidMode = 'virtual';
  available = true;
  failConnect = false;
  readonly connectCalls: WebHidMode[] = [];
  refreshCalls = 0;
  probeCalls = 0;

  getState(): WebHidSessionState {
    return {
      status: this.status,
      mode: this.mode,
      bridgeUrl: 'ws://127.0.0.1:8765/ws',
      error: null,
      errorCode: null,
      devices: this.devices,
      lastReport: null,
    };
  }

  nativeAvailable(): boolean {
    return this.available;
  }

  async probeNative(): Promise<readonly WebHidDeviceSummary[]> {
    this.probeCalls += 1;
    return this.probes;
  }

  async connect(mode?: WebHidMode): Promise<void> {
    this.connectCalls.push(mode ?? this.mode);
    this.mode = mode ?? this.mode;
    if (this.failConnect) {
      this.status = 'error';
      return;
    }
    this.status = 'ready';
    this.devices = [...this.probes];
  }

  async refresh(): Promise<void> {
    this.refreshCalls += 1;
    this.devices = [...this.probes];
  }
}

class FakeLink implements AutoConnectLink {
  status: LinkState['status'] = 'idle';
  errorCode: LinkState['errorCode'] = null;
  /** `attach()` 跑完后的结果（模拟参数同步成功 / 失败 / 设备停在升级模式） */
  afterAttach: { status: LinkState['status']; errorCode: LinkState['errorCode'] } = {
    status: 'ready',
    errorCode: null,
  };
  readonly attachments: string[] = [];

  getState(): LinkState {
    return {
      status: this.status,
      mode: 'native',
      deviceId: null,
      sync: this.status === 'ready' ? 'ready' : 'idle',
      error: null,
      errorCode: this.errorCode,
      device: null,
      warning: null,
    };
  }

  async attach(deviceId: string): Promise<void> {
    this.attachments.push(deviceId);
    this.status = 'connecting';
    this.status = this.afterAttach.status;
    this.errorCode = this.afterAttach.errorCode;
  }
}

function build(options: { readonly intervalMs?: number; readonly maxAttempts?: number } = {}) {
  const session = new FakeSession();
  const link = new FakeLink();
  const events: string[] = [];
  const connector = new AutoConnector({
    link,
    session,
    timers: idleTimers(),
    intervalMs: options.intervalMs ?? 100,
    maxAttempts: options.maxAttempts ?? 3,
    onEvent: (message) => events.push(message),
  });
  return { session, link, connector, events };
}

describe('AutoConnector', () => {
  it('connects the matching device when the session has not connected yet', async () => {
    const { session, link, connector } = build();
    session.probes = [summary()];

    await connector.tickOnce();

    // 先切到真机通道，再 attach 目标设备
    expect(session.connectCalls).toEqual(['native']);
    expect(link.attachments).toEqual(['native-0a67-0010-0']);
    expect(connector.state()).toMatchObject({ paused: false, parked: false, attempts: 0 });
  });

  it('ignores devices whose VID/PID do not match', async () => {
    const { session, link, connector } = build();
    session.probes = [summary({ id: 'native-046d-0a01-0', vendorId: 0x046d, productId: 0x0a01 })];

    await connector.tickOnce();

    expect(session.connectCalls).toEqual([]);
    expect(link.attachments).toEqual([]);
  });

  it('does not steal the channel from a connected virtual bridge session', async () => {
    const { session, link, connector } = build();
    session.status = 'ready';
    session.mode = 'virtual';
    session.probes = [summary()];

    await connector.tickOnce();

    expect(session.connectCalls).toEqual([]);
    expect(link.attachments).toEqual([]);
  });

  it('does nothing while the link is upgrading or connecting', async () => {
    const { session, link, connector } = build();
    session.probes = [summary()];

    link.status = 'dfu';
    await connector.tickOnce();
    link.status = 'connecting';
    await connector.tickOnce();

    expect(link.attachments).toEqual([]);
    expect(session.probeCalls).toBe(0);
  });

  it('keeps a manual disconnect paused until the device is unplugged and comes back', async () => {
    const { session, link, connector } = build();
    session.probes = [summary()];
    connector.pause();

    await connector.tickOnce();
    expect(link.attachments).toEqual([]);

    // 拔掉：暂停被撤销，但没设备可连
    session.probes = [];
    await connector.tickOnce();
    expect(connector.state().paused).toBe(false);
    expect(link.attachments).toEqual([]);

    // 插回：重新自动连接
    session.probes = [summary()];
    await connector.tickOnce();
    expect(link.attachments).toEqual(['native-0a67-0010-0']);
  });

  it('resume() re-arms after a manual disconnect without replugging', async () => {
    const { session, link, connector } = build();
    session.probes = [summary()];
    connector.pause();
    await connector.tickOnce();
    expect(link.attachments).toEqual([]);

    connector.resume();
    await connector.tickOnce();
    expect(link.attachments).toEqual(['native-0a67-0010-0']);
  });

  it('parks after repeated failures and retries once the device is replugged', async () => {
    const { session, link, connector } = build();
    session.probes = [summary()];
    link.afterAttach = { status: 'error', errorCode: 'device' };

    await connector.tickOnce();
    await connector.tickOnce();
    await connector.tickOnce();
    expect(link.attachments).toHaveLength(3);
    expect(connector.state().parked).toBe(true);

    // 停手：设备还在也不继续连
    await connector.tickOnce();
    expect(link.attachments).toHaveLength(3);

    // 拔插一次后重新武装
    session.probes = [];
    await connector.tickOnce();
    expect(connector.state().parked).toBe(false);
    session.probes = [summary()];
    link.afterAttach = { status: 'ready', errorCode: null };
    await connector.tickOnce();
    expect(link.attachments).toHaveLength(4);
  });

  it('parks immediately when parameter sync fails (device stuck in update mode)', async () => {
    const { session, link, connector } = build();
    session.probes = [summary()];
    link.afterAttach = { status: 'error', errorCode: 'sync' };

    await connector.tickOnce();
    expect(link.attachments).toHaveLength(1);
    expect(connector.state().parked).toBe(true);

    // 停在升级模式的设备自动重连永远不会成功，不能一直摸
    await connector.tickOnce();
    await connector.tickOnce();
    expect(link.attachments).toHaveLength(1);
  });

  it('gives up when the environment has no native WebHID', async () => {
    const { session, connector } = build();
    session.available = false;
    connector.start();
    expect(connector.state().enabled).toBe(true);

    await connector.tickOnce();

    expect(connector.state().enabled).toBe(false);
    expect(session.probeCalls).toBe(0);
  });

  it('setEnabled(false) clears the scheduled check (settings switch)', () => {
    const scheduled: number[] = [];
    const cleared: number[] = [];
    let seq = 0;
    const timers: Timers = {
      setTimeout: () => {
        seq += 1;
        scheduled.push(seq);
        return seq;
      },
      clearTimeout: (handle: unknown) => {
        cleared.push(handle as number);
      },
    };
    const connector = new AutoConnector({ link: new FakeLink(), session: new FakeSession(), timers });

    connector.start();
    expect(scheduled).toHaveLength(1);
    expect(connector.state().enabled).toBe(true);

    connector.setEnabled(false);

    expect(cleared).toEqual([1]);
    expect(connector.state().enabled).toBe(false);
  });

  it('backs off after failures instead of hammering the device every tick', async () => {
    const { session, connector } = build({ intervalMs: 100 });
    session.probes = [summary()];
    session.failConnect = true;

    await connector.tickOnce();
    expect(connector.state().attempts).toBe(1);
    await connector.tickOnce();
    expect(connector.state().attempts).toBe(2);
    await connector.tickOnce();
    expect(connector.state().attempts).toBe(3);
    expect(connector.state().parked).toBe(true);
  });
});
