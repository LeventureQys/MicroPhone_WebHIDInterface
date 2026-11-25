import http from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EQ_GAIN_TOLERANCE,
  actualValueOf,
  compare,
  paramIdOf,
  toleranceOf,
  type VoiceState,
} from '../../tools/voice/contract/readback';
import { PARAM_IDS } from '../../tools/voice/contract/targets';

/**
 * 回读比对、dry sink 的形状与 turn 日志（SubStage 4.2 §6 的第 5、6、9、10 条）。
 *
 * 第 9 条要的是"假 sink 写后返回被篡改的值"：这里让 sink 只在下一次 `readState()` 上篡改一次，
 * 于是执行器看到的是"写成功但回读不一致"，正好触发回滚分支；断言分两半——
 * 响应是 409 `E_READBACK_MISMATCH`，且 sink 里的值确实被写回前值。
 */

interface SinkWriteResult {
  writes: readonly { param: string; value: number }[];
  bandWrites: readonly { band: number; field: string; value: number }[];
}

interface DrySink {
  readonly name: string;
  readState(): Promise<VoiceState>;
  write(cmd: SinkWriteResult): Promise<void>;
}

interface ExecutorHandle {
  readonly server: http.Server;
}

interface ExecutorModule {
  createExecutor(options: Record<string, unknown>): ExecutorHandle;
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

/** `turnlog.mjs` 同样没有声明文件：用变量说明符动态 import */
async function loadTurnLog(): Promise<{ TURN_LOG_KEYS: readonly string[] }> {
  const specifier = '../../tools/voice/turnlog.mjs';
  return (await import(specifier)) as { TURN_LOG_KEYS: readonly string[] };
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

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function startExecutor(options: Record<string, unknown> = {}): Promise<{ port: number; sink: any }> {
  const { createExecutor } = await loadExecutor();
  const handle = createExecutor({ logDir: tempDir('voice-readback-'), ...options });
  await new Promise<void>((resolve) => {
    handle.server.listen(0, '127.0.0.1', () => resolve());
  });
  servers.push(handle.server);
  const address = handle.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  expect(port).toBeGreaterThan(0);
  return { port, sink: (handle as unknown as { sink: any }).sink };
}

function state(params: Record<string, number>, bands: number[] = [0, 0, 0, 0, 0, 0, 0]): VoiceState {
  return { params, bands };
}

function plan(ops: readonly Record<string, unknown>[], say = '好'): Record<string, unknown> {
  return { v: 1, status: 'ok', say, confidence: 1, ops };
}

describe('compare 容差（§4.3 / §6 第 5、6 条）', () => {
  it('5a. 整数枚举容差为 0：enc.Level 期望 2 实际 3 → mismatch，delta=-1', () => {
    expect(toleranceOf('enc.Level')).toBe(0);
    expect(toleranceOf('mic.mute')).toBe(0);
    expect(toleranceOf('rgb.Mode')).toBe(0);
    const mismatches = compare([{ param: 'enc.Level', value: 2 }], state({ 'enc.Level': 3 }));
    expect(mismatches).toEqual([{ param: 'enc.Level', expected: 2, actual: 3, delta: -1 }]);
    expect(compare([{ param: 'enc.Level', value: 2 }], state({ 'enc.Level': 2 }))).toEqual([]);
  });

  it('5b. eq.band*.gain 容差 0.1：2.0 vs 2.05 通过，2.0 vs 2.2 报错', () => {
    expect(toleranceOf('eq.band7.gain')).toBe(EQ_GAIN_TOLERANCE);
    expect(
      compare([{ band: 7, field: 'gain', value: 2 }], state({ 'eq.band7.gain': 2.05 })),
    ).toEqual([]);
    const mismatches = compare([{ band: 7, field: 'gain', value: 2 }], state({ 'eq.band7.gain': 2.2 }));
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].param).toBe('eq.band7.gain');
    expect(mismatches[0].actual).toBe(2.2);
    expect(mismatches[0].delta).toBeCloseTo(-0.2, 10);
  });

  it('5c. 其它带小数的工程量按一个 step 容差（comp.Attack step=0.0001）', () => {
    expect(toleranceOf('comp.Attack')).toBeCloseTo(0.0001, 12);
    // 差一个 step：不算不一致（raw↔工程量往返允许末位抖动）
    expect(compare([{ param: 'comp.Attack', value: 0.05 }], state({ 'comp.Attack': 0.0501 }))).toEqual([]);
    // 差三个 step：算不一致
    expect(compare([{ param: 'comp.Attack', value: 0.05 }], state({ 'comp.Attack': 0.0503 }))).toHaveLength(1);
    // 整数字段（step=1）仍然要求完全相等
    expect(toleranceOf('noisegate.attack_ms')).toBe(0);
    expect(compare([{ param: 'noisegate.attack_ms', value: 10 }], state({ 'noisegate.attack_ms': 11 }))).toHaveLength(1);
  });

  it('6. actual 缺项 → 记 mismatch 且 delta===null（读不到 ≠ 对得上）', () => {
    const mismatches = compare([{ param: 'mic.mute', value: 1 }], state({}));
    expect(mismatches).toEqual([{ param: 'mic.mute', expected: 1, actual: null, delta: null }]);
    expect(actualValueOf('mic.mute', state({}))).toBeNull();
    // bands 视图兜底：params 里没有 eq.bandN.gain 时读 bands
    expect(actualValueOf('eq.band7.gain', state({}, [0, 0, 0, 0, 0, 0, 3.5]))).toBe(3.5);
  });

  it('paramIdOf：标量写入与段写入折成同一套 id', () => {
    expect(paramIdOf({ param: 'enc.Level', value: 1 })).toBe('enc.Level');
    expect(paramIdOf({ band: 6, field: 'q', value: 1 })).toBe('eq.band6.q');
  });
});

