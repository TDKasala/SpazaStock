/** The app's languages, each named in its own language so speakers can find it from any screen. */
export const LANGUAGES = [
  { code: 'en', name: 'English', pickerLabel: 'English', intl: 'en-ZA' },
  { code: 'zu', name: 'isiZulu', pickerLabel: 'isiZulu', intl: 'zu-ZA' },
  { code: 'am', name: 'አማርኛ', pickerLabel: 'አማርኛ', intl: 'am-ET' },
  { code: 'so', name: 'Soomaali', pickerLabel: 'Soomaali', intl: 'so-SO' },
  // Bangladesh Standard Bangla (bn-BD); pickerLabel is Latin so the option is visible without Bengali system fonts.
  {
    code: 'bn',
    name: 'বাংলা (বাংলাদেশ)',
    pickerLabel: 'Bangla (Bangladesh)',
    intl: 'bn-BD',
  },
] as const;

export type Locale = (typeof LANGUAGES)[number]['code'];

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return LANGUAGES.some((l) => l.code === value);
}

/** The first supported language in the browser's preference list ('so-SO' -> 'so'), else English. */
export function detectLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const parts = tag.toLowerCase().split(/[-_]/);
    const base = parts[0];
    if (base === 'bn') {
      const region = parts[1];
      // Only Bangladesh Bangla; skip Indian Bengali (bn-IN) in the phone's list.
      if (region && region !== 'bd') continue;
      return 'bn';
    }
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/** BCP 47 tag for dates and numbers, e.g. 'am-ET'. */
export function intlTag(locale: Locale): string {
  return LANGUAGES.find((l) => l.code === locale)?.intl ?? 'en-ZA';
}
