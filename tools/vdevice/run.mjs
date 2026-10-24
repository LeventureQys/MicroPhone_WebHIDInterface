/**
 * 虚拟下位机总入口：一条命令拉起 Python 桥 + 侧车，任一子进程退出或收到 Ctrl+C 都把两个进程清理掉。
 *
 * 侧车与桥都是长驻进程，因此这里不用临时文件或后台守护，只做「起、等健康、转交信号、收拾」。
 * 自检脚本（selftest.mjs）复用这里的 startBridge/startSidecar，免得两份启动逻辑各自漂移。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TAG = '[vdevice]';
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const PROFILE_PATH = path.join(HERE, 'profiles', 'mic-m001.json');
export const SIDECAR_PATH = path.join(HERE, 'sidecar.mjs');
export const VIRTUAL_HID_PATH = path.join(REPO_ROOT, 'third_party', 'web_hid_utils', 'packages', 'virtual-hid');
export const DEVICE_ID = 'mic-m001';
export const DEFAULT_PYTHON =
  'C:\\Users\\a5935\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';

const HEALTH_INTERVAL_MS = 500;
const HEALTH_TIMEOUT_MS = 10_000;

function readValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseRunArgs(argv) {
  const options = { port: 8765, controlPort: 8766, bridgeUrl: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--port') {
      options.port = Number(readValue(argv, (index += 1), flag));
    } else if (flag === '--control-port') {
      options.controlPort = Number(readValue(argv, (index += 1), flag));
    } else if (flag === '--bridge-url') {
      options.bridgeUrl = readValue(argv, (index += 1), flag);
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 0xffff) {
    throw new Error(`--port must be an integer in 1..65535, got ${options.port}`);
  }
  if (!Number.isInteger(options.controlPort) || options.controlPort <= 0 || options.controlPort > 0xffff) {
    throw new Error(`--control-port must be an integer in 1..65535, got ${options.controlPort}`);
  }
  if (options.bridgeUrl === '') options.bridgeUrl = `ws://127.0.0.1:${options.port}/ws`;
  return options;
}

/** 解释器路径由 `MICSTUDIO_PYTHON` 覆盖；不存在时返回 null，由调用方决定退出码（入口 1、自检 2） */
export function resolvePython(env = process.env) {
  const python = env.MICSTUDIO_PYTHON ?? DEFAULT_PYTHON;
  return existsSync(python) ? python : null;
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForBridge(port, timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      await response.arrayBuffer();
      if (response.ok) return true;
    } catch {
      // 桥还没开始监听，继续轮询
    }
    await delay(HEALTH_INTERVAL_MS);
  }
  return false;
}

export function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill();
  } catch {
    // 进程已消失
  }
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}

/** 起 Python 桥（不等待健康）；stdio 可传 'ignore'/'pipe' 让自检脚本自己收日志 */
export function startBridge(options) {
  const { python, port, stdio = 'inherit', env = process.env, profilePath = PROFILE_PATH } = options;
  return spawn(python, ['-m', 'virtual_hid', 'serve', '--config', profilePath, '--port', String(port)], {
    cwd: REPO_ROOT,
    env: { ...env, PYTHONPATH: VIRTUAL_HID_PATH, PYTHONIOENCODING: 'utf-8' },
    stdio,
  });
}

/** 起 Node 侧车（不等待它连上桥） */
export function startSidecar(options) {
  const { bridgeUrl, controlPort, deviceId = DEVICE_ID, level = 0, stdio = 'inherit', execPath = process.execPath } = options;
  return spawn(
    execPath,
    [
      SIDECAR_PATH,
      '--bridge',
      bridgeUrl,
      '--device',
      deviceId,
      '--control-port',
      String(controlPort),
      '--level',
      String(level),
    ],
    { cwd: REPO_ROOT, stdio },
  );
}

