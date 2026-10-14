import React, { useState } from 'react';
import { ArrowLeft, Mail } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ErrorMessage } from '../ui/ErrorMessage';
import { isValidEmail, passwordProblem } from '../../lib/authValidation';
import { AuthLayout, LinkButton } from './AuthLayout';
import { CodeForm } from './CodeForm';
import { PasswordInput } from './PasswordInput';

interface ResetPasswordFormProps {
  initialEmail?: string;
  lockedEmail?: string;
  onBack: () => void;
}

/** Email, then the emailed code. A correct code signs the user in and the app asks for a new password. */
export const ResetPasswordForm: React.FC<ResetPasswordFormProps> = ({ initialEmail = '', lockedEmail, onBack }) => {
  const { requestPasswordReset, verifyResetCode } = useAuth();
  const { t } = useLanguage();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState(lockedEmail ?? initialEmail);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidEmail(email)) return setError(t('auth.invalidEmail'));
    if (!navigator.onLine) return setError(t('auth.needsInternet'));
    setIsBusy(true);
    setError(null);
    const res = await requestPasswordReset(email);
    setIsBusy(false);
    if (res.error) setError(t(res.error));
    else setStep('code');
  };

  if (step === 'code') {
    return (
      <CodeForm
        message={t('auth.resetCodeSent', { email: email.trim() })}
        submitLabel={t('auth.verifyResetCode')}
        onSubmit={(code) => verifyResetCode(email, code)}
        onResend={() => requestPasswordReset(email)}
        onBack={() => setStep('email')}
        backLabel={t('auth.changeEmail')}
      />
    );
  }

  return (
    <>
      {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}
      <p className="text-xs text-zinc-400 leading-relaxed">{t('auth.resetSubtitle')}</p>
      <form onSubmit={handleSend} className="space-y-4">
        <Input
          label={t('auth.emailLabel')}
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          readOnly={Boolean(lockedEmail)}
          leftIcon={<Mail className="w-4 h-4" />}
          autoFocus={!lockedEmail}
        />
        <Button type="submit" fullWidth isLoading={isBusy}>
          {t('auth.sendResetCode')}
        </Button>
      </form>
      <LinkButton onClick={onBack}>
        <ArrowLeft className="w-3.5 h-3.5" />
        {t('auth.backToSignIn')}
      </LinkButton>
    </>
  );
};

interface NewPasswordFormProps {
  submitLabel: string;
  onSaved: () => void;
}

/** New password and repeat; used after a reset code and from the account screen. */
export const NewPasswordForm: React.FC<NewPasswordFormProps> = ({ submitLabel, onSaved }) => {
  const { updatePassword } = useAuth();
  const { t } = useLanguage();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(password);
    if (problem) return setError(t(problem));
    if (password !== repeat) return setError(t('auth.errors.passwordsDontMatch'));
    if (!navigator.onLine) return setError(t('auth.needsInternet'));
    setIsBusy(true);
    setError(null);
    const res = await updatePassword(password);
    setIsBusy(false);
    if (res.error) setError(t(res.error));
    else {
      setPassword('');
      setRepeat('');
      onSaved();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}
      <PasswordInput
        label={t('auth.newPasswordLabel')}
        autoComplete="new-password"
        helperText={t('auth.passwordHint')}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <PasswordInput
        label={t('auth.confirmPasswordLabel')}
        autoComplete="new-password"
        value={repeat}
        onChange={(e) => setRepeat(e.target.value)}
      />
      <Button type="submit" fullWidth isLoading={isBusy}>
        {submitLabel}
      </Button>
    </form>
  );
};

/** Shown after a reset code signs the user in, until they choose a new password. */
export const NewPasswordScreen: React.FC = () => {
  const { user, finishPasswordRecovery, signOut } = useAuth();
  const { t } = useLanguage();
  return (
    <AuthLayout
      title={t('auth.newPasswordTitle')}
      subtitle={t('auth.newPasswordSubtitle', { email: user?.email ?? '' })}
    >
      <NewPasswordForm submitLabel={t('auth.savePassword')} onSaved={finishPasswordRecovery} />
      <LinkButton onClick={() => void signOut()}>{t('auth.signOut')}</LinkButton>
    </AuthLayout>
  );
};
