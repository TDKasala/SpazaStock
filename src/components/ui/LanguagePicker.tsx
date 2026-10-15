import React from 'react';
import { ChevronDown, Globe } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { isLocale, LANGUAGES } from '../../lib/languages';

interface LanguagePickerProps {
  /** Header style: shows the language code (EN, ZU, AM, SO, BN) instead of the full name. */
  compact?: boolean;
  className?: string;
}

/**
 * A native select over a styled label, so phones show their own picker and screen readers
 * announce it as a list. Each language is listed by its own name.
 */
export const LanguagePicker: React.FC<LanguagePickerProps> = ({ compact = false, className = '' }) => {
  const { locale, setLocale, t } = useLanguage();
  const current = LANGUAGES.find((l) => l.code === locale) ?? LANGUAGES[0];

  return (
    <label
      className={`relative inline-flex items-center gap-1.5 rounded-lg text-xs cursor-pointer focus-within:ring-2 focus-within:ring-emerald-500 ${
        compact
          ? 'px-2.5 py-1.5 font-semibold bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-200'
          : 'px-2 py-1.5 text-zinc-400 hover:text-zinc-200'
      } ${className}`}
    >
      <Globe className={`w-3.5 h-3.5 ${compact ? 'text-emerald-400' : ''}`} />
      <span aria-hidden="true">{compact ? current.code.toUpperCase() : current.name}</span>
      {!compact && <ChevronDown className="w-3 h-3" />}
      <select
        value={locale}
        onChange={(e) => {
          if (isLocale(e.target.value)) setLocale(e.target.value);
        }}
        aria-label={t('common.language')}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
};