describe('dry sink 的 72 项与 bands 同源（4.1 §10 第 5 条）', () => {
  it('初值键集合 == PARAM_IDS（72 项），bands 恒等于 params 的 eq.bandN.gain', async () => {
    const { createDrySink } = await loadDrySink();
    const sink = createDrySink();
    const initial = await sink.readState();
    expect(Object.keys(initial.params)).toHaveLength(72);
    expect(Object.keys(initial.params).sort()).toEqual([...PARAM_IDS].sort());
    expect(initial.bands).toHaveLength(7);
    for (let band = 1; band <= 7; band += 1) {
      expect(initial.params[`eq.band${band}.gain`]).toBe(initial.bands[band - 1]);
    }
    // 改非 gain 字段不影响 bands；改 gain 后 bands 立刻跟上（同源，不是两份状态）
    await sink.write({
      writes: [],
      bandWrites: [
        { band: 5, field: 'q', value: 4.2 },
        { band: 6, field: 'gain', value: 2.5 },
      ],
    });
    const after = await sink.readState();
    expect(Object.keys(after.params)).toHaveLength(72);
    expect(after.bands).toEqual([0, 0, -3.5, 0, 0, 2.5, 0]);
    for (let band = 1; band <= 7; band += 1) {
      expect(after.bands[band - 1]).toBe(after.params[`eq.band${band}.gain`]);
    }
  });
});

