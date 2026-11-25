/**
 * 二次确认（Alpha v1.3.0 / SubStage 4.2 §4.2，设计文档 §3.3 / §3.8）。
 *
 * `confirm` 层的写入整轮不执行，先回一张 `needs_confirm` + `confirmToken`；用户下一句说
 * 「确认/好/可以/行」时带着同一个 token 重发同一条 L1，才真的写。token 只活在进程内
 * （§8 明确：**不许**存到进程外，重启即失效是刻意的）。
 *
 * 三个设计点，都是为了让"确认的是同一件事"这句话可判定：
 *
 * 1. `digest(plan)` 对键顺序不敏感（递归排序后 sha256 前 16 位十六进制）——L1 由解析器或
 *    LLM 产出，键顺序不稳定，按原文摘要会一直 mismatch；
 * 2. `digest` 跳过顶层的 `confirmToken`：第二次请求的正文就是"同一条 L1 + confirmToken"，
 *    不跳过的话摘要必然与签发时不同；
 * 3. `verify` 的判定顺序固定为 `missing → expired → mismatch → ok`（§4.2 明文），
 *    过期优先于内容不符——过期了就不用再比内容，报"确认超时"对用户更准确。
 */

import { createHash, randomBytes } from 'node:crypto';

export interface PendingConfirm {
  token: string;
  /** 签发这张 token 的 turn（也是 `issue` 的第一个入参 `tokenSeed`） */
  turn: string;
  planDigest: string;
  expiresAt: number;
}

export type VerifyResult = 'ok' | 'expired' | 'mismatch' | 'missing';

/** §4.2：token 默认 30 s 有效 */
export const DEFAULT_CONFIRM_TTL_MS = 30_000;

/** 不参与摘要的顶层键（第二次请求带的确认凭证） */
const DIGEST_IGNORED_KEYS: readonly string[] = Object.freeze(['confirmToken']);

/** 稳定序列化：对象递归按 key 排序，数组保持顺序，`undefined` 视同 `JSON.stringify` 丢弃 */
function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'number' || kind === 'boolean' || kind === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (kind === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  // undefined / function / symbol 在 JSON 里没有位置
  return 'null';
}

/** 递归排序后序列化再 sha256，取前 16 位十六进制（§4.2） */
export function digest(plan: object): string {
  const source: Record<string, unknown> = { ...(plan as Record<string, unknown>) };
  for (const key of DIGEST_IGNORED_KEYS) delete source[key];
  return createHash('sha256').update(stableStringify(source), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 签发待确认记录。
 *
 * `tokenSeed` 就是当前 turn（执行器把 `t-0007` 传进来）：token 里混入 turn、摘要、时刻与
 * 8 字节随机数，同一毫秒内连发两张也不会撞。
 */
export function issue(tokenSeed: string, plan: object, ttlMs: number = DEFAULT_CONFIRM_TTL_MS): PendingConfirm {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`E_CONFIRM_TTL: TTL 必须是正数，收到 ${String(ttlMs)}`);
  }
  const planDigest = digest(plan);
  const now = Date.now();
  const token = createHash('sha256')
    .update(`${tokenSeed}|${planDigest}|${now}|${randomBytes(8).toString('hex')}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return { token, turn: tokenSeed, planDigest, expiresAt: now + ttlMs };
}

/**
 * 判定这次带 token 的提交能不能执行。
 *
 * `pending` 是调用方按 token 查出来的记录；查不到就传 `null`（→ `missing`，
 * 执行器映射成 409 `E_CONFIRM_EXPIRED`，与"重启后 token 消失"同一表现）。
 */
export function verify(
  pending: PendingConfirm | null,
  token: string,
  plan: object,
  now: number = Date.now(),
): VerifyResult {
  if (!pending) return 'missing';
  if (typeof token !== 'string' || token === '') return 'missing';
  if (now >= pending.expiresAt) return 'expired';
  if (token !== pending.token) return 'mismatch';
  if (digest(plan) !== pending.planDigest) return 'mismatch';
  return 'ok';
}
