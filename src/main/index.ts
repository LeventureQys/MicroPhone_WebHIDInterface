import { app, BrowserWindow, ipcMain, powerSaveBlocker, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  IPC_DFU_CLOSE_BLOCKED,
  IPC_GET_PLATFORM_INFO,
  IPC_REQUEST_HID_DEVICE,
  IPC_SET_DFU_ACTIVE,
  IPC_SET_HID_WHITELIST,
  PLATFORM_INFO_ARG,
} from '../shared/types';
import type { HidWhitelist, PlatformInfo } from '../shared/types';
import { DEFAULT_HID_WHITELIST, normalizeWhitelist } from '../shared/webhid-whitelist';
import { captureAndExit } from './screenshot';
import { installWebHidHandlers } from './webhid';
import { applyWindowMenu, createMainWindow } from './window';

// 本机沙箱环境下 Chromium 无法在默认 userData 上初始化（0xC0000005），
// 开发态一律落到项目内 .userdata；打包产物默认交给用户机默认路径。
// 免安装包（portable）额外把数据放在 exe 同级，拷走单个 exe 时配置与日志跟着走。
function resolveUserDataDir(): string {
  const explicit = process.env.MICSTUDIO_USER_DATA;
  if (explicit) return explicit;
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) return path.join(portableDir, 'MicStudioData');
  return app.isPackaged ? '' : path.join(process.cwd(), '.userdata');
}

const userDataOverride = resolveUserDataDir();
if (userDataOverride) {
  try {
    fs.mkdirSync(userDataOverride, { recursive: true });
    app.setPath('userData', userDataOverride);
  } catch {
    // exe 同级不可写（Program Files / 只读介质）时退回 Electron 默认目录
  }
}

// 启动日志：打包产物没有控制台，出问题只能靠这份文件定位
// 写入必须"永不抛错"：调用方把 stdout 接成管道后关闭（`$out = & electron …`）、
// 另一个实例并发持有同一份文件、磁盘写满，都会让 console.log/appendFileSync 出错。
// 管道断开时 Node 报的是异步 'error' 事件（不是 console.log 里的同步 throw），
// 没有监听器就会升级成 uncaughtException；而记录崩溃本身又要写日志，于是自我递归。
const LOG_MAX_BYTES = 8 * 1024 * 1024;
const logFile = path.join(app.getPath('userData'), 'startup.log');
let logWritten = 0;
let logBudgetExhausted = false;
let crashLogged = false;
let stdoutUsable = true;

// 就地吃掉管道断开的 EPIPE：之后 console.log 只是静默失效，不再变成崩溃
process.stdout.on('error', () => {
  stdoutUsable = false;
});
process.stderr.on('error', () => {
  stdoutUsable = false;
});

try {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  // 每次启动清空；文件被另一个实例占用时清空可能失败，但那不能阻止启动
  fs.writeFileSync(logFile, '');
} catch {
  // 目录不可写/文件被占用：继续跑，日志降级为只打控制台
}

function logLine(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  if (!logBudgetExhausted) {
    try {
      fs.appendFileSync(logFile, line);
      logWritten += Buffer.byteLength(line);
      if (logWritten > LOG_MAX_BYTES) {
        logBudgetExhausted = true;
        try {
          fs.appendFileSync(logFile, `${new Date().toISOString()} log-budget-exhausted bytes=${logWritten}\n`);
        } catch {
          // 预算已用尽，这行写不下也无所谓
        }
      }
    } catch {
      // 写盘失败（占用/只读/磁盘满）不能影响主流程
    }
  }
  if (!stdoutUsable) return;
  try {
    console.log('[main]', message);
  } catch {
    // stdout 已被调用方关闭（EPIPE）：吞掉并停止再写，写日志永远不许抛错
    stdoutUsable = false;
  }
}

function logCrash(kind: string, detail: string): void {
  if (crashLogged) {
    // 已经记录过一次崩溃：再写日志很可能就是在重复触发同一个崩溃源，直接退出
    process.exit(1);
    return;
  }
  crashLogged = true;
  logLine(`${kind}=${detail}`);
}

