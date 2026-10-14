import React from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { useShop } from '../../context/ShopContext';
import { ErrorMessage } from '../ui/ErrorMessage';

/** Tells the user when their access to a shop ended and its data left this phone. */
export const RevokedNotice: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { t } = useLanguage();
  const { revokedShopNames, dismissRevoked } = useShop();
  if (revokedShopNames.length === 0) return null;
  return (
    <div className={`space-y-2 ${className}`}>
      {revokedShopNames.map((name, i) => (
        <ErrorMessage
          key={`${name}-${i}`}
          variant="warning"
          message={t('shops.accessRemoved', { shop: name })}
          onDismiss={dismissRevoked}
        />
      ))}
    </div>
  );
};
