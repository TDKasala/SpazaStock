import React, { useState } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import type { Product, Sale, StockBatch } from '../../types';
import type { LowStockItem } from '../../lib/lowStock';
import { PushAlertsToggle } from '../expiry/PushAlertsToggle';
import { ReminderSettings } from '../expiry/ReminderSettings';
import { StockIntelligenceCard } from '../dashboard/StockIntelligenceCard';
import { Button } from '../ui/Button';
import { Wrench } from 'lucide-react';
import { ScannerTestDialog } from '../scanner/ScannerTestDialog';

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
  const [testOpen, setTestOpen] = useState(false);

  return (
    <div className="space-y-5 pb-24">
      <h2 className="text-lg font-bold text-zinc-100">{t('navigation.more')}</h2>
      <div className="p-4 bg-zinc-900/60 rounded-2xl border border-zinc-800">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">{t('scannerTest.cardTitle')}</h3>
            <p className="text-xs text-zinc-400">{t('scannerTest.cardSubtitle')}</p>
          </div>
          <Button onClick={() => setTestOpen(true)} variant="secondary" size="sm" leftIcon={<Wrench className="w-4 h-4" />}>
            {t('scannerTest.open')}
          </Button>
        </div>
      </div>
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
      <ScannerTestDialog isOpen={testOpen} onClose={() => setTestOpen(false)} />
    </div>
  );
};
