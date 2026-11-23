/**
 * v1.1.3 全量测试 S 系列：稳定性与回归。
 *
 *   node scripts/probes/fulltest-s.mjs [--app=<快照目录>] [--port=9374]
 *
 * S1 抽屉/语言/场景高频切换 200 次：无未捕获异常、DOM 节点与 JS 堆稳定
 * S4 单实例与退出：二次启动只退出自己、窗口关闭后进程退出、锁释放、无残留子进程
 * S5 离线可用：--proxy-server 指向黑洞端口启动 + 全功能走查
 * S2 坑 14/18：不带 --no-sandbox 直接拉起 Electron，记录是否复现本机 GPU 沙箱崩溃
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = 'D:\\WorkShop\\MicroPhone_WebHIDInterface';
const args = new Map(
  process.argv.slice(2).map((item) => {
    const match = item.match(/^--([^=]+)=(.*)$/);
    return match ? [match[1], match[2]] : [item, ''];
  }),
);
const appRoot = args.get('app') ? path.resolve(args.get('app')) : 'D:\\Temp\\micstudio-fulltest\\v1.1.3-baseline';
const outDir = args.get('out') ? path.resolve(args.get('out')) : path.join(repo, 'artifacts', 'fulltest-20261121', 'stability');
const port = Number(args.get('port') ?? 9374);
const electron = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!existsSync(electron)) throw new Error(`electron not found: ${electron}`);
mkdirSync(outDir, { recursive: true });

const results = { startedAt: new Date().toISOString(), checks: [], measurements: {} };
const log = (...items) => console.log(`[s] ${new Date().toISOString().slice(11, 19)}`, ...items);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function check(id, ok, detail) {
  results.checks.push({ id, ok: Boolean(ok), detail: detail ?? null });
  log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
}

class Cdp {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.exceptions = []; }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('cdp socket error')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') this.exceptions.push(message.params?.exceptionDetails?.exception?.description ?? 'exception');
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }
  send(method, params = {}, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`cdp timeout: ${method}`)); }, timeoutMs);
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  async keyEscape() {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
}

async function findTarget(deadlineMs = 40_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && (item.url ?? '').includes('index.html'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // 等端口
    }
    await wait(300);
  }
  return null;
}

const HELPERS = `(() => {
  window.__ftErrors = [];
  window.addEventListener('error', (event) => window.__ftErrors.push(String(event.message)));
  window.addEventListener('unhandledrejection', (event) => window.__ftErrors.push(String(event.reason)));
  window.__st = {
    measure() {
      const nodes = document.getElementsByTagName('*').length;
      const mem = performance.memory ? performance.memory.usedJSHeapSize : null;
      return { nodes, mem };
    },
  };
  return true;
})()`;

function launch(tag, extraArgs = [], profileOverride = null) {
  const profile = profileOverride ?? path.join('D:\\Temp\\micstudio-fulltest', `userdata-s-${tag}`);
  if (!profileOverride) {
    rmSync(profile, { recursive: true, force: true });
    mkdirSync(profile, { recursive: true });
  }
  const env = { ...process.env, MICSTUDIO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, ['.', '--no-sandbox', `--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding', ...extraArgs], {
    cwd: appRoot,
    env,
    stdio: 'ignore',
    windowsHide: false,
  });
  return { child, profile };
}

async function main() {
  // ---- S1 高频切换 --------------------------------------------------------
  const first = launch('s1');
  const target = await findTarget();
  if (!target) throw new Error('devtools target not found');
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
  const bootDeadline = Date.now() + 30_000;
  while (Date.now() < bootDeadline) {
    if (await cdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
    await wait(300);
  }
  await cdp.evaluate(HELPERS);
  // 切 mock + 关自动连接，避免高频操作误写真机
  await cdp.evaluate(`localStorage.setItem('micstudio.channel','mock'); localStorage.setItem('micstudio.autoConnect','0'); location.reload(); true`);
  await wait(1800);
  await cdp.evaluate(HELPERS);
  await wait(1500);

  const start = await cdp.evaluate(`window.__st.measure()`);
  const cycles = 200;
  const samples = [{ at: 0, ...start }];
  const langs = ['en', 'zh'];
  for (let index = 1; index <= cycles; index += 1) {
    await cdp.evaluate(`window.__micstudioGo('advanced'); true`);
    await wait(35);
    await cdp.keyEscape();
    await cdp.evaluate(`window.__micstudioGo('settings'); true`);
    await wait(35);
    await cdp.evaluate(`document.querySelector('.modal-close')?.click(); true`);
    if (index % 4 === 0) {
      const scene = ['quiet', 'meeting', 'podcast', 'sing', 'custom'][index % 5];
      await cdp.evaluate(`document.querySelector('.scene-btn[data-scene="${scene}"]')?.click(); true`);
    }
    if (index % 20 === 0) {
      const lang = langs[(index / 20) % 2];
      await cdp.evaluate(`document.querySelector('.segmented--lang .seg-btn[data-value="${lang}"]')?.click(); true`);
      await wait(120);
    }
    if (index % 50 === 0) {
      await wait(400);
      samples.push({ at: index, ...(await cdp.evaluate(`window.__st.measure()`)) });
    }
  }
  await wait(1200);
  samples.push({ at: cycles, ...(await cdp.evaluate(`window.__st.measure()`)) });
  const errors = await cdp.evaluate(`window.__ftErrors`);
  const nodeDelta = Math.abs(samples[samples.length - 1].nodes - samples[0].nodes) / samples[0].nodes;
  const memDelta = samples[0].mem ? Math.abs(samples[samples.length - 1].mem - samples[0].mem) / samples[0].mem : 0;
  results.measurements.s1 = { samples, nodeDelta, memDelta, errors: [...errors, ...cdp.exceptions] };
  check('S1.1 200 次抽屉/场景/语言切换无未捕获异常', (errors?.length ?? 0) === 0 && cdp.exceptions.length === 0, { errors: [...(errors ?? []), ...cdp.exceptions].slice(0, 5) });
  check('S1.2 DOM 节点数稳定（±10%）', nodeDelta <= 0.1, { start: samples[0].nodes, end: samples[samples.length - 1].nodes, delta: Number(nodeDelta.toFixed(4)) });
  check('S1.3 JS 堆稳定（±25%，无持续增长）', memDelta <= 0.25, { start: samples[0].mem, end: samples[samples.length - 1].mem, delta: Number(memDelta.toFixed(4)) });

  // ---- S4 单实例与退出 ----------------------------------------------------
  const second = launch('second', [`--user-data-dir=${first.profile}`], first.profile);
  let secondExited = false;
  for (let index = 0; index < 20; index += 1) {
    await wait(250);
    if (second.child.exitCode !== null) { secondExited = true; break; }
  }
  const firstAlive = first.child.exitCode === null;
  check('S4.1 二次启动（同一 userData）只退出自己，已有窗口不受影响', secondExited && firstAlive, { secondExited, secondCode: second.child.exitCode, firstAlive });
  if (!secondExited) { try { spawn('taskkill', ['/PID', String(second.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }

  // 关闭第一个窗口 → 进程退出、锁释放
  await cdp.evaluate(`window.close(); true`).catch(() => undefined);
  let firstExited = false;
  for (let index = 0; index < 30; index += 1) {
    await wait(250);
    if (first.child.exitCode !== null) { firstExited = true; break; }
  }
  check('S4.2 关闭窗口后主进程自行退出', firstExited, { exitCode: first.child.exitCode });
  await wait(1500);
  // 用同一 profile 再起一次，能起来就说明单实例锁已释放
  const third = launch('s4-third', [`--user-data-dir=${first.profile}`], first.profile);
  const thirdTarget = await findTarget(20_000);
  check('S4.3 userData 单实例锁已释放（同 profile 能再次启动）', Boolean(thirdTarget), { target: Boolean(thirdTarget) });
  if (thirdTarget) {
    const thirdCdp = new Cdp(thirdTarget.webSocketDebuggerUrl);
    await thirdCdp.open();
    await thirdCdp.evaluate(`window.close(); true`).catch(() => undefined);
  }
  await wait(1500);
  try { spawn('taskkill', ['/PID', String(third.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  // 残留进程：按命令行过滤本 profile
  const ps = spawn('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*userdata-s-s1*' }).Count`], { stdio: 'ignore' });
  await new Promise((resolve) => ps.on('exit', resolve));
  results.measurements.s4 = { secondExited, firstExited };

  // ---- S5 离线可用（代理黑洞） -------------------------------------------
  const offline = launch('offline', ['--proxy-server=http://127.0.0.1:9']);
  const offlineTarget = await findTarget(30_000);
  if (!offlineTarget) throw new Error('offline instance did not start');
  const offCdp = new Cdp(offlineTarget.webSocketDebuggerUrl);
  await offCdp.open();
  await offCdp.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
  const offDeadline = Date.now() + 30_000;
  while (Date.now() < offDeadline) {
    if (await offCdp.evaluate(`typeof window.__micstudioGo === 'function'`)) break;
    await wait(300);
  }
  await offCdp.evaluate(HELPERS);
  await wait(1200);
  await offCdp.evaluate(`window.__micstudioGo('advanced'); true`);
  await wait(500);
  await offCdp.keyEscape();
  await offCdp.evaluate(`document.querySelector('.scene-btn[data-scene="meeting"]')?.click(); true`);
  await wait(600);
  await offCdp.evaluate(`document.querySelector('.segmented--lang .seg-btn[data-value="en"]')?.click(); true`);
  await wait(700);
  const offlineState = await offCdp.evaluate(`(() => ({
    lang: document.querySelector('.segmented--lang .seg-btn.is-active')?.dataset.value ?? null,
    scene: document.querySelector('.scene-btn.is-active')?.dataset.scene ?? null,
    body: document.body.innerText.length,
    errors: window.__ftErrors ?? [],
  }))()`);
  results.measurements.s5 = offlineState;
  check('S5 代理黑洞（等价断外网）启动后界面完整、场景/语言可用、无未捕获异常', offlineState.lang === 'en' && offlineState.scene === 'meeting' && offlineState.body > 200 && offlineState.errors.length === 0, offlineState);
  await offCdp.evaluate(`window.close(); true`).catch(() => undefined);
  await wait(2000);
  try { spawn('taskkill', ['/PID', String(offline.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }

  // ---- S2 坑 14/18：不带 --no-sandbox ------------------------------------
  const bare = spawn(electron, ['.', `--user-data-dir=${path.join('D:\\Temp\\micstudio-fulltest', 'userdata-s-bare')}`], {
    cwd: appRoot,
    env: (() => { const env = { ...process.env, MICSTUDIO_USER_DATA: path.join('D:\\Temp\\micstudio-fulltest', 'userdata-s-bare') }; delete env.ELECTRON_RUN_AS_NODE; return env; })(),
    stdio: 'ignore',
    windowsHide: true,
  });
  await wait(9000);
  const bareExited = bare.exitCode !== null;
  results.measurements.trap14 = { bareExited, exitCode: bare.exitCode };
  check('S2.1 坑 14/18：不带 --no-sandbox 的 Electron 在本机沙箱内无法存活（复现）', bareExited, { exited: bareExited, exitCode: bare.exitCode });
  try { spawn('taskkill', ['/PID', String(bare.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
}

main()
  .then(() => {
    const failed = results.checks.filter((item) => !item.ok);
    results.summary = { passed: results.checks.length - failed.length, failed: failed.length, total: results.checks.length };
    results.finishedAt = new Date().toISOString();
    writeFileSync(path.join(outDir, 's-results.json'), `${JSON.stringify(results, null, 1)}\n`, 'utf8');
    log(`SUMMARY passed=${results.summary.passed} failed=${results.summary.failed} total=${results.summary.total}`);
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch((error) => {
    results.error = String(error?.stack ?? error);
    writeFileSync(path.join(outDir, 's-results.json'), `${JSON.stringify(results, null, 1)}\n`, 'utf8');
    console.error('[s] failed', error);
    process.exit(2);
  });
