/**
 * 执行器（Alpha v1.3.0 / SubStage 4.1 + 4.2）：L1 `VoicePlan` → L2 `VoiceCommand` → 落地靶。
 *
 * 两种入口（4.1 §4.5 / 4.2 §4.5）：
 *
 * ```
 * node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *      --import ./tools/voice/register-loader.mjs tools/voice/executor.mjs \
 *      --sink dry|vdevice [--url http://127.0.0.1:8766] [--port 8767] [--serve] [--plan <file>] [--reset]
 * ```
 *
 * | 端点 | 行为 |
 * |---|---|
 * | `GET /health` | `{"ok":true,"sink":…,"turn":"t-0007","undoDepth":2}` |
 * | `GET /state` | 当前状态（72 项工程量 + 7 段增益，给评测与调试） |
 * | `POST /plan` | 只算不写，`command.status` 强制 `dry-run` |
 * | `POST /apply` | 4.2 的完整流程：excluded→409 / confirm→签发 token 不写 / 确认后写→回读比对→不一致回滚 409 |
 * | `POST /undo` | 弹栈顶、写回前值、回读比对；空栈 409 `E_UNDO_EMPTY` |
 *
 * 撤销栈、confirmToken、回读比对、turn 日志都在 4.2 接上（4.1 时它们分别是 501 / null / []）。
 *
 * `createExecutor()` 允许注入 sink（`sinkInstance`）与日志目录（`logDir`）：4.2 的单测用假 sink
 * 起真 HTTP 服务，验证"第一次请求不写、第二次才写""回读被篡改要回滚"这类行为，
 * 不必拉起虚拟下位机。顶层的 `main()` 只在"本文件就是入口"时执行，被 import 时不跑。
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { planToCommand } from './contract/canonicalize';
import { DEFAULT_CONFIRM_TTL_MS, issue, verify } from './contract/confirm';
import { compare, currentValueOf } from './contract/readback';
import { DEFAULT_UNDO_DEPTH, UndoStack, snapshotEntry } from './contract/undo';
import { DEFAULT_VDEVICE_URL, createSink } from './sinks/index.mjs';
import { DEFAULT_TURN_LOG_DIR, appendTurn } from './turnlog.mjs';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8767;
const BODY_LIMIT = 64 * 1024;
const TAG = '[executor]';

/** 设计文档 §3.7 第 3 条：本次会话静音过之后，后续每轮播报都要提醒（失聪保护） */
const MUTE_GUARD_SAY = '（麦克风处于静音，我可能听不到你）';
/** 设计文档 §3.6：撤销的播报话术 */
const UNDO_SAY = '已撤销';
/** 撤销的是 `confirm` 层的静音写入时的追加话术（4.2 §5 最后一行） */
const MUTE_RESTORED_SAY = '麦克风已恢复';
/** `confirm` 层参数（撤销它们要追加"麦克风已恢复"） */
const MUTE_PARAMS = Object.freeze(['mic.mute', 'mic.sigMute']);

const USAGE = [
  '用法: node --experimental-strip-types --import ./tools/voice/register-loader.mjs tools/voice/executor.mjs [选项]',
  '  --sink dry|vdevice        落地靶（默认 dry）',
  `  --url <url>               vdevice 控制面（默认 ${DEFAULT_VDEVICE_URL}）`,
  `  --port <n>                HTTP 端口（默认 ${DEFAULT_PORT}，仅 --serve）`,
  '  --serve                   起 HTTP 服务',
  '  --plan <file>             读一个 L1 JSON 文件，打印 L2（不写）',
  '  --reset                   dry 靶复位成产品默认值',
  `  --log-dir <dir>           turn 日志目录（默认 ${DEFAULT_TURN_LOG_DIR}）`,
].join('\n');

