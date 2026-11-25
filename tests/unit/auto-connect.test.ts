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
  probeFilters: Array<{ vendorId: number; productId: number } | undefined> = [];
  readonly watchers = new Set<() => void>();
  watchOff: (() => void) | null = null;
  watchCalls = 0;

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

  async probeNative(target?: { vendorId: number; productId: number }): Promise<readonly WebHidDeviceSummary[]> {
    this.probeCalls += 1;
    this.probeFilters.push(target);
    return this.probes;
  }

  watchNative(cb: () => void): () => void {
    this.watchCalls += 1;
    this.watchers.add(cb);
    const off = (): void => {
      this.watchers.delete(cb);
    };
    this.watchOff = off;
    return off;
  }

  /** 测试里手动模拟一次 USB 插拔事件 */
  emitUsbChange(): void {
    for (const cb of [...this.watchers]) cb();
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
  private readonly listeners = new Set<() => void>();

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

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** 测试里模拟"别的路径把链路连上了"（用户手动连接 / 会话恢复） */
  emitReady(): void {
    this.status = 'ready';
    this.errorCode = null;
    for (const cb of [...this.listeners]) cb();
  }

  async attach(deviceId: string): Promise<void> {
    this.attachments.push(deviceId);
    this.status = 'connecting';
    this.status = this.afterAttach.status;
    this.errorCode = this.afterAttach.errorCode;
  }
}

