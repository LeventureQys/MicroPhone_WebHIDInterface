import { describe, expect, it, vi } from 'vitest';
import { PARAMS } from '../../src/renderer/src/domain/params';
import { currentLang, detectLang, onLangChange, setLang, t } from '../../src/renderer/src/i18n';
import { en } from '../../src/renderer/src/i18n/en';
import { zh } from '../../src/renderer/src/i18n/zh';

const zhDict: Record<string, string> = { ...zh };
const enDict: Record<string, string> = { ...en };

describe('i18n dictionaries', () => {
  it('keeps zh and en key sets identical', () => {
    const zhKeys = Object.keys(zhDict).sort();
    const enKeys = Object.keys(enDict).sort();
    expect(enKeys.length).toBe(zhKeys.length);
    expect(enKeys).toEqual(zhKeys);
  });

  it('labels every scalar parameter in both languages', () => {
    expect(PARAMS).toHaveLength(36);
    for (const spec of PARAMS) {
      const key = `param.${spec.id}.label`;
      expect(zhDict, `zh missing ${key}`).toHaveProperty(key);
      expect(enDict, `en missing ${key}`).toHaveProperty(key);
      expect(zhDict[key]).not.toBe('');
      expect(enDict[key]).not.toBe('');
    }
    const labels = Object.keys(zhDict).filter((key) => /^param\..+\.label$/.test(key));
    expect(labels).toHaveLength(36);
  });

  it('covers every unit and nav entry used by the UI', () => {
    for (const spec of PARAMS) {
      if (!spec.unit) continue;
      expect(zhDict, `zh missing common.unit.${spec.unit}`).toHaveProperty(`common.unit.${spec.unit}`);
      expect(enDict).toHaveProperty(`common.unit.${spec.unit}`);
    }
    expect(Object.keys(zhDict).filter((key) => key.startsWith('nav.'))).toHaveLength(7);
    for (let type = 0; type <= 4; type += 1) {
      expect(zhDict).toHaveProperty(`eq.type.${type}`);
      expect(enDict).toHaveProperty(`eq.type.${type}`);
    }
  });

  it('falls back to the key and warns only once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(t('not.exist.key')).toBe('not.exist.key');
    expect(t('not.exist.key')).toBe('not.exist.key');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('detects the language from the navigator language tag', () => {
    expect(detectLang({ language: 'zh-CN' })).toBe('zh');
    expect(detectLang({ language: 'zh' })).toBe('zh');
    expect(detectLang({ language: 'en-US' })).toBe('en');
    expect(detectLang({ language: 'ja-JP' })).toBe('en');
  });

  it('switches language, persists it and notifies subscribers', () => {
    const seen: string[] = [];
    const off = onLangChange((lang) => seen.push(lang));

    setLang('zh');
    const before = t('nav.eq');
    setLang('en');
    const after = t('nav.eq');

    expect(after).not.toBe(before);
    expect(currentLang()).toBe('en');
    expect(localStorage.getItem('micstudio.lang')).toBe('en');
    expect(seen).toEqual(['zh', 'en']);

    off();
    setLang('zh');
    expect(seen).toEqual(['zh', 'en']);
    expect(localStorage.getItem('micstudio.lang')).toBe('zh');
  });

  it('leaves plain values untouched when vars are passed', () => {
    setLang('zh');
    expect(t('topbar.synced', { ignored: 1 })).toBe(zhDict['topbar.synced']);
    expect(t('common.writes')).toBe(zhDict['common.writes']);
  });
});
