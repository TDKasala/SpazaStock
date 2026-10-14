import React, { useState } from 'react';
import { Mail, User } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ErrorMessage } from '../ui/ErrorMessage';
import {
  DISPLAY_NAME_MAX_LENGTH,
  isValidDisplayName,
  isValidEmail,
  passwordProblem,
} from '../../lib/authValidation';
import { LinkButton } from './AuthLayout';
import { CodeForm } from './CodeForm';
import { PasswordInput } from './PasswordInput';

interface RegisterFormProps {
  lockedEmail?: string;
  initialEmail?: string;
  onSignIn: () => void;
}

export const RegisterForm: React.FC<RegisterFormProps> = ({ lockedEmail, initialEmail = '', onSignIn }) => {
  const { signUp, confirmSignUp, resendSignUpCode } = useAuth();
  const { t } = useLanguage();
  const [step, setStep] = useState<'details' | 'confirm'>('details');
  const [name, setName] = useState('');
  const [email, setEmail] = useState(lockedEmail ?? initialEmail);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidDisplayName(name)) return setError(t('auth.errors.nameRequired'));
    if (!isValidEmail(email)) return setError(t('auth.invalidEmail'));
    const problem = passwordProblem(password);
    if (problem) return setError(t(problem));
    if (password !== repeat) return setError(t('auth.errors.passwordsDontMatch'));
    if (!navigator.onLine) return setError(t('auth.needsInternet'));

    setIsBusy(true);
    setError(null);
    const res = await signUp(email, password, name);
    setIsBusy(false);
    if (res.error) setError(t(res.error));
    else if (res.needsConfirmation) setStep('confirm');
    // Without email confirmation the session starts immediately and the app moves on.
  };

  if (step === 'confirm') {
    return (
      <CodeForm
        message={t('auth.confirmSent', { email: email.trim() })}
        submitLabel={t('auth.confirm')}
        onSubmit={(code) => confirmSignUp(email, code)}
        onResend={() => resendSignUpCode(email)}
        onBack={() => setStep('details')}
        backLabel={t('auth.changeDetails')}
      />
    );
  }

  return (
    <>
      {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label={t('auth.nameLabel')}
          placeholder={t('auth.namePlaceholder')}
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          leftIcon={<User className="w-4 h-4" />}
          autoFocus
        />
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
        />
        <PasswordInput
          label={t('auth.passwordLabel')}
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
          {t('auth.register')}
        </Button>
      </form>
      <LinkButton onClick={onSignIn}>{t('auth.haveAccount')}</LinkButton>
    </>
  );
};
