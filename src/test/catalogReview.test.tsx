import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CatalogReview } from '../components/catalog/CatalogReview';
import { LanguageProvider } from '../context/LanguageContext';
import {
  confirmShopCatalog,
  listShopCatalogReview,
  reviewShopCatalog,
  type CatalogReviewItem,
  type CatalogReviewPage,
} from '../services/catalogService';

vi.mock('../services/catalogService', () => ({
  listShopCatalogReview: vi.fn(),
  reviewShopCatalog: vi.fn(),
  confirmShopCatalog: vi.fn(),
}));

vi.mock('../components/scanner/BarcodeScannerModal', () => ({
  BarcodeScannerModal: ({ onBarcodeScanned }: { onBarcodeScanned: (code: string) => void }) => (
    <button type="button" onClick={() => onBarcodeScanned('6001087354019')}>
      Mock scan
    </button>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const maize: CatalogReviewItem = {
  id: 'maize',
  name: 'Maize meal',
  brand: 'Ace',
  category: 'groceries',
  packageSize: '2.5kg',
  shopProductId: null,
  listed: null,
  barcodes: [{ barcode: '6001087354019', kind: 'unit', unitsPerPackage: null }],
};

const rice: CatalogReviewItem = {
  id: 'rice',
  name: 'Rice',
  brand: 'Ace',
  category: 'groceries',
  packageSize: '1kg',
  shopProductId: null,
  listed: null,
  barcodes: [{ barcode: '6001087354020', kind: 'unit', unitsPerPackage: null }],
};

const hidden: CatalogReviewItem = {
  ...rice,
  id: 'soap',
  name: 'Soap',
  shopProductId: 'shop-soap',
  listed: false,
  barcodes: [],
};

function page(items: CatalogReviewItem[]): CatalogReviewPage {
  return { items, total: items.length, progress: { total: 3, selling: 0, hidden: 1, open: 2 } };
}

let container: HTMLDivElement;
let root: Root;

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(<LanguageProvider>{element}</LanguageProvider>);
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
}

function button(label: string) {
  return [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
}

beforeEach(() => {
  vi.mocked(listShopCatalogReview).mockReset();
  vi.mocked(reviewShopCatalog).mockReset();
  vi.mocked(confirmShopCatalog).mockReset();
  vi.mocked(reviewShopCatalog).mockResolvedValue({ data: { products: [] } });
  vi.mocked(confirmShopCatalog).mockResolvedValue({ data: { products: [] } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('CatalogReview', () => {
  it('searches, confirms, hides, and finishes later', async () => {
    vi.mocked(listShopCatalogReview).mockResolvedValue({ data: page([maize]) });
    const onFinishLater = vi.fn();
    await render(<CatalogReview shopId="shop-1" canEdit onFinishLater={onFinishLater} />);
    await settle();

    const search = container.querySelector('input');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(search, 'maize');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(listShopCatalogReview).toHaveBeenCalledWith('shop-1', expect.objectContaining({ query: 'maize' }));

    await act(async () => {
      button('I sell this')?.click();
    });
    await settle();
    expect(reviewShopCatalog).toHaveBeenCalledWith('shop-1', [
      { catalogProductId: 'maize', decision: 'sell', buyingPrice: null, sellingPrice: null },
    ]);

    await act(async () => {
      button('I do not sell this')?.click();
    });
    await settle();
    expect(reviewShopCatalog).toHaveBeenCalledWith('shop-1', [
      { catalogProductId: 'maize', decision: 'hide', buyingPrice: null, sellingPrice: null },
    ]);

    await act(async () => {
      button('Finish later')?.click();
    });
    await settle();
    expect(confirmShopCatalog).toHaveBeenCalledWith('shop-1', []);
    expect(onFinishLater).toHaveBeenCalledTimes(1);
  });

  it('unhides a hidden product and sells the ticked rows in one call', async () => {
    vi.mocked(listShopCatalogReview).mockResolvedValue({ data: page([maize, hidden]) });
    await render(<CatalogReview shopId="shop-1" canEdit />);
    await settle();

    await act(async () => {
      button('Show it again')?.click();
    });
    expect(reviewShopCatalog).toHaveBeenCalledWith('shop-1', [
      { catalogProductId: 'soap', decision: 'sell', buyingPrice: null, sellingPrice: null },
    ]);

    const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await act(async () => {
      boxes.forEach((box) => box.click());
    });
    await act(async () => {
      button('I sell the ticked ones')?.click();
    });
    await settle();
    expect(reviewShopCatalog).toHaveBeenLastCalledWith('shop-1', [
      { catalogProductId: 'maize', decision: 'sell', buyingPrice: null, sellingPrice: null },
      { catalogProductId: 'soap', decision: 'sell', buyingPrice: null, sellingPrice: null },
    ]);
  });

  it('searches the barcode from the scanner', async () => {
    vi.mocked(listShopCatalogReview).mockResolvedValue({ data: page([maize]) });
    await render(<CatalogReview shopId="shop-1" canEdit />);
    await settle();
    await act(async () => {
      button('Scan a barcode')?.click();
    });
    await act(async () => {
      button('Mock scan')?.click();
    });
    await settle();
    expect(listShopCatalogReview).toHaveBeenCalledWith(
      'shop-1',
      expect.objectContaining({ query: '6001087354019' })
    );
  });
});
