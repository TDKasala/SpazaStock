import React, { useRef, useState } from 'react';
import { ArrowRight, BellRing, ChevronLeft, Cloud, Package, ScanBarcode, TrendingUp, User, UserPlus, Users } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { Button } from '../ui/Button';
import { LanguagePicker } from '../ui/LanguagePicker';
import { ErrorMessage } from '../ui/ErrorMessage';
import { SignInPanel, type PanelFrame, type SignInView } from './SignInScreen';
import { PWAInstallBanner } from '../pwa/PWAInstallBanner';
import { AppWhatsAppInvite } from '../pwa/AppWhatsAppInvite';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import { takeIdleSignOutNotice } from '../../lib/idleSignOut';
import { FeatureGlyph, HeroIllustration, LandingMark, type FeatureArtKind } from './LandingArt';

interface LandingPageProps {
  /** The build has no Supabase settings, so nobody can sign in or register. */
  notConfigured?: boolean;
}

const FEATURES: ReadonlyArray<{ icon: React.FC<{ className?: string }>; key: FeatureArtKind }> = [
  { icon: ScanBarcode, key: 'scan' },
  { icon: BellRing, key: 'expiry' },
  { icon: Package, key: 'stock' },
  { icon: Cloud, key: 'offline' },
  { icon: Users, key: 'team' },
  { icon: TrendingUp, key: 'grow' },
];

/** Paints the accent phrase inside the headline green. Falls back to the whole sentence. */
function AccentHeadline({ text, accent }: { text: string; accent: string }) {
  const index = accent ? text.indexOf(accent) : -1;
  if (index < 0) return <>{text}</>;
  const before = text.slice(0, index).trimEnd();
  const after = text.slice(index + accent.length);
  return (
    <>
      {before}
      {before && <br />}
      <span className="text-emerald-400">{accent}</span>
      {after}
    </>
  );
}

export const LandingPage: React.FC<LandingPageProps> = ({ notConfigured = false }) => {
  const { t } = useLanguage();
  const { needsInstallPrompt } = usePWAInstall();
  const [idleNotice] = useState(takeIdleSignOutNotice);
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
      <header className="w-full max-w-6xl mx-auto px-5 py-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <LandingMark className="w-9 h-9 shrink-0" />
          <div className="min-w-0">
            <span className="font-bold text-lg leading-tight block">{t('common.appName')}</span>
            <span className="text-[11px] text-zinc-400 leading-tight block truncate">{t('landing.tagline')}</span>
          </div>
        </div>
        <LanguagePicker pill className="shrink-0" />
      </header>

      <main className={`flex-1 w-full max-w-6xl mx-auto px-5 ${needsInstallPrompt ? 'pb-44' : 'pb-6'}`}>
        <section className="flex flex-col gap-8 pt-2 md:pt-6 lg:grid lg:grid-cols-2 lg:items-center lg:gap-x-12 lg:gap-y-6">
          <div className="order-1 space-y-4 lg:col-start-1 lg:row-start-1">
            <p className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-300">
              {t('landing.badge')}
            </p>
            <h1 className="text-4xl sm:text-5xl font-extrabold leading-[1.08] tracking-tight">
              <AccentHeadline text={t('landing.headline')} accent={t('landing.headlineAccent')} />
            </h1>
            <p className="text-sm sm:text-base text-zinc-400 leading-relaxed max-w-xl">{t('landing.intro')}</p>
          </div>

          <div className="order-2 lg:col-start-2 lg:row-start-1 lg:row-span-2">
            <HeroIllustration />
          </div>

          <div className="order-3 space-y-4 lg:col-start-1 lg:row-start-2">
            {idleNotice && <ErrorMessage variant="info" message={t('auth.idleSignedOut')} />}

            {notConfigured ? (
              <ErrorMessage
                variant="warning"
                title={t('landing.notConfiguredTitle')}
                message={t('landing.notConfiguredBody')}
              />
            ) : (
              !authPanelOpen && (
                <div className="flex flex-col sm:flex-row gap-3">
                  <Button
                    pill
                    size="lg"
                    className="w-full sm:w-auto"
                    onClick={() => openAuthPanel('register')}
                    leftIcon={<UserPlus className="w-5 h-5" />}
                    rightIcon={<ArrowRight className="w-5 h-5" />}
                  >
                    {t('landing.createAccount')}
                  </Button>
                  <Button
                    pill
                    size="lg"
                    variant="outline"
                    className="w-full sm:w-auto"
                    onClick={() => openAuthPanel('password')}
                    leftIcon={<User className="w-5 h-5" />}
                  >
                    {t('landing.haveAccount')}
                  </Button>
                </div>
              )
            )}
          </div>
        </section>

        {authPanelOpen && !notConfigured && (
          <div
            ref={cardRef}
            className="scroll-mt-4 mt-8 p-5 bg-zinc-900 border border-zinc-800 rounded-2xl space-y-4 max-w-lg"
          >
            <SignInPanel view={view} onViewChange={setView} frame={frame} />
          </div>
        )}

        <ul className="mt-12 grid gap-4 sm:grid-cols-2">
          {FEATURES.map(({ icon: Icon, key }) => (
            <li
              key={key}
              className="p-4 sm:p-5 rounded-2xl bg-zinc-900/70 border border-zinc-800/90 flex items-center gap-3"
            >
              <div className="min-w-0 flex-1">
                <div className="w-9 h-9 rounded-xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 flex items-center justify-center mb-3">
                  <Icon className="w-4 h-4" />
                </div>
                <p className="text-sm font-semibold">{t(`landing.features.${key}.title`)}</p>
                <p className="text-xs text-zinc-400 mt-1 leading-relaxed">{t(`landing.features.${key}.body`)}</p>
              </div>
              <FeatureGlyph kind={key} className="w-24 h-[4.5rem] shrink-0" />
            </li>
          ))}
        </ul>

        {!notConfigured && (
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3 text-sm text-zinc-400">
            <p className="text-center">{t('auth.appInviteHint')}</p>
            <AppWhatsAppInvite compact />
          </div>
        )}
      </main>

      <PWAInstallBanner aboveBottomNav={false} />

      <footer className="w-full max-w-6xl mx-auto px-5 py-8 flex flex-col items-center gap-2 text-center text-xs text-zinc-500">
        <LandingMark className="w-6 h-6 opacity-80" />
        {t('landing.footer')}
      </footer>
    </div>
  );
};