class HttpFailure extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function parseArgs(argv) {
  const options = {
    sink: 'dry',
    url: DEFAULT_VDEVICE_URL,
    port: DEFAULT_PORT,
    serve: false,
    plan: '',
    reset: false,
    logDir: DEFAULT_TURN_LOG_DIR,
  };
  const takeValue = (index, flag) => {
    const value = argv[index];
    if (value === undefined) throw new Error(`${flag} 需要一个值`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--sink') options.sink = takeValue((index += 1), flag);
    else if (flag === '--url') options.url = takeValue((index += 1), flag);
    else if (flag === '--port') options.port = Number(takeValue((index += 1), flag));
    else if (flag === '--plan') options.plan = takeValue((index += 1), flag);
    else if (flag === '--log-dir') options.logDir = takeValue((index += 1), flag);
    else if (flag === '--serve') options.serve = true;
    else if (flag === '--reset') options.reset = true;
    else throw new Error(`未知参数 ${flag}`);
  }
  if (options.sink !== 'dry' && options.sink !== 'vdevice') {
    throw new Error(`--sink 只支持 dry / vdevice，收到 ${options.sink}`);
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 0xffff) {
    throw new Error(`--port 必须是 1..65535 的整数，收到 ${options.port}`);
  }
  return options;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new HttpFailure(400, 'E_PLAN_INVALID', '请求体超过 64 KB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (error) => reject(error));
  });
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HttpFailure(400, 'E_PLAN_INVALID', `请求体不是合法 JSON：${error.message}`);
  }
}

async function readPlanBody(req) {
  const contentType = String(req.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpFailure(400, 'E_PLAN_INVALID', 'Content-Type 必须是 application/json');
  }
  const buffer = await collectBody(req);
  const text = buffer.toString('utf8').trim();
  if (text === '') throw new HttpFailure(400, 'E_PLAN_INVALID', '请求体为空');
  return parseJsonText(text);
}

/**
 * `/undo` 的请求体：设计文档 §3.8 写的是 `{}`，但侧车可能不带 body。
 * 空 body 直接放行；有 body 就必须是合法 JSON（不允许把半截坏 JSON 当成空）。
 */
async function readOptionalBody(req) {
  const buffer = await collectBody(req);
  const text = buffer.toString('utf8').trim();
  if (text === '') return null;
  return parseJsonText(text);
}

function failureFrom(error) {
  if (error instanceof HttpFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('E_PLAN_INVALID')) {
    return new HttpFailure(400, 'E_PLAN_INVALID', message.replace(/^E_PLAN_INVALID:\s*/, ''));
  }
  if (message.startsWith('E_SINK_UNAVAILABLE') || message.startsWith('E_SINK_REJECTED')) {
    return new HttpFailure(502, 'E_SINK_UNAVAILABLE', message.replace(/^E_SINK_[A-Z]+:\s*/, ''));
  }
  if (message.startsWith('E_SINK_')) return new HttpFailure(500, 'E_SINK_INVALID', message);
  return new HttpFailure(500, 'E_INTERNAL', message);
}

/** 执行器关闭 pending / needConfirm 的取证：turn 之外不影响任何业务字段 */
function confirmFailure(verdict) {
  if (verdict === 'expired') return new HttpFailure(409, 'E_CONFIRM_EXPIRED', '确认超时，请再说一次');
  if (verdict === 'mismatch') {
    return new HttpFailure(409, 'E_CONFIRM_EXPIRED', '确认的内容变了（与签发 token 时的 plan 不一致），请再说一次');
  }
  return new HttpFailure(409, 'E_CONFIRM_EXPIRED', '没有待确认的内容（token 不存在或已用过），请再说一次');
}

function purgeExpired(pending, now = Date.now()) {
  for (const [token, record] of pending) {
    if (now >= record.expiresAt) pending.delete(token);
  }
}

function mismatchMessage(prefix, mismatch) {
  const params = mismatch.map((item) => item.param).join('、');
  return `${prefix}：${params}`;
}

