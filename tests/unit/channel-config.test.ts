import { describe, expect, it } from 'vitest';
import {
  CHANNEL_STORAGE_KEYS,
  DEFAULT_CHANNEL_CONFIG,
  createChannelConfigStore,
  formatIdList,
  formatReportId,
  formatWhitelistText,
  loadChannelConfig,
  normalizeChannelConfig,
  parseReportId,
  parseVidPidList,
  parseWhitelistText,
  saveChannelConfig,
  toHidWhitelist,
  type ChannelConfig,
  type ChannelKind,
} from '../../src/renderer/src/domain/channel-config';
import { DEFAULT_HID_WHITELIST } from '../../src/shared/webhid-whitelist';

interface FakeStorage {
  readonly data: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function configWith(patch: Partial<ChannelConfig>): ChannelConfig {
  return { ...DEFAULT_CHANNEL_CONFIG, ...patch };
}

describe('DEFAULT_CHANNEL_CONFIG', () => {
  it('按设计文档给出通道默认值（0x51 / 0x11、白名单 0xFF01:0x01、上限 500）', () => {
    expect(DEFAULT_CHANNEL_CONFIG.kind).toBe('mock');
    expect(DEFAULT_CHANNEL_CONFIG.bridgeUrl).toBe('ws://127.0.0.1:8765/ws');
    expect(DEFAULT_CHANNEL_CONFIG.reportIdOut).toBe(0x51);
    expect(DEFAULT_CHANNEL_CONFIG.reportIdIn).toBe(0x11);
    expect(DEFAULT_CHANNEL_CONFIG.whitelist).toEqual([{ usagePage: 65281, usage: 1 }]);
    expect(DEFAULT_CHANNEL_CONFIG.useVidPid).toBe(false);
    expect(DEFAULT_CHANNEL_CONFIG.vids).toEqual([]);
    expect(DEFAULT_CHANNEL_CONFIG.pids).toEqual([]);
    expect(DEFAULT_CHANNEL_CONFIG.diagLimit).toBe(500);
  });

  it('默认白名单与主进程匹配用的默认值同源，但数组是独立副本', () => {
    expect(DEFAULT_CHANNEL_CONFIG.whitelist).toEqual(DEFAULT_HID_WHITELIST.entries);
    expect(DEFAULT_CHANNEL_CONFIG.whitelist).not.toBe(DEFAULT_HID_WHITELIST.entries);

    const copy = normalizeChannelConfig(null).whitelist;
    expect(copy).toEqual(DEFAULT_CHANNEL_CONFIG.whitelist);
    expect(copy).not.toBe(DEFAULT_CHANNEL_CONFIG.whitelist);
  });
});

describe('normalizeChannelConfig', () => {
  it('脏数据逐项回落到默认值或夹紧', () => {
    const normalized = normalizeChannelConfig({
      kind: 'x',
      bridgeUrl: 'http://x',
      reportIdOut: 0,
      reportIdIn: 999,
      diagLimit: 9999,
      whitelist: 'x',
    });

    expect(normalized.kind).toBe('mock');
    expect(normalized.bridgeUrl).toBe('ws://127.0.0.1:8765/ws');
    expect(normalized.reportIdOut).toBe(0x51);
    expect(normalized.reportIdIn).toBe(0x11);
    expect(normalized.diagLimit).toBe(2000);
    expect(normalized.whitelist).toEqual([{ usagePage: 0xff01, usage: 1 }]);
  });

  it('非对象输入、缺失字段与错误类型都落到默认配置', () => {
    for (const raw of [null, undefined, 42, 'nonsense', true, []]) {
      expect(normalizeChannelConfig(raw)).toEqual(DEFAULT_CHANNEL_CONFIG);
    }
    expect(
      normalizeChannelConfig({ kind: 1, bridgeUrl: 2, reportIdOut: 'abc', useVidPid: 'maybe', vids: 'x', pids: {} }),
    ).toEqual(DEFAULT_CHANNEL_CONFIG);
  });

  it('白名单逐项校验：非法项丢弃，全非法回落默认，显式空数组表示全部拒绝', () => {
    expect(
      normalizeChannelConfig({
        whitelist: [
          { usagePage: 0xff01, usage: 1 },
          { usagePage: -1, usage: 1 },
          { usagePage: 0x10000, usage: 1 },
          null,
        ],
      }).whitelist,
    ).toEqual([{ usagePage: 0xff01, usage: 1 }]);

    expect(normalizeChannelConfig({ whitelist: [{ usagePage: -1, usage: 1 }] }).whitelist).toEqual([
      { usagePage: 0xff01, usage: 1 },
    ]);

    expect(normalizeChannelConfig({ whitelist: [] }).whitelist).toEqual([]);
  });

  it('接受 localStorage 形态的 HidWhitelist 对象，并挑出 vids/pids', () => {
    const normalized = normalizeChannelConfig({
      whitelist: { entries: [{ usagePage: 0xff02, usage: 2 }], vids: [0x352f], pids: [0x10, -1] },
      useVidPid: true,
    });

    expect(normalized.whitelist).toEqual([{ usagePage: 0xff02, usage: 2 }]);
    expect(normalized.vids).toEqual([0x352f]);
    expect(normalized.pids).toEqual([0x10]);
    expect(normalized.useVidPid).toBe(true);
  });

  it('诊断上限夹到 100..2000 并取整', () => {
    expect(normalizeChannelConfig({ diagLimit: 5 }).diagLimit).toBe(100);
    expect(normalizeChannelConfig({ diagLimit: 120.6 }).diagLimit).toBe(121);
    expect(normalizeChannelConfig({ diagLimit: '1500' }).diagLimit).toBe(1500);
    expect(normalizeChannelConfig({ diagLimit: 'abc' }).diagLimit).toBe(500);
  });

  it('桥接地址只接受 ws:// 与 wss://', () => {
    expect(normalizeChannelConfig({ bridgeUrl: 'ws://127.0.0.1:9000/ws' }).bridgeUrl).toBe('ws://127.0.0.1:9000/ws');
    expect(normalizeChannelConfig({ bridgeUrl: 'wss://box.local/ws' }).bridgeUrl).toBe('wss://box.local/ws');
    expect(normalizeChannelConfig({ bridgeUrl: '  ws://box.local/ws  ' }).bridgeUrl).toBe('ws://box.local/ws');
    expect(normalizeChannelConfig({ bridgeUrl: 'http://box.local/ws' }).bridgeUrl).toBe('ws://127.0.0.1:8765/ws');
  });
});

describe('loadChannelConfig', () => {
  it('storage 全空时返回默认配置', () => {
    expect(loadChannelConfig(fakeStorage())).toEqual(DEFAULT_CHANNEL_CONFIG);
  });

  it('脏 JSON 与非法取值一律回落默认', () => {
    const storage = fakeStorage({
      [CHANNEL_STORAGE_KEYS.whitelist]: '{ not json',
      [CHANNEL_STORAGE_KEYS.kind]: 'weird',
      [CHANNEL_STORAGE_KEYS.reportIdOut]: '0',
      [CHANNEL_STORAGE_KEYS.diagLimit]: '9999',
    });
    const loaded = loadChannelConfig(storage);

    expect(loaded.whitelist).toEqual(DEFAULT_CHANNEL_CONFIG.whitelist);
    expect(loaded.kind).toBe('mock');
    expect(loaded.reportIdOut).toBe(0x51);
    expect(loaded.diagLimit).toBe(2000);
  });

  it('合法 JSON 逐字段解析', () => {
    const storage = fakeStorage({
      [CHANNEL_STORAGE_KEYS.kind]: 'virtual',
      [CHANNEL_STORAGE_KEYS.bridgeUrl]: 'ws://127.0.0.1:9000/ws',
      [CHANNEL_STORAGE_KEYS.reportIdOut]: '80',
      [CHANNEL_STORAGE_KEYS.reportIdIn]: '17',
      [CHANNEL_STORAGE_KEYS.whitelist]: JSON.stringify({
        entries: [{ usagePage: 0xff02, usage: 3 }],
        vids: [0x352f],
        pids: [0x10],
      }),
      [CHANNEL_STORAGE_KEYS.useVidPid]: '1',
      [CHANNEL_STORAGE_KEYS.diagLimit]: '1200',
    });
    const loaded = loadChannelConfig(storage);

    expect(loaded.kind).toBe('virtual');
    expect(loaded.bridgeUrl).toBe('ws://127.0.0.1:9000/ws');
    expect(loaded.reportIdOut).toBe(0x50);
    expect(loaded.reportIdIn).toBe(0x11);
    expect(loaded.whitelist).toEqual([{ usagePage: 0xff02, usage: 3 }]);
    expect(loaded.useVidPid).toBe(true);
    expect(loaded.vids).toEqual([0x352f]);
    expect(loaded.pids).toEqual([0x10]);
    expect(loaded.diagLimit).toBe(1200);
  });

  it('localStorage 读写抛错时回落内存默认值，不抛异常', () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error('denied');
      },
      setItem: (): void => {
        throw new Error('denied');
      },
    };

    expect(loadChannelConfig(broken)).toEqual(DEFAULT_CHANNEL_CONFIG);
    expect(() => saveChannelConfig(DEFAULT_CHANNEL_CONFIG, broken)).not.toThrow();
  });
});

