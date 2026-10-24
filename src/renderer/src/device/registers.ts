/**
 * M001 参数寄存器真值表。
 *
 * 唯一真值源：`Document/Protocol/M001参数表V0.1.xlsx`
 * （工作表「设备信息」/「设备配置」/「设备当前预设」，与需求文档附录 B 逐行对应）。
 *
 * 本文件刻意不 import 任何模块：`device/**` 与 `domain/**` 共用这张表，
 * 零依赖才能保证没有循环引用（任务书 SubStage 1.2 §5-D1、验收项 B7）。
 * 因此量化函数在文件内自带一份，不引用 `domain/values.ts`。
 *
 * 地址列在 xlsx 里是公式（`=A3+1` 递增、`=CONCATENATE("0x",DEC2HEX(C3,4))` 显示），
 * openpyxl 的 data_only 读不到缓存值，故按行序推算：
 * 设备信息 0x0000 起 62 行、设备配置 0x1000 起 14 行、设备当前预设 0x2000 起 114 行。
 */

export type RegisterAccess = 'r' | 'rw' | 'none';
export type RegisterRegion = 'info' | 'config' | 'preset';
export type RegisterKind = 'scalar' | 'string' | 'reserved' | 'live' | 'checksum';

type UnitText = 'dB' | 'Hz' | 'ms' | 's' | '';

export type RegisterScale =
  | { readonly kind: 'raw' }
  | { readonly kind: 'linear'; readonly mul: number; readonly add: number };

export interface RegisterSpec {
  readonly addr: number;
  /** 协议英文域名，来自寄存器表 E/F 列；同区段内唯一 */
  readonly field: string;
  /** 中文名，来自寄存器表 D 列；D 列为空时用需求附录 B 的名称 */
  readonly name: string;
  readonly region: RegisterRegion;
  readonly kind: RegisterKind;
  /** 工程量下限 */
  readonly min: number;
  readonly max: number;
  /** 工程量步进；枚举与字符串填 1，保留项填 0 */
  readonly step: number;
  readonly unit: UnitText;
  /** 寄存器原始值（xlsx G 列）；字符串与校验和填 0 */
  readonly defaultRaw: number;
  readonly access: RegisterAccess;
  readonly scale: RegisterScale;
}

export const PRESET_START = 0x2000;
export const PRESET_COUNT = 114;
export const LEVEL_ADDR = 0x2057;
export const VALID_FLAG_ADDR = 0x2001;
export const CHECKSUM_ADDR = 0x2000;

const WORD_MAX = 0xFFFF;

const RAW: RegisterScale = Object.freeze({ kind: 'raw' });

function linear(mul: number, add: number): RegisterScale {
  return Object.freeze({ kind: 'linear', mul, add });
}

interface RowOptions {
  readonly kind?: RegisterKind;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: UnitText;
  readonly defaultRaw?: number;
  readonly access?: RegisterAccess;
  readonly scale?: RegisterScale;
}

function row(
  region: RegisterRegion,
  addr: number,
  field: string,
  name: string,
  options: RowOptions = {},
): RegisterSpec {
  return Object.freeze({
    addr,
    field,
    name,
    region,
    kind: options.kind ?? 'scalar',
    min: options.min ?? 0,
    max: options.max ?? WORD_MAX,
    step: options.step ?? 1,
    unit: options.unit ?? '',
    defaultRaw: options.defaultRaw ?? 0,
    access: options.access ?? 'r',
    scale: options.scale ?? RAW,
  });
}

function info(addr: number, field: string, name: string, kind: RegisterKind, defaultRaw: number): RegisterSpec {
  return row('info', addr, field, name, { kind, defaultRaw, access: 'r' });
}

function config(addr: number, field: string, name: string, options: RowOptions): RegisterSpec {
  return row('config', addr, field, name, options);
}

function preset(addr: number, field: string, name: string, options: RowOptions = {}): RegisterSpec {
  return row('preset', addr, field, name, options);
}

/** 换算标定（需求附录 A.5）：EQ gain、comp/limit threshold/attack/release 等 */
const EQ_GAIN_SCALE = linear(0.1, -32);
const DIV_10 = linear(0.1, 0);
const DIV_100 = linear(0.01, 0);
const DIV_1000 = linear(0.001, 0);
const DIV_10000 = linear(0.0001, 0);
const SUB_91 = linear(1, -91);
const SUB_600_DIV_10 = linear(0.1, -60);
const SUB_800_DIV_10 = linear(0.1, -80);

