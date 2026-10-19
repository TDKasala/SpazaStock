import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, ScanBarcode } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';

export interface ScanInputProps {
  onScan: (code: string) => void;
  autoFocus?: boolean;
  className?: string;
  /** Optional label above the field. */
  label?: string;
  /** Placeholder text inside the field. */
  placeholder?: string;
}

/**
 * A hidden-on-screen scan field optimised for hardware (HID) barcode scanners:
 * - inputmode="none" keeps the Android keyboard hidden
 * - Enter completes the scan
 * - auto-refocuses after each scan so the next one lands immediately
 * - has a keyboard toggle for manual entry when needed
 */
export const ScanInput: React.FC<ScanInputProps> = ({ onScan, autoFocus = true, className = '', label, placeholder }) => {
  const { t } = useLanguage();
  const [manual, setManual] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [autoFocus]);

  const submit = () => {
    const code = value.trim();
    if (!code) return;
    onScan(code);
    setValue('');
    // Keep focus for the next scan
    window.setTimeout(() => inputRef.current?.focus(), 10);
  };

  return (
    <div className={className}>
      {label && <label htmlFor="scan-input" className="text-xs font-semibold text-zinc-300 block mb-1">{label}</label>}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <ScanBarcode className="w-4 h-4 text-emerald-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            id="scan-input"
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            // Hide the soft keyboard unless the user toggles it on.
            inputMode={manual ? 'text' : 'none'}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full h-11 pl-9 pr-3 bg-zinc-900 border border-zinc-800 rounded-xl text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
            placeholder={placeholder ?? t('scanner.manualEntryPlaceholder')}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            setManual((v) => !v);
            // Slight delay so attribute takes effect before refocus.
            window.setTimeout(() => inputRef.current?.focus(), 30);
          }}
          className={`shrink-0 min-w-[44px] h-11 px-3 rounded-xl border text-xs font-semibold inline-flex items-center gap-1 ${
            manual
              ? 'bg-emerald-600 text-white border-emerald-500'
              : 'bg-zinc-900 text-zinc-200 border-zinc-800 hover:bg-zinc-800'
          }`}
          aria-pressed={manual}
          title={manual ? t('scanner.manualTab') : t('scanner.manualEntryTitle')}
        >
          <Keyboard className="w-4 h-4" />
          <span className="hidden sm:inline">{t('scanner.manualTab')}</span>
        </button>
      </div>
    </div>
  );
};

