import { describe, expect, it } from 'vitest';
import {
  CHECKSUM_ADDR,
  CONFIG,
  decodeAsciiWords,
  DEV_INFO,
  DRC3_FIELD_ORDER,
  DRC3_SECTIONS,
  drc3Addr,
  encodeAsciiWords,
  EQ_BAND_BASE,
  EQ_BAND_COUNT,
  EQ_BAND_STRIDE,
  EQ_FIELD_ORDER,
  eqBandAddr,
  defaultOf,
  findRegister,
  fromRaw,
  LEVEL_ADDR,
  PRESET_COUNT,
  PRESET_START,
  REGISTERS,
  toRaw,
  VALID_FLAG_ADDR,
} from '../../src/renderer/src/device/registers';

const INFO_COUNT = 62;
const CONFIG_COUNT = 14;
const PRESET = 114;

function must(addr: number) {
  const spec = findRegister(addr);
  if (!spec) throw new Error(`missing register 0x${addr.toString(16)}`);
  return spec;
}

describe('register table', () => {
  it('holds exactly 190 registers split as info 62 / config 14 / preset 114', () => {
    expect(REGISTERS).toHaveLength(190);
    expect(REGISTERS.filter((spec) => spec.region === 'info')).toHaveLength(INFO_COUNT);
    expect(REGISTERS.filter((spec) => spec.region === 'config')).toHaveLength(CONFIG_COUNT);
    expect(REGISTERS.filter((spec) => spec.region === 'preset')).toHaveLength(PRESET);
    expect(PRESET_COUNT).toBe(PRESET);
  });

  it('assigns every address exactly once and keeps them ascending', () => {
    const addrs = REGISTERS.map((spec) => spec.addr);
    expect(new Set(addrs).size).toBe(addrs.length);
    for (let index = 1; index < addrs.length; index += 1) {
      expect(addrs[index]).toBeGreaterThan(addrs[index - 1]);
    }
  });

  it('lays the preset region out contiguously from 0x2000 to 0x2071', () => {
    const preset = REGISTERS.filter((spec) => spec.region === 'preset');
    expect(preset[0].addr).toBe(PRESET_START);
    expect(preset[preset.length - 1].addr).toBe(PRESET_START + PRESET - 1);
    expect(preset.every((spec, index) => spec.addr === 0x2000 + index)).toBe(true);
    expect(PRESET_START).toBe(0x2000);
    expect(0x2000 + PRESET - 1).toBe(0x2071);
  });

  it('keeps the field name unique inside each region', () => {
    for (const region of ['info', 'config', 'preset'] as const) {
      const fields = REGISTERS.filter((spec) => spec.region === region).map((spec) => spec.field);
      expect(new Set(fields).size, `duplicate field in ${region}`).toBe(fields.length);
    }
  });

  it('anchors the well-known addresses from the protocol appendix', () => {
    expect(CHECKSUM_ADDR).toBe(0x2000);
    expect(VALID_FLAG_ADDR).toBe(0x2001);
    expect(LEVEL_ADDR).toBe(0x2057);
    expect(must(0x2000).kind).toBe('checksum');
    expect(must(0x2057).kind).toBe('live');
    expect(must(0x2052).kind).toBe('reserved');
    expect(must(0x2056).kind).toBe('reserved');
    expect(findRegister(0x9999)).toBeUndefined();
  });

  it('exposes the device info and config layout', () => {
    expect(DEV_INFO.modelCode).toEqual({ addr: 0x0000, words: 3 });
    expect(DEV_INFO.deviceName).toEqual({ addr: 0x0003, words: 8 });
    expect(DEV_INFO.firmware).toEqual({ addr: 0x000b, words: 4 });
    expect(DEV_INFO.fwType).toEqual({ addr: 0x000f, words: 1 });
    expect(DEV_INFO.vid).toEqual({ addr: 0x0016, words: 1 });
    expect(DEV_INFO.pid).toEqual({ addr: 0x0017, words: 1 });
    expect(DEV_INFO.serial).toEqual({ addr: 0x001e, words: 32 });
    expect(CONFIG.heartbeat).toBe(0x1000);
    expect(CONFIG.unitAddr).toBe(0x1001);
    expect(CONFIG.presetCount).toBe(0x1002);
    expect(CONFIG.startupNo).toBe(0x1003);
    expect(CONFIG.saveNo).toBe(0x1004);
    expect(CONFIG.loadNo).toBe(0x1005);
    expect(CONFIG.deleteNo).toBe(0x1006);
    expect(CONFIG.comErrAck).toBe(0x1007);
    expect(CONFIG.enterDfu).toBe(0x1008);
    expect(CONFIG.reinit).toBe(0x1009);
    expect(CONFIG.factoryReset).toBe(0x100a);
    expect(CONFIG.syncFlag).toBe(0x100b);
    expect(CONFIG.sysErr1).toBe(0x100c);
    expect(CONFIG.sysErr2).toBe(0x100d);
  });

  it('keeps the whole info region read-only with one word per register', () => {
    const info = REGISTERS.filter((spec) => spec.region === 'info');
    for (const spec of info) {
      expect(spec.access).toBe('r');
      expect(spec.min).toBe(0);
      expect(spec.max).toBe(0xffff);
      expect(spec.step).toBe(1);
      expect(spec.unit).toBe('');
      expect(spec.scale).toEqual({ kind: 'raw' });
    }
    const strings = info.filter((spec) => spec.kind === 'string').map((spec) => spec.field);
    expect(strings).toHaveLength(3 + 8 + 32);
    expect(strings).toContain('mc1');
    expect(strings).toContain('dn8');
    expect(strings).toContain('sn32');
  });

  it('marks the reserved, live and checksum registers as not writable', () => {
    for (const addr of [0x2000, 0x2057]) {
      expect(must(addr).access).toBe('r');
    }
    for (const addr of [0x2052, 0x2056]) {
      const spec = must(addr);
      expect(spec.access).toBe('none');
      expect(spec.min).toBe(0);
      expect(spec.max).toBe(0);
      expect(spec.step).toBe(0);
      expect(defaultOf(spec)).toBe(0);
    }
  });
});

