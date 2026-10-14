import React, { useState } from 'react';
import { Mail } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ErrorMessage } from '../ui/ErrorMessage';
import { isValidEmail } from '../../lib/authValidation';
import { AuthLayout, LinkButton } from './AuthLayout';
import { CodeForm } from './CodeForm';
import { PasswordInput } from './PasswordInput';
import { RegisterForm } from './RegisterScreen';
import { ResetPasswordForm } from './ResetPasswordScreen';

export type SignInView = 'password' | 'confirm' | 'codeEmail' | 'code' | 'register' | 'reset';

export interface PanelFrame {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}

interface SignInPanelProps {
  /** Pre-filled, read-only email (an invite is for one address). */
  lockedEmail?: string;
  initialView?: 'password' | 'register';
  /** Controls the view from outside, e.g. the landing page's "Create account" button. */
  view?: SignInView;
  onViewChange?: (view: SignInView) => void;
  /** Wraps each view with its title; called as a function so forms keep their state. */
  frame: (props: PanelFrame) => React.ReactNode;
}

/** Password sign-in, code sign-in, registration and password reset, without the page around them. */
export const SignInPanel: React.FC<SignInPanelProps> = ({
  lockedEmail,
  initialView = 'password',
  view: controlledView,
  onViewChange,
  frame,
}) => {
  const { signInWithPassword, sendCode, verifyCode, confirmSignUp, resendSignUpCode } = useAuth();
  const { t } = useLanguage();
  const [ownView, setOwnView] = useState<SignInView>(initialView);
  const view = controlledView ?? ownView;
  const [email, setEmail] = useState(lockedEmail ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const go = (next: SignInView) => {
    setError(null);
    setOwnView(next);
    onViewChange?.(next);
  };

  const checkEmailAndConnection = (): boolean => {
    if (!isValidEmail(email)) {
      setError(t('auth.invalidEmail'));
      return false;
    }
    if (!navigator.onLine) {
      setError(t('auth.needsInternet'));
      return false;
    }
    return true;
  };

  const handlePasswordSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!checkEmailAndConnection()) return;
    if (!password) {
      setError(t('auth.errors.passwordRequired'));
      return;
    }
    setIsBusy(true);
    setError(null);
    const res = await signInWithPassword(email, password);
    setIsBusy(false);
    if (res.needsConfirmation) go('confirm');
    else if (res.error) setError(t(res.error));
  };

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!checkEmailAndConnection()) return;
    setIsBusy(true);
    setError(null);
    const res = await sendCode(email);
    setIsBusy(false);
    if (res.error) setError(t(res.error));
    else go('code');
  };

  const emailInput = (
    <Input
      label={t('auth.emailLabel')}
      type="email"
      inputMode="email"
      autoComplete="email"
      placeholder="you@example.com"
      value={email}
      onChange={(e) => setEmail(e.target.value)}
      leftIcon={<Mail className="w-4 h-4" />}
      readOnly={Boolean(lockedEmail)}
    />
  );

  if (view === 'register') {
    return frame({
      title: t('auth.registerTitle'),
      subtitle: t('auth.registerSubtitle'),
      children: <RegisterForm lockedEmail={lockedEmail} initialEmail={email} onSignIn={() => go('password')} />,
    });
  }

  if (view === 'reset') {
    return frame({
      title: t('auth.resetTitle'),
      children: <ResetPasswordForm initialEmail={email} lockedEmail={lockedEmail} onBack={() => go('password')} />,
    });
  }

  if (view === 'confirm') {
    return frame({
      title: t('auth.confirmTitle'),
      children: (
        <CodeForm
          message={t('auth.confirmSent', { email: email.trim() })}
          submitLabel={t('auth.confirm')}
          onSubmit={(code) => confirmSignUp(email, code)}
          onResend={() => resendSignUpCode(email)}
          onBack={() => go('password')}
          backLabel={t('auth.backToSignIn')}
        />
      ),
    });
  }

  if (view === 'code') {
    return frame({
      subtitle: t('auth.subtitle'),
      children: (
        <CodeForm
          message={t('auth.codeSent', { email: email.trim() })}
          submitLabel={t('auth.verify')}
          onSubmit={(code) => verifyCode(email, code)}
          onResend={() => sendCode(email)}
          onBack={() => go('codeEmail')}
          backLabel={t('auth.changeEmail')}
        />
      ),
    });
  }

  if (view === 'codeEmail') {
    return frame({
      subtitle: t('auth.subtitle'),
      children: (
        <>
          {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}
          <form onSubmit={handleSendCode} className="space-y-4">
            {emailInput}
            <Button type="submit" fullWidth isLoading={isBusy}>
              {t('auth.sendCode')}
            </Button>
          </form>
          <LinkButton onClick={() => go('password')}>{t('auth.usePasswordInstead')}</LinkButton>
        </>
      ),
    });
  }

  return frame({
    subtitle: t('auth.subtitle'),
    children: (
      <>
        {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}
        <form onSubmit={handlePasswordSignIn} className="space-y-4">
          {emailInput}
          <PasswordInput
            label={t('auth.passwordLabel')}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" fullWidth isLoading={isBusy}>
            {t('auth.signIn')}
          </Button>
        </form>
        <div className="space-y-1">
          <LinkButton onClick={() => go('reset')}>{t('auth.forgotPassword')}</LinkButton>
          <LinkButton onClick={() => go('codeEmail')}>{t('auth.useCodeInstead')}</LinkButton>
        </div>
        <div className="pt-3 border-t border-zinc-800">
          <Button type="button" variant="secondary" fullWidth onClick={() => go('register')}>
            {t('auth.noAccount')}
          </Button>
        </div>
      </>
    ),
  });
};

interface SignInScreenProps {
  lockedEmail?: string;
  banner?: React.ReactNode;
  initialView?: 'password' | 'register';
}

/** Full-screen sign-in, used by the invite flow. */
export const SignInScreen: React.FC<SignInScreenProps> = ({ lockedEmail, banner, initialView }) => (
  <SignInPanel
    lockedEmail={lockedEmail}
    initialView={initialView}
    frame={({ title, subtitle, children }) => (
      <AuthLayout title={title} subtitle={subtitle} banner={banner}>
        {children}
      </AuthLayout>
    )}
  />
);
