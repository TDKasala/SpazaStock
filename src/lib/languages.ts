/** The app's languages, each named in its own language so speakers can find it from any screen. */
export const LANGUAGES = [
  { code: 'en', name: 'English', intl: 'en-ZA' },
  { code: 'zu', name: 'isiZulu', intl: 'zu-ZA' },
  { code: 'am', name: 'አማርኛ', intl: 'am-ET' },
  { code: 'so', name: 'Soomaali', intl: 'so-SO' },
  { code: 'bn', name: 'বাংলা', intl: 'bn-BD' },
] as const;

export type Locale = (typeof LANGUAGES)[number]['code'];

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return LANGUAGES.some((l) => l.code === value);
}

/** The first supported language in the browser's preference list ('so-SO' -> 'so'), else English. */
export function detectLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/** BCP 47 tag for dates and numbers, e.g. 'am-ET'. */
export function intlTag(locale: Locale): string {
  return LANGUAGES.find((l) => l.code === locale)?.intl ?? 'en-ZA';
}
