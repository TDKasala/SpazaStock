import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CatalogAdoptDialog } from '../components/stock/CatalogAdoptDialog';
import { LanguageProvider } from '../context/LanguageContext';
import { resetLocalDatabase } from '../lib/db';
import { saveShopSettings } from '../lib/shopSettings';
import { SHOP_ID } from './helpers';
import { confirmCatalogIntake, searchCatalog, type CatalogSearchHit } from '../services/catalogService';

vi.mock('../context/ShopContext', () => ({
  useShopId: () => '11111111-1111-4111-8111-111111111111',
  useShop: () => ({ settings: { role: 'owner', timezone: 'Africa/Johannesburg', reminderDays: [21, 14, 7] } }),
}));

vi.mock('../services/catalogService', () => ({
  searchCatalog: vi.fn(),
  confirmCatalogIntake: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function hit(id: string, name: string): CatalogSearchHit {
  return {
    id,
    name,
    brand: 'Ace',
    category: 'groceries',
    packageSize: '1kg',
    packageQuantity: null,
    packageUnit: null,
    imageUrl: null,
    imagePath: null,
    verificationStatus: 'verified',
    shopProductId: null,
    barcodes: [{ barcode: '6001087354019', kind: 'unit', unitsPerPackage: null }],
  };
}

const first = hit('first', 'First meal');
const second = hit('second', 'Second meal');
const third = hit('third', 'Third meal');

let container: HTMLDivElement;
let root: Root;
let online = true;

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
  online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  await resetLocalDatabase();
  await saveShopSettings(SHOP_ID, { role: 'owner' });
  vi.mocked(searchCatalog).mockReset();
  vi.mocked(confirmCatalogIntake).mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('catalogue paging and retry', () => {
  it('turns the page and adds only the rows on that page', async () => {
    vi.mocked(searchCatalog).mockImplementation(async (_shopId, _query, options) => {
      const offset = options?.offset ?? 0;
      return {
        data: {
          items: offset === 0 ? [first, second] : [third],
          total: 21,
        },
      };
    });
    await render(<CatalogAdoptDialog isOpen onClose={() => undefined} />);
    await settle();
    expect(searchCatalog).toHaveBeenCalledWith(SHOP_ID, '', expect.objectContaining({ inShop: false, limit: 20, offset: 0 }));
    expect(container.textContent).toContain('First meal');

    await act(async () => {
      buttonNamed('Next')?.click();
    });
    await settle();
    expect(searchCatalog).toHaveBeenCalledWith(SHOP_ID, '', expect.objectContaining({ inShop: false, limit: 20, offset: 20 }));
    expect(container.textContent).toContain('Third meal');
    expect(container.textContent).not.toContain('First meal');

    await act(async () => {
      buttonNamed('Select all')?.click();
    });
    await act(async () => {
      buttonNamed('Count stock')?.click();
    });
    expect(confirmCatalogIntake).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Third meal');
    expect(container.textContent).toContain('Quantity');
    expect(container.textContent).not.toContain('First meal');
  });

  it('shows retry while offline and searches again when asked', async () => {
    online = false;
    vi.mocked(searchCatalog).mockResolvedValue({ data: { items: [first], total: 1 } });
    await render(<CatalogAdoptDialog isOpen onClose={() => undefined} />);
    await settle();
    expect(searchCatalog).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Catalogue search needs a connection');
    expect(buttonNamed('Retry')).toBeTruthy();

    online = true;
    await act(async () => {
      buttonNamed('Retry')?.click();
    });
    await settle();
    expect(searchCatalog).toHaveBeenCalledWith(SHOP_ID, '', expect.objectContaining({ inShop: false, limit: 20, offset: 0 }));
    expect(container.textContent).toContain('First meal');
  });
});
