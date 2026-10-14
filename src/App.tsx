import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { LanguageProvider, useLanguage } from './context/LanguageContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ShopProvider, useShop, useShopId } from './context/ShopContext';
import { SyncProvider } from './context/SyncContext';
import { Header } from './components/layout/Header';
import { BottomNav } from './components/layout/BottomNav';
import { Dashboard } from './components/dashboard/Dashboard';
import { StockView } from './components/views/StockView';
import { SalesView } from './components/views/SalesView';
import { AlertsView } from './components/views/AlertsView';
import { OfflineIndicator } from './components/pwa/OfflineIndicator';
import { SyncBanner } from './components/sync/SyncBanner';
import { ProductFoundDialog } from './components/scanner/ProductFoundDialog';
import { ProductRegisterDialog } from './components/scanner/ProductRegisterDialog';
import { QuickStockInModal } from './components/stock/QuickStockInModal';
import { ProductStockDetailDialog } from './components/stock/ProductStockDetailDialog';
import { SignInScreen } from './components/auth/SignInScreen';
import { ShopOnboarding } from './components/auth/ShopOnboarding';
import { InviteAcceptScreen } from './components/auth/InviteAcceptScreen';
import { NewPasswordScreen } from './components/auth/ResetPasswordScreen';
import { TeamView } from './components/team/TeamView';
import { RevokedNotice } from './components/layout/RevokedNotice';
import { LoadingState } from './components/ui/LoadingState';
import { RapidSellPanel } from './components/sales/RapidSellPanel';
import { useSaleRegister } from './hooks/useSaleRegister';
import { useExpiryAlerts } from './hooks/useExpiryAlerts';
import { searchProductByBarcode } from './services/productService';
import { onDataChanged } from './lib/events';
import { refreshPushSubscription } from './lib/push';
import { captureInviteFromUrl } from './lib/invite';
import { can } from './lib/permissions';
import type { Product, ScanMode } from './types';

// html5-qrcode is large and only needed once the camera opens.
const BarcodeScannerModal = lazy(() =>
  import('./components/scanner/BarcodeScannerModal').then((m) => ({ default: m.BarcodeScannerModal }))
);

/** 'team' is reached from the shop menu, not the bottom navigation. */
export type AppTab = 'dashboard' | 'stock' | 'sales' | 'alerts' | 'team';

interface RegisterRequest {
  barcode: string;
  mode: ScanMode;
}

/** Notifications open the app at `/?tab=alerts`. */
function initialTab(): AppTab {
  if (typeof window === 'undefined') return 'dashboard';
  const params = new URLSearchParams(window.location.search);
  if (params.get('tab') !== 'alerts') return 'dashboard';
  params.delete('tab');
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  return 'alerts';
}

