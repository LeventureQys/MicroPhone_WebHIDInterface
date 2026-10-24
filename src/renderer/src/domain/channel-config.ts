import type { HidUsageEntry, HidWhitelist } from '../../../shared/types';
import { DEFAULT_HID_WHITELIST, normalizeWhitelist } from '../../../shared/webhid-whitelist';

/** 上位机到设备的通道：mock 走本地模拟，virtual 走桥接，native 走真机 WebHID */
export type ChannelKind = 'mock' | 'virtual' | 'native';

export interface ChannelConfig {
  readonly kind: ChannelKind;
  readonly bridgeUrl: string;
  readonly reportIdOut: number;
  readonly reportIdIn: number;
  readonly whitelist: readonly HidUsageEntry[];
  readonly useVidPid: boolean;
  readonly vids: readonly number[];
  readonly pids: readonly number[];
  readonly diagLimit: number;
}

/** 渲染进程 localStorage 键：逐字段存，坏掉一个字段不影响其余字段回读 */
export const CHANNEL_STORAGE_KEYS = {
  kind: 'micstudio.channel',
  bridgeUrl: 'micstudio.bridgeUrl',
  reportIdOut: 'micstudio.reportId.out',
  reportIdIn: 'micstudio.reportId.in',
  whitelist: 'micstudio.whitelist',
  useVidPid: 'micstudio.whitelist.useVidPid',
  diagLimit: 'micstudio.diagLimit',
} as const;

export const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8765/ws';
export const DEFAULT_REPORT_ID_OUT = 0x51;
export const DEFAULT_REPORT_ID_IN = 0x11;
export const DIAG_LIMIT_MIN = 100;
export const DIAG_LIMIT_MAX = 2000;

const HID_ID_MAX = 0xffff;
const REPORT_ID_MAX = 0xff;

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

/**
 * 白名单默认值直接取主进程匹配用的同一份：默认放行厂商通道 Usage Page 0xFF01 / 0x01，
 * 不含 VID/PID（写死 VID/PID 会把白名单变成产品绑定）。
 */
function defaultWhitelist(): HidUsageEntry[] {
  return DEFAULT_HID_WHITELIST.entries.map((entry) => ({ usagePage: entry.usagePage, usage: entry.usage }));
}

export const DEFAULT_CHANNEL_CONFIG: ChannelConfig = {
  kind: 'mock',
  bridgeUrl: DEFAULT_BRIDGE_URL,
  reportIdOut: DEFAULT_REPORT_ID_OUT,
  reportIdIn: DEFAULT_REPORT_ID_IN,
  whitelist: defaultWhitelist(),
  useVidPid: false,
  vids: [],
  pids: [],
  diagLimit: 500,
};

export const CHANNEL_KINDS: readonly ChannelKind[] = ['mock', 'virtual', 'native'];

function parseIntegerText(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const hex = /^0x([0-9a-f]+)$/i.exec(trimmed);
  if (hex) return Number.parseInt(hex[1], 16);
  const decimal = /^[0-9]+$/.exec(trimmed);
  if (decimal) return Number.parseInt(decimal[0], 10);
  return null;
}

function formatHexId(id: number, digits: number): string {
  return `0x${id.toString(16).toUpperCase().padStart(digits, '0')}`;
}

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // 隐私模式 / 沙箱下访问 localStorage 本身就可能抛错
    return null;
  }
}

function readItem(storage: StorageReader | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function readJson(storage: StorageReader | null, key: string): unknown {
  const text = readItem(storage, key);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function normalizeKind(value: unknown): ChannelKind {
  if (typeof value === 'string' && (CHANNEL_KINDS as readonly string[]).includes(value)) {
    return value as ChannelKind;
  }
  return DEFAULT_CHANNEL_CONFIG.kind;
}

function normalizeBridgeUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CHANNEL_CONFIG.bridgeUrl;
  const trimmed = value.trim();
  return /^wss?:\/\//i.test(trimmed) ? trimmed : DEFAULT_CHANNEL_CONFIG.bridgeUrl;
}

function normalizeReportId(value: unknown, fallback: number): number {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= REPORT_ID_MAX ? value : fallback;
  }
  if (typeof value === 'string') {
    const parsed = parseReportId(value);
    if (parsed !== null) return parsed;
  }
  return fallback;
}

