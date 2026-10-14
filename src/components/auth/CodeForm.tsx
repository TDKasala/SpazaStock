import React, { useState } from 'react';
import { ArrowLeft, KeyRound } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ErrorMessage } from '../ui/ErrorMessage';
import { isValidCode } from '../../lib/authValidation';
import type { AuthResult } from '../../context/AuthContext';
import { LinkButton } from './AuthLayout';

interface CodeFormProps {
  /** Explains where the code was sent. */
  message: string;
  submitLabel: string;
  onSubmit: (code: string) => Promise<AuthResult>;
  onResend?: () => Promise<AuthResult>;
  onBack: () => void;
  backLabel: string;
}

/** The 6-digit email code step shared by sign-in, sign-up confirmation and password reset. */
export const CodeForm: React.FC<CodeFormProps> = ({ message, submitLabel, onSubmit, onResend, onBack, backLabel }) => {
  const { t } = useLanguage();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isResending, setIsResending] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidCode(code)) {
      setError(t('auth.invalidCode'));
      return;
    }
    if (!navigator.onLine) {
      setError(t('auth.needsInternet'));
      return;
    }
    setIsBusy(true);
    setError(null);
    setNotice(null);
    const res = await onSubmit(code);
    setIsBusy(false);
    if (res.error) setError(t(res.error));
  };

  const handleResend = async () => {
    if (!onResend) return;
    setIsResending(true);
    setError(null);
    const res = await onResend();
    setIsResending(false);
    if (res.error) setError(t(res.error));
    else setNotice(t('auth.codeResent'));
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}
      {notice && <ErrorMessage variant="success" message={notice} onDismiss={() => setNotice(null)} />}
      <p className="text-xs text-zinc-400 leading-relaxed">{message}</p>
      <Input
        label={t('auth.codeLabel')}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        placeholder="123456"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        leftIcon={<KeyRound className="w-4 h-4" />}
        autoFocus
      />
      <Button type="submit" fullWidth isLoading={isBusy}>
        {submitLabel}
      </Button>
      {onResend && (
        <LinkButton onClick={() => void handleResend()} disabled={isResending}>
          {t('auth.resendCode')}
        </LinkButton>
      )}
      <LinkButton onClick={onBack}>
        <ArrowLeft className="w-3.5 h-3.5" />
        {backLabel}
      </LinkButton>
    </form>
  );
};