function createExecutor(options) {
  const sink =
    options.sinkInstance ??
    createSink({ kind: options.sink ?? 'dry', url: options.url ?? DEFAULT_VDEVICE_URL });
  if (options.reset && typeof sink.reset === 'function') sink.reset();

  const logDir = options.logDir ?? DEFAULT_TURN_LOG_DIR;
  const undo = new UndoStack(options.undoDepth ?? DEFAULT_UNDO_DEPTH);
  /** token → 待确认记录（只在进程内；重启即失效，见 4.2 §8） */
  const pending = new Map();
  let turnSeq = 0;
  /** 本次会话是否执行过 `mic.mute=1`（设计文档 §3.7 第 3 条） */
  let muteLatched = false;

  const nextTurn = () => {
    turnSeq += 1;
    return `t-${String(turnSeq).padStart(4, '0')}`;
  };
  const lastTurn = () => (turnSeq === 0 ? 't-0000' : `t-${String(turnSeq).padStart(4, '0')}`);

  const withMuteGuard = (say) => (muteLatched ? `${say}${MUTE_GUARD_SAY}` : say);

  function toCommand(result, turn, status, extra = {}) {
    return {
      v: 1,
      turn,
      status,
      writes: result.writes,
      bandWrites: result.bandWrites,
      scene: result.scene,
      tone: result.tone,
      say: extra.say ?? withMuteGuard(result.say),
      undoTurn: extra.undoTurn ?? null,
      danger: result.danger,
      confirmToken: extra.confirmToken ?? null,
      preview: result.preview,
    };
  }

  /** 写入落地后更新"静音失聪"闩锁：只认 `mic.mute`（`mic.sigMute` 不会让助手听不见） */
  function updateMuteLatch(cmd) {
    for (const write of cmd?.writes ?? []) {
      if (write.param === 'mic.mute') muteLatched = write.value === 1;
    }
  }

  function writeTurnLog(record) {
    try {
      return appendTurn(record, logDir);
    } catch (error) {
      // 日志不是业务：磁盘满 / 权限都能吞掉，只打 warn（4.2 §5）
      console.warn(`${TAG} turn 日志写盘失败（不影响本次执行结果）：${error?.message ?? error}`);
      return null;
    }
  }

  const compute = async (plan, utterance) => {
    const state = await sink.readState();
    const turn = nextTurn();
    const result = planToCommand(plan, state, { turnId: turn, utterance });
    return { result, turn, state };
  };

  /** 把前值写回去（回读不一致时的回滚，以及 `/undo` 失败时的还原） */
  async function restore(writes, bandWrites) {
    try {
      await sink.write({ writes, bandWrites });
    } catch (error) {
      throw new HttpFailure(500, 'E_ROLLBACK_FAILED', `回滚失败：${error?.message ?? error}`);
    }
  }

  const routes = {
    'GET /health': async (req, res) => {
      sendJson(res, 200, { ok: true, sink: sink.name, turn: lastTurn(), undoDepth: undo.depth() });
    },
    'GET /state': async (req, res) => {
      const state = await sink.readState();
      sendJson(res, 200, { ok: true, params: state.params, bands: state.bands });
    },
    'POST /plan': async (req, res) => {
      const plan = await readPlanBody(req);
      const utterance = typeof plan?.utterance === 'string' ? plan.utterance : undefined;
      const { result, turn } = await compute(plan, utterance);
      sendJson(res, 200, { ok: true, command: toCommand(result, turn, 'dry-run') });
    },
    'POST /apply': async (req, res) => {
      const startedAt = Date.now();
      const plan = await readPlanBody(req);
      const utterance = typeof plan?.utterance === 'string' ? plan.utterance : undefined;
      const { result, turn, state } = await compute(plan, utterance);

      if (result.undo) {
        // 4.1 §10 第 4 条：`/apply` 收到 undo 动作必须报错，不许静默零写入；撤销走 `POST /undo`
        sendJson(res, 501, {
          ok: false,
          error: { code: 'E_NOT_IMPLEMENTED', message: '撤销请用 POST /undo（/apply 不接受 undo 动作）' },
        });
        return;
      }
      if (result.tier === 'excluded') {
        const failure = new HttpFailure(409, 'E_ALL_EXCLUDED', '这些参数不支持语音调整');
        failure.detail = { command: toCommand(result, turn, 'rejected') };
        throw failure;
      }

      // 带了 token 就先验证（不管这一轮最终是不是 confirm 层）：token 是"我确认过"的凭证，
      // 已经用过的凭证不能被静默接受。用过的 token 在 ok 之后立刻从 pending 里删掉，
      // 于是"同一 token 第二次使用"落到 `missing` → 409（§5 的第三行）。
      let confirmedToken = null;
      const provided = typeof plan?.confirmToken === 'string' ? plan.confirmToken.trim() : '';
      if (provided !== '') {
        const record = pending.get(provided) ?? null;
        const verdict = verify(record, provided, plan);
        if (verdict !== 'ok') {
          if (verdict === 'expired') pending.delete(provided);
          throw confirmFailure(verdict);
        }
        pending.delete(provided);
        confirmedToken = provided;
      } else if (result.tier === 'confirm') {
        // 第一次：整轮不写，只签发 token（§4.5 第 3 步）
        purgeExpired(pending);
        const record = issue(turn, plan, options.confirmTtlMs ?? DEFAULT_CONFIRM_TTL_MS);
        pending.set(record.token, record);
        sendJson(res, 200, {
          ok: true,
          command: toCommand(result, turn, 'needs_confirm', { confirmToken: record.token }),
          readback: state,
          mismatch: [],
        });
        return;
      }

      const cmd = { writes: result.writes, bandWrites: result.bandWrites };
      const entry = snapshotEntry(
        { ...cmd, scene: result.scene, tone: result.tone },
        (paramId) => currentValueOf(paramId, state),
        turn,
      );
      undo.push(entry);
      try {
        await sink.write(cmd);
      } catch (error) {
        // 没落地：这条快照没有对应的状态变化，弹掉，避免以后"撤销成功但什么都没变"
        undo.pop();
        throw error;
      }

      const after = await sink.readState();
      const mismatch = compare([...result.writes, ...result.bandWrites], after);
      if (mismatch.length > 0) {
        await restore(entry.writes, entry.bandWrites);
        undo.pop();
        const failure = new HttpFailure(409, 'E_READBACK_MISMATCH', mismatchMessage('设备回读与写入不一致', mismatch));
        failure.detail = { mismatch, readback: after, rolledBack: true };
        throw failure;
      }

      // 先出话术再记闩锁：§3.7 第 3 条说的是"后续 turn"追加提示，
      // 静音那一轮自己已经有规则表覆盖的话术，不该再叠一层
      const command = toCommand(result, turn, 'applied', { undoTurn: turn });
      updateMuteLatch(cmd);
      writeTurnLog({
        turn,
        apply_ms: Date.now() - startedAt,
        text: typeof plan?.text === 'string' ? plan.text : utterance ?? null,
        norm_text: typeof plan?.text === 'string' ? plan.text : utterance ?? null,
        plan,
        command,
        readback_ok: true,
        mismatch: [],
        sink: sink.name,
        mem_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        confirmed: confirmedToken !== null,
      });
      sendJson(res, 200, { ok: true, command, readback: after, mismatch: [] });
    },
    'POST /undo': async (req, res) => {
      await readOptionalBody(req);
      const entry = undo.peek();
      if (!entry) throw new HttpFailure(409, 'E_UNDO_EMPTY', '没有可以撤销的操作');
      // 撤销本身也消耗一个自增号（§4.5 的 turn 编号规则）
      const turn = nextTurn();
      const before = await sink.readState();
      const cmd = { writes: entry.writes, bandWrites: entry.bandWrites };
      // 失败（sink 不可用）时直接抛出：栈顶没弹出，可以重试（§5 第一行）
      await sink.write(cmd);
      const after = await sink.readState();
      const mismatch = compare([...entry.writes, ...entry.bandWrites], after);
      if (mismatch.length > 0) {
        await restore(
          entry.writes.map((write) => ({ param: write.param, value: currentValueOf(write.param, before) })),
          entry.bandWrites.map((write) => ({
            band: write.band,
            field: write.field,
            value: currentValueOf(`eq.band${write.band}.${write.field}`, before),
          })),
        );
        const failure = new HttpFailure(
          409,
          'E_READBACK_MISMATCH',
          mismatchMessage('设备回读与撤销前值不一致', mismatch),
        );
        failure.detail = { mismatch, readback: after, rolledBack: true };
        throw failure;
      }

      undo.pop();
      updateMuteLatch(cmd);
      let say = UNDO_SAY;
      const restoredMute = cmd.writes.some(
        (write) => MUTE_PARAMS.includes(write.param) && write.value === 0,
      );
      if (restoredMute) say += MUTE_RESTORED_SAY;
      const command = {
        v: 1,
        turn,
        status: 'applied',
        writes: entry.writes,
        bandWrites: entry.bandWrites,
        scene: entry.scene,
        tone: entry.tone,
        say: withMuteGuard(say),
        undoTurn: undo.peek()?.turn ?? null,
        danger: [],
        confirmToken: null,
        preview: [`撤销 ${entry.turn}`],
      };
      sendJson(res, 200, { ok: true, command, readback: after, mismatch: [] });
    },
  };

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${HOST}:${options.port ?? DEFAULT_PORT}`);
    const key = `${req.method} ${url.pathname}`;
    const route = routes[key];
    if (!route) {
      const known = Object.keys(routes).some((item) => item.endsWith(` ${url.pathname}`));
      if (known) {
        sendJson(res, 405, {
          ok: false,
          error: { code: 'E_METHOD_NOT_ALLOWED', message: `${req.method} 不允许用于 ${url.pathname}` },
        });
        return;
      }
      sendJson(res, 404, {
        ok: false,
        error: { code: 'E_NOT_FOUND', message: `没有这个端点：${url.pathname}` },
      });
      return;
    }
    try {
      await route(req, res);
    } catch (error) {
      const failure = failureFrom(error);
      const payload = {
        ok: false,
        error: {
          code: failure.code,
          message: failure.message,
          ...(failure.detail ? { detail: failure.detail } : {}),
        },
      };
      if (failure.status >= 500) console.error(`${TAG} ${failure.code}: ${failure.message}`);
      sendJson(res, failure.status, payload);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error(`${TAG} unhandled: ${error?.stack ?? error}`);
      if (!res.writableEnded) {
        sendJson(res, 500, { ok: false, error: { code: 'E_INTERNAL', message: String(error) } });
      }
    });
  });

  return { sink, server, undo };
}

async function runPlanFile(options) {
  const text = readFileSync(options.plan, 'utf8');
  const plan = JSON.parse(text);
  const sink = createSink({ kind: options.sink, url: options.url });
  if (options.reset && typeof sink.reset === 'function') sink.reset();
  const state = await sink.readState();
  const turn = 't-0001';
  const result = planToCommand(plan, state, { turnId: turn, utterance: plan?.utterance });
  process.stdout.write(`${JSON.stringify({ ok: true, command: toCommandForPreview(result, turn) }, null, 2)}\n`);
}

/** `--plan` 的打印形状（与 `createExecutor().toCommand` 一致，不依赖会话状态） */
function toCommandForPreview(result, turn) {
  return {
    v: 1,
    turn,
    status: 'dry-run',
    writes: result.writes,
    bandWrites: result.bandWrites,
    scene: result.scene,
    tone: result.tone,
    say: result.say,
    undoTurn: null,
    danger: result.danger,
    confirmToken: null,
    preview: result.preview,
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${TAG} ${error.message}`);
    console.error(USAGE);
    process.exit(2);
    return;
  }
  if (options.plan !== '') {
    try {
      await runPlanFile(options);
    } catch (error) {
      console.error(`${TAG} ${error?.message ?? error}`);
      process.exit(1);
    }
    return;
  }
  if (!options.serve) {
    console.error(USAGE);
    process.exit(2);
    return;
  }

  const { server } = createExecutor(options);
  server.on('error', (error) => {
    console.error(`${TAG} HTTP 服务出错：${error?.message ?? error}`);
    process.exit(1);
  });
  server.listen(options.port, HOST, () => {
    console.log(`${TAG} listening http://${HOST}:${options.port} sink=${options.sink} log=${options.logDir}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
}

// 只有"本文件是入口"时才起服务：4.2 的单测会 import 它拿 createExecutor()，
// 无条件 main() 会让测试进程被 process.argv 解析打断。
const invokedHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedHref === import.meta.url) void main();

export { createExecutor, toCommandForPreview };