describe('register calibration', () => {
  it('converts across the documented scales', () => {
    expect(toRaw(must(0x202a), 0)).toBe(320);
    expect(fromRaw(must(0x202a), 320)).toBe(0);
    expect(toRaw(must(0x202a), -32)).toBe(0);
    expect(toRaw(must(0x202a), 12)).toBe(440);
    expect(fromRaw(must(0x202a), 285)).toBe(-3.5);

    expect(toRaw(must(0x204c), -2)).toBe(580);
    expect(fromRaw(must(0x204c), 580)).toBe(-2);
    expect(fromRaw(must(0x2053), 580)).toBe(-2);

    expect(toRaw(must(0x204d), 0.0005)).toBe(5);
    expect(fromRaw(must(0x204e), 1000)).toBe(0.1);
    expect(fromRaw(must(0x2055), 500)).toBe(0.05);

    expect(toRaw(must(0x205b), -91)).toBe(0);
    expect(fromRaw(must(0x205b), 0)).toBe(-91);
    expect(toRaw(must(0x205c), 0.05)).toBe(50);
    expect(fromRaw(must(0x205c), 50)).toBe(0.05);

    expect(toRaw(must(0x2063), 1.28)).toBe(128);
    expect(fromRaw(must(0x2064), 800)).toBe(0);
    expect(toRaw(must(0x2067), 10)).toBe(100);
    expect(fromRaw(must(0x2057), 128)).toBe(128);
  });

  it('clamps raw values to the range ends for every writable register', () => {
    const writable = REGISTERS.filter((spec) => spec.access === 'rw');
    expect(writable.length).toBeGreaterThan(40);
    for (const spec of writable) {
      const span = spec.max - spec.min;
      expect(fromRaw(spec, toRaw(spec, spec.min - span - 1)), spec.field).toBeCloseTo(spec.min, 6);
      expect(fromRaw(spec, toRaw(spec, spec.max + span + 1)), spec.field).toBeCloseTo(spec.max, 6);
    }
  });

  it('round-trips 100 samples of every writable register within half a step', () => {
    const writable = REGISTERS.filter((spec) => spec.access === 'rw');
    for (const spec of writable) {
      for (let sample = 0; sample < 100; sample += 1) {
        const value = spec.min + ((spec.max - spec.min) * sample) / 99;
        const back = fromRaw(spec, toRaw(spec, value));
        expect(
          Math.abs(back - value),
          `${spec.field} @ ${value} -> ${back}`,
        ).toBeLessThanOrEqual(spec.step / 2 + 1e-9);
      }
    }
  });

  it('clamps the register default that falls outside the engineering range', () => {
    const ratio = must(0x2067);
    expect(ratio.defaultRaw).toBe(1);
    expect(fromRaw(ratio, 1)).toBe(0.1);
    expect(defaultOf(ratio)).toBe(1);
    expect(() => defaultOf(ratio)).not.toThrow();
  });

  it('clamps the config default that falls outside the documented range', () => {
    const comErrAck = must(CONFIG.comErrAck);
    expect(comErrAck.min).toBe(1);
    expect(comErrAck.max).toBe(5);
    expect(comErrAck.defaultRaw).toBe(0);
    expect(defaultOf(comErrAck)).toBe(1);
  });
});

