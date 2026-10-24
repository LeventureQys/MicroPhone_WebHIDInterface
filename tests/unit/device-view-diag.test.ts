import { beforeEach, describe, expect, it } from 'vitest';
import { DiagnosticsHub } from '../../src/renderer/src/device/diagnostics';
import type { DeviceBoundTransport, DiagEntry, SelfCheckResult } from '../../src/renderer/src/device/transport';
import type { DeviceLink } from '../../src/renderer/src/device/link';
import { WebHidSession } from '../../src/renderer/src/device/webhid/session';
import { setLang, t } from '../../src/renderer/src/i18n';
import { createDeviceView } from '../../src/renderer/src/ui/views/device-view';
import { FakeKit } from './helpers/webhid-fakes';

function entry(summary: string, level: DiagEntry['level'] = 'info'): DiagEntry {
  return { at: 1_700_000_000_000, dir: 'in', hex: 'C4 0A 00', summary, level };
}

/** 假链路：只给诊断卡需要的三个方法 */
function fakeLink(options: {
  readonly transport: DeviceBoundTransport | null;
  readonly device?: unknown;
}): DeviceLink {
  return {
    transport: () => options.transport,
    getState: () => ({
      status: options.transport === null ? 'idle' : 'ready',
      mode: 'virtual',
      deviceId: options.transport === null ? null : 'mic-m001',
      sync: options.transport === null ? 'idle' : 'ready',
      error: null,
      errorCode: null,
      device: options.device ?? null,
      warning: null,
    }),
    onChange: () => () => undefined,
  } as unknown as DeviceLink;
}

interface MutableLink {
  readonly link: DeviceLink;
  /** 改设备快照并通知订阅方（模拟 link 状态变化） */
  setDevice(device: unknown): void;
}

/** 可变的假链路：用来验证"连接/断开时诊断导出里的设备行会跟着变"（A37） */
function mutableLink(initialDevice: unknown): MutableLink {
  let device: unknown = initialDevice;
  const listeners = new Set<() => void>();
  const link = {
    transport: () => null,
    getState: () => ({
      status: device === null ? 'idle' : 'ready',
      mode: 'virtual',
      deviceId: device === null ? null : 'mic-m001',
      sync: device === null ? 'idle' : 'ready',
      error: null,
      errorCode: null,
      device,
      warning: null,
    }),
    onChange: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  } as unknown as DeviceLink;
  return {
    link,
    setDevice(next: unknown): void {
      device = next;
      for (const cb of [...listeners]) cb();
    },
  };
}

function fakeTransport(selfCheck: () => Promise<SelfCheckResult>): DeviceBoundTransport {
  return {
    stats: () => ({
      outFrames: 7,
      inFrames: 5,
      crcErrors: 0,
      timeouts: 0,
      retries: 0,
      droppedPolls: 0,
      queueDepth: 0,
    }),
    selfCheck,
  } as unknown as DeviceBoundTransport;
}

function mount(hub: DiagnosticsHub | undefined, link?: DeviceLink): { root: HTMLElement; view: HTMLElement } {
  const session = new WebHidSession({ kit: new FakeKit() });
  const view = createDeviceView(session, { hub, link });
  const root = document.createElement('div');
  root.append(view);
  document.body.append(root);
  return { root, view };
}

function logRows(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.diag-log-row'));
}