function normalizeUseVidPid(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return DEFAULT_CHANNEL_CONFIG.useVidPid;
}

/**
 * 白名单两种入参都接受：UI 的数组，以及 localStorage 里的 `HidWhitelist` 对象。
 * 显式空数组表示"全部拒绝"，与被改坏的脏数据（回落默认）区分开。
 */
function normalizeEntries(raw: unknown): readonly HidUsageEntry[] {
  let items: readonly unknown[] | null = null;
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'object' && raw !== null) {
    const nested = (raw as { entries?: unknown }).entries;
    if (Array.isArray(nested)) items = nested;
  }
  if (items === null) return defaultWhitelist();
  if (items.length === 0) return [];
  const valid = normalizeWhitelist({ entries: items }).entries;
  return valid.length > 0 ? valid : defaultWhitelist();
}

function normalizeVidPidLists(source: Record<string, unknown>, whitelistSource: unknown): { vids: number[]; pids: number[] } {
  const nested =
    typeof whitelistSource === 'object' && whitelistSource !== null && !Array.isArray(whitelistSource)
      ? (whitelistSource as { vids?: unknown; pids?: unknown })
      : null;
  const lists = normalizeWhitelist({
    vids: source.vids ?? nested?.vids,
    pids: source.pids ?? nested?.pids,
  });
  return { vids: [...lists.vids], pids: [...lists.pids] };
}

function normalizeDiagLimit(value: unknown): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? parseIntegerText(value) : null;
  if (parsed === null || !Number.isFinite(parsed)) return DEFAULT_CHANNEL_CONFIG.diagLimit;
  return Math.min(DIAG_LIMIT_MAX, Math.max(DIAG_LIMIT_MIN, Math.round(parsed)));
}

/**
 * 逐字段校验并回落默认：localStorage 与 IPC 都可能送来脏数据，
 * 只有整条配置合法才允许进内存，坏字段一律用默认值而不是抛错。
 */
export function normalizeChannelConfig(raw: unknown): ChannelConfig {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const { vids, pids } = normalizeVidPidLists(source, source.whitelist);
  return {
    kind: normalizeKind(source.kind),
    bridgeUrl: normalizeBridgeUrl(source.bridgeUrl),
    reportIdOut: normalizeReportId(source.reportIdOut, DEFAULT_CHANNEL_CONFIG.reportIdOut),
    reportIdIn: normalizeReportId(source.reportIdIn, DEFAULT_CHANNEL_CONFIG.reportIdIn),
    whitelist: normalizeEntries(source.whitelist),
    useVidPid: normalizeUseVidPid(source.useVidPid),
    vids,
    pids,
    diagLimit: normalizeDiagLimit(source.diagLimit),
  };
}

export function loadChannelConfig(storage?: StorageReader): ChannelConfig {
  const target = storage ?? defaultStorage();
  if (!target) return normalizeChannelConfig(null);
  const storedWhitelist = readJson(target, CHANNEL_STORAGE_KEYS.whitelist);
  return normalizeChannelConfig({
    kind: readItem(target, CHANNEL_STORAGE_KEYS.kind),
    bridgeUrl: readItem(target, CHANNEL_STORAGE_KEYS.bridgeUrl),
    reportIdOut: readItem(target, CHANNEL_STORAGE_KEYS.reportIdOut),
    reportIdIn: readItem(target, CHANNEL_STORAGE_KEYS.reportIdIn),
    whitelist: storedWhitelist,
    useVidPid: readItem(target, CHANNEL_STORAGE_KEYS.useVidPid),
    diagLimit: readItem(target, CHANNEL_STORAGE_KEYS.diagLimit),
  });
}