describe('eq and 3-band drc addressing', () => {
  it('computes eq band addresses from the base and stride', () => {
    expect(EQ_BAND_BASE).toBe(0x2027);
    expect(EQ_BAND_STRIDE).toBe(5);
    expect(EQ_BAND_COUNT).toBe(7);
    expect(EQ_FIELD_ORDER).toEqual(['enable', 'type', 'freq', 'gain', 'q']);
    expect(eqBandAddr(0, 'enable')).toBe(0x2027);
    expect(eqBandAddr(0, 'q')).toBe(0x202b);
    expect(eqBandAddr(6, 'q')).toBe(0x2049);
    expect(eqBandAddr(6, 'enable')).toBe(0x2045);
    for (let band = 0; band < EQ_BAND_COUNT; band += 1) {
      for (const field of EQ_FIELD_ORDER) {
        expect(must(eqBandAddr(band, field)).field).toBe(`band${band + 1}.${field}`);
      }
    }
  });

  it('rejects out-of-range eq bands', () => {
    expect(() => eqBandAddr(7, 'enable')).toThrow(RangeError);
    expect(() => eqBandAddr(-1, 'enable')).toThrow(RangeError);
  });

  it('orders the 3-band drc sections low -> high -> mid with the documented bases', () => {
    expect(DRC3_SECTIONS.map((section) => section.id)).toEqual(['low', 'high', 'mid']);
    expect(DRC3_SECTIONS.map((section) => section.base)).toEqual([0x2063, 0x2068, 0x206d]);
    expect(DRC3_FIELD_ORDER).toEqual(['preGain', 'threshold', 'attackTime', 'releaseTime', 'ratio']);
    expect(drc3Addr('low', 'preGain')).toBe(0x2063);
    expect(drc3Addr('low', 'ratio')).toBe(0x2067);
    expect(drc3Addr('high', 'preGain')).toBe(0x2068);
    expect(drc3Addr('high', 'ratio')).toBe(0x206c);
    expect(drc3Addr('mid', 'preGain')).toBe(0x206d);
    expect(drc3Addr('mid', 'ratio')).toBe(0x2071);
    for (const section of DRC3_SECTIONS) {
      for (const field of DRC3_FIELD_ORDER) {
        const spec = must(drc3Addr(section.id, field));
        expect(spec.field).toBe(`drc3${section.id[0].toUpperCase()}${section.id.slice(1)}${field[0].toUpperCase()}${field.slice(1)}`);
        expect(spec.access).toBe('rw');
      }
    }
  });
});

interface AppendixRow {
  readonly addr: number;
  readonly label: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: 'dB' | 'Hz' | 'ms' | 's' | '';
  readonly defaultRaw?: number;
  readonly access?: 'r' | 'rw' | 'none';
  readonly scale?: 'raw' | 'linear';
  readonly mul?: number;
  readonly add?: number;
}