/** 设备信息 0x0000–0x003D（62 项，全部只读；G 列公式项按公式求值） */
const INFO_ROWS: readonly RegisterSpec[] = Object.freeze([
  info(0x0000, 'mc1', 'Model Code MC1', 'string', 0),
  info(0x0001, 'mc2', 'Model Code MC2', 'string', 0),
  info(0x0002, 'mc3', 'Model Code MC3', 'string', 0),
  info(0x0003, 'dn1', 'Device Name DN1', 'string', 0),
  info(0x0004, 'dn2', 'Device Name DN2', 'string', 0),
  info(0x0005, 'dn3', 'Device Name DN3', 'string', 0),
  info(0x0006, 'dn4', 'Device Name DN4', 'string', 0),
  info(0x0007, 'dn5', 'Device Name DN5', 'string', 0),
  info(0x0008, 'dn6', 'Device Name DN6', 'string', 0),
  info(0x0009, 'dn7', 'Device Name DN7', 'string', 0),
  info(0x000A, 'dn8', 'Device Name DN8', 'string', 0),
  info(0x000B, 'fwX', 'Firmware Rev X', 'scalar', 1),
  info(0x000C, 'fwY', 'Firmware Rev Y', 'scalar', 0),
  info(0x000D, 'fwZ', 'Firmware Rev Z', 'scalar', 0),
  info(0x000E, 'fwBuild', 'Firmware Rev Build', 'scalar', 0),
  info(0x000F, 'fwType', 'Firmware Type', 'scalar', 1),
  info(0x0010, 'dsp1X', 'DSP1 Rev X', 'scalar', 1),
  info(0x0011, 'dsp1Y', 'DSP1 Rev Y', 'scalar', 0),
  info(0x0012, 'dsp1Z', 'DSP1 Rev Z', 'scalar', 0),
  info(0x0013, 'dsp2X', 'DSP2 Rev X', 'scalar', 1),
  info(0x0014, 'dsp2Y', 'DSP2 Rev Y', 'scalar', 0),
  info(0x0015, 'dsp2Z', 'DSP2 Rev Z', 'scalar', 0),
  info(0x0016, 'vid', 'USB ID VID', 'scalar', 0x0a67),
  info(0x0017, 'pid', 'USB ID PID', 'scalar', 0x0010),
  info(0x0018, 'dateY', 'Date Year', 'scalar', 2027),
  info(0x0019, 'dateM', 'Date Month', 'scalar', 1),
  info(0x001A, 'dateD', 'Date Day', 'scalar', 1),
  info(0x001B, 'timeH', 'Time Hour', 'scalar', 0),
  info(0x001C, 'timeM', 'Time Minute', 'scalar', 0),
  info(0x001D, 'timeS', 'Time Second', 'scalar', 0),
  info(0x001E, 'sn1', 'Device SN SN1', 'string', 0),
  info(0x001F, 'sn2', 'Device SN SN2', 'string', 0),
  info(0x0020, 'sn3', 'Device SN SN3', 'string', 0),
  info(0x0021, 'sn4', 'Device SN SN4', 'string', 0),
  info(0x0022, 'sn5', 'Device SN SN5', 'string', 0),
  info(0x0023, 'sn6', 'Device SN SN6', 'string', 0),
  info(0x0024, 'sn7', 'Device SN SN7', 'string', 0),
  info(0x0025, 'sn8', 'Device SN SN8', 'string', 0),
  info(0x0026, 'sn9', 'Device SN SN9', 'string', 0),
  info(0x0027, 'sn10', 'Device SN SN10', 'string', 0),
  info(0x0028, 'sn11', 'Device SN SN11', 'string', 0),
  info(0x0029, 'sn12', 'Device SN SN12', 'string', 0),
  info(0x002A, 'sn13', 'Device SN SN13', 'string', 0),
  info(0x002B, 'sn14', 'Device SN SN14', 'string', 0),
  info(0x002C, 'sn15', 'Device SN SN15', 'string', 0),
  info(0x002D, 'sn16', 'Device SN SN16', 'string', 0),
  info(0x002E, 'sn17', 'Device SN SN17', 'string', 0),
  info(0x002F, 'sn18', 'Device SN SN18', 'string', 0),
  info(0x0030, 'sn19', 'Device SN SN19', 'string', 0),
  info(0x0031, 'sn20', 'Device SN SN20', 'string', 0),
  info(0x0032, 'sn21', 'Device SN SN21', 'string', 0),
  info(0x0033, 'sn22', 'Device SN SN22', 'string', 0),
  info(0x0034, 'sn23', 'Device SN SN23', 'string', 0),
  info(0x0035, 'sn24', 'Device SN SN24', 'string', 0),
  info(0x0036, 'sn25', 'Device SN SN25', 'string', 0),
  info(0x0037, 'sn26', 'Device SN SN26', 'string', 0),
  info(0x0038, 'sn27', 'Device SN SN27', 'string', 0),
  info(0x0039, 'sn28', 'Device SN SN28', 'string', 0),
  info(0x003A, 'sn29', 'Device SN SN29', 'string', 0),
  info(0x003B, 'sn30', 'Device SN SN30', 'string', 0),
  info(0x003C, 'sn31', 'Device SN SN31', 'string', 0),
  info(0x003D, 'sn32', 'Device SN SN32', 'string', 0),
]);

