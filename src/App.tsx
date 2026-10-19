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
import { MoreView } from './components/views/MoreView';
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
import { ShopOnboarding } from './components/auth/ShopOnboarding';
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
import { isArchived, resolveBarcode } from './services/productService';
import { cacheShopProductLocally, lookupProductByBarcode } from './services/productLookupService';
import { onDataChanged } from './lib/events';
import { refreshPushSubscription } from './lib/push';
import { captureInviteFromUrl } from './lib/invite';
import { can } from './lib/permissions';
import { clearFreshSignIn, hasFreshSignIn, postSignInDestination } from './lib/platformAdmin';
import type { CatalogMatch, Product, ProductLookupResult, ProductLookupSuggestion, ResolvedBarcode, ScanMode } from './types';
import { parseGs1 } from './lib/barcode/gs1';
import { playScanBeep, vibrateScan } from './lib/barcode/feedback';

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
export type AppTab = 'dashboard' | 'stock' | 'sales' | 'alerts' | 'more' | 'team';

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

interface StockInPrefill {
  expiryDate: string | null;
  lotNumber: string | null;
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
  const [stockInPrefill, setStockInPrefill] = useState<StockInPrefill | null>(null);
  const [unknownStockBarcode, setUnknownStockBarcode] = useState<string | null>(null);
  const [linkBarcode, setLinkBarcode] = useState<string | null>(null);
  const [inspectedProduct, setInspectedProduct] = useState<Product | null>(null);

  useEffect(() => onDataChanged(() => setRefreshCounter((n) => n + 1)), []);

  const openStockIn = useCallback((product: Product, via: StockInVia | null = null) => {
    setStockInVia(via);
    setStockInPrefill((prev) => prev); // keep last prefill by default; cleared when closing
    setStockInProduct(product);
  }, []);

  const openStockInResolved = (resolved: ResolvedBarcode) =>
    openStockIn(
      resolved.product,
      resolved.barcodeId ? { packagingId: resolved.packaging?.id ?? null, barcodeId: resolved.barcodeId } : null
    );

  const routeLookup = useCallback(
    async (barcode: string, mode: ScanMode, lookup: ProductLookupResult) => {
      if (lookup.status === 'found' && lookup.matchSource === 'shop' && lookup.shopProduct) {
        const product = await cacheShopProductLocally(lookup.shopProduct);
        if (mode === 'stock_in' && !isArchived(product)) openStockIn(product);
        else setFoundProduct(product);
        return;
      }
      const suggestion = lookup.status === 'found' && lookup.suggestion ? lookup.suggestion : null;
      if (suggestion && (lookup.matchSource === 'catalog' || lookup.matchSource === 'open_food_facts' || lookup.matchSource === 'cache')) {
        setRegisterRequest({
          barcode,
          mode,
          suggestion,
          origin: lookup.matchSource === 'catalog' ? 'catalog' : 'open_food_facts',
          catalog: lookup.catalog ?? null,
        });
        return;
      }
      if (mode === 'stock_in') {
        setUnknownStockBarcode(barcode);
        return;
      }
      setRegisterRequest({
        barcode,
        mode,
        suggestion: null,
        origin: lookup.status === 'not_found' || lookup.status === 'invalid_barcode' ? 'manual' : 'failed',
        catalog: null,
      });
    },
    [openStockIn]
  );

  const handleUnknownSaleBarcode = useCallback(
    (barcode: string) => {
      setScanMode(null);
      void (async () => {
        const lookup = await lookupProductByBarcode(barcode, shopId);
        await routeLookup(barcode, 'sell', lookup);
      })();
    },
    [routeLookup, shopId]
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

  const openRegister = async (barcode: string, mode: ScanMode) => {
    const lookup = await lookupProductByBarcode(barcode, shopId);
    await routeLookup(barcode, mode, lookup);
  };

  const handleBarcodeScanned = async (barcode: string) => {
    const mode = scanMode ?? 'lookup';

    // Parse GS1 element string for GTIN/expiry/lot; fall back to plain code unchanged.
    const parsed = parseGs1(barcode);
    let lookupCodes: string[] = [];
    let prefillExpiry: string | null = null;
    let prefillLot: string | null = null;
    if (parsed.kind === 'gs1') {
      lookupCodes = parsed.lookupBarcodes;
      prefillExpiry = parsed.expiry;
      prefillLot = parsed.lot ?? null;
    } else {
      lookupCodes = [barcode.trim()];
    }

    if (mode === 'sell') {
      setCurrentTab('sales');
      // For GS1, prefer the GTIN candidate.
      await saleRegister.stageBarcode(lookupCodes[0] ?? '');
      return;
    }

    setScanMode(null);

    setIsSearching(true);
    try {
      let resolved: ResolvedBarcode | null = null;
      for (const candidate of lookupCodes) {
        // Stop at the first match; candidates are ordered by specificity.
        // eslint-disable-next-line no-await-in-loop
        const r = await resolveBarcode(candidate, shopId);
        if (r) {
          resolved = r;
          break;
        }
      }
      if (!resolved) {
        // Unknown: keep the most human-friendly code for registration (prefer EAN-13 if we have it).
        const regCode = lookupCodes.find((c) => c.length === 13) ?? lookupCodes[0] ?? barcode;
        await openRegister(regCode, mode);
        // Error feedback for an unknown code in immediate stock-in.
        if (mode === 'stock_in') vibrateScan([70, 40, 40]);
      }
      else if (mode === 'stock_in' && !isArchived(resolved.product)) openStockInResolved(resolved);
      else setFoundProduct(resolved.product);
      if (resolved && mode === 'stock_in') {
        // Prefill GS1 expiry/lot for the stock-in modal.
        setStockInPrefill({ expiryDate: prefillExpiry, lotNumber: prefillLot });
        playScanBeep();
        vibrateScan(50);
      }
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
        className={`flex-1 w-full max-w-md sm:max-w-xl mx-auto px-4 py-5 ${pwaInstallLayoutPadding(needsInstallPrompt)}`}
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
            onHardwareScan={(code) => {
              // Route HID scan into the same flow as camera scans in stock-in mode.
              setScanMode(null);
              void handleBarcodeScanned(code);
            }}
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
        prefillExpiryDate={stockInPrefill?.expiryDate ?? null}
        prefillLotNumber={stockInPrefill?.lotNumber ?? null}
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

function AuthGate() {
  const { mode, isLoading, user, isRecoveringPassword } = useAuth();
  const [inviteToken, setInviteToken] = useState<string | null>(() =>
    mode === 'cloud' ? captureInviteFromUrl() : null
  );
  const [, setSignInChecked] = useState(0);
  const handleStay = useCallback(() => setSignInChecked((n) => n + 1), []);
  
  // TESTING: Bypass auth for device mode
  if (mode === 'device') {
    return (
      <ShopProvider>
        <ShopGate />
      </ShopProvider>
    );
  }
  
  if (isLoading) return <FullScreenLoading />;
  if (user && isRecoveringPassword) return <NewPasswordScreen />;
  if (inviteToken) {
    return <InviteAcceptScreen token={inviteToken} onDone={() => setInviteToken(null)} />;
  }
  if (!user) return <LandingPage />;
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
  if (!user) return <LandingPage />;
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