function build(options: {
  readonly intervalMs?: number;
  readonly maxAttempts?: number;
  readonly coldSyncRetries?: number;
} = {}) {
  const session = new FakeSession();
  const link = new FakeLink();
  const events: string[] = [];
  const connector = new AutoConnector({
    link,
    session,
    timers: idleTimers(),
    intervalMs: options.intervalMs ?? 100,
    maxAttempts: options.maxAttempts ?? 3,
    ...(options.coldSyncRetries === undefined ? {} : { coldSyncRetries: options.coldSyncRetries }),
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

  it('retries a cold device a couple of times before parking (stuck in update mode)', async () => {
    const { session, link, connector } = build({ coldSyncRetries: 2 });
    session.probes = [summary()];
    link.afterAttach = { status: 'error', errorCode: 'sync' };

    // 设备刚复位回来时 USB 已枚举、Modbus 还没起来：第一次同步失败不算数
    await connector.tickOnce();
    expect(link.attachments).toHaveLength(1);
    expect(connector.state().parked).toBe(false);
    await connector.tickOnce();
    expect(link.attachments).toHaveLength(2);
    expect(connector.state().parked).toBe(false);

    // 两次冷重试都失败：当成停在升级模式，不再对着它空转
    await connector.tickOnce();
    expect(link.attachments).toHaveLength(3);
    expect(connector.state().parked).toBe(true);
    await connector.tickOnce();
    await connector.tickOnce();
    expect(link.attachments).toHaveLength(3);
  });

  // ---- 掉线后自动重连（用户要求：丢失了连接就要尝试重新连接）--------------------

  it('re-attaches automatically after the link drops', async () => {
    const { session, link, connector } = build();
    session.probes = [summary()];
    await connector.tickOnce();
    expect(link.attachments).toHaveLength(1);

    // 已经连上：下一拍只做幂等的"已连接"判定，不再探测、不重复 attach
    await connector.tickOnce();
    expect(session.probeCalls).toBe(1);
    expect(link.attachments).toHaveLength(1);

    // 掉线（拔线 / 通道 error）：掉线本身不算"手动断开"，下一拍就要重新连
    link.status = 'error';
    link.errorCode = 'device';
    await connector.tickOnce();

    expect(link.attachments).toHaveLength(2);
    expect(connector.state().paused).toBe(false);
    expect(connector.state().parked).toBe(false);
  });

  it('waits for the device to come back and reconnects on replug', async () => {
    const { session, link, connector } = build();
    session.probes = [summary()];
    await connector.tickOnce();

    // 拔线：设备从系统里消失，链路转 error
    link.status = 'error';
    link.errorCode = 'device';
    session.probes = [];
    await connector.tickOnce();
    expect(link.attachments).toHaveLength(1);
    expect(connector.state().paused).toBe(false);

    // 插回：不需要用户点任何按钮，自己连回来
    session.probes = [summary()];
    link.afterAttach = { status: 'ready', errorCode: null };
    await connector.tickOnce();
    expect(link.attachments).toHaveLength(2);
    expect(link.getState().status).toBe('ready');
  });

  it('retries a failed reconnect instead of parking after one sync failure', async () => {
    const { session, link, connector } = build();
    session.probes = [summary()];
    await connector.tickOnce();

    // 掉线后第一次重连：设备还没缓过来，参数同步失败
    link.status = 'error';
    link.errorCode = 'device';
    link.afterAttach = { status: 'error', errorCode: 'sync' };
    await connector.tickOnce();

    expect(link.attachments).toHaveLength(2);
    // 连上过再掉下去不算"开机就在升级模式"：不能一次就停手
    expect(connector.state().parked).toBe(false);
    expect(connector.state().attempts).toBe(1);

    // 设备缓过来：下一拍自己连回去
    link.afterAttach = { status: 'ready', errorCode: null };
    await connector.tickOnce();
    expect(link.attachments).toHaveLength(3);
    expect(link.getState().status).toBe('ready');
    expect(connector.state().attempts).toBe(0);
  });

  it('still parks after the reconnect retries are used up', async () => {
    const { session, link, connector } = build({ maxAttempts: 3 });
    session.probes = [summary()];
    await connector.tickOnce();

    link.status = 'error';
    link.afterAttach = { status: 'error', errorCode: 'sync' };
    await connector.tickOnce();
    await connector.tickOnce();
    await connector.tickOnce();
    expect(connector.state().parked).toBe(true);

    // 停手后不再对着设备空转；拔插一次或手动连接才会重新武装
    const before = link.attachments.length;
    await connector.tickOnce();
    expect(link.attachments).toHaveLength(before);
  });

  it('gives a device that rebooted mid-session two cold sync retries before parking', async () => {
    const { session, link, connector, events } = build({ coldSyncRetries: 2 });
    session.probes = [summary()];
    await connector.tickOnce();
    expect(link.getState().status).toBe('ready');

    // 固件把参数落盘后自己复位：在 USB 上看起来就是"拔掉再插回"，device id 也变了
    link.status = 'error';
    link.errorCode = 'device';
    session.probes = [];
    await connector.tickOnce();

    session.probes = [summary({ id: 'native-0a67-0010-6' })];
    link.afterAttach = { status: 'error', errorCode: 'sync' };
    await connector.tickOnce();
    expect(link.attachments).toHaveLength(2);
    // 曾经连上过的设备不能一次同步失败就被判成"停在升级模式"
    expect(connector.state().parked).toBe(false);

    link.afterAttach = { status: 'ready', errorCode: null };
    await connector.tickOnce();
    expect(link.getState().status).toBe('ready');
    expect(events.some((line) => line.includes('还没有准备好应答参数同步'))).toBe(true);
  });

  it('remembers a link that was connected outside the background connector', async () => {
    const { session, link, connector, events } = build({ coldSyncRetries: 2 });
    connector.start();
    // 用户手动连接（或会话恢复）先连上了，后台 tick 还没跑过
    link.emitReady();
    expect(link.getState().status).toBe('ready');

    // 固件复位：设备消失、带着新 id 回来，同步失败
    link.status = 'error';
    link.errorCode = 'device';
    session.probes = [];
    await connector.tickOnce();
    session.probes = [summary({ id: 'native-0a67-0010-7' })];
    link.afterAttach = { status: 'error', errorCode: 'sync' };
    await connector.tickOnce();

    expect(connector.state().parked).toBe(false);
    expect(events.some((line) => line.includes('还没有准备好应答参数同步'))).toBe(true);
  });

  it('parks once the cold retries are used up', async () => {
    const { session, link, connector } = build({ coldSyncRetries: 2 });
    session.probes = [summary()];
    await connector.tickOnce();

    link.status = 'error';
    session.probes = [];
    await connector.tickOnce();
    session.probes = [summary()];
    link.afterAttach = { status: 'error', errorCode: 'sync' };
    await connector.tickOnce();
    await connector.tickOnce();
    expect(connector.state().parked).toBe(false);
    await connector.tickOnce();
    expect(connector.state().parked).toBe(true);

    const before = link.attachments.length;
    await connector.tickOnce();
    expect(link.attachments).toHaveLength(before);
  });

  it('probes only the target VID/PID instead of enumerating every HID device', async () => {
    const { session, connector } = build();
    session.probes = [summary()];

    await connector.tickOnce();

    expect(session.probeFilters).toEqual([{ vendorId: VID, productId: PID }]);
  });

  it('subscribes to USB hot-plug events and unbinds on stop', () => {
    const { session, connector } = build();

    connector.start();
    expect(session.watchCalls).toBe(1);
    expect(session.watchers.size).toBe(1);

    connector.stop();
    expect(session.watchers.size).toBe(0);
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
