import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIRM_TTL_MS, digest, issue, verify } from '../../tools/voice/contract/confirm';

/**
 * 二次确认的测试（SubStage 4.2 §6 的第 3、4、8 条）。
 *
 * 第 8 条用真 HTTP：确认流的**关键性质**是"第一次请求一个字都不写"，
 * 所以除了看响应里的 `needs_confirm`/`confirmToken`，还要看两次寄存器快照。
 */

interface SinkWriteResult {
  writes: readonly { param: string; value: number }[];
  bandWrites: readonly { band: number; field: string; value: number }[];
}

interface ExecutorHandle {
  readonly server: http.Server;
}

interface ExecutorModule {
  createExecutor(options: Record<string, unknown>): ExecutorHandle;
}

interface DrySink {
  readonly name: string;
  readState(): Promise<{ params: Record<string, number>; bands: number[] }>;
  write(cmd: SinkWriteResult): Promise<void>;
}

interface Json {
  [key: string]: any;
}

async function loadExecutor(): Promise<ExecutorModule> {
  const specifier = '../../tools/voice/executor.mjs';
  return (await import(specifier)) as ExecutorModule;
}

async function loadDrySink(): Promise<{ createDrySink: () => DrySink }> {
  const specifier = '../../tools/voice/sinks/dry.mjs';
  return (await import(specifier)) as { createDrySink: () => DrySink };
}

function request(
  port: number,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: text === '' ? {} : JSON.parse(text) });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const servers: http.Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startExecutor(options: Record<string, unknown> = {}): Promise<{ port: number }> {
  const { createExecutor } = await loadExecutor();
  const logDir = options.logDir ?? mkdtempSync(path.join(tmpdir(), 'voice-confirm-'));
  if (options.logDir === undefined) tempDirs.push(String(logDir));
  const handle = createExecutor({ logDir, ...options });
  await new Promise<void>((resolve) => {
    handle.server.listen(0, '127.0.0.1', () => resolve());
  });
  servers.push(handle.server);
  const address = handle.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  expect(port).toBeGreaterThan(0);
  return { port };
}

function mutePlan(): Record<string, unknown> {
  return {
    v: 1,
    status: 'ok',
    say: '静音',
    confidence: 1,
    ops: [{ kind: 'toggle', target: 'mute', on: true }],
  };
}

describe('digest / issue / verify（§4.2 / §6 第 3、4 条）', () => {
  it('3. digest：键顺序不同的两个等价对象 → 同一 digest', () => {
    const a = { v: 1, status: 'ok', ops: [{ kind: 'undo' }], say: '好' };
    const b = { say: '好', ops: [{ kind: 'undo' }], status: 'ok', v: 1 };
    expect(digest(a)).toBe(digest(b));
    expect(digest(a)).toHaveLength(16);
    expect(digest(a)).toMatch(/^[0-9a-f]{16}$/);
    // 内容不同就必须不同
    expect(digest(a)).not.toBe(digest({ ...a, say: '静音' }));
  });

  it('3b. digest 跳过 confirmToken（第二次请求正文带 token），但数组顺序仍敏感', () => {
    const plan = { v: 1, status: 'ok', say: '静音', ops: [{ kind: 'undo' }] };
    expect(digest({ ...plan, confirmToken: 'abc' })).toBe(digest(plan));
    // 键顺序不影响、数组顺序影响：两段 op 交换位置就是另一件事
    const forward = { v: 1, ops: [{ kind: 'undo' }, { kind: 'set', param: 'enc.Level', value: 2 }] };
    const backward = { ops: [{ kind: 'set', param: 'enc.Level', value: 2 }, { kind: 'undo' }], v: 1 };
    expect(digest(forward)).not.toBe(digest(backward));
    expect(digest({ b: 1, a: [{ x: 1, y: 2 }] })).toBe(digest({ a: [{ y: 2, x: 1 }], b: 1 }));
  });

  it('4a. verify → missing（没有待确认记录 / 空 token）', () => {
    const plan = mutePlan();
    expect(verify(null, 'whatever', plan)).toBe('missing');
    expect(verify(issue('t-0001', plan), '', plan)).toBe('missing');
  });

  it('4b. verify → expired（30 s 到期，恰好到点即过期）', () => {
    const plan = mutePlan();
    const pending = issue('t-0001', plan);
    expect(pending.expiresAt - Date.now()).toBeLessThanOrEqual(DEFAULT_CONFIRM_TTL_MS);
    expect(verify(pending, pending.token, plan, pending.expiresAt - 1)).toBe('ok');
    expect(verify(pending, pending.token, plan, pending.expiresAt)).toBe('expired');
    expect(verify(pending, pending.token, plan, pending.expiresAt + 1)).toBe('expired');
  });

  it('4c. verify → mismatch（token 对但 plan 变了）', () => {
    const plan = mutePlan();
    const pending = issue('t-0001', plan);
    expect(verify(pending, pending.token, { ...plan, say: '别的' })).toBe('mismatch');
    expect(verify(pending, 'f'.repeat(24), plan)).toBe('mismatch');
  });

  it('4d. verify → ok（带 token 的正文参与摘要时被跳过）', () => {
    const plan = mutePlan();
    const pending = issue('t-0001', plan);
    expect(verify(pending, pending.token, { ...plan, confirmToken: pending.token })).toBe('ok');
    expect(pending.turn).toBe('t-0001');
    expect(issue('t-0001', plan).token).not.toBe(pending.token);
  });
});

