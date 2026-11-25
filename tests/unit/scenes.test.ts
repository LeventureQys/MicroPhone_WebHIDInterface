import { describe, expect, it } from 'vitest';
import { DEFAULT_BANDS, DEFAULT_PARAMS } from '../../src/renderer/src/domain/defaults';
import { DEFAULT_CUSTOM_GAINS } from '../../src/renderer/src/domain/quick-controls';
import { matchScene, SCENES, scenePatch } from '../../src/renderer/src/domain/scenes';

const CUSTOM_GAINS = [1, 2, 3, 4, 5, 6, 7];

function bandsFor(gains: readonly number[]) {
  return DEFAULT_BANDS.map((band) =>
    band.index < gains.length ? { ...band, gain: gains[band.index] } : { ...band },
  );
}

describe('one-tap scenes', () => {
  it('orders scenes as quiet → game → podcast → singing → custom', () => {
    expect(SCENES.map((scene) => scene.id)).toEqual([
      'quiet',
      'game',
      'podcast',
      'sing',
      'custom',
    ]);
  });

  it('maps fixed scenes to protocol fields and seven EQ gains', () => {
    for (const scene of SCENES) {
      if (scene.id === 'custom') continue;
      const patch = scenePatch(scene);
      expect(Object.keys(patch.params)).toHaveLength(7);
      expect(patch.gains).toHaveLength(7);
      // 直接写协议阈值，不再是 0..100 的抽象强度
      expect(patch.params['noisegate.threshold_db']).toBe(scene.gateThreshold);
      expect(patch.params['comp.Threshold']).toBe(scene.compThreshold);
      expect(patch.params['enc.OnOff']).toBe(scene.encOn ? 1 : 0);
      expect(patch.params['enc.Level']).toBe(scene.encLevel);
      // C-15：防爆音写使能位，绝不替用户改限幅阈值
      expect(patch.params['limit.Enable']).toBe(scene.limiterOn ? 1 : 0);
      expect(patch.params).not.toHaveProperty('limit.Threshold');
      // 参数表 V0.3：场景要把噪声门打开，否则调了阈值不生效；
      // 三分频动态按 2026-11-22 问题单第 6 条默认关闭，场景也不再打开它
      expect(patch.params['noisegate.Enable']).toBe(1);
      expect(patch.params['drc3.Enable']).toBe(0);
    }
  });

  it('drops the match when a module enable bit is switched after applying a scene', () => {
    const scene = SCENES[0];
    const patch = scenePatch(scene);
    const bands = bandsFor(patch.gains);
    const gateOff = { ...DEFAULT_PARAMS, ...patch.params, 'noisegate.Enable': 0 };
    expect(matchScene(gateOff, bands, DEFAULT_CUSTOM_GAINS)).toBeNull();
    // 三分频默认关：手动打开就不再是场景原样（问题单第 6 条）
    const drcOn = { ...DEFAULT_PARAMS, ...patch.params, 'drc3.Enable': 1 };
    expect(matchScene(drcOn, bands, DEFAULT_CUSTOM_GAINS)).toBeNull();
  });

  it('applies the saved custom curve for the custom scene', () => {
    const custom = SCENES.find((scene) => scene.id === 'custom');
    expect(custom).toBeDefined();
    const patch = scenePatch(custom!, CUSTOM_GAINS);
    expect(patch.gains).toEqual(CUSTOM_GAINS);
    expect(patch.params['noisegate.threshold_db']).toBe(-91);
    expect(patch.params['comp.Threshold']).toBe(-60);
  });

  it('recognises a fixed scene after its patch is applied', () => {
    for (const scene of SCENES) {
      if (scene.id === 'custom') continue;
      const patch = scenePatch(scene);
      const params = { ...DEFAULT_PARAMS, ...patch.params };
      expect(matchScene(params, bandsFor(patch.gains), DEFAULT_CUSTOM_GAINS)).toBe(scene.id);
    }
  });

  it('recognises the custom scene from the saved curve', () => {
    const custom = SCENES.find((scene) => scene.id === 'custom')!;
    const patch = scenePatch(custom, CUSTOM_GAINS);
    const params = { ...DEFAULT_PARAMS, ...patch.params };
    expect(matchScene(params, bandsFor(patch.gains), CUSTOM_GAINS)).toBe('custom');
  });

  it('prefers the explicitly selected tone over curve inference', () => {
    const custom = SCENES.find((scene) => scene.id === 'custom')!;
    const params = { ...DEFAULT_PARAMS, ...scenePatch(custom, DEFAULT_CUSTOM_GAINS).params };
    const flat = bandsFor(DEFAULT_CUSTOM_GAINS);
    // 自定义曲线默认全平，和「原声」是同一条；显式选择 custom 时不能退回 flat
    expect(matchScene(params, flat, DEFAULT_CUSTOM_GAINS, 'custom')).toBe('custom');
    expect(matchScene(params, flat, DEFAULT_CUSTOM_GAINS, 'flat')).toBeNull();
  });

  it('drops the match when the user tweaks a control afterwards', () => {
    const scene = SCENES[0];
    const patch = scenePatch(scene);
    const params = { ...DEFAULT_PARAMS, ...patch.params };
    const bands = bandsFor(patch.gains);
    expect(matchScene(params, bands, DEFAULT_CUSTOM_GAINS)).toBe(scene.id);

    const tweaked = { ...params, 'noisegate.threshold_db': (params['noisegate.threshold_db'] ?? 0) + 5 };
    expect(matchScene(tweaked, bands, DEFAULT_CUSTOM_GAINS)).toBeNull();
  });

  it('drops the match when the peak guard is switched off after applying a scene', () => {
    const scene = SCENES[0];
    const patch = scenePatch(scene);
    const params = { ...DEFAULT_PARAMS, ...patch.params, 'limit.Enable': 0 };
    expect(matchScene(params, bandsFor(patch.gains), DEFAULT_CUSTOM_GAINS)).toBeNull();
  });

  it('does not claim a scene for the factory defaults', () => {
    expect(matchScene(DEFAULT_PARAMS, DEFAULT_BANDS, DEFAULT_CUSTOM_GAINS)).toBeNull();
  });
});