describe('9. 回读被篡改 → 409 E_READBACK_MISMATCH 且已回滚', () => {
  it('写后回读与期望差 1 dB → 409，sink 里的值回到前值，栈不残留', async () => {
    const tampered = 'eq.band7.gain';
    const params: Record<string, number> = { 'eq.band7.gain': 0, 'eq.band6.gain': 0 };
    // 只篡改一次：回滚那次写也会触发 write，若每次都篡改，回滚后的 /state 又会读到脏值
    let tamperArmed = false;
    let tamperDone = false;
    const sink = {
      name: 'dry',
      async readState(): Promise<VoiceState> {
        const snapshot = state({ ...params }, [0, 0, -3.5, 0, 0, 0, params['eq.band7.gain'] ?? 0]);
        if (!tamperArmed) return snapshot;
        tamperArmed = false;
        tamperDone = true;
        const current = snapshot.params[tampered];
        if (typeof current === 'number') {
          const patched: Record<string, number> = { ...snapshot.params, [tampered]: current + 1 };
          return { params: patched, bands: snapshot.bands };
        }
        return snapshot;
      },
      async write(cmd: SinkWriteResult): Promise<void> {
        for (const write of cmd.writes) params[write.param] = write.value;
        for (const write of cmd.bandWrites) params[`eq.band${write.band}.${write.field}`] = write.value;
        if (!tamperDone) tamperArmed = true;
      },
    };

    const { port } = await startExecutor({ sinkInstance: sink });
    const response = await request(
      port,
      'POST',
      '/apply',
      plan([{ kind: 'tune', target: 'brightness', direction: 'more', strength: 'slight' }], '亮一点'),
    );

    expect(response.status).toBe(409);
    expect(response.json.ok).toBe(false);
    expect(response.json.error.code).toBe('E_READBACK_MISMATCH');
    expect(response.json.error.message).toContain('eq.band7.gain');
    expect(response.json.error.detail.rolledBack).toBe(true);
    expect(response.json.error.detail.mismatch[0].param).toBe(tampered);
    expect(response.json.error.detail.mismatch[0].expected).toBe(1.5);
    expect(response.json.error.detail.mismatch[0].actual).toBe(2.5);

    // 回滚：两个被写的段都回到前值 0
    expect(params['eq.band7.gain']).toBe(0);
    expect(params['eq.band6.gain']).toBe(0);
    const current = await request(port, 'GET', '/state');
    expect(current.json.params['eq.band7.gain']).toBe(0);
    expect(current.json.params['eq.band6.gain']).toBe(0);
    // 回滚成功 → 本轮快照作废（不留下"撤销一个没生效的写入"）
    expect((await request(port, 'GET', '/health')).json.undoDepth).toBe(0);
  });
});

describe('10. turn 日志：一次 apply 一行，含设计文档 §3.10 全部键', () => {
  it('artifacts/voice/exec 风格的 exec-<ts>.jsonl 多一行，UTF-8 无 BOM，字段齐全', async () => {
    const { createDrySink } = await loadDrySink();
    const logDir = tempDir('voice-turnlog-');
    const { port } = await startExecutor({ sinkInstance: createDrySink(), logDir });
    const { TURN_LOG_KEYS } = await loadTurnLog();

    const applied = await request(
      port,
      'POST',
      '/apply',
      plan([{ kind: 'tune', target: 'clarity', direction: 'more', strength: 'slight' }], '清楚一点'),
    );
    expect(applied.json.command.status).toBe('applied');

    const files = readdirSync(logDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^exec-\d{8}-\d{6}-\d{3}\.jsonl$/);
    // 与 4.3 的 `turn-*.jsonl` 不许同名（§4.4 的分工）
    expect(files[0].startsWith('turn-')).toBe(false);

    const raw = readFileSync(path.join(logDir, files[0]));
    expect(raw[0]).not.toBe(0xef);
    expect(raw[1]).not.toBe(0xbb);
    const lines = raw.toString('utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    for (const key of TURN_LOG_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(record, key)).toBe(true);
    }
    expect(record.turn).toBe(applied.json.command.turn);
    expect(record.readback_ok).toBe(true);
    expect(record.mismatch).toEqual([]);
    expect(record.sink).toBe('dry');
    expect(typeof record.apply_ms).toBe('number');
    expect(record.plan).toMatchObject({ v: 1, status: 'ok' });
    expect(record.command).toMatchObject({ status: 'applied' });
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    // 执行器侧拿不到的字段按 null 落盘（唤醒/ASR/LLM/TTS 的耗时在 4.3 的 pipeline 里）
    expect(record.wake_ms).toBeNull();
    expect(record.asr_ms).toBeNull();
    expect(record.llm_ms).toBeNull();
    expect(record.tts_ms).toBeNull();
  });
});
