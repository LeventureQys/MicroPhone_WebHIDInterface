/**
 * 落地靶工厂（SubStage 4.1 §4.3）：`createSink({kind, url})`。
 *
 * 两个靶的契约一致：`readState() -> VoiceState`、`write({writes, bandWrites}) -> void`
 * （失败抛 `E_SINK_*`）。`device`（真机）留给 M9，本版不实现也不静默退化——
 * 传一个未知 kind 直接抛，免得执行器"看起来在跑但什么都没写"。
 */

import { createDrySink } from './dry.mjs';
import { DEFAULT_VDEVICE_URL, createVDeviceSink } from './vdevice.mjs';

export { DEFAULT_VDEVICE_URL };

export function createSink(options = {}) {
  const kind = options.kind ?? 'dry';
  if (kind === 'dry') return createDrySink();
  if (kind === 'vdevice') return createVDeviceSink({ url: options.url ?? DEFAULT_VDEVICE_URL });
  throw new Error(`E_SINK_UNKNOWN: 未知落地靶 ${JSON.stringify(kind)}（支持 dry / vdevice）`);
}