/**
 * 需求文档 §9 附录 B 的手抄表（B.1 用 DEV_INFO + 区段断言覆盖，B.2/B.3 逐行在此）。
 * 附录 B 里写「—」的列不出现，表示不比该字段。
 */
const APPENDIX_B_CONFIG: readonly AppendixRow[] = [
  { addr: 0x1000, label: '心跳 Heartbeat', defaultRaw: 700 },
  { addr: 0x1001, label: '设备地址 Addr', defaultRaw: 0 },
  { addr: 0x1002, label: '系统预设总数 Number(N)', defaultRaw: 1 },
  { addr: 0x1003, label: '启动加载预设 StartupNo', defaultRaw: 1 },
  { addr: 0x1004, label: '保存预设 SaveNo', defaultRaw: 1 },
  { addr: 0x1005, label: '加载预设 LoadNo', defaultRaw: 1 },
  { addr: 0x1006, label: '删除预设 DeleNo', defaultRaw: 0 },
  { addr: 0x1007, label: '通讯错误 ComErrAck', defaultRaw: 0 },
  { addr: 0x1008, label: '进入升级模式 DFU', defaultRaw: 0 },
  { addr: 0x1009, label: '系统重新初始化 ReInit', defaultRaw: 0 },
  { addr: 0x100a, label: '恢复出厂设置 Set', defaultRaw: 0 },
  { addr: 0x100b, label: '软件同步数据标志 SyncFlag', defaultRaw: 0 },
  { addr: 0x100c, label: '系统错误状态 1 SysErr1', defaultRaw: 0 },
  { addr: 0x100d, label: '系统错误状态 2 SysErr2', defaultRaw: 0 },
];