/** 设备配置 0x1000–0x100D（14 项） */
const CONFIG_ROWS: readonly RegisterSpec[] = Object.freeze([
  config(0x1000, 'heartbeat', '心跳', { defaultRaw: 700, access: 'none' }),
  config(0x1001, 'unitAddr', '设备地址', { access: 'rw' }),
  config(0x1002, 'presetCount', '系统预设总数', { defaultRaw: 1, access: 'none' }),
  // 范围写作 [1,N]（N = 预设总数，表内未定值），按任务书兜底 0..0xFFFF
  config(0x1003, 'startupNo', '系统启动加载的预设', { defaultRaw: 1, access: 'none' }),
  config(0x1004, 'saveNo', '保存（存储器）预设', { defaultRaw: 1, access: 'none' }),
  config(0x1005, 'loadNo', '加载（存储器）预设', { defaultRaw: 1, access: 'none' }),
  config(0x1006, 'deleteNo', '删除（存储器）预设', { defaultRaw: 0, access: 'none' }),
  // H 列范围 [1,5] 而 G 列默认 0，默认值越界由 defaultOf 夹紧到 1
  config(0x1007, 'comErrAck', '通讯错误', { min: 1, max: 5, defaultRaw: 0, access: 'r' }),
  config(0x1008, 'enterDfu', '进入升级模式', { defaultRaw: 0, access: 'rw' }),
  config(0x1009, 'reinit', '系统重新初始化', { defaultRaw: 0, access: 'none' }),
  config(0x100A, 'factoryReset', '恢复出厂设置', { defaultRaw: 0, access: 'none' }),
  config(0x100B, 'syncFlag', '软件同步数据标志', { min: 0, max: 1, access: 'none' }),
  config(0x100C, 'sysErr1', '系统错误状态记录 1', { defaultRaw: 0, access: 'r' }),
  config(0x100D, 'sysErr2', '系统错误状态记录 2', { defaultRaw: 0, access: 'r' }),
]);

