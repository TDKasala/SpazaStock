import React, { useState } from 'react';
import { Mail, KeyRound, Package, ArrowLeft } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ErrorMessage } from '../ui/ErrorMessage';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const SignInScreen: React.FC = () => {
  const { sendCode, verifyCode } = useAuth();
  const { t, locale, setLocale } = useLanguage();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) {
      setError(t('auth.invalidEmail'));
      return;
    }
    if (!navigator.onLine) {
      setError(t('auth.needsInternet'));
      return;
    }
    setIsBusy(true);
    setError(null);
    const res = await sendCode(email);
    setIsBusy(false);
    if (res.error) setError(res.error);
    else setStep('code');
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setError(t('auth.invalidCode'));
      return;
    }
    setIsBusy(true);
    setError(null);
    const res = await verifyCode(email, code);
    setIsBusy(false);
    if (res.error) setError(res.error);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center text-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center shadow-lg shadow-emerald-950/50">
            <Package className="w-7 h-7 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold">{t('common.appName')}</h1>
            <p className="text-xs text-zinc-400 mt-1">{t('auth.subtitle')}</p>
          </div>
        </div>

        <div className="p-5 bg-zinc-900 border border-zinc-800 rounded-2xl space-y-4">
          {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}

          {step === 'email' ? (
            <form onSubmit={handleSendCode} className="space-y-4">
              <Input
                label={t('auth.emailLabel')}
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                leftIcon={<Mail className="w-4 h-4" />}
                autoFocus
              />
              <Button type="submit" fullWidth isLoading={isBusy}>
                {t('auth.sendCode')}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleVerify} className="space-y-4">
              <p className="text-xs text-zinc-400 leading-relaxed">
                {t('auth.codeSent', { email: email.trim() })}
              </p>
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
                {t('auth.verify')}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setStep('email');
                  setCode('');
                  setError(null);
                }}
                className="w-full text-xs text-zinc-400 hover:text-zinc-200 inline-flex items-center justify-center gap-1"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                {t('auth.changeEmail')}
              </button>
            </form>
          )}
        </div>

        <button
          onClick={() => setLocale(locale === 'en' ? 'zu' : 'en')}
          className="w-full text-xs text-zinc-500 hover:text-zinc-300"
        >
          {locale === 'en' ? 'isiZulu' : 'English'}
        </button>
      </div>
    </div>
  );
};
