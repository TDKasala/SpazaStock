import React, { useState } from 'react';
import { Store, LogOut, RefreshCw } from 'lucide-react';
import { useShop } from '../../context/ShopContext';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ErrorMessage } from '../ui/ErrorMessage';
import { RevokedNotice } from '../layout/RevokedNotice';

export const ShopOnboarding: React.FC = () => {
  const { createShop, error: loadError, reload } = useShop();
  const { user, signOut } = useAuth();
  const { t } = useLanguage();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t('onboarding.nameRequired'));
      return;
    }
    if (!navigator.onLine) {
      setError(t('auth.needsInternet'));
      return;
    }
    setIsBusy(true);
    setError(null);
    const res = await createShop(name);
    setIsBusy(false);
    if (res.error) setError(res.error);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
            <Store className="w-7 h-7 text-emerald-400" />
          </div>
          <h1 className="text-xl font-bold">{t('onboarding.title')}</h1>
          <p className="text-xs text-zinc-400">{t('onboarding.subtitle')}</p>
        </div>

        <RevokedNotice />

        {loadError ? (
          <div className="space-y-3">
            <ErrorMessage
              variant="warning"
              message={loadError === 'offline' ? t('onboarding.offlineNoShop') : loadError}
            />
            <Button onClick={reload} variant="secondary" fullWidth leftIcon={<RefreshCw className="w-4 h-4" />}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-5 bg-zinc-900 border border-zinc-800 rounded-2xl space-y-4">
            {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}
            <Input
              label={t('onboarding.nameLabel')}
              placeholder={t('onboarding.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              autoFocus
            />
            <Button type="submit" fullWidth isLoading={isBusy}>
              {t('onboarding.create')}
            </Button>
          </form>
        )}

        <p className="text-xs text-zinc-500 text-center leading-relaxed">{t('onboarding.hasInvite')}</p>

        <button
          onClick={signOut}
          className="w-full text-xs text-zinc-500 hover:text-zinc-300 inline-flex items-center justify-center gap-1.5"
        >
          <LogOut className="w-3.5 h-3.5" />
          {t('auth.signOutAs', { email: user?.email ?? '' })}
        </button>
      </div>
    </div>
  );
};
