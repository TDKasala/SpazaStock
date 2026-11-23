import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { LanguageProvider, useLanguage } from './context/LanguageContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ShopProvider, useShop, useShopId } from './context/ShopContext';
import { SyncProvider } from './context/SyncContext';
import { Header } from './components/layout/Header';
import { BottomNav } from './components/layout/BottomNav';
import { SHOP_SHELL_WIDTH } from './components/layout/shell';
import { Dashboard } from './components/dashboard/Dashboard';
import { StockView } from './components/views/StockView';
import { SalesView } from './components/views/SalesView';
import { AlertsView } from './components/views/AlertsView';
import { MoreView } from './components/views/MoreView';
import { WholesaleOrders } from './components/wholesale/WholesaleOrders';
import { OfflineIndicator } from './components/pwa/OfflineIndicator';
import { PWAInstallBanner, pwaInstallLayoutPadding } from './components/pwa/PWAInstallBanner';
import { usePWAInstall } from './hooks/usePWAInstall';
import { SyncBanner } from './components/sync/SyncBanner';
import { ProductFoundDialog } from './components/scanner/ProductFoundDialog';
import { ProductRegisterDialog, type LookupOrigin } from './components/scanner/ProductRegisterDialog';
import { QuickStockInModal } from './components/stock/QuickStockInModal';
import { ProductStockDetailDialog } from './components/stock/ProductStockDetailDialog';
import { UnknownBarcodeDialog } from './components/stock/UnknownBarcodeDialog';
import { LinkBarcodeDialog } from './components/stock/LinkBarcodeDialog';
import { LandingPage } from './components/auth/LandingPage';
import { LoginPage } from './components/auth/LoginPage';
import { ShopOnboarding } from './components/auth/ShopOnboarding';
import { CatalogReview } from './components/catalog/CatalogReview';
import { InviteAcceptScreen } from './components/auth/InviteAcceptScreen';
import { NewPasswordScreen } from './components/auth/ResetPasswordScreen';
import { TeamView } from './components/team/TeamView';
import { RevokedNotice } from './components/layout/RevokedNotice';
import { SuspendedNotice } from './components/layout/SuspendedNotice';
import { LoadingState } from './components/ui/LoadingState';
import { RapidSellPanel, RapidSellSummary } from './components/sales/RapidSellPanel';
import { useSaleRegister } from './hooks/useSaleRegister';
import { useExpiryAlerts } from './hooks/useExpiryAlerts';
import { useStockIntelligence } from './hooks/useStockIntelligence';
import { resolveInventoryScan, type InventoryScan } from './services/scanRoute';
import { onDataChanged } from './lib/events';
import { refreshPushSubscription } from './lib/push';
import { captureInviteFromUrl } from './lib/invite';
import { can } from './lib/permissions';
import { clearFreshSignIn, hasFreshSignIn, postSignInDestination } from './lib/platformAdmin';
import { loggedOutRedirect } from './lib/signInRedirect';
import { markSuspendedSignInDenied } from './lib/suspendedSignIn';
import type { CatalogMatch, Product, ProductLookupSuggestion, ResolvedBarcode, ScanMode } from './types';

// The scanner (and its WASM decoder fallback) is only needed once the camera opens.
const BarcodeScannerModal = lazy(() =>
  import('./components/scanner/BarcodeScannerModal').then((m) => ({ default: m.BarcodeScannerModal }))
);

// Platform administration lives at /admin and is never downloaded by shop phones.
const AdminApp = lazy(() => import('./admin/AdminApp').then((m) => ({ default: m.AdminApp })));

function isAdminPath(): boolean {
  return typeof window !== 'undefined' && /^\/admin(\/|$)/.test(window.location.pathname);
}

/** 'team' is reached from the shop menu, not the bottom navigation. */
export type AppTab = 'dashboard' | 'stock' | 'sales' | 'alerts' | 'list' | 'more' | 'team';

interface RegisterRequest {
  barcode: string;
  mode: ScanMode;
  suggestion?: ProductLookupSuggestion | null;
  origin: LookupOrigin;
  catalog?: CatalogMatch | null;
}

/** The pack or case barcode a delivery was scanned with, carried into stock-in. */
interface StockInVia {
  packagingId: string | null;
  barcodeId: string | null;
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
  const intelligence = useStockIntelligence(shopId, refreshCounter);
  const { needsInstallPrompt } = usePWAInstall();

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
  const [stockInVia, setStockInVia] = useState<StockInVia | null>(null);
  const [unknownStockBarcode, setUnknownStockBarcode] = useState<string | null>(null);
  const [linkBarcode, setLinkBarcode] = useState<string | null>(null);
  const [inspectedProduct, setInspectedProduct] = useState<Product | null>(null);