/** 当前预设 0x2000–0x2071（114 项；EQ 7 段、3BandDrc 三区按寄存器表行序） */
const PRESET_ROWS: readonly RegisterSpec[] = Object.freeze([
  preset(CHECKSUM_ADDR, 'checksum', '预设数据校验和', { kind: 'checksum', access: 'r' }),
  preset(VALID_FLAG_ADDR, 'validFlag', '预设有效标志', { min: 0, max: 1, defaultRaw: 1, access: 'rw' }),
  preset(0x2002, 'presetName1', '预设名称 1', { kind: 'string', access: 'rw' }),
  preset(0x2003, 'presetName2', '预设名称 2', { kind: 'string', access: 'rw' }),
  preset(0x2004, 'presetName3', '预设名称 3', { kind: 'string', access: 'rw' }),
  preset(0x2005, 'presetName4', '预设名称 4', { kind: 'string', access: 'rw' }),
  preset(0x2006, 'presetName5', '预设名称 5', { kind: 'string', access: 'rw' }),
  preset(0x2007, 'presetName6', '预设名称 6', { kind: 'string', access: 'rw' }),
  preset(0x2008, 'presetName7', '预设名称 7', { kind: 'string', access: 'rw' }),
  preset(0x2009, 'presetName8', '预设名称 8', { kind: 'string', access: 'rw' }),
  preset(0x200A, 'presetName9', '预设名称 9', { kind: 'string', access: 'rw' }),
  preset(0x200B, 'presetName10', '预设名称 10', { kind: 'string', access: 'rw' }),
  preset(0x200C, 'presetName11', '预设名称 11', { kind: 'string', access: 'rw' }),
  preset(0x200D, 'presetName12', '预设名称 12', { kind: 'string', access: 'rw' }),
  preset(0x200E, 'presetName13', '预设名称 13', { kind: 'string', access: 'rw' }),
  preset(0x200F, 'presetName14', '预设名称 14', { kind: 'string', access: 'rw' }),
  preset(0x2010, 'presetName15', '预设名称 15', { kind: 'string', access: 'rw' }),
  preset(0x2011, 'presetName16', '预设名称 16', { kind: 'string', access: 'rw' }),
  preset(0x2012, 'presetName17', '预设名称 17', { kind: 'string', access: 'rw' }),
  preset(0x2013, 'presetName18', '预设名称 18', { kind: 'string', access: 'rw' }),
  preset(0x2014, 'presetName19', '预设名称 19', { kind: 'string', access: 'rw' }),
  preset(0x2015, 'presetName20', '预设名称 20', { kind: 'string', access: 'rw' }),
  preset(0x2016, 'presetName21', '预设名称 21', { kind: 'string', access: 'rw' }),
  preset(0x2017, 'presetName22', '预设名称 22', { kind: 'string', access: 'rw' }),
  preset(0x2018, 'presetName23', '预设名称 23', { kind: 'string', access: 'rw' }),
  preset(0x2019, 'presetName24', '预设名称 24', { kind: 'string', access: 'rw' }),
  preset(0x201A, 'presetName25', '预设名称 25', { kind: 'string', access: 'rw' }),
  preset(0x201B, 'presetName26', '预设名称 26', { kind: 'string', access: 'rw' }),
  preset(0x201C, 'presetName27', '预设名称 27', { kind: 'string', access: 'rw' }),
  preset(0x201D, 'presetName28', '预设名称 28', { kind: 'string', access: 'rw' }),
  preset(0x201E, 'presetName29', '预设名称 29', { kind: 'string', access: 'rw' }),
  preset(0x201F, 'presetName30', '预设名称 30', { kind: 'string', access: 'rw' }),
  preset(0x2020, 'presetName31', '预设名称 31', { kind: 'string', access: 'rw' }),
  preset(0x2021, 'presetName32', '预设名称 32', { kind: 'string', access: 'rw' }),
  preset(0x2022, 'mute', 'MIC 静音', { min: 0, max: 1, access: 'rw' }),
  preset(0x2023, 'micGain', 'MIC 音量', { min: 0, max: 100, defaultRaw: 100, access: 'r' }),
  preset(0x2024, 'encOnOff', '降噪开关', { min: 0, max: 1, access: 'rw' }),
  preset(0x2025, 'encLevel', '降噪强度', { min: 0, max: 3, access: 'rw' }),
  preset(0x2026, 'eqMode', 'MIC 均衡器模式', { min: 0, max: 4, defaultRaw: 1, access: 'rw' }),

  preset(0x2027, 'band1.enable', 'Band-1 Enable', { min: 0, max: 1, defaultRaw: 1, access: 'rw' }),
  preset(0x2028, 'band1.type', 'Band-1 Type', { min: 0, max: 4, defaultRaw: 4, access: 'rw' }),
  preset(0x2029, 'band1.freq', 'Band-1 Freq', { min: 20, max: 20000, unit: 'Hz', defaultRaw: 50, access: 'rw' }),
  preset(0x202A, 'band1.gain', 'Band-1 Gain', { min: -32, max: 12, step: 0.1, unit: 'dB', defaultRaw: 320, access: 'rw', scale: EQ_GAIN_SCALE }),
  preset(0x202B, 'band1.q', 'Band-1 Q', { min: 0.1, max: 12, step: 0.1, defaultRaw: 7, access: 'rw', scale: DIV_10 }),

  preset(0x202C, 'band2.enable', 'Band-2 Enable', { min: 0, max: 1, defaultRaw: 1, access: 'rw' }),
  preset(0x202D, 'band2.type', 'Band-2 Type', { min: 0, max: 4, defaultRaw: 3, access: 'rw' }),
  preset(0x202E, 'band2.freq', 'Band-2 Freq', { min: 20, max: 20000, unit: 'Hz', defaultRaw: 20000, access: 'rw' }),
  preset(0x202F, 'band2.gain', 'Band-2 Gain', { min: -32, max: 12, step: 0.1, unit: 'dB', defaultRaw: 320, access: 'rw', scale: EQ_GAIN_SCALE }),
  preset(0x2030, 'band2.q', 'Band-2 Q', { min: 0.1, max: 12, step: 0.1, defaultRaw: 7, access: 'rw', scale: DIV_10 }),

  preset(0x2031, 'band3.enable', 'Band-3 Enable', { min: 0, max: 1, defaultRaw: 1, access: 'rw' }),
  preset(0x2032, 'band3.type', 'Band-3 Type', { min: 0, max: 4, defaultRaw: 0, access: 'rw' }),
  preset(0x2033, 'band3.freq', 'Band-3 Freq', { min: 20, max: 20000, unit: 'Hz', defaultRaw: 215, access: 'rw' }),
  preset(0x2034, 'band3.gain', 'Band-3 Gain', { min: -32, max: 12, step: 0.1, unit: 'dB', defaultRaw: 285, access: 'rw', scale: EQ_GAIN_SCALE }),
  preset(0x2035, 'band3.q', 'Band-3 Q', { min: 0.1, max: 12, step: 0.1, defaultRaw: 8, access: 'rw', scale: DIV_10 }),

  preset(0x2036, 'band4.enable', 'Band-4 Enable', { min: 0, max: 1, defaultRaw: 1, access: 'rw' }),
  preset(0x2037, 'band4.type', 'Band-4 Type', { min: 0, max: 4, defaultRaw: 0, access: 'rw' }),
  preset(0x2038, 'band4.freq', 'Band-4 Freq', { min: 20, max: 20000, unit: 'Hz', defaultRaw: 1000, access: 'rw' }),
  preset(0x2039, 'band4.gain', 'Band-4 Gain', { min: -32, max: 12, step: 0.1, unit: 'dB', defaultRaw: 320, access: 'rw', scale: EQ_GAIN_SCALE }),
  preset(0x203A, 'band4.q', 'Band-4 Q', { min: 0.1, max: 12, step: 0.1, defaultRaw: 15, access: 'rw', scale: DIV_10 }),

  preset(0x203B, 'band5.enable', 'Band-5 Enable', { min: 0, max: 1, defaultRaw: 1, access: 'rw' }),
  preset(0x203C, 'band5.type', 'Band-5 Type', { min: 0, max: 4, defaultRaw: 0, access: 'rw' }),
  preset(0x203D, 'band5.freq', 'Band-5 Freq', { min: 20, max: 20000, unit: 'Hz', defaultRaw: 2000, access: 'rw' }),
  preset(0x203E, 'band5.gain', 'Band-5 Gain', { min: -32, max: 12, step: 0.1, unit: 'dB', defaultRaw: 320, access: 'rw', scale: EQ_GAIN_SCALE }),
  preset(0x203F, 'band5.q', 'Band-5 Q', { min: 0.1, max: 12, step: 0.1, defaultRaw: 10, access: 'rw', scale: DIV_10 }),

  preset(0x2040, 'band6.enable', 'Band-6 Enable', { min: 0, max: 1, defaultRaw: 1, access: 'rw' }),
  preset(0x2041, 'band6.type', 'Band-6 Type', { min: 0, max: 4, defaultRaw: 0, access: 'rw' }),
  preset(0x2042, 'band6.freq', 'Band-6 Freq', { min: 20, max: 20000, unit: 'Hz', defaultRaw: 5000, access: 'rw' }),
  preset(0x2043, 'band6.gain', 'Band-6 Gain', { min: -32, max: 12, step: 0.1, unit: 'dB', defaultRaw: 320, access: 'rw', scale: EQ_GAIN_SCALE }),
  preset(0x2044, 'band6.q', 'Band-6 Q', { min: 0.1, max: 12, step: 0.1, defaultRaw: 10, access: 'rw', scale: DIV_10 }),

  preset(0x2045, 'band7.enable', 'Band-7 Enable', { min: 0, max: 1, defaultRaw: 1, access: 'rw' }),
  preset(0x2046, 'band7.type', 'Band-7 Type', { min: 0, max: 4, defaultRaw: 0, access: 'rw' }),
  preset(0x2047, 'band7.freq', 'Band-7 Freq', { min: 20, max: 20000, unit: 'Hz', defaultRaw: 10000, access: 'rw' }),
  preset(0x2048, 'band7.gain', 'Band-7 Gain', { min: -32, max: 12, step: 0.1, unit: 'dB', defaultRaw: 320, access: 'rw', scale: EQ_GAIN_SCALE }),
  preset(0x2049, 'band7.q', 'Band-7 Q', { min: 0.1, max: 12, step: 0.1, defaultRaw: 7, access: 'rw', scale: DIV_10 }),

  preset(0x204A, 'compEnable', 'Comp 使能', { min: 0, max: 1, access: 'rw' }),
  preset(0x204B, 'compMakeUpGain', 'Comp MakeUpGain', { min: 0, max: 60, step: 0.1, unit: 'dB', access: 'rw', scale: DIV_10 }),
  preset(0x204C, 'compThreshold', 'Comp Threshold', { min: -60, max: 0, step: 0.1, unit: 'dB', defaultRaw: 580, access: 'rw', scale: SUB_600_DIV_10 }),
  preset(0x204D, 'compAttack', 'Comp Attack', { min: 0.0001, max: 0.2, step: 0.0001, unit: 's', defaultRaw: 5, access: 'rw', scale: DIV_10000 }),
  preset(0x204E, 'compRelease', 'Comp Release', { min: 0.005, max: 2, step: 0.0001, unit: 's', defaultRaw: 1000, access: 'rw', scale: DIV_10000 }),
  preset(0x204F, 'compRate', 'Comp Rate', { min: 1, max: 100, step: 0.1, defaultRaw: 60, access: 'rw', scale: DIV_10 }),
  preset(0x2050, 'compKneeWidth', 'Comp KneeWidth', { min: 0, max: 60, step: 0.1, unit: 'dB', defaultRaw: 10, access: 'rw', scale: DIV_10 }),

  preset(0x2051, 'limitEnable', 'Limit 使能', { min: 0, max: 1, access: 'rw' }),
  // 保留项：寄存器表范围与步进均写 0，本版本不读写（需求 R2-7）
  preset(0x2052, 'limitPreGain', 'Limit preGain（保留）', { kind: 'reserved', min: 0, max: 0, step: 0, unit: 'dB', access: 'none' }),
  preset(0x2053, 'limitThreshold', 'Limit Threshold', { min: -60, max: 0, step: 0.1, unit: 'dB', defaultRaw: 580, access: 'rw', scale: SUB_600_DIV_10 }),
  preset(0x2054, 'limitAttack', 'Limit Attack', { min: 0.0001, max: 0.2, step: 0.0001, unit: 's', defaultRaw: 5, access: 'rw', scale: DIV_10000 }),
  preset(0x2055, 'limitRelease', 'Limit Release', { min: 0.005, max: 2, step: 0.0001, unit: 's', defaultRaw: 500, access: 'rw', scale: DIV_10000 }),
  preset(0x2056, 'limitRate', 'Limit Rate（保留）', { kind: 'reserved', min: 0, max: 0, step: 0, access: 'none' }),

  preset(LEVEL_ADDR, 'micLevel', 'MIC 电平指示', { kind: 'live', min: 0, max: 256, access: 'r' }),
  preset(0x2058, 'micSigMute', 'MIC 电平信号静音', { min: 0, max: 1, access: 'rw' }),
  preset(0x2059, 'hpOnOff', '监听开关', { min: 0, max: 1, defaultRaw: 1, access: 'rw' }),
  preset(0x205A, 'hpGain', '监听音量', { min: 0, max: 100, defaultRaw: 100, access: 'r' }),

  preset(0x205B, 'noisegateThresholdDb', 'NoiseGate threshold_db', { min: -91, max: 0, unit: 'dB', access: 'rw', scale: SUB_91 }),
  preset(0x205C, 'noisegateRatio', 'NoiseGate ratio', { min: 0.05, max: 0.999, step: 0.001, defaultRaw: 50, access: 'rw', scale: DIV_1000 }),
  preset(0x205D, 'noisegateAttackMs', 'NoiseGate attack_ms', { min: 5, max: 500, unit: 'ms', defaultRaw: 5, access: 'rw' }),
  preset(0x205E, 'noisegateReleaseMs', 'NoiseGate release_ms', { min: 5, max: 500, unit: 'ms', defaultRaw: 5, access: 'rw' }),
  preset(0x205F, 'noisegateKneeWidthDb', 'NoiseGate knee_width_db', { min: 6, max: 12, unit: 'dB', defaultRaw: 6, access: 'rw' }),
  preset(0x2060, 'noisegateHpFreq', 'NoiseGate hp_freq', { min: 60, max: 200, unit: 'Hz', defaultRaw: 60, access: 'rw' }),

  preset(0x2061, 'drc3Fc1', '3BandDrc 分频点 1', { min: 50, max: 10000, unit: 'Hz', defaultRaw: 50, access: 'rw' }),
  preset(0x2062, 'drc3Fc2', '3BandDrc 分频点 2', { min: 50, max: 10000, unit: 'Hz', defaultRaw: 50, access: 'rw' }),

  // 低区（freq < fc1）
  preset(0x2063, 'drc3LowPreGain', '3BandDrc 低区 preGain', { min: 0, max: 4, step: 0.01, access: 'rw', scale: DIV_100 }),
  preset(0x2064, 'drc3LowThreshold', '3BandDrc 低区 threshold', { min: -80, max: 0, step: 0.1, unit: 'dB', access: 'rw', scale: SUB_800_DIV_10 }),
  preset(0x2065, 'drc3LowAttackTime', '3BandDrc 低区 attackTime', { min: 1, max: 400, unit: 'ms', defaultRaw: 1, access: 'rw' }),
  preset(0x2066, 'drc3LowReleaseTime', '3BandDrc 低区 releaseTime', { min: 5, max: 680, unit: 'ms', defaultRaw: 5, access: 'rw' }),
  preset(0x2067, 'drc3LowRatio', '3BandDrc 低区 ratio', { min: 1, max: 20, step: 0.1, defaultRaw: 1, access: 'rw', scale: DIV_10 }),

  // 高区（freq > fc2）
  preset(0x2068, 'drc3HighPreGain', '3BandDrc 高区 preGain', { min: 0, max: 4, step: 0.01, access: 'rw', scale: DIV_100 }),
  preset(0x2069, 'drc3HighThreshold', '3BandDrc 高区 threshold', { min: -80, max: 0, step: 0.1, unit: 'dB', access: 'rw', scale: SUB_800_DIV_10 }),
  preset(0x206A, 'drc3HighAttackTime', '3BandDrc 高区 attackTime', { min: 1, max: 400, unit: 'ms', defaultRaw: 1, access: 'rw' }),
  preset(0x206B, 'drc3HighReleaseTime', '3BandDrc 高区 releaseTime', { min: 5, max: 680, unit: 'ms', defaultRaw: 5, access: 'rw' }),
  preset(0x206C, 'drc3HighRatio', '3BandDrc 高区 ratio', { min: 1, max: 20, step: 0.1, defaultRaw: 1, access: 'rw', scale: DIV_10 }),

  // 中区（fc1 < freq < fc2）
  preset(0x206D, 'drc3MidPreGain', '3BandDrc 中区 preGain', { min: 0, max: 4, step: 0.01, access: 'rw', scale: DIV_100 }),
  preset(0x206E, 'drc3MidThreshold', '3BandDrc 中区 threshold', { min: -80, max: 0, step: 0.1, unit: 'dB', access: 'rw', scale: SUB_800_DIV_10 }),
  preset(0x206F, 'drc3MidAttackTime', '3BandDrc 中区 attackTime', { min: 1, max: 400, unit: 'ms', defaultRaw: 1, access: 'rw' }),
  preset(0x2070, 'drc3MidReleaseTime', '3BandDrc 中区 releaseTime', { min: 5, max: 680, unit: 'ms', defaultRaw: 5, access: 'rw' }),
  preset(0x2071, 'drc3MidRatio', '3BandDrc 中区 ratio', { min: 1, max: 20, step: 0.1, defaultRaw: 1, access: 'rw', scale: DIV_10 }),
]);

