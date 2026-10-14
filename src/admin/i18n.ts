import { useCallback } from 'react';
import { interpolate, useLanguage, type TranslateVars } from '../context/LanguageContext';
import { adminEn, type AdminTranslations } from './locales/en';
import { adminZu } from './locales/zu';

/** The admin area is translated into English and isiZulu; other shop languages fall back to English. */
export type AdminLocale = 'en' | 'zu';

const dictionaries: Record<AdminLocale, AdminTranslations> = { en: adminEn, zu: adminZu };

export function adminLocale(locale: string): AdminLocale {
  return locale === 'zu' ? 'zu' : 'en';
}

function lookup(source: unknown, key: string): string | undefined {
  let current: unknown = source;
  for (const part of key.split('.')) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}

/** Falls back to English, then to the key itself. */
export function translateAdmin(locale: AdminLocale, key: string, vars?: TranslateVars): string {
  return interpolate(lookup(dictionaries[locale], key) ?? lookup(adminEn, key) ?? key, vars);
}

export function hasAdminKey(key: string): boolean {
  return lookup(adminEn, key) !== undefined;
}

export type AdminTranslate = (key: string, vars?: TranslateVars) => string;

export function useAdminI18n() {
  const { locale, setLocale } = useLanguage();
  const current = adminLocale(locale);
  const at: AdminTranslate = useCallback((key, vars) => translateAdmin(current, key, vars), [current]);
  /** Translates a value from the database (a status, reason or kind), showing it raw when unknown. */
  const label = useCallback(
    (group: string, value: string | null | undefined) => {
      if (value === null || value === undefined || value === '') return translateAdmin(current, 'common.none');
      const key = `${group}.${value.replace(/\./g, '_')}`;
      return hasAdminKey(key) ? translateAdmin(current, key) : value;
    },
    [current]
  );
  return { at, label, locale: current, setLocale };
}
