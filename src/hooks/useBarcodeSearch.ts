import { useState, useCallback } from 'react';
import { Product } from '../types';
import { searchProductByBarcode } from '../services/productService';

export function useBarcodeSearch() {
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [foundProduct, setFoundProduct] = useState<Product | null>(null);
  const [unregisteredBarcode, setUnregisteredBarcode] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const openScanner = useCallback(() => {
    setFoundProduct(null);
    setUnregisteredBarcode(null);
    setSearchError(null);
    setIsScannerOpen(true);
  }, []);

  const closeScanner = useCallback(() => {
    setIsScannerOpen(false);
  }, []);

  const handleBarcodeScanned = useCallback(async (barcode: string) => {
    setIsScannerOpen(false);
    setIsSearching(true);
    setSearchError(null);

    try {
      const product = await searchProductByBarcode(barcode);
      if (product) {
        setFoundProduct(product);
        setUnregisteredBarcode(null);
      } else {
        setFoundProduct(null);
        setUnregisteredBarcode(barcode);
      }
    } catch (err: any) {
      setSearchError(err?.message || 'Failed to search barcode');
      setUnregisteredBarcode(barcode);
    } finally {
      setIsSearching(false);
    }
  }, []);

  const handleProductRegistered = useCallback((product: Product) => {
    setUnregisteredBarcode(null);
    setFoundProduct(product);
  }, []);

  const closeProductFound = useCallback(() => {
    setFoundProduct(null);
  }, []);

  const closeProductRegister = useCallback(() => {
    setUnregisteredBarcode(null);
  }, []);

  return {
    isScannerOpen,
    isSearching,
    foundProduct,
    unregisteredBarcode,
    searchError,
    openScanner,
    closeScanner,
    handleBarcodeScanned,
    handleProductRegistered,
    closeProductFound,
    closeProductRegister,
  };
}
