import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommonCatalogSetup } from '../components/auth/CommonCatalogSetup';
import { LanguageProvider } from '../context/LanguageContext';
import { confirmShopCatalog, listCommonCatalog, type CommonCatalogItem } from '../services/catalogService';

vi.mock('../services/catalogService', () => ({
  listCommonCatalog: vi.fn(),
  confirmShopCatalog: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item: CommonCatalogItem = {
  id: 'catalog-1',
  name: 'Maize meal',
  brand: 'Ace',
  category: 'groceries',
  packageSize: '2.5kg',
  shopProductId: null,
  barcodes: [{ barcode: '6001087354019', kind: 'unit', unitsPerPackage: null }],
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
  vi.mocked(listCommonCatalog).mockReset();
  vi.mocked(confirmShopCatalog).mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('CommonCatalogSetup', () => {
  it('confirms the ticked products once, with blank prices left empty', async () => {
    vi.mocked(listCommonCatalog).mockResolvedValue({ data: [item] });
    vi.mocked(confirmShopCatalog).mockResolvedValue({ data: { products: [] } });
    const onDone = vi.fn();
    await render(<CommonCatalogSetup shopId="shop-1" onDone={onDone} />);
    await settle();

    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => {
      box?.click();
    });
    const confirm = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Add the ones I ticked')
    );
    await act(async () => {
      confirm?.click();
    });
    await settle();

    expect(confirmShopCatalog).toHaveBeenCalledTimes(1);
    expect(confirmShopCatalog).toHaveBeenCalledWith('shop-1', [
      { catalogProductId: 'catalog-1', buyingPrice: null, sellingPrice: null },
    ]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('skip sends an empty selection and does not add products', async () => {
    vi.mocked(listCommonCatalog).mockResolvedValue({ data: [item] });
    vi.mocked(confirmShopCatalog).mockResolvedValue({ data: { products: [] } });
    const onDone = vi.fn();
    await render(<CommonCatalogSetup shopId="shop-1" onDone={onDone} />);
    await settle();

    const skip = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Skip for now'));
    await act(async () => {
      skip?.click();
    });
    await settle();

    expect(confirmShopCatalog).toHaveBeenCalledTimes(1);
    expect(confirmShopCatalog).toHaveBeenCalledWith('shop-1', []);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
