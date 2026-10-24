import { describe, expect, it } from 'vitest';

import { ACTIONS, FaultTable, parseFaults, REPLY_ACTIONS } from '../../../tools/vdevice/faults.mjs';

const APP_READ = { mode: 'app', func: 0x12 };
const APP_WRITE = { mode: 'app', func: 0x10 };
const DFU_BLOCK = { mode: 'bootloader', dfuCmd: 0x03, phase: 'block' };
const DFU_INFO = { mode: 'bootloader', dfuCmd: 0x02, phase: 'info' };

describe('故障规则表（SubStage 2.2 / R7-4）', () => {
  it('1. drop：{func:18, nth:1} 只吃掉第一次读', () => {
    const table = new FaultTable([{ on: { func: 0x12, nth: 1 }, action: 'drop' }]);
    const first = table.match(APP_READ);
    expect(first?.action).toBe('drop');
    expect(table.consume(first!)).toBe(true);
    expect(table.match(APP_READ)).toBeNull();
    expect(table.match(APP_WRITE)).toBeNull();
    expect(table.fired()).toBe(1);
  });

  it('2. delay：命中带 ms，times:1 用尽后不再匹配', () => {
    const table = new FaultTable([{ on: { func: 0x12 }, action: 'delay', ms: 200 }]);
    const hit = table.match(APP_READ);
    expect(hit).toMatchObject({ action: 'delay', ms: 200 });
    table.consume(hit!);
    expect(table.match(APP_READ)).toBeNull();
  });

  it('3. dropAck / crcError / ackError / powerLoss / disconnect / sticky 各一条', () => {
    const dropAck = new FaultTable([{ on: { func: 0x12 }, action: 'dropAck' }]);
    expect(dropAck.match(APP_READ)?.action).toBe('dropAck');

    const crcError = new FaultTable([{ action: 'crcError' }]);
    expect(crcError.match(APP_READ)?.action).toBe('crcError');
    expect(crcError.match(DFU_BLOCK)?.action).toBe('crcError');

    const ackError = new FaultTable([{ on: { func: 0x12 }, action: 'ackError', code: 5 }]);
    const ackHit = ackError.match(APP_READ);
    expect(ackHit).toMatchObject({ action: 'ackError', code: 5 });

    const powerLoss = new FaultTable([{ on: { mode: 'bootloader', dfuCmd: 0x03 }, action: 'powerLoss' }]);
    expect(powerLoss.match(DFU_BLOCK)?.action).toBe('powerLoss');
    expect(powerLoss.match(APP_READ)).toBeNull();
    expect(powerLoss.match(DFU_INFO)).toBeNull();

    const disconnect = new FaultTable([{ on: { func: 0x13 }, action: 'disconnect', ms: 300 }]);
    const disconnectHit = disconnect.match({ mode: 'app', func: 0x13 });
    expect(disconnectHit).toMatchObject({ action: 'disconnect', ms: 300 });

    const sticky = new FaultTable([{ on: { func: 0x12 }, action: 'sticky' }]);
    expect(sticky.match(APP_READ)?.action).toBe('sticky');
    expect(sticky.match(APP_WRITE)).toBeNull();
  });

  it('4. 九类动作齐全且 parseFaults 拒绝非法配置', () => {
    expect([...ACTIONS].sort()).toEqual(
      ['ackError', 'crcError', 'delay', 'disconnect', 'drop', 'dropAck', 'powerLoss', 'statusFail', 'sticky'].sort(),
    );
    expect(ACTIONS).toHaveLength(9);
    expect(() => parseFaults([{ action: 'explode' }])).toThrow(/unknown|action/);
    expect(() => parseFaults([{ action: 'ackError' }])).toThrow(/code is required/);
    expect(() => parseFaults([{ action: 'ackError', code: 6 }])).toThrow(/0\.\.5/);
    expect(() => parseFaults([{ action: 'drop', on: { nth: 0 } }])).toThrow(/nth/);
    expect(() => parseFaults('nope')).toThrow(/array/);
    expect(() => new FaultTable([{ on: { mode: 'dfu' }, action: 'drop' }])).toThrow(/mode/);
    expect(parseFaults([{ on: { func: 18 }, action: 'drop' }])[0].on).toMatchObject({ mode: 'any', phase: 'any', func: 18 });
    // statusFail 与其它改回执的动作一样走"帧上消费"，不需要额外参数
    expect(parseFaults([{ on: { mode: 'bootloader', dfuCmd: 3, phase: 'block', nth: 5 }, action: 'statusFail' }])[0]).toMatchObject({
      action: 'statusFail',
      times: 1,
    });
    expect(REPLY_ACTIONS).toEqual(expect.arrayContaining(['statusFail']));
  });

  it('7. statusFail：只在 bootloader 块帧上命中，一次用尽（R6-7）', () => {
    const table = new FaultTable([
      { on: { mode: 'bootloader', dfuCmd: 0x03, phase: 'block', nth: 5 }, action: 'statusFail', times: 1 },
    ]);
    for (let attempt = 1; attempt <= 4; attempt += 1) expect(table.match(DFU_BLOCK)).toBeNull();
    const hit = table.match(DFU_BLOCK);
    expect(hit).toMatchObject({ action: 'statusFail' });
    expect(table.consume(hit!)).toBe(true);
    expect(table.match(DFU_BLOCK)).toBeNull();
    expect(table.match(DFU_INFO)).toBeNull();
    expect(table.match(APP_READ)).toBeNull();
    expect(table.fired()).toBe(1);
  });

  it('5. nth 计数：{nth:3, times:2} 只在第 3、4 次命中', () => {
    const table = new FaultTable([{ on: { nth: 3 }, action: 'dropAck', times: 2 }]);
    const hits: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const hit = table.match(APP_READ);
      if (!hit) continue;
      hits.push(attempt);
      table.consume(hit);
    }
    expect(hits).toEqual([3, 4]);
    expect(table.fired()).toBe(2);
  });

  it('6. 规则顺序：两条同时匹配取第一条，reset 后计数清零', () => {
    const table = new FaultTable([
      { on: { func: 0x12 }, action: 'drop' },
      { on: { func: 0x12 }, action: 'crcError' },
    ]);
    expect(table.size()).toBe(2);
    const hit = table.match(APP_READ);
    expect(hit?.action).toBe('drop');
    table.consume(hit!);
    expect(table.fired()).toBe(1);
    table.reset();
    expect(table.fired()).toBe(0);
    expect(table.match(APP_READ)?.action).toBe('drop');
  });
});
