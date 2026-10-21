import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const maize: CatalogSearchHit = {
  id: 'maize',
  name: 'Maize meal',
  brand: null,
  category: 'groceries',
  packageSize: '2.5kg',
  packageQuantity: null,
  packageUnit: null,
  imageUrl: null,
  imagePath: null,
  verificationStatus: 'verified',
  shopProductId: null,
  barcodes: [{ barcode: '6001000001111', kind: 'unit', unitsPerPackage: null }],
};

const rice: CatalogSearchHit = { ...maize, id: 'rice', name: 'Rice' };

let container: HTMLDivElement;
let root: Root;
let online = true;

async function render(open = true) {
  await act(async () => {
    root.render(
      <LanguageProvider>
        <CatalogAdoptDialog isOpen={open} onClose={() => undefined} />
      </LanguageProvider>
    );
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

function setValue(input: HTMLInputElement | null | undefined, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  set?.call(input, value);
  input?.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(async () => {
  online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  await resetLocalDatabase();
  await saveShopSettings(SHOP_ID, { role: 'owner' });
  vi.mocked(searchCatalog).mockReset();
  vi.mocked(confirmCatalogIntake).mockReset();
  vi.mocked(searchCatalog).mockResolvedValue({ data: { items: [maize, rice], total: 2 } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('catalogue stock wizard', () => {
  it('counts two batches, including one that does not expire, and can drop a product', async () => {
    await render();
    await settle();
    await act(async () => {
      buttonNamed('Select all')?.click();
    });
    await act(async () => {
      buttonNamed('Count stock')?.click();
    });
    await act(async () => {
      buttonNamed('Add another batch')?.click();
    });
    await act(async () => {
      const quantities = [...container.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]')];
      setValue(quantities[0], '3');
      setValue(quantities[1], '5');
      const dates = [...container.querySelectorAll<HTMLInputElement>('input[type="date"]')];
      setValue(dates[0], '2026-12-01');
      const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
      boxes[1]?.click();
    });
    expect(container.querySelectorAll('input[type="date"]')).toHaveLength(1);
    await act(async () => {
      buttonNamed('Next')?.click();
    });
    await act(async () => {
      buttonNamed('Review')?.click();
    });
    expect(container.textContent).toContain('Does not expire');
    const riceCard = [...container.querySelectorAll('[data-testid="intake-review"] > div')].find((card) =>
      card.textContent?.includes('Rice')
    );
    await act(async () => {
      [...(riceCard?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Remove')?.click();
    });
    expect(container.querySelector('[data-testid="intake-review"]')?.textContent).not.toContain('Rice');
    expect(container.querySelector('[data-testid="intake-review"]')?.textContent).toContain('Maize meal');
  });

  it('restores an unfinished count after the dialog is closed', async () => {
    await render();
    await settle();
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[aria-label="Maize meal"]')?.click();
    });
    await act(async () => {
      buttonNamed('Count stock')?.click();
    });
    await act(async () => {
      setValue(container.querySelector('input[inputmode="numeric"]'), '8');
    });
    await settle();
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await render();
    await settle();
    expect(container.querySelector<HTMLInputElement>('input[inputmode="numeric"]')?.value).toBe('8');
    expect(container.textContent).toContain('Maize meal');
  });

  it('keeps the draft when confirming fails offline', async () => {
    await render();
    await settle();
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[aria-label="Maize meal"]')?.click();
    });
    await act(async () => {
      buttonNamed('Count stock')?.click();
    });
    await act(async () => {
      setValue(container.querySelector('input[inputmode="numeric"]'), '2');
      const lasting = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((box) =>
        box.parentElement?.textContent?.includes('Does not expire')
      );
      lasting?.click();
    });
    await act(async () => {
      buttonNamed('Review')?.click();
    });
    online = false;
    await act(async () => {
      buttonNamed('Add to this shop')?.click();
    });
    expect(confirmCatalogIntake).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Saving this stock needs a connection');
    expect(container.textContent).toContain('Maize meal');
  });
});
