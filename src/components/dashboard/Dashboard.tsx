import React from 'react';
import { PackagePlus, ScanLine, CalendarClock, PackageSearch } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { ActionTile } from '../ui/ActionTile';
import { ExpiryAlertsCard } from '../expiry/ExpiryAlertsCard';
import type { Product, ScanMode, StockActionType } from '../../types';
import type { ExpiryAlertItem } from '../../services/stockService';
import type { AppTab } from '../../App';

export interface DashboardProps {
  onOpenScanner: (mode: ScanMode) => void;
  onNavigateTab: (tab: AppTab) => void;
  expiryAlerts: ExpiryAlertItem[];
  isLoadingAlerts: boolean;
  onSelectProduct: (product: Product) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({
  onOpenScanner,
  onNavigateTab,
  expiryAlerts,
  isLoadingAlerts,
  onSelectProduct,
}) => {
  const { t, dict } = useLanguage();

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
            icon={<PackagePlus className="w-7 h-7 stroke-[1.75]" />}
            onClick={() => handleActionClick('add_stock')}
          />
          <ActionTile
            id="quick_sale"
            title={dict.dashboard.actions.quickSale.title}
            icon={<ScanLine className="w-7 h-7 stroke-[1.75]" />}
            onClick={() => handleActionClick('quick_sale')}
          />
          <ActionTile
            id="expiry_alerts"
            title={dict.dashboard.actions.expiryAlerts.title}
            icon={<CalendarClock className="w-7 h-7 stroke-[1.75]" />}
            accentColor="orange"
            onClick={() => handleActionClick('expiry_alerts')}
          />
          <ActionTile
            id="view_stock"
            title={dict.dashboard.actions.viewStock.title}
            icon={<PackageSearch className="w-7 h-7 stroke-[1.75]" />}
            onClick={() => handleActionClick('view_stock')}
          />
        </div>
      </section>

      <ExpiryAlertsCard
        alerts={expiryAlerts}
        isLoading={isLoadingAlerts}
        onViewAll={() => onNavigateTab('alerts')}
        onSelectProduct={onSelectProduct}
      />
    </div>
  );
};
