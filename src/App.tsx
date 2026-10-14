import React, { useState } from 'react';
import { LanguageProvider } from './context/LanguageContext';
import { Header } from './components/layout/Header';
import { BottomNav } from './components/layout/BottomNav';
import { Dashboard } from './components/dashboard/Dashboard';
import { StockView } from './components/views/StockView';
import { SalesView } from './components/views/SalesView';
import { AlertsView } from './components/views/AlertsView';
import { SetupGuideDialog } from './components/setup/SetupGuideDialog';
import { OfflineIndicator } from './components/pwa/OfflineIndicator';
import { BarcodeScannerModal } from './components/scanner/BarcodeScannerModal';
import { ProductFoundDialog } from './components/scanner/ProductFoundDialog';
import { ProductRegisterDialog } from './components/scanner/ProductRegisterDialog';
import { QuickStockInModal } from './components/stock/QuickStockInModal';
import { ProductStockDetailDialog } from './components/stock/ProductStockDetailDialog';
import { LoadingState } from './components/ui/LoadingState';
import { useBarcodeSearch } from './hooks/useBarcodeSearch';
import { Product, StockInResult } from './types';

export function AppContent() {
  const [currentTab, setCurrentTab] = useState<string>('dashboard');
  const [isSetupOpen, setIsSetupOpen] = useState<boolean>(false);
  const [stockRefreshCounter, setStockRefreshCounter] = useState<number>(0);

  // Scanner & Product Search Hook
  const {
    isScannerOpen,
    isSearching,
    foundProduct,
    unregisteredBarcode,
    openScanner,
    closeScanner,
    handleBarcodeScanned,
    handleProductRegistered,
    closeProductFound,
    closeProductRegister,
  } = useBarcodeSearch();

  // Stock-In Target Product
  const [stockInProduct, setStockInProduct] = useState<Product | null>(null);

  // Detailed Batch Inspection Target Product
  const [inspectedProduct, setInspectedProduct] = useState<Product | null>(null);

  // When a new product is registered, immediately offer to stock it in!
  const onRegisterSuccess = (product: Product) => {
    handleProductRegistered(product);
    setStockRefreshCounter((c) => c + 1);
  };

  const handleStockInCompleted = (result: StockInResult) => {
    setStockRefreshCounter((c) => c + 1);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-white">
      {/* Top Header */}
      <Header onOpenSetupGuide={() => setIsSetupOpen(true)} />

      {/* Main View Area */}
      <main className="flex-1 w-full max-w-md sm:max-w-xl mx-auto px-4 py-5">
        {currentTab === 'dashboard' && (
          <Dashboard
            onOpenSetupGuide={() => setIsSetupOpen(true)}
            onOpenScanner={openScanner}
            onNavigateTab={setCurrentTab}
          />
        )}
        {currentTab === 'stock' && (
          <StockView
            onOpenScanner={openScanner}
            onOpenSetupGuide={() => setIsSetupOpen(true)}
            onSelectProduct={(p) => setInspectedProduct(p)}
            onQuickStockIn={(p) => setStockInProduct(p)}
            refreshTrigger={stockRefreshCounter}
          />
        )}
        {currentTab === 'sales' && (
          <SalesView
            onOpenScanner={openScanner}
            onSearchBarcode={handleBarcodeScanned}
          />
        )}
        {currentTab === 'alerts' && (
          <AlertsView
            onOpenScanner={openScanner}
            onSelectProduct={(p) => setInspectedProduct(p)}
            onQuickStockIn={(p) => setStockInProduct(p)}
            refreshTrigger={stockRefreshCounter}
          />
        )}
      </main>

      {/* Mobile-first bottom navigation bar */}
      <BottomNav currentTab={currentTab} onSelectTab={setCurrentTab} />

      {/* Network offline toast notification */}
      <OfflineIndicator />

      {/* Supabase Connection Guide Dialog */}
      <SetupGuideDialog isOpen={isSetupOpen} onClose={() => setIsSetupOpen(false)} />

      {/* Camera Barcode Scanner Modal */}
      <BarcodeScannerModal
        isOpen={isScannerOpen}
        onClose={closeScanner}
        onBarcodeScanned={handleBarcodeScanned}
      />

      {/* Product Found Dialog (from scanning) */}
      <ProductFoundDialog
        isOpen={foundProduct !== null}
        product={foundProduct}
        onClose={closeProductFound}
        onScanAnother={() => {
          closeProductFound();
          openScanner();
        }}
        onQuickAction={(action, prod) => {
          closeProductFound();
          if (action === 'add_stock') {
            setStockInProduct(prod);
          } else if (action === 'quick_sale') {
            setCurrentTab('sales');
          }
        }}
      />

      {/* Product Registration Dialog (when barcode not found in active shop) */}
      <ProductRegisterDialog
        isOpen={unregisteredBarcode !== null}
        initialBarcode={unregisteredBarcode || ''}
        onClose={closeProductRegister}
        onProductRegistered={onRegisterSuccess}
      />

      {/* Quick Stock-In Modal */}
      <QuickStockInModal
        isOpen={stockInProduct !== null}
        product={stockInProduct}
        onClose={() => setStockInProduct(null)}
        onStockInSuccess={handleStockInCompleted}
        onStockInAnother={() => {
          setStockInProduct(null);
          openScanner();
        }}
      />

      {/* Product Stock & Batches Inspection Dialog */}
      <ProductStockDetailDialog
        isOpen={inspectedProduct !== null}
        product={inspectedProduct}
        onClose={() => setInspectedProduct(null)}
        onOpenStockIn={(prod) => {
          setInspectedProduct(null);
          setStockInProduct(prod);
        }}
      />

      {/* Global Searching Overlay */}
      {isSearching && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-xl flex flex-col items-center">
            <LoadingState message="Searching shop catalog..." />
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <AppContent />
    </LanguageProvider>
  );
}
