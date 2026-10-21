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

vi.mock('../services/productImageService', async () => {
  const actual = await vi.importActual<typeof import('../services/productImageService')>('../services/productImageService');
  return {
    ...actual,
    getCachedImage: vi.fn(async (path: string) => {
      if (!path.startsWith('catalog/')) return undefined;
      return {
        path,
        shopId: 'catalog',
        bytes: new Uint8Array([1, 2, 3]).buffer,
        mimeType: 'image/webp',
        pending: false,
        cachedAt: '2026-10-21T00:00:00.000Z',
      };
    }),
    adoptRemoteImage: vi.fn(async () => null),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function hit(partial: Partial<CatalogSearchHit> & Pick<CatalogSearchHit, 'id' | 'name'>): CatalogSearchHit {
  return {
    brand: 'Ace',
    category: 'groceries',
    packageSize: '2.5kg',
    packageQuantity: null,
    packageUnit: null,
    imageUrl: null,
    imagePath: null,
    verificationStatus: 'verified',
    shopProductId: null,
    barcodes: [{ barcode: '6001087354019', kind: 'unit', unitsPerPackage: null }],
    ...partial,
  };
}

const pictured = hit({
  id: 'pictured',
  name: 'Pictured meal',
  imagePath: 'catalog/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
});
const plain = hit({ id: 'plain', name: 'Plain rice', imageUrl: null, imagePath: null });
const remote = hit({ id: 'remote', name: 'Remote oil', imageUrl: 'https://example.com/oil.jpg', imagePath: null });
const already = hit({ id: 'already', name: 'Already here', shopProductId: 'shop-already' });

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

function buttonNamed(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(text));
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

describe('catalogue pictures and bulk add', () => {
  it('shows a stored picture, an external picture, and a placeholder', async () => {
    vi.mocked(searchCatalog).mockResolvedValue({
      data: { items: [pictured, plain, remote, already], total: 4 },
    });
    await render(<CatalogAdoptDialog isOpen onClose={() => undefined} />);
    await settle();
    await settle();

    expect(searchCatalog).toHaveBeenCalledWith(SHOP_ID, '', { inShop: false, limit: 20, offset: 0 });
    expect(container.textContent).toContain('Pictured meal');
    expect(container.textContent).toContain('Plain rice');
    expect(container.textContent).toContain('Remote oil');
    expect(container.textContent).not.toContain('Already here');

    const picturedImage = container.querySelector<HTMLImageElement>('img[alt="Pictured meal"]');
    const remoteImage = container.querySelector<HTMLImageElement>('img[alt="Remote oil"]');
    const plainRow = [...container.querySelectorAll('li')].find((row) => row.textContent?.includes('Plain rice'));
    expect(picturedImage).toBeTruthy();
    expect(picturedImage?.getAttribute('src')).toBeTruthy();
    expect(remoteImage?.getAttribute('src')).toBe('https://example.com/oil.jpg');
    expect(plainRow?.querySelector('img')).toBeNull();
    expect(plainRow?.querySelector('svg')).toBeTruthy();

    const showAdded = [...container.querySelectorAll('label')].find((label) =>
      label.textContent?.includes('Show products already in this shop')
    );
    await act(async () => {
      showAdded?.click();
    });
    await settle();
    expect(searchCatalog).toHaveBeenCalledWith(SHOP_ID, '', { inShop: true, limit: 20, offset: 0 });
    expect(container.textContent).toContain('Already here');
    expect(container.textContent).not.toContain('Add selected');
  });

  it('adds the current page selection and clears the rows that succeeded', async () => {
    vi.mocked(searchCatalog).mockResolvedValue({ data: { items: [pictured, plain], total: 2 } });
    vi.mocked(adoptCatalogProduct).mockImplementation(async (_shopId, id) => ({
      data: {
        created: true,
        product: {
          id: `shop-${id}`,
          shopId: SHOP_ID,
          barcode: '6001087354019',
          name: id,
          category: 'groceries',
          buyingPrice: null,
          sellingPrice: null,
          createdAt: '2026-10-21T00:00:00.000Z',
          updatedAt: '2026-10-21T00:00:00.000Z',
          archivedAt: null,
          brand: 'Ace',
          size: '2.5kg',
          imagePath: id === 'pictured' ? pictured.imagePath : null,
          minStockUnits: null,
          catalogProductId: id,
        },
        packagings: [],
        barcodes: [],
      },
    }));

    await render(<CatalogAdoptDialog isOpen onClose={() => undefined} />);
    await settle();
    await act(async () => {
      buttonNamed('Select all')?.click();
    });
    expect(container.textContent).toContain('2 selected');
    await act(async () => {
      buttonNamed('Add selected')?.click();
    });
    await settle();

    expect(adoptCatalogProduct).toHaveBeenCalledTimes(2);
    expect(adoptCatalogProduct).toHaveBeenCalledWith(SHOP_ID, 'pictured', { buyingPrice: null, sellingPrice: null });
    expect(adoptCatalogProduct).toHaveBeenCalledWith(SHOP_ID, 'plain', { buyingPrice: null, sellingPrice: null });
    expect(container.textContent).not.toContain('Pictured meal');
    expect(container.textContent).not.toContain('Plain rice');
    expect(container.textContent).not.toContain('2 selected');
    expect(container.textContent).toContain('Added to this shop');
  });

  it('keeps a failed product selected and shows the error', async () => {
    vi.mocked(searchCatalog).mockResolvedValue({ data: { items: [pictured, plain], total: 2 } });
    vi.mocked(adoptCatalogProduct).mockImplementation(async (_shopId, id) => {
      if (id === 'plain') return { error: { code: 'error', message: 'no' } };
      return {
        data: {
          created: true,
          product: {
            id: 'shop-pictured',
            shopId: SHOP_ID,
            barcode: '6001087354019',
            name: 'Pictured meal',
            category: 'groceries',
            buyingPrice: null,
            sellingPrice: null,
            createdAt: '2026-10-21T00:00:00.000Z',
            updatedAt: '2026-10-21T00:00:00.000Z',
            archivedAt: null,
            brand: 'Ace',
            size: '2.5kg',
            imagePath: pictured.imagePath,
            minStockUnits: null,
            catalogProductId: 'pictured',
          },
          packagings: [],
          barcodes: [],
        },
      };
    });

    await render(<CatalogAdoptDialog isOpen onClose={() => undefined} />);
    await settle();
    await act(async () => {
      buttonNamed('Select all')?.click();
    });
    await act(async () => {
      buttonNamed('Add selected')?.click();
    });
    await settle();

    expect(container.textContent).not.toContain('Pictured meal');
    expect(container.textContent).toContain('Plain rice');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Plain rice"]')?.checked).toBe(true);
    expect(container.textContent).toContain('Could not add this product');
  });
});