export function AppContent() {
  const shopId = useShopId();
  const { settings } = useShop();
  const { t } = useLanguage();
  const { mode } = useAuth();
  const [currentTab, setCurrentTab] = useState<AppTab>(initialTab);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const expiry = useExpiryAlerts(shopId, refreshCounter);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    const handleMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === 'open-alerts') setCurrentTab('alerts');
    };
    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    if (mode === 'cloud') void refreshPushSubscription();
  }, [mode, shopId]);

  const [scanMode, setScanMode] = useState<ScanMode | null>(null);
  const [hasOpenedScanner, setHasOpenedScanner] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [foundProduct, setFoundProduct] = useState<Product | null>(null);
  const [registerRequest, setRegisterRequest] = useState<RegisterRequest | null>(null);
  const [stockInProduct, setStockInProduct] = useState<Product | null>(null);
  const [inspectedProduct, setInspectedProduct] = useState<Product | null>(null);

  useEffect(() => onDataChanged(() => setRefreshCounter((n) => n + 1)), []);

  const handleUnknownSaleBarcode = useCallback((barcode: string) => {
    setScanMode(null);
    setRegisterRequest({ barcode, mode: 'sell' });
  }, []);
  const saleRegister = useSaleRegister(shopId, handleUnknownSaleBarcode);
  const { resetSession } = saleRegister;

  const openScanner = useCallback(
    (mode: ScanMode) => {
      setFoundProduct(null);
      setHasOpenedScanner(true);
      if (mode === 'sell') resetSession();
      setScanMode(mode);
    },
    [resetSession]
  );

  const handleBarcodeScanned = async (barcode: string) => {
    const mode = scanMode ?? 'lookup';

    // Rapid selling keeps the scanner open; each scan sells one unit.
    if (mode === 'sell') {
      setCurrentTab('sales');
      await saleRegister.sellBarcode(barcode);
      return;
    }

    setScanMode(null);

    setIsSearching(true);
    try {
      const product = await searchProductByBarcode(barcode, shopId);
      if (!product) setRegisterRequest({ barcode, mode });
      else if (mode === 'stock_in') setStockInProduct(product);
      else setFoundProduct(product);
    } finally {
      setIsSearching(false);
    }
  };

  const handleProductRegistered = (product: Product) => {
    const mode = registerRequest?.mode ?? 'lookup';
    setRegisterRequest(null);
    if (mode === 'stock_in') setStockInProduct(product);
    else setFoundProduct(product);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-white">
      <Header onOpenTeam={() => setCurrentTab('team')} />

      <main className="flex-1 w-full max-w-md sm:max-w-xl mx-auto px-4 py-5">
        <RevokedNotice className="mb-4" />
        <SyncBanner />
        {currentTab === 'team' && mode === 'cloud' && can(settings.role, 'team.manage') && (
          <TeamView onBack={() => setCurrentTab('dashboard')} />
        )}
        {currentTab === 'dashboard' && (
          <Dashboard
            onOpenScanner={openScanner}
            onNavigateTab={setCurrentTab}
            expiryAlerts={expiry.alerts}
            isLoadingAlerts={expiry.isLoading}
            onSelectProduct={setInspectedProduct}
          />
        )}
        {currentTab === 'stock' && (
          <StockView
            onOpenScanner={() => openScanner('stock_in')}
            onSelectProduct={setInspectedProduct}
            onQuickStockIn={setStockInProduct}
            refreshTrigger={refreshCounter}
          />
        )}
        {currentTab === 'sales' && (
          <SalesView
            register={saleRegister}
            onOpenScanner={() => openScanner('sell')}
            refreshTrigger={refreshCounter}
          />
        )}
        {currentTab === 'alerts' && (
          <AlertsView
            alerts={expiry.alerts}
            isLoading={expiry.isLoading}
            onOpenScanner={() => openScanner('lookup')}
            onSelectProduct={setInspectedProduct}
            onQuickStockIn={setStockInProduct}
            refreshTrigger={refreshCounter}
          />
        )}
      </main>

      <BottomNav currentTab={currentTab} onSelectTab={setCurrentTab} />
      <OfflineIndicator />

      {hasOpenedScanner && (
        <Suspense fallback={null}>
          <BarcodeScannerModal
            isOpen={scanMode !== null}
            title={scanMode === 'sell' ? t('sales.scanToSell') : undefined}
            onClose={() => setScanMode(null)}
            onBarcodeScanned={handleBarcodeScanned}
            continuous={scanMode === 'sell'}
          >
            {scanMode === 'sell' && <RapidSellPanel register={saleRegister} onDone={() => setScanMode(null)} />}
          </BarcodeScannerModal>
        </Suspense>
      )}

      <ProductFoundDialog
        isOpen={foundProduct !== null}
        product={foundProduct}
        onClose={() => setFoundProduct(null)}
        onScanAnother={() => openScanner('lookup')}
        onQuickAction={(action, product) => {
          setFoundProduct(null);
          if (action === 'add_stock') {
            setStockInProduct(product);
          } else {
            setCurrentTab('sales');
            void saleRegister.sellProduct(product, 1);
          }
        }}
      />

      <ProductRegisterDialog
        isOpen={registerRequest !== null}
        initialBarcode={registerRequest?.barcode ?? ''}
        onClose={() => setRegisterRequest(null)}
        onProductRegistered={handleProductRegistered}
      />

      <QuickStockInModal
        isOpen={stockInProduct !== null}
        product={stockInProduct}
        onClose={() => setStockInProduct(null)}
        onStockInAnother={() => {
          setStockInProduct(null);
          openScanner('stock_in');
        }}
      />

      <ProductStockDetailDialog
        isOpen={inspectedProduct !== null}
        product={inspectedProduct}
        refreshTrigger={refreshCounter}
        onClose={() => setInspectedProduct(null)}
        onOpenStockIn={(product) => {
          setInspectedProduct(null);
          setStockInProduct(product);
        }}
      />

      {isSearching && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-xl flex flex-col items-center">
            <LoadingState message={t('scanner.searching')} />
          </div>
        </div>
      )}
    </div>
  );
}

function FullScreenLoading() {
  const { t } = useLanguage();
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <LoadingState message={t('common.loading')} />
    </div>
  );
}

function ShopGate() {
  const { shop, isLoading } = useShop();
  if (isLoading) return <FullScreenLoading />;
  if (!shop) return <ShopOnboarding />;
  // Keyed by shop so switching shops restarts sync and resets every screen.
  return (
    <SyncProvider key={shop.id}>
      <AppContent />
    </SyncProvider>
  );
}

function AuthGate() {
  const { mode, isLoading, user, isRecoveringPassword } = useAuth();
  const [inviteToken, setInviteToken] = useState<string | null>(() =>
    mode === 'cloud' ? captureInviteFromUrl() : null
  );
  if (isLoading) return <FullScreenLoading />;
  if (mode === 'cloud' && user && isRecoveringPassword) return <NewPasswordScreen />;
  if (mode === 'cloud' && inviteToken) {
    return <InviteAcceptScreen token={inviteToken} onDone={() => setInviteToken(null)} />;
  }
  if (mode === 'cloud' && !user) return <SignInScreen />;
  return (
    <ShopProvider>
      <ShopGate />
    </ShopProvider>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </LanguageProvider>
  );
}
