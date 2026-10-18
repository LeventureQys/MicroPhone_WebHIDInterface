import { BrowserWindow, Menu } from 'electron';
import path from 'node:path';

export interface WindowSize {
  width?: number;
  height?: number;
}

export function createMainWindow(size: WindowSize = {}): BrowserWindow {
  const win = new BrowserWindow({
    width: size.width ?? 1280,
    height: size.height ?? 820,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0e1118',
    autoHideMenuBar: true,
    title: 'MIC STUDIO',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.on('ready-to-show', () => win.show());

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  win.webContents.on('did-fail-load', (_event, code, description) => {
    console.error('[window] did-fail-load', code, description);
  });
  win.webContents.on('console-message', (_event, _level, message) => {
    console.log('[renderer]', message);
  });

  return win;
}

export function applyWindowMenu(): void {
  Menu.setApplicationMenu(null);
}
