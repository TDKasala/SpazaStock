import React, { useState } from 'react';
import { Package, Cloud, CloudOff, RefreshCw, AlertTriangle, ChevronDown } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { LanguagePicker } from '../ui/LanguagePicker';
import { useAuth } from '../../context/AuthContext';
import { useShop } from '../../context/ShopContext';
import { useSyncStatus } from '../../hooks/useSyncStatus';
import { PWAInstallButton } from '../pwa/PWAInstallButton';
import { AppWhatsAppInvite } from '../pwa/AppWhatsAppInvite';
import { ShopMenu } from './ShopMenu';
import { AccountDialog } from '../account/AccountDialog';
import { SHOP_SHELL_WIDTH } from './shell';

export const Header: React.FC<{ onOpenTeam: () => void }> = ({ onOpenTeam }) => {
  const { t } = useLanguage();
  const { mode, signOut, user } = useAuth();
  const { shop } = useShop();
  const { status, syncNow } = useSyncStatus();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);

  const handleSignOut = async () => {
    if (status.pending > 0 && !window.confirm(t('auth.signOutPendingConfirm', { count: status.pending }))) {
      return;
    }
    await signOut();
  };

  let pill: { icon: React.ReactNode; label: string; className: string; onClick: () => void };
  if (status.failed > 0) {
    pill = {
      icon: <AlertTriangle className="w-3.5 h-3.5" />,
      label: t('sync.failedShort', { count: status.failed }),
      className: 'bg-rose-950/40 text-rose-300 border-rose-800/60',
      onClick: () => void syncNow(),
    };
  } else if (!status.isOnline) {
    pill = {
      icon: <CloudOff className="w-3.5 h-3.5" />,
      label: status.pending > 0 ? t('sync.pendingShort', { count: status.pending }) : t('common.offline'),
      className: 'bg-amber-950/40 text-amber-300 border-amber-800/60',
      onClick: () => void syncNow(),
    };
  } else if (status.isSyncing || status.pending > 0) {
    pill = {
      icon: <RefreshCw className={`w-3.5 h-3.5 ${status.isSyncing ? 'animate-spin' : ''}`} />,
      label: status.pending > 0 ? t('sync.pendingShort', { count: status.pending }) : t('sync.syncing'),
      className: 'bg-zinc-900 text-zinc-300 border-zinc-800',
      onClick: () => void syncNow(),
    };
  } else {
    pill = {
      icon: <Cloud className="w-3.5 h-3.5" />,
      label: t('sync.synced'),
      className: 'bg-emerald-950/40 text-emerald-400 border-emerald-800/60',
      onClick: () => void syncNow(),
    };
  }

  return (
    <>
      <header className="sticky top-0 z-40 w-full bg-zinc-950/80 backdrop-blur-md border-b border-zinc-800/80 pt-[env(safe-area-inset-top,0px)]">
        <div className={`${SHOP_SHELL_WIDTH} mx-auto px-4 py-3 flex items-center justify-between gap-3`}>
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 shrink-0 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center text-white shadow-md shadow-emerald-950/50">
              <Package className="w-5 h-5 text-white" />
            </div>
            {mode === 'cloud' && shop ? (
              <button
                onClick={() => setIsMenuOpen(true)}
                className="min-w-0 text-left rounded-lg -mx-1 px-1 py-0.5 hover:bg-zinc-900 transition-colors"
                aria-haspopup="dialog"
                aria-label={t('shops.menuTitle')}
              >
                <h1 className="text-base font-bold text-zinc-100 tracking-tight leading-none truncate">
                  {t('common.appName')}
                </h1>
                <p className="text-[11px] text-zinc-400 leading-none mt-1 inline-flex items-center gap-1 max-w-full">
                  <span className="truncate">{shop.name}</span>
                  <ChevronDown className="w-3 h-3 shrink-0" />
                </p>
              </button>
            ) : (
              <div className="min-w-0">
                <h1 className="text-base font-bold text-zinc-100 tracking-tight leading-none truncate">
                  {t('common.appName')}
                </h1>
                <p className="text-[11px] text-zinc-400 leading-none mt-1 truncate">{t('common.tagline')}</p>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {mode === 'cloud' && (
              <button
                onClick={pill.onClick}
                title={status.lastError ?? pill.label}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${pill.className}`}
              >
                {pill.icon}
                <span className="hidden sm:inline">{pill.label}</span>
              </button>
            )}

            <AppWhatsAppInvite compact inviterName={user?.email?.split('@')[0] || undefined} />

            <LanguagePicker compact />

            <PWAInstallButton compact />
          </div>
        </div>
      </header>

      {/* Outside the header: its backdrop filter would confine fixed-position dialogs. */}
      {mode === 'cloud' && (
        <>
          <ShopMenu
            isOpen={isMenuOpen}
            onClose={() => setIsMenuOpen(false)}
            onOpenTeam={onOpenTeam}
            onOpenAccount={() => setIsAccountOpen(true)}
            onSignOut={() => void handleSignOut()}
          />
          <AccountDialog isOpen={isAccountOpen} onClose={() => setIsAccountOpen(false)} />
        </>
      )}
    </>
  );
};
