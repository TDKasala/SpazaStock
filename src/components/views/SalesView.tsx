import React from 'react';
import { SalesRegister } from '../sales/SalesRegister';

export interface SalesViewProps {
  onOpenScanner: () => void;
  onOpenRegisterProduct: (barcode: string) => void;
  refreshTrigger?: number;
}

export const SalesView: React.FC<SalesViewProps> = ({
  onOpenScanner,
  onOpenRegisterProduct,
  refreshTrigger,
}) => {
  return (
    <SalesRegister
      onOpenScanner={onOpenScanner}
      onOpenRegisterProduct={onOpenRegisterProduct}
      refreshTrigger={refreshTrigger}
    />
  );
};
