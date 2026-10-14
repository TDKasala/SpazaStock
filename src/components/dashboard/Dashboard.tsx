import React from 'react';
import {
  PackagePlus,
  ScanLine,
  CalendarClock,
  PackageSearch,
  Database,
  HelpCircle,
  ScanBarcode,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { ActionTile } from '../ui/ActionTile';
import { isSupabaseConfigured } from '../../lib/supabase';
import { StockActionType } from '../../types';

export interface DashboardProps {
  onOpenSetupGuide: () => void;
  onOpenScanner: () => void;
  onNavigateTab: (tab: string) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({
  onOpenSetupGuide,
  onOpenScanner,
  onNavigateTab,
}) => {
  const { t, dict } = useLanguage();
  const isDbConfigured = isSupabaseConfigured();

  const handleActionClick = (action: StockActionType) => {
    switch (action) {
      case 'add_stock':
      case 'quick_sale':
        onOpenScanner();
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
      {/* Supabase Status Banner if unconfigured */}
      {!isDbConfigured && (
        <div className="bg-gradient-to-r from-zinc-900 to-zinc-950 border border-zinc-800 rounded-2xl p-4 flex items-start gap-3.5 shadow-md">
          <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20 shrink-0">
            <Database className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-1.5">
              {t('setup.bannerTitle')}
            </h3>
            <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
              {t('setup.bannerMessage')}
            </p>
            <button
              onClick={onOpenSetupGuide}
              className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 hover:text-emerald-300 hover:underline"
            >
              {t('setup.configureButton')} &rarr;
            </button>
          </div>
        </div>
      )}

      {/* Main Section: "Your shop at a glance" (Matches user screenshot) */}
      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <div>
            <h2 className="text-lg font-bold text-zinc-100 tracking-tight">
              {t('dashboard.glanceHeading')}
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              {t('dashboard.subtitle')}
            </p>
          </div>
        </div>

        {/* 2x2 Grid matching the screenshot */}
        <div className="grid grid-cols-2 gap-3.5">
          {/* Action 1: Add Stock */}
          <ActionTile
            id="add_stock"
            title={dict.dashboard.actions.addStock.title}
            icon={<PackagePlus className="w-10 h-10 stroke-[1.75]" />}
            onClick={() => handleActionClick('add_stock')}
          />

          {/* Action 2: Quick Sale */}
          <ActionTile
            id="quick_sale"
            title={dict.dashboard.actions.quickSale.title}
            icon={<ScanLine className="w-10 h-10 stroke-[1.75]" />}
            onClick={() => handleActionClick('quick_sale')}
          />

          {/* Action 3: Expiry Alerts */}
          <ActionTile
            id="expiry_alerts"
            title={dict.dashboard.actions.expiryAlerts.title}
            icon={<CalendarClock className="w-10 h-10 stroke-[1.75]" />}
            accentColor="orange"
            onClick={() => handleActionClick('expiry_alerts')}
          />

          {/* Action 4: View Stock */}
          <ActionTile
            id="view_stock"
            title={dict.dashboard.actions.viewStock.title}
            icon={<PackageSearch className="w-10 h-10 stroke-[1.75]" />}
            onClick={() => handleActionClick('view_stock')}
          />
        </div>
      </section>

      {/* Quick Launch Barcode Scanner Banner */}
      <button
        onClick={onOpenScanner}
        className="w-full p-4 rounded-2xl bg-gradient-to-r from-emerald-950/40 via-zinc-900 to-zinc-950 border border-emerald-500/30 flex items-center justify-between gap-3 text-left transition-all active:scale-[0.98] group cursor-pointer shadow-lg"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30 group-hover:scale-105 transition-transform">
            <ScanBarcode className="w-5 h-5" />
          </div>
          <div>
            <h4 className="text-sm font-bold text-zinc-100 flex items-center gap-1.5">
              <span>{t('scanner.scanAction')}</span>
              <span className="text-[10px] uppercase font-bold bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded">
                Camera
              </span>
            </h4>
            <p className="text-xs text-zinc-400 mt-0.5">
              Scan barcode or enter manually to check price or register products
            </p>
          </div>
        </div>
        <span className="text-emerald-400 font-bold text-sm hidden sm:inline">&rarr;</span>
      </button>

      {/* Foundation Architecture Card */}
      <div className="bg-zinc-900/40 border border-zinc-800/80 rounded-2xl p-4 sm:p-5 space-y-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          <HelpCircle className="w-4 h-4 text-emerald-400" />
          <span>{t('common.step')}</span>
        </div>
        <p className="text-xs text-zinc-300 leading-relaxed">
          Camera-based barcode scanner active with Android mobile compatibility, permission handling, and manual barcode entry fallback. Product search and duplicate prevention enabled.
        </p>
        <div className="flex items-center gap-2 pt-1 text-[11px] text-zinc-400">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>Catalog ready: Scan any barcode to look up or register products</span>
        </div>
      </div>
    </div>
  );
};
