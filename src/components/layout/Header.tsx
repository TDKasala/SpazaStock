import React from 'react';
import { Package, Globe, Database } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { PWAInstallButton } from '../pwa/PWAInstallButton';
import { isSupabaseConfigured } from '../../lib/supabase';

export interface HeaderProps {
  onOpenSetupGuide: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenSetupGuide }) => {
  const { locale, setLocale, t } = useLanguage();
  const isDbConfigured = isSupabaseConfigured();

  const toggleLanguage = () => {
    setLocale(locale === 'en' ? 'zu' : 'en');
  };

  return (
    <header className="sticky top-0 z-40 w-full bg-zinc-950/80 backdrop-blur-md border-b border-zinc-800/80 pt-[env(safe-area-inset-top,0px)]">
      <div className="max-w-md sm:max-w-xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
        {/* Brand */}
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center text-white shadow-md shadow-emerald-950/50">
            <Package className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h1 className="text-base font-bold text-zinc-100 tracking-tight leading-none">
                {t('common.appName')}
              </h1>
              <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                PWA
              </span>
            </div>
            <p className="text-[11px] text-zinc-400 leading-none mt-1 hidden xs:block">
              {t('common.tagline')}
            </p>
          </div>
        </div>

        {/* Header Right Actions */}
        <div className="flex items-center gap-2">
          {/* Supabase status badge */}
          <button
            onClick={onOpenSetupGuide}
            title={isDbConfigured ? t('common.connected') : t('common.unconfigured')}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              isDbConfigured
                ? 'bg-emerald-950/40 text-emerald-400 border-emerald-800/60 hover:bg-emerald-900/50'
                : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:border-amber-600/60 hover:text-amber-400'
            }`}
          >
            <Database className={`w-3.5 h-3.5 ${isDbConfigured ? 'text-emerald-400' : 'text-zinc-500'}`} />
            <span className="hidden sm:inline">
              {isDbConfigured ? t('common.connected') : 'DB Setup'}
            </span>
          </button>

          {/* Language Switcher */}
          <button
            onClick={toggleLanguage}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-200 hover:text-white transition-colors cursor-pointer"
            aria-label={`Switch to ${locale === 'en' ? 'isiZulu' : 'English'}`}
          >
            <Globe className="w-3.5 h-3.5 text-emerald-400" />
            <span>{locale === 'en' ? 'ZU' : 'EN'}</span>
          </button>

          {/* PWA Install Button */}
          <PWAInstallButton compact />
        </div>
      </div>
    </header>
  );
};
