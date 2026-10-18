import type React from 'react';
import { createContext, useContext, useState } from 'react';
import type { Translations } from './locales/en';
import { en } from './locales/en';
import { zhCN } from './locales/zh-CN';

export type Lang = 'en' | 'zh-CN';

const LOCALES: Record<Lang, Translations> = { en, 'zh-CN': zhCN };

const STORAGE_KEY = 'lang';

function getInitialLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh-CN') return stored;
  } catch {
    /* ignore */
  }
  return 'en';
}

// Derive deep dot-notation keys from Translations
type DeepKeys<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? P extends ''
      ? K
      : `${P}.${K}`
    : DeepKeys<T[K], P extends '' ? K : `${P}.${K}`>;
}[keyof T & string];

export type TranslationKey = DeepKeys<Translations>;

export type TFunction = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

function resolve(obj: unknown, path: string): string {
  const parts = path.split('.');
  let curr = obj;
  for (const p of parts) {
    if (curr == null || typeof curr !== 'object') return path;
    curr = (curr as Record<string, unknown>)[p];
  }
  return typeof curr === 'string' ? curr : path;
}

interface I18nContextType {
  lang: Lang;
  setLang: (l: Lang) => void;
}

const I18nContext = createContext<I18nContextType | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(getInitialLang);

  const setLang = (l: Lang) => {
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
    setLangState(l);
  };

  return (
    <I18nContext.Provider value={{ lang, setLang }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useTranslation must be used inside I18nProvider');
  const { lang, setLang } = ctx;
  const locale = LOCALES[lang];

  function t(
    key: TranslationKey,
    params?: Record<string, string | number>,
  ): string {
    let text = resolve(locale, key);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{{${k}}}`, String(v));
      }
    }
    return text;
  }

  return { t, lang, setLang };
}