const APPENDIX_B_PRESET: readonly AppendixRow[] = [
  { addr: 0x2000, label: '预设数据校验和 Checksum', access: 'r', scale: 'raw' },
  { addr: 0x2001, label: '预设有效标志 ValidFlag', defaultRaw: 1, access: 'rw' },
  { addr: 0x2022, label: 'MIC 静音 Mute', min: 0, max: 1, step: 1, unit: '', defaultRaw: 0, access: 'rw', scale: 'raw' },
  { addr: 0x2023, label: 'MIC 音量 Gain', min: 0, max: 100, step: 1, unit: '', defaultRaw: 100, access: 'r', scale: 'raw' },
  { addr: 0x2024, label: '降噪开关 OnOff', min: 0, max: 1, step: 1, unit: '', defaultRaw: 0, access: 'rw', scale: 'raw' },
  { addr: 0x2025, label: '降噪强度 Threshold', min: 0, max: 3, step: 1, unit: '', defaultRaw: 0, access: 'rw', scale: 'raw' },
  { addr: 0x2026, label: 'MIC 均衡器模式 MIC', min: 0, max: 4, step: 1, unit: '', defaultRaw: 1, access: 'rw', scale: 'raw' },
  { addr: 0x204a, label: 'Comp 使能 Enable', min: 0, max: 1, step: 1, unit: '', defaultRaw: 0, access: 'rw', scale: 'raw' },
  { addr: 0x204b, label: 'Comp MakeUpGain', min: 0, max: 60, step: 0.1, unit: 'dB', defaultRaw: 0, access: 'rw', scale: 'linear', mul: 0.1, add: 0 },
  { addr: 0x204c, label: 'Comp Threshold', min: -60, max: 0, step: 0.1, unit: 'dB', defaultRaw: 580, access: 'rw', scale: 'linear', mul: 0.1, add: -60 },
  { addr: 0x204d, label: 'Comp Attack', min: 0.0001, max: 0.2, step: 0.0001, unit: 's', defaultRaw: 5, access: 'rw', scale: 'linear', mul: 0.0001, add: 0 },
  { addr: 0x204e, label: 'Comp Release', min: 0.005, max: 2, step: 0.0001, unit: 's', defaultRaw: 1000, access: 'rw', scale: 'linear', mul: 0.0001, add: 0 },
  { addr: 0x204f, label: 'Comp Rate', min: 1, max: 100, step: 0.1, unit: '', defaultRaw: 60, access: 'rw', scale: 'linear', mul: 0.1, add: 0 },
  { addr: 0x2050, label: 'Comp KneeWidth', min: 0, max: 60, step: 0.1, unit: 'dB', defaultRaw: 10, access: 'rw', scale: 'linear', mul: 0.1, add: 0 },
  { addr: 0x2051, label: 'Limit 使能 Enable', min: 0, max: 1, step: 1, unit: '', defaultRaw: 0, access: 'rw', scale: 'raw' },
  { addr: 0x2052, label: 'Limit preGain（保留）', min: 0, max: 0, step: 0, unit: 'dB', defaultRaw: 0, access: 'none' },
  { addr: 0x2053, label: 'Limit Threshold', min: -60, max: 0, step: 0.1, unit: 'dB', defaultRaw: 580, access: 'rw', scale: 'linear', mul: 0.1, add: -60 },
  { addr: 0x2054, label: 'Limit Attack', min: 0.0001, max: 0.2, step: 0.0001, unit: 's', defaultRaw: 5, access: 'rw', scale: 'linear', mul: 0.0001, add: 0 },
  { addr: 0x2055, label: 'Limit Release', min: 0.005, max: 2, step: 0.0001, unit: 's', defaultRaw: 500, access: 'rw', scale: 'linear', mul: 0.0001, add: 0 },
  { addr: 0x2056, label: 'Limit Rate（保留）', min: 0, max: 0, step: 0, unit: '', defaultRaw: 0, access: 'none' },
  { addr: 0x2057, label: 'MIC 电平指示 Level', min: 0, max: 256, step: 1, unit: '', defaultRaw: 0, access: 'r', scale: 'raw' },
  { addr: 0x2058, label: 'MIC 电平信号静音 MicSigLevelMute', min: 0, max: 1, step: 1, unit: '', defaultRaw: 0, access: 'rw', scale: 'raw' },
  { addr: 0x2059, label: '监听开关 HP.OnOff', min: 0, max: 1, step: 1, unit: '', defaultRaw: 1, access: 'rw', scale: 'raw' },
  { addr: 0x205a, label: '监听音量 HP.Gain', min: 0, max: 100, step: 1, unit: '', defaultRaw: 100, access: 'r', scale: 'raw' },
  { addr: 0x205b, label: 'NoiseGate threshold_db', min: -91, max: 0, step: 1, unit: 'dB', defaultRaw: 0, access: 'rw', scale: 'linear', mul: 1, add: -91 },
  { addr: 0x205c, label: 'NoiseGate ratio', min: 0.05, max: 0.999, step: 0.001, unit: '', defaultRaw: 50, access: 'rw', scale: 'linear', mul: 0.001, add: 0 },
  { addr: 0x205d, label: 'NoiseGate attack_ms', min: 5, max: 500, step: 1, unit: 'ms', defaultRaw: 5, access: 'rw', scale: 'raw' },
  { addr: 0x205e, label: 'NoiseGate release_ms', min: 5, max: 500, step: 1, unit: 'ms', defaultRaw: 5, access: 'rw', scale: 'raw' },
  { addr: 0x205f, label: 'NoiseGate knee_width_db', min: 6, max: 12, step: 1, unit: 'dB', defaultRaw: 6, access: 'rw', scale: 'raw' },
  { addr: 0x2060, label: 'NoiseGate hp_freq', min: 60, max: 200, step: 1, unit: 'Hz', defaultRaw: 60, access: 'rw', scale: 'raw' },
  { addr: 0x2061, label: '3BandDrc 分频点 1 fc1', min: 50, max: 10000, step: 1, unit: 'Hz', defaultRaw: 50, access: 'rw', scale: 'raw' },
  { addr: 0x2062, label: '3BandDrc 分频点 2 fc2', min: 50, max: 10000, step: 1, unit: 'Hz', defaultRaw: 50, access: 'rw', scale: 'raw' },
];

