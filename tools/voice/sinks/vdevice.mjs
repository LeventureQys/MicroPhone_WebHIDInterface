/**
 * `vdevice` 落地靶：把写入落到虚拟下位机的控制面（SubStage 4.1 §4.3 / §4.4）。
 *
 * - 读：`GET /control/registers` → `{"ok":true,"registers":{"0x2025":2,…}}`（4.1 追加的只读路由）；
 * - 写：`POST /control/registers`，body 是**寄存器原始值**（`{"values":{"0x205B":51}}`），
 *   工程量 ↔ 原始值的换算一律走 `registers.ts` 的 `toRaw` / `fromRaw`（经 canonicalize 转出），
 *   本文件不复制任何范围、步进或标定。
 *
 * 控制面默认 `http://127.0.0.1:8766`（`tools/vdevice/run.mjs` 的 `--control-port` 默认值）。
 * 失败一律抛 `E_SINK_*`：连不上、超时、路由缺失算 `E_SINK_UNAVAILABLE`（执行器映射成 502）；
 * 控制面回 4xx 且带 `error` 字段算 `E_SINK_REJECTED`。两者都是 502 的语义子集，
 * 区别只在错误码文案，便于排查是"靶没起"还是"靶拒了这次写入"。
 */

import { fromRawById, specOfParamId, toRawById } from '../contract/canonicalize';
import { PARAM_IDS } from '../contract/targets';

export const DEFAULT_VDEVICE_URL = 'http://127.0.0.1:8766';
const REQUEST_TIMEOUT_MS = 3000;
const BAND_COUNT = 7;

/** 寄存器地址 → 控制面快照里的键（`0x` + 4 位大写十六进制，与 `ParamStack.snapshot()` 同形） */
export function registerKey(addr) {
  return `0x${addr.toString(16).toUpperCase().padStart(4, '0')}`;
}

function specOrThrow(id) {
  const spec = specOfParamId(id);
  if (!spec) throw new Error(`E_SINK_INVALID: 未知 paramId ${id}`);
  return spec;
}

async function requestJson(url, init, what) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`E_SINK_UNAVAILABLE: 落地靶不可用（${what} ${url}）：${error?.message ?? error}`);
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = text === '' ? null : JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const rejected = payload?.ok === false && typeof payload.error === 'string';
    const detail = rejected ? `（${payload.error}）` : '';
    const code = rejected ? 'E_SINK_REJECTED' : 'E_SINK_UNAVAILABLE';
    throw new Error(`${code}: ${what} ${url} 回 ${response.status}${detail}`);
  }
  if (!payload || payload.ok !== true) {
    throw new Error(`E_SINK_UNAVAILABLE: ${what} ${url} 的响应不是 {"ok":true}（虚拟下位机版本过旧？）`);
  }
  return payload;
}

export function createVDeviceSink(options = {}) {
  const base = String(options.url ?? DEFAULT_VDEVICE_URL).replace(/\/+$/, '');

  return {
    name: 'vdevice',

    /** 回读 72 个 paramId 的工程量；寄存器缺项按寄存器表的默认原始值兜底 */
    async readState() {
      const payload = await requestJson(`${base}/control/registers`, { method: 'GET' }, 'GET');
      const registers = payload.registers ?? {};
      const params = {};
      for (const id of PARAM_IDS) {
        const spec = specOrThrow(id);
        const raw = registers[registerKey(spec.addr)];
        params[id] = fromRawById(id, typeof raw === 'number' ? raw : spec.defaultRaw);
      }
      const bands = [];
      for (let band = 1; band <= BAND_COUNT; band += 1) bands.push(params[`eq.band${band}.gain`] ?? 0);
      return { params, bands };
    },

    /** 写入：一次 POST 带上本轮全部寄存器（工程量 → 原始值） */
    async write(cmd) {
      const values = {};
      for (const write of cmd?.writes ?? []) {
        const spec = specOrThrow(write.param);
        values[registerKey(spec.addr)] = toRawById(write.param, write.value);
      }
      for (const bandWrite of cmd?.bandWrites ?? []) {
        const id = `eq.band${bandWrite.band}.${bandWrite.field}`;
        const spec = specOrThrow(id);
        values[registerKey(spec.addr)] = toRawById(id, bandWrite.value);
      }
      if (Object.keys(values).length === 0) return;
      await requestJson(
        `${base}/control/registers`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ values }),
        },
        'POST',
      );
    },
  };
}
