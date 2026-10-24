/**
 * DFU 模块入口：帧层（SigmaBus 编解码）与镜像层（解析 / Gamma / 校验和）。
 * 会话状态机在 4.2 的 `./session.ts`，不从这里导出。
 */
export * from './frame';
export * from './image';
