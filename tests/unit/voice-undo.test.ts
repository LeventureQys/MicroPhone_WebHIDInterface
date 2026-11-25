import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { VoiceState } from '../../tools/voice/contract/canonicalize';
import { UndoStack, snapshotEntry, type UndoEntry } from '../../tools/voice/contract/undo';

/**
 * 撤销栈与 `/undo` 的行为测试（SubStage 4.2 §6 的第 1、2、7 条 + §5 的最后两行）。
 *
 * 第 7 条要求"用假 sink + 真 HTTP"：这里直接给执行器注入一个内存 sink（`sinkInstance`），
 * 起真 `http.Server`（端口 0 让系统分配），用 `node:http` 发真请求——不经过 fetch，
 * 免得 happy-dom 环境把 `fetch` 换掉后行为不一致。
 */

interface SinkWriteResult {
  writes: readonly { param: string; value: number }[];
  bandWrites: readonly { band: number; field: string; value: number }[];
}

interface SinkLike {
  readonly name: string;
  readState(): Promise<VoiceState>;
  write(cmd: SinkWriteResult): Promise<void>;
  reset?(): void;
}

interface ExecutorHandle {
  readonly sink: SinkLike;
  readonly server: http.Server;
}

interface ExecutorModule {
  createExecutor(options: Record<string, unknown>): ExecutorHandle;
}

interface DrySink {
  readonly name: string;
  readState(): Promise<VoiceState>;
  write(cmd: SinkWriteResult): Promise<void>;
}

interface Json {
  // 响应形状由执行器定义，测试只按字段断言
  [key: string]: any;
}

/** `.mjs` 没有类型声明（`tsconfig` 不开 `allowJs`），用变量说明符动态 import 交给 vitest 解析 */
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

async function startExecutor(options: Record<string, unknown> = {}): Promise<{ port: number; sink: SinkLike }> {
  const { createExecutor } = await loadExecutor();
  const logDir = options.logDir ?? mkdtempSync(path.join(tmpdir(), 'voice-undo-'));
  if (options.logDir === undefined) tempDirs.push(String(logDir));
  const handle = createExecutor({ logDir, ...options });
  await new Promise<void>((resolve) => {
    handle.server.listen(0, '127.0.0.1', () => resolve());
  });
  servers.push(handle.server);
  const address = handle.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  expect(port).toBeGreaterThan(0);
  return { port, sink: handle.sink };
}

function entryOf(turn: string, param: string, value: number): UndoEntry {
  return { turn, at: 0, writes: [{ param, value }], bandWrites: [], scene: null, tone: null };
}

function plan(ops: readonly Record<string, unknown>[], say = '好'): Record<string, unknown> {
  return { v: 1, status: 'ok', say, confidence: 1, ops };
}

describe('UndoStack（§4.1 / §6 第 1、2 条）', () => {
  it('1. 深度 5：压 6 条后 depth()==5，pop() 返回第 6 条（最旧的一条被丢）', () => {
    const stack = new UndoStack();
    for (let index = 1; index <= 6; index += 1) {
      stack.push(entryOf(`t-000${index}`, 'enc.Level', index));
    }
    expect(stack.depth()).toBe(5);
    expect(stack.pop()?.turn).toBe('t-0006');
    expect(stack.depth()).toBe(4);
    // 最旧的 t-0001 已被丢掉：连续 pop 到空只剩 4 条
    const rest: string[] = [];
    for (let index = 0; index < 4; index += 1) rest.push(stack.pop()?.turn ?? '');
    expect(rest).toEqual(['t-0005', 't-0004', 't-0003', 't-0002']);
    expect(stack.pop()).toBeNull();
  });

  it('2. 空栈 pop() 返回 null', () => {
    const stack = new UndoStack();
    expect(stack.depth()).toBe(0);
    expect(stack.pop()).toBeNull();
  });

  it('peek() 不弹出，且取出的是副本（改它不影响栈内快照）', () => {
    const stack = new UndoStack();
    stack.push(entryOf('t-0001', 'mic.mute', 0));
    const peeked = stack.peek();
    expect(peeked?.turn).toBe('t-0001');
    expect(stack.depth()).toBe(1);
    peeked?.writes.push({ param: 'enc.Level', value: 3 });
    expect(stack.peek()?.writes).toHaveLength(1);
    stack.clear();
    expect(stack.depth()).toBe(0);
  });

  it('snapshotEntry 记的是前值：标量取 params，EQ 段字段折成 eq.bandN.<field>', () => {
    const state: VoiceState = { params: { 'enc.Level': 2, 'eq.band7.q': 0.7 }, bands: [0, 0, -3.5, 0, 0, 0, 1.5] };
    const entry = snapshotEntry(
      {
        writes: [{ param: 'enc.Level', value: 3 }],
        bandWrites: [
          { band: 7, field: 'gain', value: 3 },
          { band: 7, field: 'q', value: 1.2 },
        ],
        scene: null,
        tone: 'warm',
      },
      (paramId) => {
        const fromParams = state.params[paramId];
        if (typeof fromParams === 'number') return fromParams;
        if (paramId === 'eq.band7.gain') return state.bands[6] ?? 0;
        return -1;
      },
      't-0009',
      1234,
    );
    expect(entry.turn).toBe('t-0009');
    expect(entry.at).toBe(1234);
    expect(entry.writes).toEqual([{ param: 'enc.Level', value: 2 }]);
    expect(entry.bandWrites).toEqual([
      { band: 7, field: 'gain', value: 1.5 },
      { band: 7, field: 'q', value: 0.7 },
    ]);
    expect(entry.tone).toBe('warm');
    expect(entry.scene).toBeNull();
  });
});