describe('saveChannelConfig', () => {
  it('写入的 JSON 可被 loadChannelConfig 原样读回', () => {
    const storage = fakeStorage();
    const config = configWith({
      kind: 'native',
      bridgeUrl: 'wss://box.local/ws',
      reportIdOut: 0x50,
      reportIdIn: 0x10,
      whitelist: [
        { usagePage: 0xff01, usage: 1 },
        { usagePage: 0x0001, usage: 6 },
      ],
      useVidPid: true,
      vids: [0x352f],
      pids: [0x10],
      diagLimit: 300,
    });

    saveChannelConfig(config, storage);

    expect(loadChannelConfig(storage)).toEqual(config);
    expect(storage.getItem(CHANNEL_STORAGE_KEYS.reportIdOut)).toBe('80');
    expect(storage.getItem(CHANNEL_STORAGE_KEYS.reportIdIn)).toBe('16');
    expect(storage.getItem(CHANNEL_STORAGE_KEYS.kind)).toBe('native');
  });

  it('VID/PID 列表即使开关关闭也照原样落盘，开关只影响匹配入参', () => {
    const storage = fakeStorage();
    const config = configWith({ useVidPid: false, vids: [0x352f], pids: [0x10] });

    saveChannelConfig(config, storage);
    expect(loadChannelConfig(storage).vids).toEqual([0x352f]);
    expect(toHidWhitelist(loadChannelConfig(storage))).toEqual({
      entries: [{ usagePage: 0xff01, usage: 1 }],
      vids: [],
      pids: [],
    });
  });
});

