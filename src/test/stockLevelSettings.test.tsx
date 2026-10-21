import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StockLevelSettings } from '../components/stock/StockLevelSettings';
import { LanguageProvider } from '../context/LanguageContext';
import type { Product, StockBatch } from '../types';

const shopId = '11111111-1111-4111-8111-111111111111';

vi.mock('../services/productService', () => ({
  setProductMinStock: vi.fn(async () => ({ product: { id: 'bread' } })),
}));

import { setProductMinStock } from '../services/productService';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function product(id: string, name: string, min: number | null, archived = false): Product {
  return {
    id,
    shopId,
    barcode: id,
    name,
    category: 'groceries',
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    minStockUnits: min,
    archivedAt: archived ? '2026-10-20T00:00:00.000Z' : null,
  };
}

function batch(productId: string, quantity: number, expiryDate: string | null): StockBatch {
  return {
    id: `${productId}-${expiryDate ?? 'none'}-${quantity}`,
    shopId,
    productId,
    quantity,
    initialQuantity: quantity,
    expiryDate,
    receivedAt: '2026-10-01T00:00:00.000Z',
  };
}

const products = [product('bread', 'Bread', null), product('milk', 'Milk', 4, true), product('coke', 'Coke', 2)];
const batches = [batch('bread', 3, null), batch('bread', 9, '2020-01-01')];

let container: HTMLDivElement;
let root: Root;

async function render(canEdit: boolean) {
  await act(async () => {
    root.render(
      <LanguageProvider>
        <StockLevelSettings
          shopId={shopId}
          canEdit={canEdit}
          products={products}
          batches={batches}
          timezone="Africa/Johannesburg"
        />
      </LanguageProvider>
    );
  });
}

function field(name: string): HTMLInputElement {
  const input = container.querySelector(`input[aria-label="${name} Minimum stock (units)"]`);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing field for ${name}`);
  return input;
}

async function typeAndLeave(input: HTMLInputElement, value: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.mocked(setProductMinStock).mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('stock level settings', () => {
  it('saves a minimum and clears it when the field is left blank', async () => {
    await render(true);
    expect(container.textContent).toContain('3 on hand');
    expect(container.textContent).not.toContain('Milk');

    await typeAndLeave(field('Bread'), '5');
    expect(setProductMinStock).toHaveBeenCalledWith('bread', 5, shopId);

    const saved = products.map((item) => (item.id === 'bread' ? { ...item, minStockUnits: 5 } : item));
    await act(async () => {
      root.render(
        <LanguageProvider>
          <StockLevelSettings
            shopId={shopId}
            canEdit
            products={saved}
            batches={batches}
            timezone="Africa/Johannesburg"
          />
        </LanguageProvider>
      );
    });
    await typeAndLeave(field('Bread'), '');
    expect(setProductMinStock).toHaveBeenCalledWith('bread', null, shopId);
  });

  it('rejects a number that is not a whole unit count', async () => {
    await render(true);
    await typeAndLeave(field('Coke'), '1.5');
    expect(setProductMinStock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Enter a whole number, or leave it blank.');
  });

  it('lets staff read the minimums without changing them', async () => {
    await render(false);
    const input = field('Coke');
    expect(input.disabled).toBe(true);
    expect(input.value).toBe('2');
    expect(container.textContent).toContain('Only an owner or manager can change these.');
    await typeAndLeave(input, '9');
    expect(setProductMinStock).not.toHaveBeenCalled();
  });

  it('narrows the list by product name', async () => {
    await render(true);
    const search = container.querySelector('input[aria-label="Search products"]');
    if (!(search instanceof HTMLInputElement)) throw new Error('Missing search');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(search, 'coke');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      search.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain('Coke');
    expect(container.textContent).not.toContain('Bread');
  });
});
