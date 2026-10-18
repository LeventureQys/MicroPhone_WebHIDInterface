import { app, BrowserWindow, ipcMain, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC_REQUEST_HID_DEVICE } from '../shared/types';
import { captureAndExit } from './screenshot';
import { installWebHidHandlers } from './webhid';
import { applyWindowMenu, createMainWindow } from './window';

// 本机沙箱环境下 Chromium 无法在默认 userData 上初始化（0xC0000005），
// 开发态一律落到项目内 .userdata；打包产物交给用户机默认路径。
const userDataOverride =
  process.env.MICSTUDIO_USER_DATA ??
  (app.isPackaged ? '' : path.join(process.cwd(), '.userdata'));
if (userDataOverride) app.setPath('userData', userDataOverride);

// 启动日志：打包产物没有控制台，出问题只能靠这份文件定位
const logFile = path.join(app.getPath('userData'), 'startup.log');
fs.mkdirSync(path.dirname(logFile), { recursive: true });
fs.writeFileSync(logFile, '');
function logLine(message: string): void {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
    console.log('[main]', message);
  } catch {
    // 日志失败不能影响启动
  }
}

logLine(`boot packaged=${app.isPackaged} argv=${JSON.stringify(process.argv)}`);
logLine(`userData=${app.getPath('userData')}`);

process.on('uncaughtException', (error) => {
  logLine(`uncaught=${error instanceof Error ? error.stack : String(error)}`);
});

const hasLock = app.requestSingleInstanceLock();
logLine(`singleInstanceLock=${hasLock}`);
if (!hasLock) {
  app.quit();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((item) => item.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function focusExistingWindow(): void {
  const [win] = BrowserWindow.getAllWindows();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

app.on('second-instance', focusExistingWindow);

app.whenReady().then(() => {
  logLine('ready');
  applyWindowMenu();
  installWebHidHandlers(session.defaultSession);

  ipcMain.handle(IPC_REQUEST_HID_DEVICE, async () => ({
    ok: false,
    reason: 'not-implemented',
  }));

  const win = createMainWindow({
    width: Number(readArg('width') ?? 0) || undefined,
    height: Number(readArg('height') ?? 0) || undefined,
  });
  logLine(`window-created`);

  win.webContents.on('did-fail-load', (_event, code, description) => {
    logLine(`did-fail-load ${code} ${description}`);
  });
  win.webContents.on('console-message', (_event, _level, message) => {
    logLine(`renderer: ${message}`);
  });

  const screenshotPath = readArg('screenshot');
  const route = readArg('route');
  const execFile = readArg('exec-file');
  const holdMs = Number(readArg('hold') ?? 0);
  if (screenshotPath) logLine(`screenshot-mode ${screenshotPath}`);

  if (!screenshotPath && Number.isFinite(holdMs) && holdMs > 0) {
    // 验收用：保持窗口存活指定毫秒后自行退出，避免测试脚本吊死在常驻进程上
    logLine(`hold-mode ${holdMs}ms`);
    setTimeout(() => {
      logLine('hold-mode-finished');
      app.exit(0);
    }, holdMs);
  }

  if (screenshotPath) {
    win.webContents.once('did-finish-load', () => {
      logLine('did-finish-load, capturing');
      void captureAndExit(win, { filePath: screenshotPath, route, execFile });
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  logLine('window-all-closed');
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  logLine('before-quit');
});
