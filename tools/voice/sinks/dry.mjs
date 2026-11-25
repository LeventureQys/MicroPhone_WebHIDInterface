/**
 * `dry` 落地靶：内存里维护一份 `VoiceState`，不碰设备、不碰文件（SubStage 4.1 §4.3）。
 *
 * 状态是**一份 72 项的 `params`**（44 可写标量 + 28 个 `eq.bandN.{type,freq,gain,q}`，
 * 与 `targets.ts` 的 `PARAM_IDS` 同集合），`bands`（7 段增益）只是由它派生出来的便捷视图：
 * 4.2 的回读比对要覆盖 `bandWrites`，而 `eq` 动作改 `q`/`freq` 时要读真实当前值，
 * 两个 sink 的 `/state` 形状必须一致（vdevice 侧同样回读 72 项）。
 *
 * 初值取产品默认：44 项标量来自 `DEFAULT_PARAMS`，28 个 EQ 字段来自 `DEFAULT_BANDS` 的**前 7 段**
 * （`DEFAULT_BANDS` 共 14 段，8..14 是界面内部插值出来的，没有寄存器）。这样 `/plan` 的样例
 * 能和设计文档 §3.2 对得上（band7.gain 从 0 加 1.5，band6.gain 从 0 加 1）。
 *
 * 写入的值已经过 `canonicalize` 的夹紧与量化，这里只做"落到内存"与浅拷贝，
 * 不再二次夹紧——否则两处夹紧规则漂移时无法定位是哪一层改的。
 */

import { DEFAULT_BANDS, DEFAULT_PARAMS } from '../../../src/renderer/src/domain/defaults';
import { PARAM_IDS } from '../contract/targets';

/** 可调段（1..7）的 EQ 字段名，顺序与 `targets.ts` 的 EQ 段 id 一致 */
const EQ_FIELDS = ['type', 'freq', 'gain', 'q'];
const BAND_COUNT = 7;

/** 7 段增益视图：永远从 `params` 派生，避免两处各存一份后漂移 */
function gainsOf(params) {
  const bands = [];
  for (let band = 1; band <= BAND_COUNT; band += 1) bands.push(params[`eq.band${band}.gain`] ?? 0);
  return bands;
}

function initialState() {
  // 键集合 = `PARAM_IDS`（44 可写标量 + 28 EQ 字段 = 72），与 vdevice sink 的回读形状一致；
  // 只读的 `gain.Mic` / `gain.Hp` 属 `excluded` 层，两个 sink 都不放（canonicalize 读它们时
  // 仍会回落到 `DEFAULT_PARAMS`，值不变）
  const params = {};
  for (const id of PARAM_IDS) {
    // 只跳过 28 个 EQ 段字段（`eq.bandN.<field>`）；`eq.mode` 是标量，别一起跳过
    if (/^eq\.band\d+\./.test(id)) continue;
    params[id] = DEFAULT_PARAMS[id] ?? 0;
  }
  for (let band = 1; band <= BAND_COUNT; band += 1) {
    const source = DEFAULT_BANDS[band - 1];
    if (!source) continue;
    for (const field of EQ_FIELDS) params[`eq.band${band}.${field}`] = source[field];
  }
  return { params, bands: gainsOf(params) };
}

function assertFinite(value, what) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`E_SINK_INVALID: dry 只接受有限数，收到 ${what}=${JSON.stringify(value)}`);
  }
}

export function createDrySink() {
  let state = initialState();

  return {
    name: 'dry',

    async readState() {
      return { params: { ...state.params }, bands: [...state.bands] };
    },

    async write(cmd) {
      const params = { ...state.params };
      for (const write of cmd?.writes ?? []) {
        assertFinite(write.value, write.param);
        params[write.param] = write.value;
      }
      for (const bandWrite of cmd?.bandWrites ?? []) {
        const id = `eq.band${bandWrite.band}.${bandWrite.field}`;
        assertFinite(bandWrite.value, id);
        params[id] = bandWrite.value;
      }
      state = { params, bands: gainsOf(params) };
    },

    /** `--reset`：回到产品默认值 */
    reset() {
      state = initialState();
    },
  };
}
