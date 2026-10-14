import React from 'react';
import { PackagePlus, ScanLine, CalendarClock, PackageSearch, Smartphone, ScanBarcode } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { ActionTile } from '../ui/ActionTile';
import type { ScanMode, StockActionType } from '../../types';
import type { AppTab } from '../../App';

export interface DashboardProps {
  onOpenSetupGuide: () => void;
  onOpenScanner: (mode: ScanMode) => void;
  onNavigateTab: (tab: AppTab) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ onOpenSetupGuide, onOpenScanner, onNavigateTab }) => {
  const { t, dict } = useLanguage();
  const { mode } = useAuth();

  const handleActionClick = (action: StockActionType) => {
    switch (action) {
      case 'add_stock':
        onOpenScanner('stock_in');
        break;
      case 'quick_sale':
        onNavigateTab('sales');
        onOpenScanner('sell');
        break;
      case 'view_stock':
        onNavigateTab('stock');
        break;
      case 'expiry_alerts':
        onNavigateTab('alerts');
        break;
    }
  };

  return (
    <div className="space-y-6 pb-24">
      {mode === 'device' && (
        <div className="bg-gradient-to-r from-zinc-900 to-zinc-950 border border-zinc-800 rounded-2xl p-4 flex items-start gap-3.5 shadow-md">
          <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20 shrink-0">
            <Smartphone className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-zinc-100">{t('setup.bannerTitle')}</h3>
            <p className="text-xs text-zinc-400 mt-1 leading-relaxed">{t('setup.bannerMessage')}</p>
            <button
              onClick={onOpenSetupGuide}
              className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 hover:text-emerald-300 hover:underline"
            >
              {t('setup.configureButton')} &rarr;
            </button>
          </div>
        </div>
      )}

      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <div>
            <h2 className="text-lg font-bold text-zinc-100 tracking-tight">{t('dashboard.glanceHeading')}</h2>
            <p className="text-xs text-zinc-400 mt-0.5">{t('dashboard.subtitle')}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3.5">
          <ActionTile
            id="add_stock"
            title={dict.dashboard.actions.addStock.title}
            icon={<PackagePlus className="w-10 h-10 stroke-[1.75]" />}
            onClick={() => handleActionClick('add_stock')}
          />
          <ActionTile
            id="quick_sale"
            title={dict.dashboard.actions.quickSale.title}
            icon={<ScanLine className="w-10 h-10 stroke-[1.75]" />}
            onClick={() => handleActionClick('quick_sale')}
          />
          <ActionTile
            id="expiry_alerts"
            title={dict.dashboard.actions.expiryAlerts.title}
            icon={<CalendarClock className="w-10 h-10 stroke-[1.75]" />}
            accentColor="orange"
            onClick={() => handleActionClick('expiry_alerts')}
          />
          <ActionTile
            id="view_stock"
            title={dict.dashboard.actions.viewStock.title}
            icon={<PackageSearch className="w-10 h-10 stroke-[1.75]" />}
            onClick={() => handleActionClick('view_stock')}
          />
        </div>
      </section>

      <button
        onClick={() => onOpenScanner('lookup')}
        className="w-full p-4 rounded-2xl bg-gradient-to-r from-emerald-950/40 via-zinc-900 to-zinc-950 border border-emerald-500/30 flex items-center justify-between gap-3 text-left transition-all active:scale-[0.98] group cursor-pointer shadow-lg"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30 group-hover:scale-105 transition-transform">
            <ScanBarcode className="w-5 h-5" />
          </div>
          <div>
            <h4 className="text-sm font-bold text-zinc-100">{t('dashboard.lookupTitle')}</h4>
            <p className="text-xs text-zinc-400 mt-0.5">{t('dashboard.lookupDescription')}</p>
          </div>
        </div>
        <span className="text-emerald-400 font-bold text-sm hidden sm:inline">&rarr;</span>
      </button>
    </div>
  );
};
