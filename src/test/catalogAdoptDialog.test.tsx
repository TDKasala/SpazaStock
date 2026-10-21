import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CatalogAdoptDialog } from '../components/stock/CatalogAdoptDialog';
import { LanguageProvider } from '../context/LanguageContext';
import { resetLocalDatabase } from '../lib/db';
import { saveShopSettings } from '../lib/shopSettings';
import { SHOP_ID } from './helpers';
import { adoptCatalogProduct, searchCatalog, type CatalogSearchHit } from '../services/catalogService';

vi.mock('../context/ShopContext', () => ({
  useShopId: () => '11111111-1111-4111-8111-111111111111',
  useShop: () => ({ settings: { role: 'owner', timezone: 'Africa/Johannesburg', reminderDays: [21, 14, 7] } }),
}));

vi.mock('../services/catalogService', () => ({
  searchCatalog: vi.fn(),
  adoptCatalogProduct: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hit: CatalogSearchHit = {
  id: 'catalog-1',
  name: 'Shared Maize',
  brand: 'Ace',
  category: 'groceries',
  packageSize: '2.5kg',
  packageQuantity: null,
  packageUnit: null,
  imageUrl: null,
  imagePath: null,
  verificationStatus: 'user_submitted',
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
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
}

beforeEach(async () => {
  await resetLocalDatabase();
  await saveShopSettings(SHOP_ID, { role: 'owner' });
  vi.mocked(searchCatalog).mockReset();
  vi.mocked(adoptCatalogProduct).mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('CatalogAdoptDialog', () => {
  it('searches the shared catalogue and adopts one product with this shop’s prices', async () => {
    vi.mocked(searchCatalog).mockResolvedValue({ data: { items: [hit], total: 1 } });
    vi.mocked(adoptCatalogProduct).mockResolvedValue({
      data: {
        created: true,
        product: {
          id: 'product-1',
          shopId: SHOP_ID,
          barcode: '6001087354019',
          name: 'Shared Maize',
          category: 'groceries',
          buyingPrice: 4,
          sellingPrice: 7,
          createdAt: '2026-10-20T00:00:00.000Z',
          updatedAt: '2026-10-20T00:00:00.000Z',
          archivedAt: null,
          brand: 'Ace',
          size: '2.5kg',
          imagePath: null,
          minStockUnits: null,
          catalogProductId: hit.id,
        },
        packagings: [],
        barcodes: [],
      },
    });

    await render(<CatalogAdoptDialog isOpen onClose={() => undefined} />);
    await settle();
    expect(container.textContent).toContain('Shared Maize');
    expect(container.textContent).not.toContain('Buying price for this shop');

    const choice = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Shared Maize'));
    await act(async () => {
      choice?.click();
    });
    const buying = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]');
    expect(buying).toBeTruthy();
    await act(async () => {
      const inputs = container.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(inputs[0], '4');
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      set?.call(inputs[1], '7');
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    });
    const add = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Add to this shop'));
    await act(async () => {
      add?.click();
    });
    expect(adoptCatalogProduct).toHaveBeenCalledWith(SHOP_ID, hit.id, { buyingPrice: 4, sellingPrice: 7 });
    expect(container.textContent).toContain('Added to this shop');
  });

  it('does not ask for new prices when the shop already stocks the product', async () => {
    vi.mocked(searchCatalog).mockResolvedValue({
      data: { items: [{ ...hit, shopProductId: 'already' }], total: 1 },
    });
    await render(<CatalogAdoptDialog isOpen onClose={() => undefined} />);
    await settle();
    expect(container.textContent).not.toContain('Shared Maize');
    const showAdded = [...container.querySelectorAll('label')].find((label) =>
      label.textContent?.includes('Show products already in this shop')
    );
    await act(async () => {
      showAdded?.click();
    });
    await settle();
    const choice = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Shared Maize'));
    await act(async () => {
      choice?.click();
    });
    expect(container.textContent).toContain('In your shop');
    expect(container.querySelector('input[inputmode="decimal"]')).toBeNull();
    expect(container.textContent).toContain('Keep this shop’s prices');
  });
});
