import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROUTES = ['meter', 'input', 'eq', 'dynamics', 'drc', 'device', 'settings'];
const repoRoot = process.cwd();
const outIndex = path.join(repoRoot, 'out', 'renderer', 'index.html');
const artifactsDir = path.join(repoRoot, 'artifacts');
const userDataDir = path.join(repoRoot, '.userdata');
const timeoutMs = 60_000;

function electronBinary() {
  const candidate =
    process.platform === 'win32'
      ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
      : path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron');
  if (!fs.existsSync(candidate)) {
    console.error(
      `[screenshot] 找不到 Electron 可执行文件：${candidate}\n` +
        '先执行：node node_modules/electron/install.js（并设置 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）',
    );
    process.exit(1);
  }
  return candidate;
}

function ensureBuild() {
  if (fs.existsSync(outIndex)) return;
  console.log('[screenshot] out/renderer 不存在，先执行构建');
  execFileSync(process.execPath, [path.join(repoRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

function captureRoute(binary, route) {
  const target = path.join(artifactsDir, `shot-${route}.png`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.MICSTUDIO_USER_DATA = userDataDir;

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      binary,
      ['.', `--screenshot=${target}`, `--route=${route}`, '--no-sandbox'],
      { cwd: repoRoot, env, stdio: 'ignore' },
    );
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      const exists = fs.existsSync(target);
      const bytes = exists ? fs.statSync(target).size : 0;
      resolve({
        route,
        ok: code === 0 && bytes > 0,
        code,
        bytes,
        ms: Date.now() - started,
        target,
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ route, ok: false, code: -1, bytes: 0, ms: Date.now() - started, target, error });
    });
  });
}

async function main() {
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  ensureBuild();
  const binary = electronBinary();

  const results = [];
  for (const route of ROUTES) {
    console.log(`[screenshot] capturing ${route}`);
    results.push(await captureRoute(binary, route));
  }

  const failures = results.filter((item) => !item.ok);
  console.table(
    results.map((item) => ({
      route: item.route,
      ok: item.ok,
      bytes: item.bytes,
      ms: item.ms,
      file: path.relative(repoRoot, item.target),
    })),
  );

  if (failures.length > 0) {
    fs.writeFileSync(
      path.join(artifactsDir, 'screenshot-failures.log'),
      failures.map((item) => `${item.route}\tcode=${item.code}\tbytes=${item.bytes}`).join('\n'),
      'utf8',
    );
    console.error(`[screenshot] ${failures.length} 张失败，详见 artifacts/screenshot-failures.log`);
    process.exit(1);
  }
  console.log(`[screenshot] ${results.length} 张全部完成`);
}

main().catch((error) => {
  console.error('[screenshot] 异常', error);
  process.exit(1);
});
