import React, { useEffect, useState } from 'react';
import { Check, LogOut, Plus, ShieldCheck, Store, UserCog, Users } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { useShop } from '../../context/ShopContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { ErrorMessage } from '../ui/ErrorMessage';
import { ShopFormFields } from '../shop/ShopFormFields';
import { emptyShopForm, parseShopForm, type ShopFormErrors, type ShopFormValues } from '../../lib/shopDetails';
import { can } from '../../lib/permissions';
import { fetchPlatformRole } from '../../lib/platformAdmin';

interface ShopMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenTeam: () => void;
  onOpenAccount: () => void;
  onSignOut: () => void;
}

export const ShopMenu: React.FC<ShopMenuProps> = ({ isOpen, onClose, onOpenTeam, onOpenAccount, onSignOut }) => {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { shop, shops, switchShop, createShop } = useShop();
  const [isAdding, setIsAdding] = useState(false);
  const [values, setValues] = useState<ShopFormValues>(emptyShopForm);
  const [fieldErrors, setFieldErrors] = useState<ShopFormErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  useEffect(() => {
    if (!isOpen || !navigator.onLine) return;
    let cancelled = false;
    void fetchPlatformRole().then((role) => {
      if (!cancelled) setIsPlatformAdmin(role !== null);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const close = () => {
    setIsAdding(false);
    setValues(emptyShopForm());
    setFieldErrors({});
    setError(null);
    onClose();
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const { input, errors } = parseShopForm(values, t);
    setFieldErrors(errors);
    if (!input) return;
    if (!navigator.onLine) return setError(t('auth.needsInternet'));
    setIsBusy(true);
    setError(null);
    const res = await createShop(input);
    setIsBusy(false);
    if (res.error) setError(res.error);
    else close();
  };

  const rowClass =
    'w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left text-sm text-zinc-200 hover:bg-zinc-800/70 transition-colors';

  return (
    <Dialog isOpen={isOpen} onClose={close} title={t('shops.menuTitle')} description={user?.email ?? undefined}>
      <div className="space-y-4">
        <section className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 px-1">{t('shops.yourShops')}</h3>
          {shops.map((s) => {
            const isCurrent = s.id === shop?.id;
            return (
              <button
                key={s.id}
                className={`${rowClass} ${isCurrent ? 'bg-zinc-800/60' : ''}`}
                onClick={() => {
                  switchShop(s.id);
                  close();
                }}
              >
                <Store className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block truncate font-medium">{s.name}</span>
                  <span className="block text-xs text-zinc-500">{s.role ? t(`roles.${s.role}`) : ''}</span>
                </span>
                {isCurrent && <Check className="w-4 h-4 text-emerald-400 shrink-0" aria-label={t('shops.current')} />}
              </button>
            );
          })}

          {isAdding ? (
            <form onSubmit={handleCreate} className="space-y-3 p-3 rounded-xl border border-zinc-800">
              {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}
              <ShopFormFields values={values} errors={fieldErrors} onChange={setValues} autoFocusName />
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={() => setIsAdding(false)} disabled={isBusy}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" fullWidth isLoading={isBusy}>
                  {t('onboarding.create')}
                </Button>
              </div>
            </form>
          ) : (
            <button className={rowClass} onClick={() => setIsAdding(true)}>
              <Plus className="w-4 h-4 text-zinc-400 shrink-0" />
              {t('shops.addShop')}
            </button>
          )}
        </section>

        <section className="space-y-1 pt-3 border-t border-zinc-800">
          {can(shop?.role, 'team.manage') && (
            <button
              className={rowClass}
              onClick={() => {
                close();
                onOpenTeam();
              }}
            >
              <Users className="w-4 h-4 text-zinc-400 shrink-0" />
              {t('shops.team')}
            </button>
          )}
          <button
            className={rowClass}
            onClick={() => {
              close();
              onOpenAccount();
            }}
          >
            <UserCog className="w-4 h-4 text-zinc-400 shrink-0" />
            {t('shops.account')}
          </button>
          {isPlatformAdmin && (
            <a className={rowClass} href="/admin">
              <ShieldCheck className="w-4 h-4 text-zinc-400 shrink-0" />
              {t('shops.adminConsole')}
            </a>
          )}
          <button
            className={rowClass}
            onClick={() => {
              close();
              onSignOut();
            }}
          >
            <LogOut className="w-4 h-4 text-zinc-400 shrink-0" />
            {t('auth.signOut')}
          </button>
        </section>
      </div>
    </Dialog>
  );
};