/**
 * 起一整套（桥 + 侧车）并等桥健康；任一步失败都把已起的子进程收拾掉再抛，
 * 免得调用方拿到半套环境还要自己猜哪半边活着。
 */
export async function startVDevice(options = {}) {
  const {
    port = 8765,
    controlPort = 8766,
    deviceId = DEVICE_ID,
    level = 0,
    stdio = 'inherit',
    python = resolvePython(),
    healthTimeoutMs = HEALTH_TIMEOUT_MS,
  } = options;
  if (python === null) {
    throw new Error(`python not found: ${process.env.MICSTUDIO_PYTHON ?? DEFAULT_PYTHON} (set MICSTUDIO_PYTHON)`);
  }
  const bridgeUrl = `ws://127.0.0.1:${port}/ws`;
  const bridge = startBridge({ python, port, stdio });
  const fail = (message) => {
    killChild(bridge);
    throw new Error(message);
  };
  bridge.on('error', (error) => {
    console.error(`${TAG} bridge spawn failed: ${error.message}`);
  });
  const healthy = await waitForBridge(port, healthTimeoutMs);
  if (!healthy) fail(`bridge did not answer http://127.0.0.1:${port}/healthz within ${healthTimeoutMs} ms`);
  const sidecar = startSidecar({ bridgeUrl, controlPort, deviceId, level, stdio });
  const cleanup = () => {
    killChild(sidecar);
    killChild(bridge);
  };
  return { bridge, sidecar, python, bridgeUrl, controlUrl: `http://127.0.0.1:${controlPort}`, cleanup };
}

async function main() {
  let options;
  try {
    options = parseRunArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${TAG} ${error.message}`);
    process.exit(1);
    return;
  }

  const python = resolvePython();
  if (python === null) {
    console.error(
      `${TAG} python not found: ${process.env.MICSTUDIO_PYTHON ?? DEFAULT_PYTHON} (set MICSTUDIO_PYTHON)`,
    );
    process.exit(1);
    return;
  }
  for (const required of [PROFILE_PATH, SIDECAR_PATH]) {
    if (existsSync(required)) continue;
    console.error(`${TAG} missing file: ${required}`);
    process.exit(1);
    return;
  }

  let shuttingDown = false;
  const children = { bridge: null, sidecar: null };

  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    killChild(children.sidecar);
    killChild(children.bridge);
    process.exit(code);
  }

  function onChildExit(name, code) {
    if (shuttingDown) return;
    console.error(`${TAG} ${name} exited with code ${code === null ? 'null' : code}`);
    shutdown(code === 0 ? 0 : 1);
  }

  const bridge = startBridge({ python, port: options.port });
  children.bridge = bridge;
  bridge.on('error', (error) => {
    console.error(`${TAG} bridge spawn failed: ${error.message}`);
    shutdown(1);
  });
  bridge.on('exit', (code) => onChildExit('bridge', code));

  const healthy = await waitForBridge(options.port);
  if (!healthy) {
    console.error(
      `${TAG} bridge did not answer http://127.0.0.1:${options.port}/healthz within ${HEALTH_TIMEOUT_MS} ms`,
    );
    shutdown(1);
    return;
  }

  const sidecar = startSidecar({ bridgeUrl: options.bridgeUrl, controlPort: options.controlPort, level: 0 });
  children.sidecar = sidecar;
  sidecar.on('error', (error) => {
    console.error(`${TAG} sidecar spawn failed: ${error.message}`);
    shutdown(1);
  });
  sidecar.on('exit', (code) => onChildExit('sidecar', code));

  console.log(`${TAG} bridge  http://127.0.0.1:${options.port}`);
  console.log(`${TAG} ws      ${options.bridgeUrl}`);
  console.log(`${TAG} control http://127.0.0.1:${options.controlPort}`);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => shutdown(0));
  }
  process.on('exit', () => {
    killChild(children.sidecar);
    killChild(children.bridge);
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) void main();