describe('device view / 诊断卡（5.1b）', () => {
  beforeEach(() => {
    setLang('zh');
    document.body.innerHTML = '';
  });

  it('1. 未注入 hub 时创建不抛错，诊断卡存在且显示空态', () => {
    const { root, view } = mount(undefined);
    const titles = Array.from(root.querySelectorAll('.card-title')).map((node) => node.textContent);
    expect(titles).toContain(t('diag.title'));
    expect(root.querySelector('.diag-log-empty')?.textContent).toBe(t('diag.log.empty'));
    expect(root.querySelector<HTMLDetailsElement>('.diag-details')?.open).toBe(false);
    (view as HTMLElement & { destroy?: () => void }).destroy?.();
  });

  it('2. 日志按 200 条上限渲染（R8-4）', () => {
    const hub = new DiagnosticsHub();
    const { root, view } = mount(hub);
    for (let index = 0; index < 3; index += 1) hub.push(entry(`帧 ${index}`));
    expect(logRows(root)).toHaveLength(3);

    for (let index = 3; index < 205; index += 1) hub.push(entry(`帧 ${index}`));
    expect(hub.entries()).toHaveLength(205);
    expect(logRows(root)).toHaveLength(200);
    // 只留最近 200 条：最旧的 5 条不在 DOM 里
    expect(logRows(root)[0].textContent).toContain('帧 5');
    expect(logRows(root).at(-1)?.textContent).toContain('帧 204');
    (view as HTMLElement & { destroy?: () => void }).destroy?.();
  });

  it('3. 统计随 hub 更新，CRC 错条目带 is-error', () => {
    const hub = new DiagnosticsHub();
    const { root, view } = mount(hub);
    hub.push(entry('CRC 校验失败', 'error'));
    hub.update({ crcErrors: 1, outFrames: 12 });

    expect(root.querySelector<HTMLElement>('[data-stat="crc"]')?.textContent).toBe('1');
    expect(root.querySelector<HTMLElement>('[data-stat="out"]')?.textContent).toBe('12');
    expect(logRows(root)[0].classList.contains('is-error')).toBe(true);
    (view as HTMLElement & { destroy?: () => void }).destroy?.();
  });

  it('4. destroy() 后推日志不再改 DOM', () => {
    const hub = new DiagnosticsHub();
    const { root, view } = mount(hub);
    hub.push(entry('第一条'));
    expect(logRows(root)).toHaveLength(1);
    (view as HTMLElement & { destroy?: () => void }).destroy?.();

    hub.push(entry('第二条'));
    hub.update({ crcErrors: 9 });
    expect(logRows(root)).toHaveLength(1);
    expect(root.querySelector<HTMLElement>('[data-stat="crc"]')?.textContent).toBe('0');
  });

  it('5. 未连设备时自检按钮 disabled；连上后能跑出逐条结果', async () => {
    const offline = mount(undefined, fakeLink({ transport: null }));
    const disabled = offline.root.querySelector<HTMLButtonElement>('.diag-selfcheck');
    expect(disabled?.disabled).toBe(true);
    (offline.view as HTMLElement & { destroy?: () => void }).destroy?.();

    const online = mount(
      new DiagnosticsHub(),
      fakeLink({
        transport: fakeTransport(async () => ({
          ok: true,
          steps: [{ name: 'sync', ok: true, detail: '回读完成' }],
        })),
      }),
    );
    const button = online.root.querySelector<HTMLButtonElement>('.diag-selfcheck');
    expect(button?.disabled).toBe(false);
    expect(online.root.querySelector<HTMLElement>('[data-stat="out"]')?.textContent).toBe('7');
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const steps = Array.from(online.root.querySelectorAll<HTMLElement>('.diag-selfcheck-step'));
    expect(steps).toHaveLength(1);
    expect(steps[0].classList.contains('is-ok')).toBe(true);
    expect(steps[0].textContent).toContain(t('diag.selfcheck.ok'));
    (online.view as HTMLElement & { destroy?: () => void }).destroy?.();
  });

  it('5b. 设备摘要读 link 的 DeviceSnapshot，未连接时显示 —', () => {
    const offline = mount(undefined);
    expect(offline.root.querySelector<HTMLElement>('[data-diag="model"]')?.textContent).toBe(t('diag.device.none'));
    (offline.view as HTMLElement & { destroy?: () => void }).destroy?.();

    const online = mount(
      new DiagnosticsHub(),
      fakeLink({
        transport: null,
        device: {
          modelCode: 'JYM001',
          deviceName: 'MIC M001',
          firmware: { x: 1, y: 2, z: 3, build: 45 },
          firmwareType: 1,
          vid: 0x352f,
          pid: 0x0111,
          serial: 'VHID-MIC-M001',
          comErrAck: 0,
        },
      }),
    );
    expect(online.root.querySelector<HTMLElement>('[data-diag="model"]')?.textContent).toBe('JYM001');
    expect(online.root.querySelector<HTMLElement>('[data-diag="firmware"]')?.textContent).toBe('1.2.3.45');
    expect(online.root.querySelector<HTMLElement>('[data-diag="vidpid"]')?.textContent).toBe('0x352F / 0x0111');
    (online.view as HTMLElement & { destroy?: () => void }).destroy?.();
  });

  it('5c. 诊断导出的设备行随 link 变化（A37）：连上写快照、断开写未连接', () => {
    const device = {
      modelCode: 'JYM001',
      deviceName: 'MIC M001',
      firmware: { x: 1, y: 0, z: 0, build: 0 },
      firmwareType: 1,
      vid: 0x0a67,
      pid: 0x0010,
      serial: 'VHID-MIC-M001',
      comErrAck: 0,
    };
    const hub = new DiagnosticsHub();
    const handle = mutableLink(null);
    const { view } = mount(hub, handle.link);
    // 未连接：导出文本里的设备行是占位
    expect(hub.toText()).toContain('设备：未连接');

    handle.setDevice(device);
    expect(hub.toText()).toContain(
      '设备：JYM001 MIC M001 / 固件 1.0.0.0 / VID 0x0A67 PID 0x0010 / SN VHID-MIC-M001',
    );

    handle.setDevice(null);
    expect(hub.toText()).toContain('设备：未连接');
    (view as HTMLElement & { destroy?: () => void }).destroy?.();
  });

  it('5d. 写入语义说明（A42）在连接卡里固定展示', () => {
    const { root, view } = mount(undefined);
    expect(root.querySelector('.device-save-note')?.textContent).toBe(t('device.saveNote'));
    (view as HTMLElement & { destroy?: () => void }).destroy?.();
  });
});