export const REGISTERS: readonly RegisterSpec[] = Object.freeze([
  ...INFO_ROWS,
  ...CONFIG_ROWS,
  ...PRESET_ROWS,
]);

const BY_ADDR = new Map(REGISTERS.map((spec) => [spec.addr, spec]));

export function findRegister(addr: number): RegisterSpec | undefined {
  return BY_ADDR.get(addr);
}

/** 设备信息区的字段布局（多词字段的首址与词数） */
export const DEV_INFO = Object.freeze({
  modelCode: Object.freeze({ addr: 0x0000, words: 3 }),
  deviceName: Object.freeze({ addr: 0x0003, words: 8 }),
  firmware: Object.freeze({ addr: 0x000b, words: 4 }),
  fwType: Object.freeze({ addr: 0x000f, words: 1 }),
  vid: Object.freeze({ addr: 0x0016, words: 1 }),
  pid: Object.freeze({ addr: 0x0017, words: 1 }),
  serial: Object.freeze({ addr: 0x001e, words: 32 }),
});

/** 设备配置区地址 */
export const CONFIG = Object.freeze({
  heartbeat: 0x1000,
  unitAddr: 0x1001,
  presetCount: 0x1002,
  startupNo: 0x1003,
  saveNo: 0x1004,
  loadNo: 0x1005,
  deleteNo: 0x1006,
  comErrAck: 0x1007,
  enterDfu: 0x1008,
  reinit: 0x1009,
  factoryReset: 0x100a,
  syncFlag: 0x100b,
  sysErr1: 0x100c,
  sysErr2: 0x100d,
});

