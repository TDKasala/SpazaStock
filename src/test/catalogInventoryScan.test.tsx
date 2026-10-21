import React, { useEffect, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductFoundDialog } from '../components/scanner/ProductFoundDialog';
import { ProductRegisterDialog } from '../components/scanner/ProductRegisterDialog';
import { QuickStockInModal } from '../components/stock/QuickStockInModal';
import { UnknownBarcodeDialog } from '../components/stock/UnknownBarcodeDialog';
import { LanguageProvider } from '../context/LanguageContext';
import { resetLocalDatabase } from '../lib/db';
import { saveShopSettings } from '../lib/shopSettings';
import { lookupProductByBarcode } from '../services/productLookupService';
import { resolveBarcode } from '../services/productService';
import { resolveInventoryScan, type InventoryScan } from '../services/scanRoute';
import type { Product, ProductLookupResult, ScanMode } from '../types';
import { SHOP_ID } from './helpers';

vi.mock('../services/productService', async () => {
  const actual = await vi.importActual<typeof import('../services/productService')>('../services/productService');
  return { ...actual, resolveBarcode: vi.fn() };
});

vi.mock('../services/productLookupService', async () => {
  const actual = await vi.importActual<typeof import('../services/productLookupService')>(
    '../services/productLookupService'
  );
  return { ...actual, lookupProductByBarcode: vi.fn() };
});

vi.mock('../context/ShopContext', () => ({
  useShopId: () => '11111111-1111-4111-8111-111111111111',
  useShop: () => ({ settings: { role: 'owner', timezone: 'Africa/Johannesburg', reminderDays: [21, 14, 7] } }),
}));

vi.mock('../hooks/useSyncStatus', () => ({
  useSyncStatus: () => ({ status: 'synced', pending: 0, failed: 0 }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LISTED = '6009900000011';
const HIDDEN = '6009900000012';
const UNKNOWN = '6009900000013';

function product(barcode: string, name: string, listed: boolean): Product {
  return {
    id: barcode,
    shopId: SHOP_ID,
    barcode,
    name,
    category: 'groceries',
    buyingPrice: 10,
    sellingPrice: 15,
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    archivedAt: null,
    listed,
    catalogProductId: 'catalog-1',
  };
}

function shopLookup(row: Product): ProductLookupResult {
  return { status: 'found', matchSource: 'shop', barcode: row.barcode, shopProduct: row };
}

function Outcome({ barcode, mode }: { barcode: string; mode: ScanMode }) {
  const [scan, setScan] = useState<InventoryScan | null>(null);
  const [registerBarcode, setRegisterBarcode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void resolveInventoryScan(barcode, SHOP_ID, mode).then((next) => {
      if (!cancelled) setScan(next);
    });
    return () => {
      cancelled = true;
    };
  }, [barcode, mode]);

  if (!scan) return null;
  if (scan.screen === 'stock_in') {
    return (
      <QuickStockInModal
        isOpen
        product={scan.product}
        packagingId={scan.packagingId}
        barcodeId={scan.barcodeId}
        onClose={() => undefined}
      />
    );
  }
  if (scan.screen === 'found') {
    return (
      <ProductFoundDialog
        isOpen
        product={scan.product}
        onClose={() => undefined}
        onScanAnother={() => undefined}
        onQuickAction={() => undefined}
      />
    );
  }
  if (scan.screen === 'unknown_stock') {
    return (
      <>
        <UnknownBarcodeDialog
          isOpen={registerBarcode === null}
          barcode={scan.barcode}
          canLink
          onLinkExisting={() => undefined}
          onCreateNew={() => setRegisterBarcode(scan.barcode)}
          onClose={() => undefined}
        />
        {registerBarcode && (
          <ProductRegisterDialog
            isOpen
            initialBarcode={registerBarcode}
            suggestion={null}
            origin="manual"
            catalog={null}
            onClose={() => undefined}
            onProductRegistered={() => undefined}
          />
        )}
      </>
    );
  }
  return (
    <ProductRegisterDialog
      isOpen
      initialBarcode={scan.barcode}
      suggestion={scan.suggestion}
      origin={scan.origin}
      catalog={scan.catalog}
      onClose={() => undefined}
      onProductRegistered={() => undefined}
    />
  );
}

let container: HTMLDivElement;
let root: Root;

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(<LanguageProvider>{element}</LanguageProvider>);
  });
}

async function waitForText(text: string) {
  for (let i = 0; i < 50 && !container.textContent?.includes(text); i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  expect(container.textContent).toContain(text);
}

describe('catalogue scan routing', () => {
  beforeEach(async () => {
    await resetLocalDatabase();
    await saveShopSettings(SHOP_ID, { role: 'owner' });
    vi.mocked(resolveBarcode).mockReset();
    vi.mocked(lookupProductByBarcode).mockReset();
    vi.mocked(resolveBarcode).mockResolvedValue(null);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('opens stock-in for a listed catalogue product already in the shop', async () => {
    vi.mocked(lookupProductByBarcode).mockResolvedValue(shopLookup(product(LISTED, 'Sunflower oil', true)));
    await render(<Outcome barcode={LISTED} mode="stock_in" />);
    await waitForText('Stock-In Delivery');
    expect(container.textContent).not.toContain('Register New Product');
    expect(lookupProductByBarcode).toHaveBeenCalledWith(LISTED, SHOP_ID);
  });

  it('does not offer stock-in or a sale for a hidden product, and does once it is listed again', async () => {
    vi.mocked(lookupProductByBarcode).mockResolvedValue(shopLookup(product(HIDDEN, 'Sunflower oil', false)));
    await render(<Outcome barcode={HIDDEN} mode="stock_in" />);
    await waitForText('is hidden in this shop');
    expect(container.textContent).not.toContain('Stock-In Delivery');
    expect(container.textContent).not.toContain('Add Stock Batch');
    expect(container.textContent).not.toContain('Sell 1 Unit');

    vi.mocked(lookupProductByBarcode).mockResolvedValue(shopLookup(product(HIDDEN, 'Sunflower oil', true)));
    await render(<Outcome barcode={HIDDEN} mode="lookup" />);
    await waitForText('Add Stock Batch');
    expect(container.textContent).toContain('Sell 1 Unit');
    expect(container.textContent).not.toContain('is hidden in this shop');
  });

  it('still opens registration for a barcode the shop and the catalogue do not know', async () => {
    vi.mocked(lookupProductByBarcode).mockResolvedValue({
      status: 'not_found',
      barcode: UNKNOWN,
      matchSource: 'open_food_facts',
    });
    await render(<Outcome barcode={UNKNOWN} mode="stock_in" />);
    await waitForText('New barcode');
    const create = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Create a new product')
    );
    expect(create).toBeTruthy();
    await act(async () => {
      create!.click();
    });
    await waitForText('Register New Product');
  });
});
