/**
 * 补充取证（2026-11-13 问题清单）：
 *   - 压缩器 / 限制器的使能开关（旁通）是不是真的开关控件，能不能切换
 *   - 均衡器旁通的实际界面（上一次全量走查没滚到这一段）
 *
 *   node scripts/probes/verify-supplement-20261113.mjs
 *
 * 结束时把改过的开关恢复原状；截图写到 artifacts/verify-20261113/。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..', '..');
const shotDir = path.join(repo, 'artifacts', 'verify-20261113');
const electron = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const profile = 'D:\\Temp\\ud-verify-supplement';
const port = 9355;
if (!existsSync(electron)) throw new Error('electron missing');
mkdirSync(shotDir, { recursive: true });
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = { ...process.env, MICSTUDIO_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(
  electron,
  [
    '.',
    '--no-sandbox',
    `--remote-debugging-port=${port}`,
    '--width=1280',
    '--height=820',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
  ],
  { cwd: repo, env, stdio: 'ignore' },
);

const results = { checks: [] };
function check(name, ok, detail) {
  results.checks.push({ name, ok: Boolean(ok), detail: detail ?? null });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
}

try {
  let target = null;
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && target === null) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((item) => item.type === 'page' && (item.url ?? '').includes('index.html')) ?? null;
    } catch {
      // 端口还没起
    }
    if (target === null) await wait(300);
  }
  if (target === null) throw new Error('no page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout ${method}`));
      }, timeoutMs);
    });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  };
  const shot = async (name) => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await send('Page.bringToFront', {}, 5_000).catch(() => undefined);
        const result = await send('Page.captureScreenshot', { format: 'png' }, 10_000);
        writeFileSync(path.join(shotDir, name), Buffer.from(result.data, 'base64'));
        console.log(`shot ${name}`);
        return;
      } catch (error) {
        console.log(`shot ${name} retry (${error?.message ?? error})`);
        await wait(1000);
      }
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.bringToFront', {}, 5_000).catch(() => undefined);

  const syncDeadline = Date.now() + 30_000;
  let synced = false;
  while (Date.now() < syncDeadline) {
    synced = await evaluate(`!!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready')`);
    if (synced) break;
    await wait(400);
  }
  console.log(`sync=${synced}`);
  await wait(800);

  await evaluate(`window.__micstudioGo('advanced'); true`);
  await wait(800);
  await evaluate(`document.querySelector('.modal-body [data-section="dynamics"]')?.scrollIntoView({ block: 'start' }); true`);
  await wait(600);

  const dynamics = JSON.parse(
    await evaluate(`(() => JSON.stringify({
      comp: (() => {
        const node = document.querySelector('.modal-body [data-param="comp.Enable"]');
        return { tag: node?.querySelector('input')?.type ?? null, checked: node?.querySelector('input[type="checkbox"]')?.checked ?? null };
      })(),
      limit: (() => {
        const node = document.querySelector('.modal-body [data-param="limit.Enable"]');
        return { tag: node?.querySelector('input')?.type ?? null, checked: node?.querySelector('input[type="checkbox"]')?.checked ?? null };
      })(),
      hints: Array.from(document.querySelectorAll('.modal-body [data-section="dynamics"] .macro-hint')).map((node) => node.textContent.trim()),
    }))()`),
  );
  await shot('07-advanced-dynamics.png');
  check(
    '压缩器/限制器的 Enable 是开关控件（旁通）',
    dynamics.comp.tag === 'checkbox' && dynamics.limit.tag === 'checkbox' && dynamics.hints.some((text) => text.includes('旁通')),
    `comp=${dynamics.comp.tag}/${dynamics.comp.checked} limit=${dynamics.limit.tag}/${dynamics.limit.checked} hints=${JSON.stringify(dynamics.hints)}`,
  );

  // 切换一次压缩器开关再切回来（验证可操作，并还原）
  const toggled = JSON.parse(
    await evaluate(`(async () => {
      const box = document.querySelector('.modal-body [data-param="comp.Enable"] input[type="checkbox"]');
      const before = box.checked;
      box.click();
      await new Promise((resolve) => setTimeout(resolve, 900));
      const after = box.checked;
      box.click();
      await new Promise((resolve) => setTimeout(resolve, 900));
      return JSON.stringify({ before, after, restored: box.checked });
    })()`),
  );
  check(
    '压缩器开关可切换并保留状态',
    toggled.before !== toggled.after && toggled.restored === toggled.before,
    `${toggled.before} → ${toggled.after} → ${toggled.restored}`,
  );

  // 均衡器旁通：滚动到均衡分区，取正常态与旁通态两张图
  await evaluate(`document.querySelector('.modal-body [data-section="eq"]')?.scrollIntoView({ block: 'start' }); true`);
  await wait(600);
  await shot('08-advanced-eq.png');
  await evaluate(`document.querySelector('.modal-body [data-bypass="eq"] input[type="checkbox"]')?.click(); true`);
  await wait(900);
  const eqState = JSON.parse(
    await evaluate(`(() => JSON.stringify({
      bypass: document.querySelector('.modal-body [data-bypass="eq"] input[type="checkbox"]')?.checked ?? null,
      disabled: Array.from(document.querySelectorAll('.modal-body .eq-row[data-band] input, .modal-body .eq-row[data-band] select')).filter((node) => node.disabled).length,
      note: Array.from(document.querySelectorAll('.modal-body .module-bypass-note')).map((node) => node.textContent.trim()).find((text) => text.includes('均衡') || text.includes('7 段')) ?? null,
    }))()`),
  );
  await shot('09-advanced-eq-bypass.png');
  check(
    '均衡器旁通：开关打开后 7 段全部禁用并显示说明',
    eqState.bypass === true && eqState.disabled >= 7 && (eqState.note ?? '').includes('旁通'),
    `disabled=${eqState.disabled} note=${eqState.note}`,
  );
  await evaluate(`document.querySelector('.modal-body [data-bypass="eq"] input[type="checkbox"]')?.click(); true`);
  await wait(900);
  const restored = JSON.parse(
    await evaluate(`(() => JSON.stringify({
      bypass: document.querySelector('.modal-body [data-bypass="eq"] input[type="checkbox"]')?.checked ?? null,
      disabled: Array.from(document.querySelectorAll('.modal-body .eq-row[data-band] input, .modal-body .eq-row[data-band] select')).filter((node) => node.disabled).length,
    }))()`),
  );
  check(
    '取消均衡器旁通后恢复可编辑',
    restored.bypass === false && restored.disabled === 0,
    `bypass=${restored.bypass} disabled=${restored.disabled}`,
  );

  await wait(1200);
  const finalState = JSON.parse(
    await evaluate(`(() => JSON.stringify({
      syncReady: !!document.querySelector('#sync-pill')?.classList.contains('state-pill--ready'),
      notice: document.querySelector('.console-notice')?.hidden ? null : document.querySelector('.console-notice')?.textContent?.trim() ?? null,
    }))()`),
  );
  check('补充取证结束后链路仍 ready、无错误提示', finalState.syncReady && finalState.notice === null, JSON.stringify(finalState));

  results.summary = {
    total: results.checks.length,
    passed: results.checks.filter((item) => item.ok).length,
    failed: results.checks.filter((item) => !item.ok).length,
  };
  writeFileSync(path.join(shotDir, 'supplement.json'), JSON.stringify(results, null, 2));
  console.log(`RESULT ${JSON.stringify(results.summary)}`);
  if (results.summary.failed > 0) process.exitCode = 1;
} catch (error) {
  console.log(`ERROR ${error?.message ?? error}`);
  writeFileSync(path.join(shotDir, 'supplement.json'), JSON.stringify({ ...results, error: String(error?.stack ?? error) }, null, 2));
  process.exitCode = 1;
} finally {
  spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
}