export const EQ_BAND_BASE = 0x2027;
export const EQ_BAND_STRIDE = 5;
export const EQ_BAND_COUNT = 7;

export type EqField = 'enable' | 'type' | 'freq' | 'gain' | 'q';
export const EQ_FIELD_ORDER: readonly EqField[] = Object.freeze(['enable', 'type', 'freq', 'gain', 'q']);

/** 段号 0..6 与字段名 → 寄存器地址（0x2027 起每段 5 个） */
export function eqBandAddr(band: number, field: EqField): number {
  const fieldIndex = EQ_FIELD_ORDER.indexOf(field);
  if (!Number.isInteger(band) || band < 0 || band >= EQ_BAND_COUNT || fieldIndex < 0) {
    throw new RangeError(`eq band out of range: band=${band} field=${field}`);
  }
  return EQ_BAND_BASE + band * EQ_BAND_STRIDE + fieldIndex;
}

export type Drc3SectionId = 'low' | 'high' | 'mid';

/** 顺序即寄存器表行序：低 → 高 → 中（需求 R2-4） */
export const DRC3_SECTIONS: readonly { readonly id: Drc3SectionId; readonly base: number }[] = Object.freeze([
  Object.freeze({ id: 'low', base: 0x2063 }),
  Object.freeze({ id: 'high', base: 0x2068 }),
  Object.freeze({ id: 'mid', base: 0x206d }),
]);