describe('8. /apply confirm 流（真 HTTP）：第一次只签发 token，第二次才写', () => {
  it('needs_confirm 不写寄存器；带 token 重发才 applied；同一 token 复用 → 409', async () => {
    const { port } = await startExecutor({ sinkInstance: (await loadDrySink()).createDrySink() });

    const before = await request(port, 'GET', '/state');
    expect(before.json.params['mic.mute']).toBe(0);

    const first = await request(port, 'POST', '/apply', mutePlan());
    expect(first.status).toBe(200);
    expect(first.json.ok).toBe(true);
    expect(first.json.command.status).toBe('needs_confirm');
    expect(typeof first.json.command.confirmToken).toBe('string');
    expect(first.json.command.confirmToken).toHaveLength(24);
    expect(first.json.mismatch).toEqual([]);
    // 写入项照常给出（用户要看到"将要做什么"），但一个字都没落盘
    expect(first.json.command.writes).toEqual([{ param: 'mic.mute', value: 1 }]);

    const untouched = await request(port, 'GET', '/state');
    expect(untouched.json.params['mic.mute']).toBe(0);
    expect((await request(port, 'GET', '/health')).json.undoDepth).toBe(0);

    const token = first.json.command.confirmToken as string;
    const second = await request(port, 'POST', '/apply', { ...mutePlan(), confirmToken: token });
    expect(second.status).toBe(200);
    expect(second.json.command.status).toBe('applied');
    expect(second.json.command.confirmToken).toBeNull();
    expect(second.json.readback.params['mic.mute']).toBe(1);
    expect((await request(port, 'GET', '/state')).json.params['mic.mute']).toBe(1);

    // 同一 token 第二次使用：已用过即失效
    const reused = await request(port, 'POST', '/apply', { ...mutePlan(), confirmToken: token });
    expect(reused.status).toBe(409);
    expect(reused.json.error.code).toBe('E_CONFIRM_EXPIRED');
  });

  it('token 过期 → 409 E_CONFIRM_EXPIRED，消息"确认超时，请再说一次"', async () => {
    const { port } = await startExecutor({
      sinkInstance: (await loadDrySink()).createDrySink(),
      confirmTtlMs: 1,
    });
    const first = await request(port, 'POST', '/apply', mutePlan());
    const token = first.json.command.confirmToken as string;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const late = await request(port, 'POST', '/apply', { ...mutePlan(), confirmToken: token });
    expect(late.status).toBe(409);
    expect(late.json.error.code).toBe('E_CONFIRM_EXPIRED');
    expect(late.json.error.message).toBe('确认超时，请再说一次');
    expect((await request(port, 'GET', '/state')).json.params['mic.mute']).toBe(0);
  });

  it('token 对应的 plan 变了 → 409 E_CONFIRM_EXPIRED，消息"确认的内容变了"', async () => {
    const { port } = await startExecutor({ sinkInstance: (await loadDrySink()).createDrySink() });
    const first = await request(port, 'POST', '/apply', mutePlan());
    const token = first.json.command.confirmToken as string;

    const other = {
      v: 1,
      status: 'ok',
      say: '关监听',
      confidence: 1,
      ops: [{ kind: 'toggle', target: 'monitor', on: false }],
    };
    const changed = await request(port, 'POST', '/apply', { ...other, confirmToken: token });
    expect(changed.status).toBe(409);
    expect(changed.json.error.code).toBe('E_CONFIRM_EXPIRED');
    expect(changed.json.error.message).toContain('确认的内容变了');
    // 内容不符不燃烧 token：原件在有效期内仍可确认
    const ok = await request(port, 'POST', '/apply', { ...mutePlan(), confirmToken: token });
    expect(ok.status).toBe(200);
    expect(ok.json.command.status).toBe('applied');
  });

  it('设计文档 §3.7 第 3 条：静音执行过之后，后续每轮的 say 追加失聪提示', async () => {
    const { port } = await startExecutor({ sinkInstance: (await loadDrySink()).createDrySink() });
    const first = await request(port, 'POST', '/apply', mutePlan());
    const applied = await request(port, 'POST', '/apply', {
      ...mutePlan(),
      confirmToken: first.json.command.confirmToken,
    });
    // 静音那一轮的话术由规则表覆盖，不追加提示（它自己就是"已静音"）
    expect(applied.json.command.say).toBe('已静音，请用界面上的开关恢复');

    const next = await request(
      port,
      'POST',
      '/apply',
      { v: 1, status: 'ok', say: '亮一点', confidence: 1, ops: [{ kind: 'tune', target: 'brightness', direction: 'more', strength: 'slight' }] },
    );
    expect(next.json.command.say).toBe('亮一点（麦克风处于静音，我可能听不到你）');
  });
});
