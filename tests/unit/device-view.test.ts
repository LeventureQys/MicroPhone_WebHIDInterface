import { beforeEach, describe, expect, it } from 'vitest';
import { WebHidSession } from '../../src/renderer/src/device/webhid/session';
import { setLang, t } from '../../src/renderer/src/i18n';
import { createDeviceView } from '../../src/renderer/src/ui/views/device-view';
import { FakeHidDevice, FakeKit, flush } from './helpers/webhid-fakes';

function buttons(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('.device-actions .btn'));
}

function mount(session: WebHidSession): { root: HTMLElement; view: HTMLElement } {
  const view = createDeviceView(session);
  const root = document.createElement('div');
  root.append(view);
  document.body.append(root);
  return { root, view };
}

describe('device view', () => {
  beforeEach(() => {
    setLang('zh');
    document.body.innerHTML = '';
  });

  it('renders the idle state with the connect button enabled', () => {
    const session = new WebHidSession({ kit: new FakeKit() });
    const { root, view } = mount(session);

    const titles = Array.from(view.querySelectorAll('.card-title')).map((node) => node.textContent);
    expect(titles).toEqual(
      expect.arrayContaining([t('device.devices'), t('device.reports'), t('device.title'), t('device.kit')]),
    );
    expect(root.querySelector('.device-empty')?.textContent).toBe(t('device.devices.idle'));

    const [connect, disconnect] = buttons(root);
    expect(connect.disabled).toBe(false);
    expect(connect.textContent).toBe(t('device.connect'));
    expect(disconnect.disabled).toBe(true);

    (view as HTMLElement & { destroy?: () => void }).destroy?.();
  });

  it('lists bridge devices, opens one and shows its reports', async () => {
    const device = new FakeHidDevice({ deviceId: 'gamepad', productName: 'Virtual Gamepad' });
    const session = new WebHidSession({ kit: new FakeKit({ devices: [device] }) });
    const { root, view } = mount(session);

    buttons(root)[0].click();
    await flush();

    const rows = root.querySelectorAll('.device-row');
    expect(rows).toHaveLength(1);
    expect(root.querySelector('.device-row-name')?.textContent).toBe('Virtual Gamepad');
    expect(root.querySelector('.device-row-id')?.textContent).toContain('0x1234');

    const open = root.querySelector<HTMLButtonElement>('.device-row .btn');
    expect(open?.textContent).toBe(t('device.devices.open'));
    open?.click();
    await flush();

    expect(root.querySelector('.device-badge--open')?.textContent).toBe(t('device.devices.opened'));

    device.emitInputReport(2, [0x40, 0x7f]);
    await new Promise((resolve) => setTimeout(resolve, 90));

    expect(root.querySelector('.device-hex')?.textContent).toBe('40 7F');
    expect(root.querySelector('.device-field-key')?.textContent).toBe('1:48');
    expect(root.querySelector('.device-field-value')?.textContent).toBe('64');

    (view as HTMLElement & { destroy?: () => void }).destroy?.();
  });

  it('surfaces a bridge failure with the mapped message', async () => {
    const session = new WebHidSession({
      kit: new FakeKit({ failInstall: new Error('cannot connect to ws://127.0.0.1:8765/ws') }),
    });
    const { root, view } = mount(session);

    buttons(root)[0].click();
    await flush();

    const box = root.querySelector<HTMLElement>('.device-error');
    expect(box?.hidden).toBe(false);
    expect(root.querySelector('.device-error-title')?.textContent).toBe(t('device.error.bridge'));
    expect(root.querySelector('.device-error-detail')?.textContent).toContain('cannot connect');

    (view as HTMLElement & { destroy?: () => void }).destroy?.();
  });

  it('keeps the routing contract: destroy unsubscribes without touching the session', async () => {
    const session = new WebHidSession({ kit: new FakeKit() });
    const { view } = mount(session);
    (view as HTMLElement & { destroy?: () => void }).destroy?.();

    await expect(session.connect('virtual')).resolves.toBeUndefined();
    expect(session.getState().status).toBe('ready');
  });
});
