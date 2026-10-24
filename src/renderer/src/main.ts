import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';

import { createShell, type Shell } from './app/shell';
import { ChannelTransport } from './device/channel-transport';
import { DiagnosticsHub } from './device/diagnostics';
import { FirmwareController } from './device/dfu/controller';
import { DeviceLink } from './device/link';
import { MockTransport } from './device/mock-transport';
import { createWebHidSession } from './device/webhid';
import { loadChannelConfig } from './domain/channel-config';
import { AppStore } from './domain/state';
import { currentLang } from './i18n';
import { createAdvancedView } from './ui/views/advanced-view';
import { createConsoleView } from './ui/views/console-view';
import { createDeviceView } from './ui/views/device-view';
import { createFirmwareView } from './ui/views/firmware-view';
import { createSettingsView } from './ui/views/settings-view';

/** 桥接地址来自设置页（`micstudio.bridgeUrl`，§5.15），缺省 ws://127.0.0.1:8765/ws */
function readBridgeUrl(): string {
  return loadChannelConfig().bridgeUrl;
}

async function boot(): Promise<void> {
  const mount = document.getElementById('app');
  if (!mount) throw new Error('#app not found');

  // 一条参数链路：ChannelTransport 决定现在说话的是 Mock 还是真实设备，
  // AppStore / 各视图只认这一个 Transport，切换通道不重建订阅（任务书 §4.10）
  const mock = new MockTransport({ scene: 'speech', hz: 50 });
  const channel = new ChannelTransport(mock);
  const store = new AppStore(channel, { lang: currentLang() });
  // HID 会话比视图活得久：切语言或开关抽屉时连接不断
  const webhid = createWebHidSession({ bridgeUrl: readBridgeUrl() });
  const link = new DeviceLink({ session: webhid, channel, mock, store });
  await channel.open();

  // 诊断数据面：参数链路的帧日志进 hub，DFU 会话的帧日志也进同一个 hub（诊断卡只看一个来源）
  const hub = new DiagnosticsHub({ ringSize: loadChannelConfig().diagLimit });
  channel.onDiag((entry) => hub.push(entry));
  const firmware = new FirmwareController({ link, onDiag: (entry) => hub.push(entry) });

  // 抽屉之间互相跳转（设备 → 固件 / 设置），回调里用 shell 自己的句柄
  let shellRef: Shell | null = null;
  const shell = createShell({
    store,
    mock: channel.kind === 'mock',
    console: (api) => createConsoleView(store, channel, api),
    advanced: () => createAdvancedView(store),
    device: () =>
      createDeviceView(webhid, {
        link,
        hub,
        onOpenFirmware: () => shellRef?.openPanel('firmware'),
        onOpenSettings: () => shellRef?.openPanel('settings'),
      }),
    firmware: () => createFirmwareView({ controller: firmware, onClose: () => shellRef?.closePanel() }),
    settings: () => createSettingsView(store),
  });
  shellRef = shell;
  mount.replaceChildren(shell.root);

  // 验收截图脚本用它打开指定抽屉
  (window as Window & { __micstudioGo?: (panel: string) => void }).__micstudioGo = (panel) => {
    if (panel === 'advanced' || panel === 'device' || panel === 'firmware' || panel === 'settings') {
      shell.openPanel(panel);
      return;
    }
    shell.closePanel();
  };

  console.log('[boot] renderer ready', `channel=${channel.kind}`, `link=${link.getState().status}`);
}

void boot().catch((error) => {
  console.error('[boot] failed', error);
});
