import type { HidDeviceDescriptor, HidUsageEntry, HidWhitelist } from './types';

const HID_ID_MAX = 0xffff;

/**
 * 默认白名单只按 Usage Page/Usage 放行厂商通道，不含 VID/PID：
 * VID/PID 属于具体产品型号，写死会把白名单变成产品绑定。
 */
export const DEFAULT_HID_WHITELIST: HidWhitelist = {
  entries: [{ usagePage: 0xff01, usage: 0x01 }],
  vids: [],
  pids: [],
};

function emptyWhitelist(): HidWhitelist {
  return { entries: [], vids: [], pids: [] };
}

function isHidId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= HID_ID_MAX;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 渲染进程传来的白名单不可信（localStorage 可能被改坏），
 * 这里逐项校验，非法项丢弃而不抛错；全部非法时退化成空白名单（等价全部拒绝）。
 */
export function normalizeWhitelist(raw: unknown): HidWhitelist {
  if (typeof raw !== 'object' || raw === null) return emptyWhitelist();
  const source = raw as { entries?: unknown; vids?: unknown; pids?: unknown };

  const entries: HidUsageEntry[] = [];
  for (const item of asArray(source.entries)) {
    if (typeof item !== 'object' || item === null) continue;
    const usagePage = (item as { usagePage?: unknown }).usagePage;
    const usage = (item as { usage?: unknown }).usage;
    if (!isHidId(usagePage) || !isHidId(usage)) continue;
    entries.push({ usagePage, usage });
  }

  return {
    entries,
    vids: asArray(source.vids).filter(isHidId),
    pids: asArray(source.pids).filter(isHidId),
  };
}

export function isEmptyWhitelist(list: HidWhitelist): boolean {
  return list.entries.length === 0 && list.vids.length === 0 && list.pids.length === 0;
}

/**
 * 空白名单等价"全部拒绝"：真机通道保持 Alpha 现状（requestDevice 拿到空数组）。
 * 不得按产品名/序列号匹配。
 * Electron 的 HIDDevice 不带 usage page，主进程放行判定用 shouldAllowSelection；
 * 本函数留给单测与将来描述符可见时复用。
 */
export function matchesWhitelist(device: HidDeviceDescriptor, list: HidWhitelist): boolean {
  if (isEmptyWhitelist(list)) return false;

  const collections = device.collections ?? [];
  for (const entry of list.entries) {
    if (collections.some((item) => item.usagePage === entry.usagePage && item.usage === entry.usage)) {
      return true;
    }
  }

  if (list.vids.includes(device.vendorId)) return true;
  if (list.pids.includes(device.productId)) return true;
  return false;
}

/**
 * 主进程的放行判定：usage 过滤由渲染进程 requestDevice({filters}) 在 Chromium 侧完成，
 * Electron 的 HIDDevice 又拿不到 usage page，所以这里只做三层粗粒度复核：
 * 空白名单拒绝、没有 VID/PID 条件直接放行、有 VID/PID 条件时按 VID/PID 复核。
 */
export function shouldAllowSelection(list: HidWhitelist, device: HidDeviceDescriptor): boolean {
  if (isEmptyWhitelist(list)) return false;

  const hasIdFilter = list.vids.length > 0 || list.pids.length > 0;
  if (!hasIdFilter) return true;

  return list.vids.includes(device.vendorId) || list.pids.includes(device.productId);
}
