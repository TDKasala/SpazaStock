import React, { createContext, useContext, useEffect, useState } from 'react';
import { detectLocale, isLocale, type Locale } from '../lib/languages';
import { en, Translations } from '../locales/en';
import { zu } from '../locales/zu';
import { am } from '../locales/am';
import { so } from '../locales/so';
import { bn } from '../locales/bn';

const STORAGE_KEY = 'spazastock_locale';

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

const dictionaries: Record<Locale, Translations> = { en, zu, am, so, bn };

/** The saved choice, else the phone's language when the app supports it, else English. */
function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // Storage unavailable (private mode); fall through.
  }
  if (typeof navigator === 'undefined') return 'en';
  return detectLocale(navigator.languages?.length ? navigator.languages : [navigator.language ?? 'en']);
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = (newLocale: Locale) => {
    setLocaleState(newLocale);
    try {
      localStorage.setItem(STORAGE_KEY, newLocale);
    } catch {
      // Not remembered across visits, but the switch still applies now.
    }
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
