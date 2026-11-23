import React from 'react';
import { Package } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { LanguagePicker } from '../ui/LanguagePicker';

interface AuthLayoutProps {
  title?: string;
  subtitle?: string;
  /** Shown above the card, e.g. the invite being accepted. */
  banner?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export const AuthLayout: React.FC<AuthLayoutProps> = ({ title, subtitle, banner, children, footer }) => {
  const { t } = useLanguage();
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm sm:max-w-md space-y-6">
        <div className="flex flex-col items-center text-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center shadow-lg shadow-emerald-950/50">
            <Package className="w-7 h-7 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold">{title ?? t('common.appName')}</h1>
            {subtitle && <p className="text-xs text-zinc-400 mt-1 leading-relaxed">{subtitle}</p>}
          </div>
        </div>

        {banner}

        <div className="p-5 bg-zinc-900 border border-zinc-800 rounded-2xl space-y-4">{children}</div>

        {footer}

        <div className="flex justify-center">
          <LanguagePicker />
        </div>
      </div>
    </div>
  );
};

export const LinkButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className = '', ...props }) => (
  <button
    type="button"
    className={`w-full text-xs text-zinc-400 hover:text-zinc-200 inline-flex items-center justify-center gap-1 py-1 ${className}`}
    {...props}
  />
);