function assertAppendixRow(row: AppendixRow): void {
  const spec = must(row.addr);
  const where = `附录 B ${row.label} (0x${row.addr.toString(16)})`;
  if (row.min !== undefined) expect(spec.min, `${where} min`).toBe(row.min);
  if (row.max !== undefined) expect(spec.max, `${where} max`).toBe(row.max);
  if (row.step !== undefined) expect(spec.step, `${where} step`).toBe(row.step);
  if (row.unit !== undefined) expect(spec.unit, `${where} unit`).toBe(row.unit);
  if (row.defaultRaw !== undefined) expect(spec.defaultRaw, `${where} defaultRaw`).toBe(row.defaultRaw);
  if (row.access !== undefined) expect(spec.access, `${where} access`).toBe(row.access);
  if (row.scale !== undefined) expect(spec.scale.kind, `${where} scale`).toBe(row.scale);
  if (row.mul !== undefined || row.add !== undefined) {
    expect(spec.scale.kind, `${where} scale`).toBe('linear');
    if (spec.scale.kind === 'linear') {
      if (row.mul !== undefined) expect(spec.scale.mul, `${where} mul`).toBe(row.mul);
      if (row.add !== undefined) expect(spec.scale.add, `${where} add`).toBe(row.add);
    }
  }
}

describe('appendix B cross-check (R2-1)', () => {
  it('matches appendix B.1 device info word layout', () => {
    const words =
      DEV_INFO.modelCode.words +
      DEV_INFO.deviceName.words +
      DEV_INFO.firmware.words +
      DEV_INFO.fwType.words +
      3 + // DSP1 X.Y.Z
      3 + // DSP2 X.Y.Z
      DEV_INFO.vid.words +
      DEV_INFO.pid.words +
      3 + // 生产日期 Y/M/D
      3 + // 生产时间 h/m/s
      DEV_INFO.serial.words;
    expect(words).toBe(INFO_COUNT);
    for (let addr = 0x0000; addr <= 0x003d; addr += 1) {
      expect(must(addr).region).toBe('info');
      expect(must(addr).access).toBe('r');
    }
    expect(must(0x000f).defaultRaw).toBe(1);
  });

  it('matches appendix B.2 device config defaults', () => {
    for (const row of APPENDIX_B_CONFIG) assertAppendixRow(row);
    expect(must(0x1008).access).toBe('rw');
    expect(must(0x1001).access).toBe('rw');
    expect(must(0x1007).access).toBe('r');
    expect(must(0x100c).access).toBe('r');
    expect(must(0x100d).access).toBe('r');
  });

  it('matches appendix B.3 preset scalars row by row', () => {
    for (const row of APPENDIX_B_PRESET) assertAppendixRow(row);
  });

  it('matches appendix B.3 preset name block', () => {
    for (let addr = 0x2002; addr <= 0x2021; addr += 1) {
      const spec = must(addr);
      expect(spec.kind).toBe('string');
      expect(spec.access).toBe('rw');
      expect(spec.field).toBe(`presetName${addr - 0x2001}`);
    }
  });

  it('matches appendix B.3 eq summary rows and the 7-band address table', () => {
    const typeDefault = [4, 3, 0, 0, 0, 0, 0];
    const freqDefault = [50, 20000, 215, 1000, 2000, 5000, 10000];
    const gainDefault = [320, 320, 285, 320, 320, 320, 320];
    const gainDb = [0, 0, -3.5, 0, 0, 0, 0];
    const qDefault = [7, 7, 8, 15, 10, 10, 7];
    for (let band = 0; band < EQ_BAND_COUNT; band += 1) {
      const enable = must(eqBandAddr(band, 'enable'));
      expect(enable.min).toBe(0);
      expect(enable.max).toBe(1);
      expect(enable.step).toBe(1);
      expect(enable.defaultRaw).toBe(1);
      expect(enable.access).toBe('rw');

      const type = must(eqBandAddr(band, 'type'));
      expect(type.min).toBe(0);
      expect(type.max).toBe(4);
      expect(type.defaultRaw).toBe(typeDefault[band]);
      expect(type.access).toBe('rw');

      const freq = must(eqBandAddr(band, 'freq'));
      expect(freq.min).toBe(20);
      expect(freq.max).toBe(20000);
      expect(freq.step).toBe(1);
      expect(freq.unit).toBe('Hz');
      expect(freq.defaultRaw).toBe(freqDefault[band]);

      const gain = must(eqBandAddr(band, 'gain'));
      expect(gain.min).toBe(-32);
      expect(gain.max).toBe(12);
      expect(gain.step).toBe(0.1);
      expect(gain.unit).toBe('dB');
      // 附录 B 的汇总行写 320，逐段默认以寄存器表 G 列为准（第 3 段 285 = −3.5 dB）
      expect(gain.defaultRaw).toBe(gainDefault[band]);
      expect(gain.scale).toEqual({ kind: 'linear', mul: 0.1, add: -32 });
      expect(fromRaw(gain, gain.defaultRaw)).toBeCloseTo(gainDb[band], 6);

      const q = must(eqBandAddr(band, 'q'));
      expect(q.min).toBe(0.1);
      expect(q.max).toBe(12);
      expect(q.step).toBe(0.1);
      expect(q.defaultRaw).toBe(qDefault[band]);
      expect(q.scale).toEqual({ kind: 'linear', mul: 0.1, add: 0 });
    }
    // 附录 B 把 Type 的步进写成 0；量化需要正步进，枚举按 1 处理（任务书 D3）
    expect(must(eqBandAddr(0, 'type')).step).toBe(1);
  });

  it('matches appendix B.3 3-band drc table', () => {
    const expected = {
      preGain: { min: 0, max: 4, step: 0.01, unit: '', defaultRaw: 0, mul: 0.01, add: 0 },
      threshold: { min: -80, max: 0, step: 0.1, unit: 'dB', defaultRaw: 0, mul: 0.1, add: -80 },
      attackTime: { min: 1, max: 400, step: 1, unit: 'ms', defaultRaw: 1, mul: null, add: null },
      releaseTime: { min: 5, max: 680, step: 1, unit: 'ms', defaultRaw: 5, mul: null, add: null },
      ratio: { min: 1, max: 20, step: 0.1, unit: '', defaultRaw: 1, mul: 0.1, add: 0 },
    } as const;
    for (const section of DRC3_SECTIONS) {
      for (const field of DRC3_FIELD_ORDER) {
        const row = expected[field];
        const spec = must(drc3Addr(section.id, field));
        const where = `3BandDrc ${section.id} ${field}`;
        expect(spec.min, where).toBe(row.min);
        expect(spec.max, where).toBe(row.max);
        expect(spec.step, where).toBe(row.step);
        expect(spec.unit, where).toBe(row.unit);
        expect(spec.defaultRaw, where).toBe(row.defaultRaw);
        expect(spec.access, where).toBe('rw');
        if (row.mul === null) {
          expect(spec.scale.kind, where).toBe('raw');
        } else {
          expect(spec.scale, where).toEqual({ kind: 'linear', mul: row.mul, add: row.add });
        }
      }
    }
  });
});

