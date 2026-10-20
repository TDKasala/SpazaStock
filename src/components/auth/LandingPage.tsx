import React from 'react';
import {
  ArrowRight,
  BellRing,
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
import { PWAInstallBanner } from '../pwa/PWAInstallBanner';
import { AppWhatsAppInvite } from '../pwa/AppWhatsAppInvite';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import { loginHref } from '../../lib/signInRedirect';
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
              <a className="landing-header-signin" href={loginHref()}>
                {t('landing.haveAccount')}
              </a>
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

            {notConfigured ? (
              <ErrorMessage
                variant="warning"
                title={t('landing.notConfiguredTitle')}
                message={t('landing.notConfiguredBody')}
              />
            ) : (
              <div className="landing-actions">
                <a className="landing-button landing-button-primary" href={loginHref('register')}>
                  <UserPlus className="w-4 h-4" aria-hidden />
                  {t('landing.createAccount')}
                  <ArrowRight className="w-4 h-4" aria-hidden />
                </a>
              </div>
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
