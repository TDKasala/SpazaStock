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

type View = 'password' | 'confirm' | 'codeEmail' | 'code' | 'register' | 'reset';

interface SignInScreenProps {
  /** Pre-filled, read-only email (an invite is for one address). */
  lockedEmail?: string;
  banner?: React.ReactNode;
  initialView?: 'password' | 'register';
}

export const SignInScreen: React.FC<SignInScreenProps> = ({ lockedEmail, banner, initialView = 'password' }) => {
  const { signInWithPassword, sendCode, verifyCode, confirmSignUp, resendSignUpCode } = useAuth();
  const { t } = useLanguage();
  const [view, setView] = useState<View>(initialView);
  const [email, setEmail] = useState(lockedEmail ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const go = (next: View) => {
    setError(null);
    setView(next);
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
      autoFocus={!lockedEmail}
    />
  );

  if (view === 'register') {
    return (
      <AuthLayout title={t('auth.registerTitle')} subtitle={t('auth.registerSubtitle')} banner={banner}>
        <RegisterForm lockedEmail={lockedEmail} initialEmail={email} onSignIn={() => go('password')} />
      </AuthLayout>
    );
  }

  if (view === 'reset') {
    return (
      <AuthLayout title={t('auth.resetTitle')} banner={banner}>
        <ResetPasswordForm initialEmail={email} lockedEmail={lockedEmail} onBack={() => go('password')} />
      </AuthLayout>
    );
  }

  if (view === 'confirm') {
    return (
      <AuthLayout title={t('auth.confirmTitle')} banner={banner}>
        <CodeForm
          message={t('auth.confirmSent', { email: email.trim() })}
          submitLabel={t('auth.confirm')}
          onSubmit={(code) => confirmSignUp(email, code)}
          onResend={() => resendSignUpCode(email)}
          onBack={() => go('password')}
          backLabel={t('auth.backToSignIn')}
        />
      </AuthLayout>
    );
  }

  if (view === 'code') {
    return (
      <AuthLayout subtitle={t('auth.subtitle')} banner={banner}>
        <CodeForm
          message={t('auth.codeSent', { email: email.trim() })}
          submitLabel={t('auth.verify')}
          onSubmit={(code) => verifyCode(email, code)}
          onResend={() => sendCode(email)}
          onBack={() => go('codeEmail')}
          backLabel={t('auth.changeEmail')}
        />
      </AuthLayout>
    );
  }

  if (view === 'codeEmail') {
    return (
      <AuthLayout subtitle={t('auth.subtitle')} banner={banner}>
        {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}
        <form onSubmit={handleSendCode} className="space-y-4">
          {emailInput}
          <Button type="submit" fullWidth isLoading={isBusy}>
            {t('auth.sendCode')}
          </Button>
        </form>
        <LinkButton onClick={() => go('password')}>{t('auth.usePasswordInstead')}</LinkButton>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout subtitle={t('auth.subtitle')} banner={banner}>
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
    </AuthLayout>
  );
};
