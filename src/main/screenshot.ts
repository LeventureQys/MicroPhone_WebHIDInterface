import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

interface ScreenshotOptions {
  filePath: string;
  route?: string;
  execFile?: string;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 验收取证用：窗口加载完成后切到指定路由、可选注入一段交互脚本，
 * 再等布局稳定抓真实像素。桌面截屏在本机沙箱会话下会挂起，因此统一走 capturePage。
 */
export async function captureAndExit(win: BrowserWindow, options: ScreenshotOptions): Promise<void> {
  const target = path.resolve(options.filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  try {
    if (options.route) {
      const route = JSON.stringify(options.route);
      await win.webContents.executeJavaScript(
        `window.__micstudioGo && window.__micstudioGo(${route})`,
      );
      await wait(320);
    }

    if (options.execFile) {
      const code = fs.readFileSync(path.resolve(options.execFile), 'utf8');
      const probeResult = await win.webContents.executeJavaScript(code, true);
      console.log('[probe]', typeof probeResult === 'string' ? probeResult : JSON.stringify(probeResult));
      await wait(320);
    }

    await wait(900);
    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    fs.writeFileSync(target, png);
    console.log('[screenshot]', target, png.length);
    app.exit(0);
  } catch (error) {
    console.error('[screenshot] failed', error instanceof Error ? error.message : error);
    app.exit(1);
  }
}