export type Drc3Field = 'preGain' | 'threshold' | 'attackTime' | 'releaseTime' | 'ratio';
export const DRC3_FIELD_ORDER: readonly Drc3Field[] = Object.freeze([
  'preGain',
  'threshold',
  'attackTime',
  'releaseTime',
  'ratio',
]);

export function drc3Addr(section: Drc3SectionId, field: Drc3Field): number {
  const entry = DRC3_SECTIONS.find((item) => item.id === section);
  const fieldIndex = DRC3_FIELD_ORDER.indexOf(field);
  if (!entry || fieldIndex < 0) {
    throw new RangeError(`drc3 section out of range: section=${section} field=${field}`);
  }
  return entry.base + fieldIndex;
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

function scaleValue(spec: RegisterSpec, value: number): number {
  const scale = spec.scale;
  if (scale.kind === 'raw') return value;
  return (value - scale.add) / scale.mul;
}

/** 量化到工程量步进（与 domain/values.ts:quantize 同一算法，因本文件不允许 import） */
function snap(spec: RegisterSpec, value: number): number {
  if (!Number.isFinite(value)) return spec.min;
  const clamped = Math.min(spec.max, Math.max(spec.min, value));
  if (!(spec.step > 0)) return clamped;
  const steps = Math.round((clamped - spec.min) / spec.step - 1e-9);
  const snapped = round6(spec.min + steps * spec.step);
  return Math.min(spec.max, Math.max(spec.min, snapped));
}

function rawMinOf(spec: RegisterSpec): number {
  return Math.round(round6(scaleValue(spec, spec.min)));
}

function rawMaxOf(spec: RegisterSpec): number {
  return Math.round(round6(scaleValue(spec, spec.max)));
}

/** 工程量 → 寄存器原始值：先量化到步进，再按标定式换算并夹紧到原始值区间 */
export function toRaw(spec: RegisterSpec, value: number): number {
  const raw = Math.round(round6(scaleValue(spec, snap(spec, value))));
  return Math.min(rawMaxOf(spec), Math.max(rawMinOf(spec), raw));
}

/** 寄存器原始值 → 工程量 */
export function fromRaw(spec: RegisterSpec, raw: number): number {
  const scale = spec.scale;
  if (scale.kind === 'raw') return raw;
  return round6(raw * scale.mul + scale.add);
}

/** 寄存器表默认原始值 → 工程量；原始值越界时夹紧到工程量区间 */
export function defaultOf(spec: RegisterSpec): number {
  const value = fromRaw(spec, spec.defaultRaw);
  return Math.min(spec.max, Math.max(spec.min, value));
}

/** 每字两个字符，高字节在前；遇 0x00 停止，去掉尾部空白（需求 A.4） */
export function decodeAsciiWords(words: readonly number[]): string {
  let text = '';
  for (const word of words) {
    const value = word & 0xffff;
    const high = (value >> 8) & 0xff;
    const low = value & 0xff;
    if (high === 0) break;
    text += String.fromCharCode(high);
    if (low === 0) break;
    text += String.fromCharCode(low);
  }
  return text.replace(/\s+$/, '');
}

/** 字符串 → 16 位字数组，右补 0x00，超长按词数截断 */
export function encodeAsciiWords(text: string, wordCount: number): number[] {
  const words: number[] = [];
  for (let index = 0; index < wordCount; index += 1) {
    const first = text.charCodeAt(index * 2);
    const second = text.charCodeAt(index * 2 + 1);
    const high = Number.isNaN(first) ? 0 : first & 0xff;
    const low = Number.isNaN(second) ? 0 : second & 0xff;
    words.push((high << 8) | low);
  }
  return words;
}
