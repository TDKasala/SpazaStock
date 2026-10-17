import React from 'react';
import { useLanguage } from '../../context/LanguageContext';
import type { Product, Sale, StockBatch } from '../../types';
import type { LowStockItem } from '../../lib/lowStock';
import { PushAlertsToggle } from '../expiry/PushAlertsToggle';
import { ReminderSettings } from '../expiry/ReminderSettings';
import { StockIntelligenceCard } from '../dashboard/StockIntelligenceCard';

export interface MoreViewProps {
  lowStock: LowStockItem[];
  products: Product[];
  sales: Sale[];
  batches: StockBatch[];
  timezone: string;
  isLoadingIntelligence: boolean;
}

export const MoreView: React.FC<MoreViewProps> = ({
  lowStock,
  products,
  sales,
  batches,
  timezone,
  isLoadingIntelligence,
}) => {
  const { t } = useLanguage();

  return (
    <div className="space-y-5 pb-24">
      <h2 className="text-lg font-bold text-zinc-100">{t('navigation.more')}</h2>
      <PushAlertsToggle />
      <ReminderSettings />
      <StockIntelligenceCard
        lowStock={lowStock}
        products={products}
        sales={sales}
        batches={batches}
        timezone={timezone}
        isLoading={isLoadingIntelligence}
      />
    </div>
  );
};
