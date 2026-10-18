import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProductRegisterDialog } from '../components/scanner/ProductRegisterDialog';
import { LanguageProvider } from '../context/LanguageContext';
import { resetLocalDatabase } from '../lib/db';
import { saveShopSettings } from '../lib/shopSettings';
import type { ProductLookupSuggestion } from '../types';
import { SHOP_ID } from './helpers';

vi.mock('../context/ShopContext', () => ({
  useShopId: () => '11111111-1111-4111-8111-111111111111',
  useShop: () => ({ settings: { role: 'owner', timezone: 'Africa/Johannesburg', reminderDays: [21, 14, 7] } }),
}));

vi.mock('../hooks/useSyncStatus', () => ({
  useSyncStatus: () => ({ status: 'synced', pending: 0, failed: 0 }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const suggestion: ProductLookupSuggestion = {
  name: { value: 'Coke', source: 'external' },
  brand: { value: null, source: 'missing' },
  size: { value: '330ml', source: 'external' },
  category: { value: 'beverages', source: 'external' },
  barcode: { value: '5449000000996', source: 'external' },
  imageUrl: { value: null, source: 'missing' },
};

let container: HTMLDivElement;
let root: Root;

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(<LanguageProvider>{element}</LanguageProvider>);
  });
}

beforeEach(async () => {
  await resetLocalDatabase();
  await saveShopSettings(SHOP_ID, { role: 'owner' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function sourceText(): string {
  return container.querySelector('[data-testid="lookup-source"]')?.textContent ?? '';
}

function labelled(label: string): HTMLInputElement | null {
  const text = [...container.querySelectorAll('label')].find((node) => node.textContent?.includes(label));
  const id = text?.getAttribute('for');
  return id ? container.querySelector<HTMLInputElement>(`#${CSS.escape(id)}`) : null;
}

describe('ProductRegisterDialog lookup sources', () => {
  it('shows an Open Food Facts suggestion and leaves prices empty', async () => {
    await render(
      <ProductRegisterDialog
        isOpen
        initialBarcode="5449000000996"
        suggestion={suggestion}
        origin="open_food_facts"
        onClose={() => undefined}
        onProductRegistered={() => undefined}
      />
    );
    expect(sourceText()).toContain('Open Food Facts');
    expect(container.textContent).toContain('Still missing');
    expect(labelled('Product Name')?.value).toBe('Coke');
    expect(labelled('Selling Price')?.value).toBe('');
    expect(labelled('Buying Price')?.value).toBe('');
  });

  it('names the SpazaStock catalog when the barcode is already known', async () => {
    await render(
      <ProductRegisterDialog
        isOpen
        initialBarcode="5449000000996"
        suggestion={{ ...suggestion, name: { value: 'Coke', source: 'user' } }}
        origin="catalog"
        catalog={{
          id: 'cat',
          verificationStatus: 'user_submitted',
          kind: 'unit',
          unitsPerPackage: null,
          packageQuantity: null,
          packageUnit: null,
          unitBarcode: '5449000000996',
          ingredients: null,
          imageUrl: null,
        }}
        onClose={() => undefined}
        onProductRegistered={() => undefined}
      />
    );
    expect(sourceText()).toContain('SpazaStock catalog');
    expect(container.textContent).toContain('Add this product');
  });

  it('fills the product picture from the shared catalog and still offers a new photo', async () => {
    await render(
      <ProductRegisterDialog
        isOpen
        initialBarcode="6009668781362"
        suggestion={{ ...suggestion, name: { value: 'Excella', source: 'user' }, imageUrl: { value: null, source: 'user' } }}
        origin="catalog"
        catalog={{
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          verificationStatus: 'user_submitted',
          kind: 'unit',
          unitsPerPackage: null,
          packageQuantity: null,
          packageUnit: null,
          unitBarcode: '6009668781362',
          ingredients: null,
          imageUrl: null,
          imagePath: 'catalog/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
        }}
        onClose={() => undefined}
        onProductRegistered={() => undefined}
      />
    );
    expect(container.textContent).toContain('Take photo');
    expect(container.textContent).toContain('Replace');
    expect(container.textContent).toContain('This picture is saved with the product');
    expect(container.querySelector('input[capture="environment"]')).toBeTruthy();
  });

  it('explains a manual entry when lookup did not find a product', async () => {
    await render(
      <ProductRegisterDialog
        isOpen
        initialBarcode="123"
        origin="manual"
        onClose={() => undefined}
        onProductRegistered={() => undefined}
      />
    );
    expect(sourceText()).toContain('not in the catalog');
    expect(labelled('Product Name')?.value).toBe('');
    expect(labelled('Selling Price')?.value).toBe('');
  });

  it('says the shared catalog updates after the product is saved', async () => {
    const onProductRegistered = vi.fn();
    await render(
      <ProductRegisterDialog
        isOpen
        initialBarcode="INTERNAL-1"
        origin="manual"
        onClose={() => undefined}
        onProductRegistered={onProductRegistered}
      />
    );
    const name = labelled('Product Name');
    expect(name).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(name, 'House Bread');
      name?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveButton = () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Register Product'));
    await act(async () => {
      saveButton()?.click();
      for (let i = 0; i < 40 && !container.querySelector('[data-testid="catalog-saved"]'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
    expect(container.querySelector('[data-testid="catalog-saved"]')?.textContent).toContain(
      'The shared catalog updates when this phone syncs'
    );
    expect(onProductRegistered).not.toHaveBeenCalled();
    await act(async () => {
      saveButton()?.click();
    });
    expect(onProductRegistered).toHaveBeenCalledOnce();
  });
});
