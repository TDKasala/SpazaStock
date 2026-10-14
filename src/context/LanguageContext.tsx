import React, { createContext, useContext, useEffect, useState } from 'react';
import { Locale } from '../types';
import { en, Translations } from '../locales/en';
import { zu } from '../locales/zu';

export type TranslateVars = Record<string, string | number>;

interface LanguageContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: TranslateVars) => string;
  dict: Translations;
}

function lookup(source: unknown, parts: string[]): string | undefined {
  let current: unknown = source;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}

export function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  );
}

const dictionaries: Record<Locale, Translations> = {
  en,
  zu,
};

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const saved = localStorage.getItem('spazastock_locale') as Locale;
    return saved === 'zu' || saved === 'en' ? saved : 'en';
  });

  const setLocale = (newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem('spazastock_locale', newLocale);
  };

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const dict = dictionaries[locale];

  // Dot-notated key lookup with fallback to English, then to the key itself.
  const t = (key: string, vars?: TranslateVars): string => {
    const parts = key.split('.');
    return interpolate(lookup(dict, parts) ?? lookup(en, parts) ?? key, vars);
  };

  return (
    <LanguageContext.Provider value={{ locale, setLocale, t, dict }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = (): LanguageContextType => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
};
