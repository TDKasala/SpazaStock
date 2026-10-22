import React, { useState } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { useShop } from '../../context/ShopContext';
import { can } from '../../lib/permissions';
import type { Product, Sale, StockBatch } from '../../types';
import type { LowStockItem } from '../../lib/lowStock';
import { PushAlertsToggle } from '../expiry/PushAlertsToggle';
import { ReminderSettings } from '../expiry/ReminderSettings';
import { StockIntelligenceCard } from '../dashboard/StockIntelligenceCard';
import { StockLevelSettings } from '../stock/StockLevelSettings';
import { WholesaleOrders } from '../wholesale/WholesaleOrders';
import { Button } from '../ui/Button';

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
  const { shop } = useShop();
  const [ordering, setOrdering] = useState(false);

  if (ordering && shop) {
    return (
      <WholesaleOrders
        shopId={shop.id}
        canManage={can(shop.role, 'orders.manage')}
        canReceive={can(shop.role, 'stock.receive')}
        products={products}
        batches={batches}
        timezone={timezone}
        onClose={() => setOrdering(false)}
      />
    );
  }

  return (
    <div className="space-y-5 pb-24">
      <h2 className="text-lg font-bold text-zinc-100">{t('navigation.more')}</h2>
      <Button variant="outline" fullWidth onClick={() => setOrdering(true)}>
        {t('wholesale.open')}
      </Button>
      <PushAlertsToggle />
      {shop && (
        <StockLevelSettings
          shopId={shop.id}
          canEdit={can(shop.role, 'products.edit')}
          products={products}
          batches={batches}
          timezone={timezone}
        />
      )}
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
