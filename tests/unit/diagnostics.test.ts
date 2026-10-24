import { describe, expect, it } from 'vitest';
import {
  DiagnosticsHub,
  ENTRY_EVENT,
  STATS_EVENT,
} from '../../src/renderer/src/device/diagnostics';
import type { DiagEntry } from '../../src/renderer/src/device/proto/session';

const T0 = new Date(2026, 9, 25, 12, 0, 0, 123).getTime();

function entry(at: number, summary = `帧 ${at}`): DiagEntry {
  return { at, dir: 'out', hex: '00 02 00 08 00 00 F8 19', summary, level: 'info' };
}

describe('DiagnosticsHub 环形缓冲（R8-4）', () => {
  it('ringSize=3 推 5 条：只保留最后 3 条且时间升序', () => {
    const hub = new DiagnosticsHub({ ringSize: 3 });
    for (let index = 0; index < 5; index += 1) hub.push(entry(T0 + index, `第 ${index} 条`));

    const kept = hub.entries();
    expect(kept).toHaveLength(3);
    expect(kept.map((item) => item.summary)).toEqual(['第 2 条', '第 3 条', '第 4 条']);
    expect(kept.map((item) => item.at)).toEqual([T0 + 2, T0 + 3, T0 + 4]);
  });

  it('默认上限 500 条：推 620 条只留最后 500 条', () => {
    const hub = new DiagnosticsHub();
    for (let index = 0; index < 620; index += 1) hub.push(entry(T0 + index, `第 ${index} 条`));

    const kept = hub.entries();
    expect(kept).toHaveLength(500);
    expect(kept[0].summary).toBe('第 120 条');
    expect(kept[499].summary).toBe('第 619 条');
  });

  it('entries() 返回副本，外部改动不影响内部缓冲', () => {
    const hub = new DiagnosticsHub({ ringSize: 2 });
    hub.push(entry(T0));
    const snapshot = hub.entries() as DiagEntry[];
    snapshot.push(entry(T0 + 1));

    expect(hub.entries()).toHaveLength(1);
  });
});

describe('DiagnosticsHub.toText（R8-3）', () => {
  it('首行固定、未连接时第二行为“未连接”、写行含地址与字段', () => {
    const hub = new DiagnosticsHub();
    hub.push({
      at: T0,
      dir: 'out',
      hex: '00 10 00 0A 20 24 00 01 43 C0',
      summary: '写 0x2024 OnOff = 1',
      level: 'info',
    });

    const text = hub.toText();
    const lines = text.split('\n');

    expect(lines[0]).toBe('# MIC STUDIO 诊断日志');
    expect(lines[1]).toBe('设备：未连接');
    expect(lines[2]).toBe(
      '统计：出帧 0 / 入帧 0 / CRC 错 0 / 超时 0 / 重试 0 / 丢弃轮询 0 / 队列 0',
    );
    expect(lines[3]).toBe('12:00:00.123  →  00 10 00 0A 20 24 00 01 43 C0   写 0x2024 OnOff = 1');
    expect(text).toContain('写 0x2024 OnOff = 1');
  });

  it('update({deviceSummary}) 后设备行显示摘要；入站行用“←”且按时间升序', () => {
    const hub = new DiagnosticsHub();
    hub.update({ deviceSummary: 'JYM001 MIC M001 / 固件 1.0.0.0 / VID 0x0A67 PID 0x0010 / SN VHID-MIC-M001' });
    hub.push({
      at: T0 + 5,
      dir: 'in',
      hex: '00 02 00 08 00 00 F8 19',
      summary: 'ACK 0x0000 成功',
      level: 'info',
    });
    hub.push({
      at: T0,
      dir: 'out',
      hex: '00 10 00 0A 20 24 00 01 43 C0',
      summary: '写 0x2024 OnOff = 1',
      level: 'info',
    });

    const lines = hub.toText().split('\n');
    expect(lines[1]).toBe(
      '设备：JYM001 MIC M001 / 固件 1.0.0.0 / VID 0x0A67 PID 0x0010 / SN VHID-MIC-M001',
    );
    expect(lines[3]).toContain('→');
    expect(lines[3]).toContain('写 0x2024 OnOff = 1');
    expect(lines[4]).toContain('←');
    expect(lines[4]).toContain('ACK 0x0000 成功');
  });

  it('统计行反映 update() 合并后的值', () => {
    const hub = new DiagnosticsHub();
    hub.update({ outFrames: 42, inFrames: 42, retries: 1, droppedPolls: 3 });

    const line = hub.toText().split('\n')[2];
    expect(line).toBe('统计：出帧 42 / 入帧 42 / CRC 错 0 / 超时 0 / 重试 1 / 丢弃轮询 3 / 队列 0');
  });
});

describe('DiagnosticsHub.update / stats / clear', () => {
  it('update() 是合并语义：先 outFrames 再 inFrames，两者都在', () => {
    const hub = new DiagnosticsHub();
    hub.update({ outFrames: 1 });
    hub.update({ inFrames: 2 });

    const stats = hub.stats();
    expect(stats.outFrames).toBe(1);
    expect(stats.inFrames).toBe(2);
    expect(stats.crcErrors).toBe(0);
    expect(stats.queueDepth).toBe(0);
  });

  it('stats() 不泄漏 deviceSummary，只含 7 个统计字段', () => {
    const hub = new DiagnosticsHub();
    hub.update({ outFrames: 1, deviceSummary: 'JYM001' });

    expect(Object.keys(hub.stats()).sort()).toEqual(
      ['crcErrors', 'droppedPolls', 'inFrames', 'outFrames', 'queueDepth', 'retries', 'timeouts'].sort(),
    );
  });

  it('clear() 后 entries() 为空、stats() 归零', () => {
    const hub = new DiagnosticsHub();
    hub.push(entry(T0));
    hub.update({ outFrames: 7, inFrames: 7 });
    hub.clear();

    expect(hub.entries()).toHaveLength(0);
    expect(hub.stats()).toEqual({
      outFrames: 0,
      inFrames: 0,
      crcErrors: 0,
      timeouts: 0,
      retries: 0,
      droppedPolls: 0,
      queueDepth: 0,
    });
  });
});

describe('DiagnosticsHub 事件', () => {
  it('push() 派发 entry 事件、update() 派发 stats 事件', () => {
    const hub = new DiagnosticsHub();
    const seenEntries: DiagEntry[] = [];
    const seenStats: number[] = [];
    hub.addEventListener(ENTRY_EVENT, (event) => {
      seenEntries.push((event as CustomEvent<DiagEntry>).detail);
    });
    hub.addEventListener(STATS_EVENT, (event) => {
      seenStats.push((event as CustomEvent<{ outFrames: number }>).detail.outFrames);
    });

    const pushed = entry(T0, '写 0x2024 OnOff = 1');
    hub.push(pushed);
    hub.update({ outFrames: 3 });

    expect(seenEntries).toHaveLength(1);
    expect(seenEntries[0]).toBe(pushed);
    expect(seenStats).toEqual([3]);
    expect(ENTRY_EVENT).toBe('entry');
    expect(STATS_EVENT).toBe('stats');
  });
});