describe('toHidWhitelist', () => {
  it('形状与 shared/types 的 HidWhitelist 一致，开关打开才带 VID/PID', () => {
    const off = toHidWhitelist(configWith({ vids: [0x352f], pids: [0x10] }));
    expect(off).toEqual({ entries: [{ usagePage: 0xff01, usage: 1 }], vids: [], pids: [] });

    const on = toHidWhitelist(configWith({ useVidPid: true, vids: [0x352f], pids: [0x10] }));
    expect(on).toEqual({ entries: [{ usagePage: 0xff01, usage: 1 }], vids: [0x352f], pids: [0x10] });
  });

  it('返回新数组，不与配置共享引用', () => {
    const config = configWith({ useVidPid: true, vids: [0x352f], pids: [0x10], whitelist: [{ usagePage: 1, usage: 2 }] });
    const list = toHidWhitelist(config);
    expect(list.vids).not.toBe(config.vids);
    expect(list.entries).not.toBe(config.whitelist);
  });
});

describe('parseReportId', () => {
  it("接受十六进制与十进制，0 与越界值都判非法", () => {
    expect(parseReportId('0x51')).toBe(81);
    expect(parseReportId('81')).toBe(81);
    expect(parseReportId('0X11')).toBe(17);
    expect(parseReportId(' 0x51 ')).toBe(81);
    expect(parseReportId('255')).toBe(255);
    expect(parseReportId('0')).toBeNull();
    expect(parseReportId('abc')).toBeNull();
    expect(parseReportId('256')).toBeNull();
    expect(parseReportId('0x100')).toBeNull();
    expect(parseReportId('-81')).toBeNull();
    expect(parseReportId('')).toBeNull();
  });

  it('formatReportId 与 parseReportId 往返一致', () => {
    expect(formatReportId(0x51)).toBe('0x51');
    expect(formatReportId(0x11)).toBe('0x11');
    expect(formatReportId(0x05)).toBe('0x05');
    expect(parseReportId(formatReportId(0xff))).toBe(0xff);
  });
});

