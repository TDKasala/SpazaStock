import React, { useEffect, useState } from 'react';
import { User } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ErrorMessage } from '../ui/ErrorMessage';
import { NewPasswordForm } from '../auth/ResetPasswordScreen';
import { DISPLAY_NAME_MAX_LENGTH, isValidDisplayName, normalizeDisplayName } from '../../lib/authValidation';
import { getDisplayName, updateDisplayName } from '../../services/teamService';

export const AccountDialog: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!isOpen || !userId) return;
    setError(null);
    setNotice(null);
    setShowPassword(false);
    let active = true;
    void getDisplayName(userId).then((res) => {
      if (active && res.data) setName(res.data);
    });
    return () => {
      active = false;
    };
  }, [isOpen, userId]);

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId) return;
    if (!isValidDisplayName(name)) return setError(t('auth.errors.nameRequired'));
    if (!navigator.onLine) return setError(t('auth.needsInternet'));
    setIsBusy(true);
    setError(null);
    const res = await updateDisplayName(userId, normalizeDisplayName(name));
    setIsBusy(false);
    if (res.error) setError(t('auth.errors.generic'));
    else setNotice(t('account.nameSaved'));
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t('account.title')} description={user?.email ?? undefined}>
      <div className="space-y-5">
        {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}
        {notice && <ErrorMessage variant="success" message={notice} onDismiss={() => setNotice(null)} />}
        <form onSubmit={saveName} className="space-y-3">
          <Input
            label={t('account.nameLabel')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={DISPLAY_NAME_MAX_LENGTH}
            autoComplete="name"
            leftIcon={<User className="w-4 h-4" />}
          />
          <Button type="submit" variant="secondary" fullWidth isLoading={isBusy}>
            {t('account.saveName')}
          </Button>
        </form>

        <div className="pt-4 border-t border-zinc-800 space-y-3">
          {showPassword ? (
            <NewPasswordForm
              submitLabel={t('auth.savePassword')}
              onSaved={() => {
                setShowPassword(false);
                setNotice(t('account.passwordChanged'));
              }}
            />
          ) : (
            <Button variant="outline" fullWidth onClick={() => setShowPassword(true)}>
              {t('account.changePassword')}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
};