describe('7. /apply（假 sink + 真 HTTP）：immediate → applied → /undo → 回读等于前值', () => {
  it('写入后 /state 是新值，撤销后回到前值，undoTurn 与 /health 的 undoDepth 同步', async () => {
    const { createDrySink } = await loadDrySink();
    const { port } = await startExecutor({ sinkInstance: createDrySink() });

    const before = await request(port, 'GET', '/state');
    expect(before.json.params['eq.band7.gain']).toBe(0);
    expect(before.json.params['eq.band6.gain']).toBe(0);

    const applied = await request(
      port,
      'POST',
      '/apply',
      plan([{ kind: 'tune', target: 'brightness', direction: 'more', strength: 'slight' }], '亮一点'),
    );
    expect(applied.status).toBe(200);
    expect(applied.json.ok).toBe(true);
    expect(applied.json.command.status).toBe('applied');
    expect(applied.json.command.undoTurn).toBe(applied.json.command.turn);
    expect(applied.json.mismatch).toEqual([]);
    expect(applied.json.readback.params['eq.band7.gain']).toBe(1.5);
    expect(applied.json.readback.params['eq.band6.gain']).toBe(1);

    const health = await request(port, 'GET', '/health');
    expect(health.json.undoDepth).toBe(1);

    const undone = await request(port, 'POST', '/undo', {});
    expect(undone.status).toBe(200);
    expect(undone.json.command.status).toBe('applied');
    expect(undone.json.command.turn).not.toBe(applied.json.command.turn);
    expect(undone.json.command.preview).toEqual([`撤销 ${applied.json.command.turn}`]);
    expect(undone.json.command.undoTurn).toBeNull();
    expect(undone.json.mismatch).toEqual([]);
    expect(undone.json.readback.params['eq.band7.gain']).toBe(0);
    expect(undone.json.readback.params['eq.band6.gain']).toBe(0);

    const after = await request(port, 'GET', '/state');
    expect(after.json.params['eq.band7.gain']).toBe(0);
    expect(after.json.params['eq.band6.gain']).toBe(0);
    // 撤销成功不再入栈（避免"撤销的撤销"成环）
    expect((await request(port, 'GET', '/health')).json.undoDepth).toBe(0);
  });

  it('空栈 /undo → 409 E_UNDO_EMPTY（消息"没有可以撤销的操作"）', async () => {
    const { createDrySink } = await loadDrySink();
    const { port } = await startExecutor({ sinkInstance: createDrySink() });
    const undone = await request(port, 'POST', '/undo', {});
    expect(undone.status).toBe(409);
    expect(undone.json.error.code).toBe('E_UNDO_EMPTY');
    expect(undone.json.error.message).toBe('没有可以撤销的操作');
  });

  it('撤销静音的写入：允许，且 say 追加"麦克风已恢复"（§5 最后一行）', async () => {
    const { createDrySink } = await loadDrySink();
    const { port } = await startExecutor({ sinkInstance: createDrySink() });

    const first = await request(
      port,
      'POST',
      '/apply',
      plan([{ kind: 'toggle', target: 'mute', on: true }], '静音'),
    );
    expect(first.json.command.status).toBe('needs_confirm');
    const confirmed = await request(port, 'POST', '/apply', {
      ...plan([{ kind: 'toggle', target: 'mute', on: true }], '静音'),
      confirmToken: first.json.command.confirmToken,
    });
    expect(confirmed.json.command.status).toBe('applied');
    expect((await request(port, 'GET', '/state')).json.params['mic.mute']).toBe(1);

    const undone = await request(port, 'POST', '/undo', {});
    expect(undone.status).toBe(200);
    expect(undone.json.command.say).toBe('已撤销麦克风已恢复');
    expect((await request(port, 'GET', '/state')).json.params['mic.mute']).toBe(0);
  });

  it('撤销时 sink 不可用 → 502 E_SINK_UNAVAILABLE，栈顶不弹出（可以重试）', async () => {
    const inner = (await loadDrySink()).createDrySink();
    let failing = false;
    const flaky: SinkLike = {
      name: 'dry',
      readState: () => inner.readState(),
      write: async (cmd) => {
        if (failing) throw new Error('E_SINK_UNAVAILABLE: 落地靶不可用（假 sink 故意失败）');
        await inner.write(cmd);
      },
    };
    const { port } = await startExecutor({ sinkInstance: flaky });

    const applied = await request(
      port,
      'POST',
      '/apply',
      plan([{ kind: 'tune', target: 'clarity', direction: 'more', strength: 'slight' }], '清楚一点'),
    );
    expect(applied.json.command.status).toBe('applied');

    failing = true;
    const failed = await request(port, 'POST', '/undo', {});
    expect(failed.status).toBe(502);
    expect(failed.json.error.code).toBe('E_SINK_UNAVAILABLE');
    expect((await request(port, 'GET', '/health')).json.undoDepth).toBe(1);

    failing = false;
    const retried = await request(port, 'POST', '/undo', {});
    expect(retried.status).toBe(200);
    expect(retried.json.readback.params['eq.band5.gain']).toBe(0);
    expect((await request(port, 'GET', '/health')).json.undoDepth).toBe(0);
  });
});