  useEffect(() => onDataChanged(() => setRefreshCounter((n) => n + 1)), []);

  const openStockIn = useCallback((product: Product, via: StockInVia | null = null) => {
    setStockInVia(via);
    setStockInProduct(product);
  }, []);

  const openStockInResolved = (resolved: ResolvedBarcode) =>
    openStockIn(
      resolved.product,
      resolved.barcodeId ? { packagingId: resolved.packaging?.id ?? null, barcodeId: resolved.barcodeId } : null
    );

  const applyInventoryScan = useCallback(
    (scan: InventoryScan) => {
      if (scan.screen === 'stock_in') {
        openStockIn(
          scan.product,
          scan.barcodeId ? { packagingId: scan.packagingId, barcodeId: scan.barcodeId } : null
        );
        return;
      }
      if (scan.screen === 'found') {
        setFoundProduct(scan.product);
        return;
      }
      if (scan.screen === 'unknown_stock') {
        setUnknownStockBarcode(scan.barcode);
        return;
      }
      setRegisterRequest({
        barcode: scan.barcode,
        mode: scan.mode,
        suggestion: scan.suggestion,
        origin: scan.origin,
        catalog: scan.catalog,
      });
    },
    [openStockIn]
  );

  const handleUnknownSaleBarcode = useCallback(
    (barcode: string) => {
      setScanMode(null);
      void (async () => {
        applyInventoryScan(await resolveInventoryScan(barcode, shopId, 'sell'));
      })();
    },
    [applyInventoryScan, shopId]
  );
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

    if (mode === 'sell') {
      setCurrentTab('sales');
      await saleRegister.stageBarcode(barcode);
      return;
    }

    setScanMode(null);

    setIsSearching(true);
    try {
      applyInventoryScan(await resolveInventoryScan(barcode, shopId, mode));
    } finally {
      setIsSearching(false);
    }
  };

  const handleProductRegistered = (product: Product) => {
    const mode = registerRequest?.mode ?? 'lookup';
    setRegisterRequest(null);
    if (mode === 'stock_in') openStockIn(product);
    else setFoundProduct(product);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-white">
      <Header onOpenTeam={() => setCurrentTab('team')} />

      <main
        className={`flex-1 w-full ${SHOP_SHELL_WIDTH} mx-auto px-4 py-5 ${pwaInstallLayoutPadding(needsInstallPrompt)}`}
      >
        <RevokedNotice className="mb-4" />
        <SuspendedNotice />
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
            onQuickStockIn={openStockIn}
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
            onQuickStockIn={openStockIn}
            refreshTrigger={refreshCounter}
            lowStock={intelligence.lowStock}
            products={intelligence.products}
          />
        )}
        {currentTab === 'list' && (
          <WholesaleOrders
            products={intelligence.products}
            batches={intelligence.batches}
            timezone={intelligence.timezone}
          />
        )}
        {currentTab === 'more' && (
          <MoreView
            lowStock={intelligence.lowStock}
            products={intelligence.products}
            sales={intelligence.sales}
            batches={intelligence.batches}
            timezone={intelligence.timezone}
            isLoadingIntelligence={intelligence.isLoading}
          />
        )}
      </main>

      <PWAInstallBanner />
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
            footer={
              scanMode === 'sell' && (
                <RapidSellSummary
                  register={saleRegister}
                  onDone={() => {
                    void saleRegister.commitPendingSale().then((ok) => {
                      if (ok) setScanMode(null);
                    });
                  }}
                />
              )
            }
          >
            {scanMode === 'sell' && <RapidSellPanel register={saleRegister} />}
          </BarcodeScannerModal>
        </Suspense>
      )}

      <ProductFoundDialog
        isOpen={foundProduct !== null}
        product={foundProduct}
        onClose={() => setFoundProduct(null)}
        onScanAnother={() => openScanner('lookup')}
        onQuickAction={(action, product) => {
          if (product.listed === false) return;
          setFoundProduct(null);
          if (action === 'add_stock') {
            openStockIn(product);
          } else {
            setCurrentTab('sales');
            void saleRegister.sellProduct(product, 1);
          }
        }}
        onRestored={setFoundProduct}
      />

      <ProductRegisterDialog
        isOpen={registerRequest !== null}
        initialBarcode={registerRequest?.barcode ?? ''}
        suggestion={registerRequest?.suggestion}
        origin={registerRequest?.origin ?? 'manual'}
        catalog={registerRequest?.catalog}
        onLinkExisting={
          registerRequest?.mode === 'stock_in' && can(settings.role, 'products.edit')
            ? () => {
                setLinkBarcode(registerRequest.barcode);
                setRegisterRequest(null);
              }
            : undefined
        }
        onClose={() => setRegisterRequest(null)}
        onProductRegistered={handleProductRegistered}
      />

      <UnknownBarcodeDialog
        isOpen={unknownStockBarcode !== null}
        barcode={unknownStockBarcode ?? ''}
        canLink={can(settings.role, 'products.edit')}
        onClose={() => setUnknownStockBarcode(null)}
        onLinkExisting={() => {
          setLinkBarcode(unknownStockBarcode);
          setUnknownStockBarcode(null);
        }}
        onCreateNew={() => {
          const barcode = unknownStockBarcode ?? '';
          setUnknownStockBarcode(null);
          setRegisterRequest({ barcode, mode: 'stock_in', suggestion: null, origin: 'manual', catalog: null });
        }}
      />

      <LinkBarcodeDialog
        isOpen={linkBarcode !== null}
        barcode={linkBarcode ?? ''}
        onClose={() => setLinkBarcode(null)}
        onLinked={(resolved) => {
          setLinkBarcode(null);
          openStockInResolved(resolved);
        }}
      />

      <QuickStockInModal
        isOpen={stockInProduct !== null}
        product={stockInProduct}
        packagingId={stockInVia?.packagingId ?? null}
        barcodeId={stockInVia?.barcodeId ?? null}
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
          openStockIn(product);
        }}
        onProductChanged={setInspectedProduct}
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
  const { shop, isLoading, accessDenied, completeCatalogPrompt } = useShop();
  const { signOut } = useAuth();
  const signingOut = useRef(false);

  useEffect(() => {
    if (!accessDenied || signingOut.current) return;
    signingOut.current = true;
    markSuspendedSignInDenied();
    void signOut();
  }, [accessDenied, signOut]);

  if (isLoading || accessDenied) return <FullScreenLoading />;
  if (!shop) return <ShopOnboarding />;
  if (shop.catalogPromptPending && (shop.role === 'owner' || shop.role === 'manager')) {
    return <CatalogReview shopId={shop.id} canEdit onFinishLater={completeCatalogPrompt} />;
  }
  // Keyed by shop so switching shops restarts sync and resets every screen.
  return (
    <SyncProvider key={shop.id}>
      <AppContent />
    </SyncProvider>
  );
}

