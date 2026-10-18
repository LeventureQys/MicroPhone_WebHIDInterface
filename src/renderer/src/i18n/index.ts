import { DEFAULT_LANG } from '../domain/defaults';
import { en } from './en';
import { zh } from './zh';

export type Lang = 'zh' | 'en';

const STORAGE_KEY = 'micstudio.lang';
const DICTS: Record<Lang, Record<string, string>> = { zh, en };

const listeners = new Set<(lang: Lang) => void>();
/** 缺失 key 只 warn 一次，避免 50Hz 渲染循环刷屏 */
const warned = new Set<string>();

export function detectLang(nav: { language: string }): Lang {
  return nav.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function isLang(value: string | null | undefined): value is Lang {
  return value === 'zh' || value === 'en';
}

function readStoredLang(): Lang | null {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isLang(stored) ? stored : null;
  } catch {
    // 存储被禁用（隐私模式 / 沙箱）时退回浏览器语言
    return null;
  }
}

function detectInitialLang(): Lang {
  const stored = readStoredLang();
  if (stored) return stored;
  if (typeof navigator === 'undefined' || !navigator.language) return DEFAULT_LANG;
  return detectLang(navigator);
}

let lang: Lang = detectInitialLang();

export function currentLang(): Lang {
  return lang;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const text = DICTS[lang][key];
  if (text === undefined) {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] missing key: ${key}`);
    }
    return key;
  }
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match: string, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

export function setLang(next: Lang): void {
  lang = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    // 写入失败不影响本次会话的语言切换
  }
  for (const cb of [...listeners]) cb(next);
}

export function onLangChange(cb: (lang: Lang) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
