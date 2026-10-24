import { describe, expect, it } from 'vitest';
import { DEFAULT_BANDS, DEFAULT_PARAMS } from '../../src/renderer/src/domain/defaults';
import { matchScene, SCENES, scenePatch } from '../../src/renderer/src/domain/scenes';

describe('one-tap scenes', () => {
  it('maps every scene to protocol fields and seven EQ gains', () => {
    for (const scene of SCENES) {
      const patch = scenePatch(scene);
      expect(Object.keys(patch.params)).toHaveLength(5);
      expect(patch.gains).toHaveLength(7);
      expect(patch.params['enc.OnOff']).toBe(scene.encOn ? 1 : 0);
      expect(patch.params['enc.Level']).toBe(scene.encLevel);
      // C-15：防爆音写使能位，绝不替用户改限幅阈值
      expect(patch.params['limit.Enable']).toBe(scene.limiterOn ? 1 : 0);
      expect(patch.params).not.toHaveProperty('limit.Threshold');
    }
  });

  it('recognises the scene after its patch is applied', () => {
    for (const scene of SCENES) {
      const patch = scenePatch(scene);
      const params = { ...DEFAULT_PARAMS, ...patch.params };
      const bands = DEFAULT_BANDS.map((band) =>
        band.index < patch.gains.length ? { ...band, gain: patch.gains[band.index] } : { ...band },
      );
      expect(matchScene(params, bands)).toBe(scene.id);
    }
  });

  it('drops the match when the user tweaks a control afterwards', () => {
    const scene = SCENES[0];
    const patch = scenePatch(scene);
    const params = { ...DEFAULT_PARAMS, ...patch.params };
    const bands = DEFAULT_BANDS.map((band) =>
      band.index < patch.gains.length ? { ...band, gain: patch.gains[band.index] } : { ...band },
    );
    expect(matchScene(params, bands)).toBe(scene.id);

    const tweaked = { ...params, 'noisegate.threshold_db': (params['noisegate.threshold_db'] ?? 0) + 5 };
    expect(matchScene(tweaked, bands)).toBeNull();
  });

  it('drops the match when the peak guard is switched off after applying a scene', () => {
    // 场景全部 limiterOn=true；把 limit.Enable 关掉后不该再claim同一个场景
    const scene = SCENES[0];
    const patch = scenePatch(scene);
    const params = { ...DEFAULT_PARAMS, ...patch.params, 'limit.Enable': 0 };
    const bands = DEFAULT_BANDS.map((band) =>
      band.index < patch.gains.length ? { ...band, gain: patch.gains[band.index] } : { ...band },
    );
    expect(matchScene(params, bands)).toBeNull();
  });

  it('does not claim a scene for the factory defaults', () => {
    expect(matchScene(DEFAULT_PARAMS, DEFAULT_BANDS)).toBeNull();
  });
});