describe('ascii word packing (appendix A.4)', () => {
  it('packs two characters per word with the high byte first', () => {
    expect(encodeAsciiWords('JY', 1)).toEqual([0x4a59]);
    expect(encodeAsciiWords('JYM001', 3)).toEqual([0x4a59, 0x4d30, 0x3031]);
    expect(decodeAsciiWords([0x4a59, 0x4d30, 0x3031])).toBe('JYM001');
    expect(decodeAsciiWords(encodeAsciiWords('JYM001', 3))).toBe('JYM001');
  });

  it('pads with 0x00 words and truncates to the requested length', () => {
    const words = encodeAsciiWords('M001', 8);
    expect(words).toHaveLength(8);
    expect(words[0]).toBe(0x4d30);
    expect(words[1]).toBe(0x3031);
    expect(words.slice(2)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(encodeAsciiWords('M001', 1)).toEqual([0x4d30]);
  });

  it('stops at the first empty byte and trims trailing blanks', () => {
    expect(decodeAsciiWords([0x4a59, 0x0000, 0x3031])).toBe('JY');
    expect(decodeAsciiWords([])).toBe('');
    expect(decodeAsciiWords([0x2020, 0x2000])).toBe('');
    expect(decodeAsciiWords([0x4a00])).toBe('J');
  });
});