describe('parseVidPidList', () => {
  it('逗号分隔，十六进制与十进制混用', () => {
    expect(parseVidPidList('0x352F, 4660')).toEqual([13615, 4660]);
    expect(parseVidPidList('0x352F,0x1234')).toEqual([13615, 4660]);
    expect(parseVidPidList('')).toEqual([]);
    expect(parseVidPidList('   ')).toEqual([]);
  });

  it('非法项丢弃，16 位边界外的值不进入列表', () => {
    expect(parseVidPidList('0x352F, abc, 0x10000, -1, 0x0010')).toEqual([0x352f, 0x10]);
    expect(parseVidPidList('0, 65535')).toEqual([0, 65535]);
  });

  it('formatIdList 与 parseVidPidList 往返一致', () => {
    expect(formatIdList([0x352f, 0x10])).toBe('0x352F, 0x0010');
    expect(parseVidPidList(formatIdList([0x352f, 0x10]))).toEqual([0x352f, 0x10]);
    expect(formatIdList([])).toBe('');
  });
});

describe('白名单文本', () => {
  it('每行 usagePage:usage，十进制与 0x 十六进制都接受', () => {
    const parsed = parseWhitelistText('0xFF01:1\n0001:0x06\n\n 0x0002 : 0x0007 ');
    expect(parsed.entries).toEqual([
      { usagePage: 0xff01, usage: 1 },
      { usagePage: 1, usage: 6 },
      { usagePage: 2, usage: 7 },
    ]);
    expect(parsed.invalid).toBe(0);
  });

  it('缺分隔符、非数字、越界都记成非法行', () => {
    const parsed = parseWhitelistText('nonsense\n1234\n0xFF01\n0xFF01:abc\n0x10000:1');
    expect(parsed.entries).toEqual([]);
    expect(parsed.invalid).toBe(5);
    expect(parseWhitelistText('').invalid).toBe(0);
  });

  it('formatWhitelistText 与 parseWhitelistText 往返一致', () => {
    const entries = [
      { usagePage: 0xff01, usage: 1 },
      { usagePage: 1, usage: 6 },
    ];
    expect(formatWhitelistText(entries)).toBe('0xFF01:0x0001\n0x0001:0x0006');
    expect(parseWhitelistText(formatWhitelistText(entries)).entries).toEqual(entries);
  });
});

describe('createChannelConfigStore', () => {
  it('初值来自 storage，set 立即落盘并派发给订阅者', () => {
    const storage = fakeStorage({ [CHANNEL_STORAGE_KEYS.kind]: 'virtual' });
    const store = createChannelConfigStore(storage);
    expect(store.get().kind).toBe('virtual');

    const seen: ChannelConfig[] = [];
    const off = store.subscribe((config) => seen.push(config));

    store.set({ kind: 'native' });
    expect(store.get().kind).toBe('native');
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe('native');
    expect(storage.getItem(CHANNEL_STORAGE_KEYS.kind)).toBe('native');
    expect(loadChannelConfig(storage).kind).toBe('native');

    off();
    store.set({ bridgeUrl: 'ws://127.0.0.1:9000/ws' });
    expect(seen).toHaveLength(1);
    expect(loadChannelConfig(storage).bridgeUrl).toBe('ws://127.0.0.1:9000/ws');
  });

  it('set 也走同一套校验：越界与非法值不会写进配置', () => {
    const storage = fakeStorage();
    const store = createChannelConfigStore(storage);

    store.set({ diagLimit: 5, reportIdOut: 0, bridgeUrl: 'http://x', kind: 'x' as ChannelKind });
    const config = store.get();

    expect(config.diagLimit).toBe(100);
    expect(config.reportIdOut).toBe(0x51);
    expect(config.bridgeUrl).toBe('ws://127.0.0.1:8765/ws');
    expect(config.kind).toBe('mock');
  });

  it('没有 storage 时退化成会话内状态，不抛异常', () => {
    const store = createChannelConfigStore();
    expect(() => store.set({ kind: 'virtual' })).not.toThrow();
    expect(store.get().kind).toBe('virtual');
  });
});
