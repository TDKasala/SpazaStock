import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LanguageProvider } from '../context/LanguageContext';
import { adminApi } from '../admin/api';
import { CatalogPage } from '../admin/pages/CatalogPage';
import { CatalogEditorPage } from '../admin/pages/CatalogEditorPage';
import type { CatalogProductDetail, CatalogSearchPage } from '../admin/types';

vi.mock('../admin/api', () => ({
  adminApi: {
    searchCatalog: vi.fn(),
    getCatalogProduct: vi.fn(),
    saveCatalogProduct: vi.fn(),
    linkCatalogBarcode: vi.fn(),
    unlinkCatalogBarcode: vi.fn(),
    setCatalogImage: vi.fn(),
  },
  adminErrorMessage: () => 'error',
  uploadCatalogImage: vi.fn(),
}));

vi.mock('../components/scanner/BarcodeScannerModal', () => ({
  BarcodeScannerModal: ({
    isOpen,
    onBarcodeScanned,
  }: {
    isOpen: boolean;
    onBarcodeScanned: (barcode: string) => void;
  }) =>
    isOpen ? (
      <button type="button" onClick={() => onBarcodeScanned('6001007300123')}>
        scan-code
      </button>
    ) : null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CATALOG_ID = '6f1c2a4e-1b2c-4d3e-8f90-123456789abc';

const page: CatalogSearchPage = {
  ok: true,
  total: 1,
  limit: 25,
  offset: 0,
  rows: [
    {
      id: CATALOG_ID,
      name: 'Shared Maize',
      brand: 'Ace',
      category: 'groceries',
      package_size: '2.5kg',
      package_quantity: null,
      package_unit: null,
      image_url: null,
      image_path: null,
      verification_status: 'verified',
      barcodes: [{ barcode: '6001087354019', kind: 'unit', units_per_package: null }],
    },
  ],
};

const detail: CatalogProductDetail = {
  ok: true,
  product: page.rows[0],
  barcodes: page.rows[0].barcodes ?? [],
};

let container: HTMLDivElement;
let root: Root;

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(<LanguageProvider>{element}</LanguageProvider>);
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  vi.mocked(adminApi.searchCatalog).mockReset();
  vi.mocked(adminApi.getCatalogProduct).mockReset();
  vi.mocked(adminApi.searchCatalog).mockResolvedValue(page);
  vi.mocked(adminApi.getCatalogProduct).mockResolvedValue(detail);
  window.history.pushState(null, '', '/admin/catalog');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('admin catalogue screens', () => {
  it('searches the catalogue and opens a product', async () => {
    await render(<CatalogPage />);
    await settle();
    expect(adminApi.searchCatalog).toHaveBeenCalledWith('', 25, 0);
    expect(container.textContent).toContain('Shared Maize');
    expect(container.textContent).not.toContain('Buying price');

    const search = container.querySelector('#catalog-search') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(search, 'Maize');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      search.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(adminApi.searchCatalog).toHaveBeenCalledWith('Maize', 25, 0);

    const link = container.querySelector('a') as HTMLAnchorElement;
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(window.location.pathname).toBe(`/admin/catalog/${CATALOG_ID}`);
  });

  it('puts a scanned barcode into the editor field', async () => {
    await render(<CatalogEditorPage catalogId={CATALOG_ID} />);
    await settle();
    expect((container.querySelector('#catalog-name') as HTMLInputElement).value).toBe('Shared Maize');
    expect(container.querySelector('#catalog-package-size')).toBeTruthy();
    expect(container.querySelector('[name="buyingPrice"]')).toBeNull();

    const scan = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Scan barcode'));
    await act(async () => {
      scan?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    const fakeScan = [...container.querySelectorAll('button')].find((button) => button.textContent === 'scan-code');
    await act(async () => {
      fakeScan?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect((container.querySelector('#catalog-barcode') as HTMLInputElement).value).toBe('6001007300123');
  });
});
