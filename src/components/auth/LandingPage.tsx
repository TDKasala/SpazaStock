import React, { useRef, useState } from 'react';
import { BellRing, ChevronLeft, Package, RefreshCw, ScanBarcode, Users } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { Button } from '../ui/Button';
import { LanguagePicker } from '../ui/LanguagePicker';
import { ErrorMessage } from '../ui/ErrorMessage';
import { SignInPanel, type PanelFrame, type SignInView } from './SignInScreen';
import { PWAInstallBanner } from '../pwa/PWAInstallBanner';
import { AppInviteShareSection } from '../pwa/AppInviteShareSection';
import { usePWAInstall } from '../../hooks/usePWAInstall';

interface LandingPageProps {
  /** The build has no Supabase settings, so nobody can sign in or register. */
  notConfigured?: boolean;
}

const FEATURES = [
  { icon: ScanBarcode, key: 'scan' },
  { icon: BellRing, key: 'expiry' },
  { icon: RefreshCw, key: 'offline' },
  { icon: Users, key: 'team' },
] as const;

export const LandingPage: React.FC<LandingPageProps> = ({ notConfigured = false }) => {
  const { t } = useLanguage();
  const { needsInstallPrompt } = usePWAInstall();
  const [view, setView] = useState<SignInView>('password');
  const [authPanelOpen, setAuthPanelOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const openAuthPanel = (next: SignInView) => {
    setView(next);
    setAuthPanelOpen(true);
    window.requestAnimationFrame(() => {
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const frame = ({ title, subtitle, children }: PanelFrame) => (
    <>
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setAuthPanelOpen(false)}
          className="shrink-0 w-9 h-9 -ml-1 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          aria-label={t('landing.backToOverview')}
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-zinc-100">{title ?? t('auth.signIn')}</h2>
          {subtitle && <p className="text-xs text-zinc-400 mt-1 leading-relaxed">{subtitle}</p>}
        </div>
      </div>
      {children}
    </>
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <header className="w-full max-w-5xl mx-auto px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center shadow-lg shadow-emerald-950/50">
            <Package className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-lg">{t('common.appName')}</span>
        </div>
        <LanguagePicker />
      </header>

      <main
        className={`flex-1 w-full max-w-5xl mx-auto px-5 pt-4 md:pt-12 grid gap-10 md:items-start ${
          authPanelOpen && !notConfigured ? 'md:grid-cols-2' : 'max-w-3xl'
        } ${needsInstallPrompt ? 'pb-44' : 'pb-10'}`}
      >
        <section className="space-y-6">
          <div className="space-y-3">
            <h1 className="text-3xl md:text-4xl font-extrabold leading-tight">{t('landing.headline')}</h1>
            <p className="text-sm md:text-base text-zinc-400 leading-relaxed">{t('landing.intro')}</p>
          </div>

          {notConfigured ? (
            <ErrorMessage
              variant="warning"
              title={t('landing.notConfiguredTitle')}
              message={t('landing.notConfiguredBody')}
            />
          ) : (
            <>
              {!authPanelOpen && (
                <div className="flex flex-col sm:flex-row gap-3">
                  <Button size="lg" onClick={() => openAuthPanel('register')}>
                    {t('landing.createAccount')}
                  </Button>
                  <Button size="lg" variant="outline" onClick={() => openAuthPanel('password')}>
                    {t('landing.haveAccount')}
                  </Button>
                </div>
              )}
              <div className="p-4 rounded-2xl border border-[#25D366]/30 bg-[#25D366]/5">
                <AppInviteShareSection />
              </div>
            </>
          )}

          <ul className="grid gap-3 sm:grid-cols-2">
            {FEATURES.map(({ icon: Icon, key }) => (
              <li key={key} className="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800 flex gap-3">
                <Icon className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold">{t(`landing.features.${key}.title`)}</p>
                  <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed">{t(`landing.features.${key}.body`)}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {authPanelOpen && !notConfigured && (
          <div
            ref={cardRef}
            className="scroll-mt-4 p-5 bg-zinc-900 border border-zinc-800 rounded-2xl space-y-4 md:sticky md:top-6"
          >
            <SignInPanel view={view} onViewChange={setView} frame={frame} />
          </div>
        )}
      </main>

      <PWAInstallBanner aboveBottomNav={false} />

      <footer className="w-full max-w-5xl mx-auto px-5 py-6 text-center text-xs text-zinc-600">
        {t('landing.footer')}
      </footer>
    </div>
  );
};