logLine(`boot packaged=${app.isPackaged} argv=${JSON.stringify(process.argv)}`);
logLine(`userData=${app.getPath('userData')}`);
logLine(`portableDir=${process.env.PORTABLE_EXECUTABLE_DIR ?? ''}`);

if (app.isPackaged) app.setAppUserModelId('com.micstudio.app');

process.on('uncaughtException', (error) => {
  logCrash('uncaught', error instanceof Error ? (error.stack ?? error.message) : String(error));
});

process.on('unhandledRejection', (reason) => {
  logCrash('unhandledRejection', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
});

const hasLock = app.requestSingleInstanceLock();
logLine(`singleInstanceLock=${hasLock}`);
if (!hasLock) {
  app.quit();
}

// 真机白名单、DFU 守卫状态都只在本进程内，渲染进程经 IPC 下发
let hidWhitelist: HidWhitelist = DEFAULT_HID_WHITELIST;
let dfuActive = false;
let powerBlockerId: number | null = null;

function platformInfo(): PlatformInfo {
  return { platform: process.platform, appVersion: app.getVersion(), locale: app.getLocale() };
}

function notifyDfuCloseBlocked(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_DFU_CLOSE_BLOCKED);
  }
}

// 升级期间拦关闭：窗口不关，通知渲染进程提示用户等升级结束
function installDfuCloseGuard(win: BrowserWindow): void {
  win.on('close', (event) => {
    if (!dfuActive) return;
    event.preventDefault();
    logLine('dfu-close-blocked window');
    if (!win.isDestroyed()) win.webContents.send(IPC_DFU_CLOSE_BLOCKED);
  });
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

  const info = platformInfo();
  logLine(`platform=${info.platform} appVersion=${info.appVersion} locale=${info.locale}`);
  logLine(`guards dfuActive=${dfuActive} whitelistEntries=${hidWhitelist.entries.length}`);
  const platformInfoArg = `${PLATFORM_INFO_ARG}${JSON.stringify(info)}`;

  installWebHidHandlers(session.defaultSession, { getWhitelist: () => hidWhitelist });

  ipcMain.handle(IPC_SET_HID_WHITELIST, (_event, raw: unknown) => {
    hidWhitelist = normalizeWhitelist(raw);
    logLine(
      `whitelist-updated entries=${hidWhitelist.entries.length} vids=${hidWhitelist.vids.length} pids=${hidWhitelist.pids.length}`,
    );
    return undefined;
  });

  ipcMain.handle(IPC_GET_PLATFORM_INFO, () => platformInfo());

  // 主进程不拦截真机请求：选择器交给渲染进程的 navigator.hid.requestDevice()
  ipcMain.handle(IPC_REQUEST_HID_DEVICE, async () => ({ ok: true }));

  ipcMain.handle(IPC_SET_DFU_ACTIVE, (_event, active: unknown) => {
    dfuActive = active === true;
    if (dfuActive) {
      if (powerBlockerId === null) powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    } else if (powerBlockerId !== null) {
      powerSaveBlocker.stop(powerBlockerId);
      powerBlockerId = null;
    }
    logLine(`dfu-active=${dfuActive} blocker=${powerBlockerId === null ? 'none' : powerBlockerId}`);
    return undefined;
  });

  const win = createMainWindow({
    width: Number(readArg('width') ?? 0) || undefined,
    height: Number(readArg('height') ?? 0) || undefined,
    additionalArguments: [platformInfoArg],
  });
  installDfuCloseGuard(win);
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
    if (BrowserWindow.getAllWindows().length === 0) {
      installDfuCloseGuard(createMainWindow({ additionalArguments: [platformInfoArg] }));
    }
  });
});

app.on('window-all-closed', () => {
  logLine('window-all-closed');
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (dfuActive) {
    event.preventDefault();
    logLine('dfu-close-blocked quit');
    notifyDfuCloseBlocked();
    return;
  }
  logLine('before-quit');
});