export function saveChannelConfig(config: ChannelConfig, storage?: StorageWriter): void {
  const target = storage ?? defaultStorage();
  if (!target) return;
  const normalized = normalizeChannelConfig(config);
  // 落盘保留用户填的 VID/PID 列表本身，是否参与匹配由 useVidPid 决定（见 toHidWhitelist）
  const stored: HidWhitelist = {
    entries: normalized.whitelist.map((entry) => ({ usagePage: entry.usagePage, usage: entry.usage })),
    vids: [...normalized.vids],
    pids: [...normalized.pids],
  };
  try {
    target.setItem(CHANNEL_STORAGE_KEYS.kind, normalized.kind);
    target.setItem(CHANNEL_STORAGE_KEYS.bridgeUrl, normalized.bridgeUrl);
    target.setItem(CHANNEL_STORAGE_KEYS.reportIdOut, String(normalized.reportIdOut));
    target.setItem(CHANNEL_STORAGE_KEYS.reportIdIn, String(normalized.reportIdIn));
    target.setItem(CHANNEL_STORAGE_KEYS.whitelist, JSON.stringify(stored));
    target.setItem(CHANNEL_STORAGE_KEYS.useVidPid, normalized.useVidPid ? '1' : '0');
    target.setItem(CHANNEL_STORAGE_KEYS.diagLimit, String(normalized.diagLimit));
  } catch {
    // 配额耗尽 / 隐私模式：配置退化成会话内有效，不当致命错误
  }
}

/** IPC 入参：形状以 shared/types 的 HidWhitelist 为准；开关关闭时 VID/PID 不参与匹配 */
export function toHidWhitelist(config: ChannelConfig): HidWhitelist {
  return {
    entries: config.whitelist.map((entry) => ({ usagePage: entry.usagePage, usage: entry.usage })),
    vids: config.useVidPid ? [...config.vids] : [],
    pids: config.useVidPid ? [...config.pids] : [],
  };
}

/** 接受 '81' / '0x51'；0 是保留值，超出 1..255 一律判非法 */
export function parseReportId(text: string): number | null {
  const value = parseIntegerText(text);
  if (value === null || value < 1 || value > REPORT_ID_MAX) return null;
  return value;
}

export function formatReportId(id: number): string {
  return formatHexId(id, 2);
}

export function parseVidPidList(text: string): number[] {
  const ids: number[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const value = parseIntegerText(part);
    if (value === null || value < 0 || value > HID_ID_MAX) continue;
    ids.push(value);
  }
  return ids;
}

export function formatIdList(ids: readonly number[]): string {
  return ids.map((id) => formatHexId(id, 4)).join(', ');
}

export interface WhitelistParseResult {
  readonly entries: HidUsageEntry[];
  /** 格式错误的行数：> 0 且 entries 为空表示整段输入不可用 */
  readonly invalid: number;
}

/** 每行 `usagePage:usage`，两侧都接受十进制或 0x 十六进制 */
export function parseWhitelistText(text: string): WhitelistParseResult {
  const entries: HidUsageEntry[] = [];
  let invalid = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split(':');
    if (parts.length !== 2) {
      invalid += 1;
      continue;
    }
    const usagePage = parseIntegerText(parts[0]);
    const usage = parseIntegerText(parts[1]);
    if (usagePage === null || usage === null || usagePage > HID_ID_MAX || usage > HID_ID_MAX) {
      invalid += 1;
      continue;
    }
    entries.push({ usagePage, usage });
  }
  return { entries, invalid };
}

export function formatWhitelistText(entries: readonly HidUsageEntry[]): string {
  return entries.map((entry) => `${formatHexId(entry.usagePage, 4)}:${formatHexId(entry.usage, 4)}`).join('\n');
}

export interface ChannelConfigStore {
  get(): ChannelConfig;
  set(patch: Partial<ChannelConfig>): void;
  subscribe(cb: (config: ChannelConfig) => void): () => void;
}

/**
 * 通道配置的唯一读写口：每次 set 都立即落盘并广播，
 * 视图之间（设置页 / 设备页）不必互相知道对方存在。
 */
export function createChannelConfigStore(storage?: StorageReader & StorageWriter): ChannelConfigStore {
  let state = loadChannelConfig(storage);
  const listeners = new Set<(config: ChannelConfig) => void>();

  return {
    get: () => state,
    set: (patch) => {
      state = normalizeChannelConfig({ ...state, ...patch });
      saveChannelConfig(state, storage);
      for (const listener of [...listeners]) listener(state);
    },
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