/** Right after signing in, platform admins go to the console; everyone else continues to their shop. */
function PostSignInCheck({ onStay }: { onStay: () => void }) {
  useEffect(() => {
    let cancelled = false;
    void postSignInDestination().then((destination) => {
      if (cancelled) return;
      if (destination) window.location.replace(destination);
      else onStay();
    });
    return () => {
      cancelled = true;
    };
  }, [onStay]);
  return <FullScreenLoading />;
}

/** Signed-out people always land on the login page, including a visit to the overview. */
function SignedOutScreen() {
  const destination = loggedOutRedirect(window.location.pathname);
  if (destination) {
    window.location.replace(destination);
    return <FullScreenLoading />;
  }
  return <LoginPage />;
}

function AuthGate() {
  const { mode, isLoading, user, isRecoveringPassword } = useAuth();
  const [inviteToken, setInviteToken] = useState<string | null>(() =>
    mode === 'cloud' ? captureInviteFromUrl() : null
  );
  const [, setSignInChecked] = useState(0);
  const handleStay = useCallback(() => setSignInChecked((n) => n + 1), []);
  if (mode === 'device') return <LandingPage notConfigured />;
  if (isLoading) return <FullScreenLoading />;
  if (user && isRecoveringPassword) return <NewPasswordScreen />;
  if (inviteToken) {
    return <InviteAcceptScreen token={inviteToken} onDone={() => setInviteToken(null)} />;
  }
  if (!user) return <SignedOutScreen />;
  if (hasFreshSignIn()) return <PostSignInCheck onStay={handleStay} />;
  return (
    <ShopProvider>
      <ShopGate />
    </ShopProvider>
  );
}

/** Admins sign in like everyone else; the server decides what they may see. */
function AdminGate() {
  const { mode, isLoading, user } = useAuth();
  useEffect(() => {
    if (user) clearFreshSignIn();
  }, [user]);
  if (mode === 'device') return <LandingPage notConfigured />;
  if (isLoading) return <FullScreenLoading />;
  if (!user) return <SignedOutScreen />;
  return (
    <Suspense fallback={<FullScreenLoading />}>
      <AdminApp />
    </Suspense>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <AuthProvider>{isAdminPath() ? <AdminGate /> : <AuthGate />}</AuthProvider>
    </LanguageProvider>
  );
}
