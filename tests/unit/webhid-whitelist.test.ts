import { describe, expect, it } from 'vitest';
import type { HidDeviceDescriptor, HidWhitelist } from '../../src/shared/types';
import {
  DEFAULT_HID_WHITELIST,
  isEmptyWhitelist,
  matchesWhitelist,
  normalizeWhitelist,
  shouldAllowSelection,
} from '../../src/shared/webhid-whitelist';

function device(
  vendorId: number,
  productId: number,
  collections: ReadonlyArray<{ usagePage: number; usage: number }> = [],
): HidDeviceDescriptor {
  return { vendorId, productId, collections };
}

function whitelist(patch: Partial<HidWhitelist> = {}): HidWhitelist {
  return { entries: [], vids: [], pids: [], ...patch };
}

describe('DEFAULT_HID_WHITELIST', () => {
  it('只含一条 Usage Page/Usage 规则，不含 VID/PID', () => {
    expect(DEFAULT_HID_WHITELIST.entries).toHaveLength(1);
    expect(DEFAULT_HID_WHITELIST.entries[0]).toEqual({ usagePage: 0xff01, usage: 0x01 });
    expect(DEFAULT_HID_WHITELIST.vids).toEqual([]);
    expect(DEFAULT_HID_WHITELIST.pids).toEqual([]);
  });

  it('默认白名单不是空白名单，厂商通道设备可被放行', () => {
    expect(isEmptyWhitelist(DEFAULT_HID_WHITELIST)).toBe(false);
    expect(matchesWhitelist(device(0x1234, 0x0001, [{ usagePage: 0xff01, usage: 0x01 }]), DEFAULT_HID_WHITELIST)).toBe(
      true,
    );
  });
});

describe('matchesWhitelist — Usage Page/Usage', () => {
  it('collections 命中 usagePage 0xFF01 + usage 0x01 时放行', () => {
    expect(matchesWhitelist(device(0, 0, [{ usagePage: 0xff01, usage: 0x01 }]), DEFAULT_HID_WHITELIST)).toBe(true);
  });

  it('usagePage 不同则拒绝', () => {
    expect(matchesWhitelist(device(0, 0, [{ usagePage: 0xff00, usage: 0x01 }]), DEFAULT_HID_WHITELIST)).toBe(false);
  });

  it('usage 不同则拒绝', () => {
    expect(matchesWhitelist(device(0, 0, [{ usagePage: 0xff01, usage: 0x02 }]), DEFAULT_HID_WHITELIST)).toBe(false);
  });

  it('多集合里任一项命中即放行', () => {
    const target = device(0, 0, [
      { usagePage: 0x0001, usage: 0x0002 },
      { usagePage: 0xff01, usage: 0x01 },
    ]);
    expect(matchesWhitelist(target, DEFAULT_HID_WHITELIST)).toBe(true);
  });
});

describe('matchesWhitelist — 空设备与空白名单', () => {
  it('无 collections、vid/pid 都为 0 的空设备 → false', () => {
    expect(matchesWhitelist(device(0, 0), DEFAULT_HID_WHITELIST)).toBe(false);
  });

  it('空白名单（三项全空）对任何设备都返回 false（R9-2）', () => {
    const empty = whitelist();
    expect(isEmptyWhitelist(empty)).toBe(true);
    expect(matchesWhitelist(device(0, 0), empty)).toBe(false);
    expect(matchesWhitelist(device(0x352f, 0x0010, [{ usagePage: 0xff01, usage: 0x01 }]), empty)).toBe(false);
  });

  it('缺 collections 字段的设备不会抛错，按未命中处理', () => {
    const bare = { vendorId: 0, productId: 0 } as HidDeviceDescriptor;
    expect(matchesWhitelist(bare, DEFAULT_HID_WHITELIST)).toBe(false);
  });
});

describe('matchesWhitelist — VID/PID', () => {
  it('vids 命中 vendorId 时放行', () => {
    expect(matchesWhitelist(device(0x352f, 0x0010), whitelist({ vids: [0x352f] }))).toBe(true);
  });

  it('vid 不同则拒绝', () => {
    expect(matchesWhitelist(device(0x1234, 0x0010), whitelist({ vids: [0x352f] }))).toBe(false);
  });

  it('pids 命中 productId 时放行', () => {
    expect(matchesWhitelist(device(0x1234, 0x0010), whitelist({ pids: [0x0010] }))).toBe(true);
  });

  it('pid 不同则拒绝', () => {
    expect(matchesWhitelist(device(0x1234, 0x0011), whitelist({ pids: [0x0010] }))).toBe(false);
  });

  it('不按产品名/序列号匹配：描述里其余字段不参与判定', () => {
    const withName = { ...device(0x1111, 0x2222), name: 'MIC M001', serialNumber: 'VHID-MIC-M001' };
    expect(matchesWhitelist(withName, DEFAULT_HID_WHITELIST)).toBe(false);
  });
});

