import React, { useRef, useState } from 'react';
import {
  ArrowRight,
  BellRing,
  ChevronLeft,
  Cloud,
  Package,
  ScanBarcode,
  TrendingUp,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { LanguagePicker } from '../ui/LanguagePicker';
import { ErrorMessage } from '../ui/ErrorMessage';
import { SignInPanel, type PanelFrame, type SignInView } from './SignInScreen';
import { PWAInstallBanner } from '../pwa/PWAInstallBanner';
import { AppWhatsAppInvite } from '../pwa/AppWhatsAppInvite';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import { takeIdleSignOutNotice } from '../../lib/idleSignOut';
import { takeSignInScreenRequest } from '../../lib/signInRedirect';
import { FeatureGlyph, LandingMark, type FeatureArtKind } from './LandingArt';
import './styles/landing-page.css';

interface LandingPageProps {
  /** The build has no Supabase settings, so nobody can sign in or register. */
  notConfigured?: boolean;
}

const FEATURES: ReadonlyArray<{ icon: LucideIcon; key: FeatureArtKind }> = [
  { icon: ScanBarcode, key: 'scan' },
  { icon: BellRing, key: 'expiry' },
  { icon: Package, key: 'stock' },
  { icon: Cloud, key: 'offline' },
  { icon: Users, key: 'team' },
  { icon: TrendingUp, key: 'grow' },
];

const HERO_MARKS: ReadonlyArray<FeatureArtKind> = ['scan', 'stock', 'expiry'];

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
      <span className="landing-title-highlight">{accent}</span>
      {after}
    </>
  );
}

export const LandingPage: React.FC<LandingPageProps> = ({ notConfigured = false }) => {
  const { t } = useLanguage();
  const { needsInstallPrompt } = usePWAInstall();
  const [idleNotice] = useState(takeIdleSignOutNotice);
  const [view, setView] = useState<SignInView>('password');
  const [authPanelOpen, setAuthPanelOpen] = useState(takeSignInScreenRequest);
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
    <div className="landing-page" style={needsInstallPrompt ? { paddingBottom: '11rem' } : undefined}>
      <header className="landing-header">
        <div className="landing-container landing-header-inner">
          <div className="landing-brand">
            <div className="landing-logo">
              <LandingMark className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="landing-brand-name">{t('common.appName')}</p>
              <p className="landing-brand-tagline">{t('landing.tagline')}</p>
            </div>
          </div>
          <div className="landing-header-actions">
            {!notConfigured && (
              <button type="button" className="landing-header-signin" onClick={() => openAuthPanel('password')}>
                {t('landing.haveAccount')}
              </button>
            )}
            <LanguagePicker unstyled compact className="landing-language" />
          </div>
        </div>
      </header>

      <div className="landing-container">
        <section className="landing-hero">
          <div className="landing-hero-content">
            <p className="landing-eyebrow">{t('landing.badge')}</p>
            <h1 className="landing-title">
              <AccentHeadline text={t('landing.headline')} accent={t('landing.headlineAccent')} />
            </h1>
            <p className="landing-description">{t('landing.intro')}</p>

            {idleNotice && <ErrorMessage variant="info" message={t('auth.idleSignedOut')} />}

            {notConfigured ? (
              <ErrorMessage
                variant="warning"
                title={t('landing.notConfiguredTitle')}
                message={t('landing.notConfiguredBody')}
              />
            ) : (
              !authPanelOpen && (
                <div className="landing-actions">
                  <button type="button" className="landing-button landing-button-primary" onClick={() => openAuthPanel('register')}>
                    <UserPlus className="w-4 h-4" aria-hidden />
                    {t('landing.createAccount')}
                    <ArrowRight className="w-4 h-4" aria-hidden />
                  </button>
                </div>
              )
            )}
          </div>

          <div className="landing-hero-panel" aria-hidden="true">
            {HERO_MARKS.map((key) => (
              <div key={key} className="landing-hero-row">
                <FeatureGlyph kind={key} />
                <p>{t(`landing.features.${key}.title`)}</p>
              </div>
            ))}
          </div>
        </section>

        {authPanelOpen && !notConfigured && (
          <div ref={cardRef} className="landing-auth scroll-mt-20">
            <SignInPanel view={view} onViewChange={setView} frame={frame} />
          </div>
        )}

        <ul className="landing-features">
          {FEATURES.map(({ icon: Icon, key }) => (
            <li key={key} className="landing-feature-card">
              <div className="landing-feature-icon">
                <Icon width={18} height={18} />
              </div>
              <p className="landing-feature-title">{t(`landing.features.${key}.title`)}</p>
              <p className="landing-feature-description">{t(`landing.features.${key}.body`)}</p>
            </li>
          ))}
        </ul>

        {!notConfigured && (
          <div className="landing-referral">
            <p>{t('auth.appInviteHint')}</p>
            <AppWhatsAppInvite className="landing-whatsapp-button" />
          </div>
        )}

        <footer className="landing-footer">
          <div className="landing-footer-logo">
            <LandingMark className="w-4 h-4" />
          </div>
          <p>{t('landing.footer')}</p>
        </footer>
      </div>

      <PWAInstallBanner aboveBottomNav={false} />
    </div>
  );
};
