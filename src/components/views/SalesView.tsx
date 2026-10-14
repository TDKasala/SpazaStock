import React from 'react';
import { SalesRegister } from '../sales/SalesRegister';
import type { SaleRegister } from '../../hooks/useSaleRegister';

export interface SalesViewProps {
  register: SaleRegister;
  onOpenScanner: () => void;
  refreshTrigger?: number;
}

export const SalesView: React.FC<SalesViewProps> = ({ register, onOpenScanner, refreshTrigger }) => {
  return <SalesRegister register={register} onOpenScanner={onOpenScanner} refreshTrigger={refreshTrigger} />;
};