describe('normalizeWhitelist', () => {
  it('丢弃非法项，保留合法 usage/vid/pid', () => {
    const normalized = normalizeWhitelist({
      entries: [
        { usagePage: 0xff01, usage: 1 },
        { usagePage: -1, usage: 1 },
        null,
      ],
      vids: ['x', 123],
      pids: [0x1111],
    });
    expect(normalized).toEqual({ entries: [{ usagePage: 0xff01, usage: 1 }], vids: [123], pids: [4369] });
  });

  it('丢弃超出 16 位范围、非整数、非数字的项', () => {
    const normalized = normalizeWhitelist({
      entries: [
        { usagePage: 0x10000, usage: 1 },
        { usagePage: 1.5, usage: 1 },
        { usagePage: '65281', usage: 1 },
      ],
      vids: [0x10000, -1, 3.14, 0x352f],
      pids: [null, undefined, Number.NaN],
    });
    expect(normalized).toEqual({ entries: [], vids: [0x352f], pids: [] });
  });

  it('非对象输入退化成空白名单且不抛错', () => {
    for (const raw of ['nonsense', null, undefined, 42, true, [], () => undefined]) {
      expect(normalizeWhitelist(raw)).toEqual({ entries: [], vids: [], pids: [] });
    }
  });

  it('字段缺失或类型不对时逐字段退化成空数组', () => {
    expect(normalizeWhitelist({})).toEqual({ entries: [], vids: [], pids: [] });
    expect(normalizeWhitelist({ entries: 'x', vids: 1, pids: {} })).toEqual({ entries: [], vids: [], pids: [] });
  });

  it('返回新对象，不回写默认白名单', () => {
    const normalized = normalizeWhitelist({ entries: [{ usagePage: 0xff01, usage: 1 }] });
    expect(normalized).not.toBe(DEFAULT_HID_WHITELIST);
    expect(DEFAULT_HID_WHITELIST.entries).toHaveLength(1);
  });
});

describe('isEmptyWhitelist', () => {
  it('三项全空 → true', () => {
    expect(isEmptyWhitelist(whitelist())).toBe(true);
  });

  it('只有 entries → false', () => {
    expect(isEmptyWhitelist(whitelist({ entries: [{ usagePage: 0xff01, usage: 1 }] }))).toBe(false);
  });

  it('只有 vids → false', () => {
    expect(isEmptyWhitelist(whitelist({ vids: [0x352f] }))).toBe(false);
  });

  it('只有 pids → false', () => {
    expect(isEmptyWhitelist(whitelist({ pids: [0x0010] }))).toBe(false);
  });
});

describe('shouldAllowSelection — 主进程粗粒度复核', () => {
  it('空白名单 → false（R9-2：全部拒绝）', () => {
    expect(shouldAllowSelection(whitelist(), device(0x352f, 0x0010))).toBe(false);
    expect(
      shouldAllowSelection(whitelist(), device(0x352f, 0x0010, [{ usagePage: 0xff01, usage: 0x01 }])),
    ).toBe(false);
  });

  it('只有 entries、vids/pids 为空 → true（usage 过滤已由渲染进程 requestDevice filters 完成）', () => {
    const list = whitelist({ entries: [{ usagePage: 0xff01, usage: 0x01 }] });
    expect(shouldAllowSelection(list, device(0x1111, 0x2222))).toBe(true);
    expect(shouldAllowSelection(DEFAULT_HID_WHITELIST, device(0x352f, 0x0010))).toBe(true);
  });

  it('vids 命中 vendorId → true', () => {
    expect(shouldAllowSelection(whitelist({ vids: [0x352f] }), device(0x352f, 0x0010))).toBe(true);
  });

  it('vids 未命中 vendorId → false', () => {
    expect(shouldAllowSelection(whitelist({ vids: [0x352f] }), device(0x1234, 0x0010))).toBe(false);
  });

  it('pids 命中 productId → true', () => {
    expect(shouldAllowSelection(whitelist({ pids: [0x0010] }), device(0x1234, 0x0010))).toBe(true);
  });
});
