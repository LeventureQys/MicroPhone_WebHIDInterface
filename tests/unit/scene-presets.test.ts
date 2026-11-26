import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CUSTOM_GAINS, EQ_PRESETS } from '../../src/renderer/src/domain/quick-controls';
import {
  CUSTOM_EQ_STORAGE_KEY,
  SCENES_STORAGE_KEY,
  clearSceneOverride,
  defaultSceneGains,
  defaultSceneParams,
  forgetSceneTone,
  loadCustomEq,
  loadSceneOverrides,
  migrateSceneStorage,
  recordSceneGains,
  recordSceneParams,
  recordSceneTone,
  saveCustomEq,
  saveSceneOverrides,
  sceneGains,
  sceneParams,
  sceneTone,
} from '../../src/renderer/src/domain/scene-presets';
import { SCENES } from '../../src/renderer/src/domain/scenes';

/** 只发 setItem/getItem 的最小存储，模拟"写不进去"的隐私模式 */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe('per-scene saved values (buglist 2026-11-22 #9)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts from the factory preset of each scene', () => {
    for (const scene of SCENES) {
      const params = defaultSceneParams(scene.id);
      expect(params['noisegate.threshold_db']).toBe(scene.gateThreshold);
      expect(params['comp.Threshold']).toBe(scene.compThreshold);
      expect(params['enc.OnOff']).toBe(scene.encOn ? 1 : 0);
      expect(params['drc3.Enable']).toBe(0);
      expect(sceneParams(scene.id)).toEqual(params);
    }
  });

  it('overlays only the params the user changed', () => {
    let overrides = recordSceneParams({}, 'game', { 'comp.Threshold': -28 });
    expect(sceneParams('game', overrides)['comp.Threshold']).toBe(-28);
    // 没动过的项仍跟随出厂预设
    expect(sceneParams('game', overrides)['noisegate.threshold_db']).toBe(-41);

    overrides = recordSceneParams(overrides, 'game', { 'noisegate.threshold_db': -50 });
    expect(sceneParams('game', overrides)['comp.Threshold']).toBe(-28);
    expect(sceneParams('game', overrides)['noisegate.threshold_db']).toBe(-50);
    // 另一个场景不受影响
    expect(sceneParams('podcast', overrides)['comp.Threshold']).toBe(-42);
  });

  it('quantizes and drops junk instead of trusting storage', () => {
    const overrides = recordSceneParams({}, 'quiet', {
      // 0.3335 这种不在步进上的值要按寄存器步进量化，未知 id / 只读项直接丢掉
      'noisegate.ratio': 0.3335,
      'gain.Mic': 42,
      'nope.nope': 1,
    } as Record<string, number>);
    expect(sceneParams('quiet', overrides)['noisegate.ratio']).toBe(0.333);
    expect(sceneParams('quiet', overrides)['gain.Mic']).toBeUndefined();
  });

  it('round-trips through localStorage and ignores corrupt entries', () => {
    let overrides = recordSceneParams({}, 'sing', { 'comp.Threshold': -30 });
    overrides = recordSceneGains(overrides, 'sing', [1, 2, 3, 4, 5, 6, 7]);
    saveSceneOverrides(overrides);

    const loaded = loadSceneOverrides();
    expect(sceneParams('sing', loaded)['comp.Threshold']).toBe(-30);
    expect(sceneGains('sing', loaded)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    localStorage.setItem(SCENES_STORAGE_KEY, '{ not json');
    expect(loadSceneOverrides()).toEqual({});

    localStorage.setItem(
      SCENES_STORAGE_KEY,
      JSON.stringify({ quiet: { params: { 'comp.Threshold': 'x' } }, bogus: { params: { 'comp.Threshold': -1 } } }),
    );
    expect(loadSceneOverrides()).toEqual({});
  });

  it('clears a scene back to its factory preset', () => {
    const overrides = recordSceneParams({}, 'podcast', { 'comp.Threshold': -30 });
    const cleared = clearSceneOverride(overrides, 'podcast');
    expect(sceneParams('podcast', cleared)['comp.Threshold']).toBe(-42);
    // 没有覆盖值时返回原表（不制造新对象，调用方可以据此跳过落盘）
    expect(clearSceneOverride(cleared, 'podcast')).toBe(cleared);
  });

  it('uses the tone table for fixed scenes and the custom curve for the custom scene', () => {
    const custom = [3, 2, 1, 0, -1, -2, -3];
    expect(defaultSceneGains('quiet')).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(defaultSceneGains('custom', custom)).toEqual(custom);
    expect(defaultSceneGains('custom', DEFAULT_CUSTOM_GAINS)).toEqual([...DEFAULT_CUSTOM_GAINS]);
    // 用户改过曲线以后，场景曲线以保存值为准
    const overrides = recordSceneGains({}, 'quiet', [1, 1, 1, 1, 1, 1, 1]);
    expect(sceneGains('quiet', overrides)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('remembers a tone change inside the scene and drops stale curve overrides', () => {
    let overrides = recordSceneTone({}, 'quiet', 'bright');
    expect(sceneTone('quiet', overrides)).toBe('bright');
    expect(sceneGains('quiet', overrides)).toEqual([...EQ_PRESETS.bright]);

    // 换音色后旧曲线覆盖作废：固定音色的曲线由音色表决定
    overrides = recordSceneGains(overrides, 'quiet', [1, 1, 1, 1, 1, 1, 1]);
    expect(sceneGains('quiet', overrides)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    overrides = recordSceneTone(overrides, 'quiet', 'warm');
    expect(sceneGains('quiet', overrides)).toEqual([...EQ_PRESETS.warm]);

    // 音色回出厂时 tone / gains 一起摘掉，参数覆盖保留
    overrides = recordSceneParams(overrides, 'quiet', { 'comp.Threshold': -30 });
    overrides = forgetSceneTone(overrides, 'quiet');
    expect(sceneTone('quiet', overrides)).toBe('flat');
    expect(sceneGains('quiet', overrides)).toEqual([...EQ_PRESETS.flat]);
    expect(sceneParams('quiet', overrides)['comp.Threshold']).toBe(-30);
  });

  it('persists the custom curve and tolerates a broken file', () => {
    expect(loadCustomEq()).toBeNull();
    saveCustomEq([1.04, -2.06, 99, -99, 0, 0, 0]);
    expect(loadCustomEq()).toEqual([1, -2.1, 12, -32, 0, 0, 0]);
    localStorage.setItem(CUSTOM_EQ_STORAGE_KEY, '[1,2]');
    expect(loadCustomEq()).toBeNull();
  });

  it('keeps working when localStorage throws', () => {
    const broken: Storage = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadSceneOverrides(broken)).toEqual({});
    expect(loadCustomEq(broken)).toBeNull();
    expect(() => saveSceneOverrides(recordSceneParams({}, 'quiet', { 'comp.Threshold': -1 }), broken)).not.toThrow();
    expect(() => saveCustomEq([0, 0, 0, 0, 0, 0, 0], broken)).not.toThrow();
  });

  it('migrates scene overrides without touching the user curve', () => {
    const curve = [-3, -2, -1, 1, 3, 2, 0];
    localStorage.setItem(
      SCENES_STORAGE_KEY,
      JSON.stringify({
        custom: {
          gains: curve,
          params: { 'comp.Threshold': -30, 'mic.mute': 1 },
        },
        game: {
          gains: [1, 2, 3, 4, 5, 6, 7],
          params: { 'noisegate.threshold_db': -50 },
        },
      }),
    );
    localStorage.setItem(CUSTOM_EQ_STORAGE_KEY, JSON.stringify(curve));

    migrateSceneStorage();
    // 曲线可能是用户真拖过的：迁移不能误删
    expect(loadCustomEq()).toEqual(curve);
    const migrated = loadSceneOverrides();
    // 场景里的冗余 gains 覆盖要清掉（它让自定义场景一打开就是 dirty）
    expect(migrated.custom?.gains).toBeUndefined();
    // 旧版误记的全局开关也要丢掉（新作用域里它不属于场景）
    expect(migrated.custom?.params).toEqual({ 'comp.Threshold': -30 });
    expect(migrated.game?.params).toEqual({ 'noisegate.threshold_db': -50 });
    // 非 custom 场景的曲线覆盖更可能是用户真拖的，迁移保留
    expect(migrated.game?.gains).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // 迁移只跑一次：之后场景里新存的曲线覆盖不能被清
    const withGains = recordSceneGains(migrated, 'custom', [1, 2, 3, 4, 5, 6, 7]);
    saveSceneOverrides(withGains);
    migrateSceneStorage();
    expect(loadSceneOverrides().custom?.gains).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
