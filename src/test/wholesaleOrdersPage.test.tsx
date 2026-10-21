import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WholesaleOrders } from '../components/wholesale/WholesaleOrders';
import { LanguageProvider } from '../context/LanguageContext';
import { resetLocalDatabase } from '../lib/db';
import { saveWholesaleOrder, setWholesaleItemPurchased, setWholesaleOrderStatus, upsertWholesaler } from '../services/wholesaleService';
import { stockIn } from '../services/stockService';
import type { Product, StockBatch } from '../types';

const shopId = '11111111-1111-4111-8111-111111111111';

vi.mock('../services/wholesaleService', () => ({
  upsertWholesaler: vi.fn(),
  archiveWholesaler: vi.fn(),
  saveWholesaleOrder: vi.fn(),
  setWholesaleOrderStatus: vi.fn(),
  setWholesaleItemPurchased: vi.fn(),
}));

vi.mock('../services/stockService', () => ({
  stockIn: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function product(id: string, name: string, min: number | null, target: number | null): Product {
  return {
    id,
    shopId,
    barcode: id,
    name,
    category: 'groceries',
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    minStockUnits: min,
    targetStockUnits: target,
    archivedAt: null,
  };
}

function batch(productId: string, quantity: number, expiryDate: string | null): StockBatch {
  return {
    id: `${productId}-${expiryDate ?? 'none'}`,
    shopId,
    productId,
    quantity,
    initialQuantity: quantity,
    expiryDate,
    receivedAt: '2026-10-01T00:00:00.000Z',
  };
}

let container: HTMLDivElement;
let root: Root;

function buttonNamed(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(text));
}

async function render() {
  await act(async () => {
    root.render(
      <LanguageProvider>
        <WholesaleOrders
          shopId={shopId}
          canManage
          products={[product('bread', 'Bread', 5, 12), product('coke', 'Coke', null, null)]}
          batches={[batch('bread', 2, null), batch('bread', 9, '2020-01-01')]}
          timezone="Africa/Johannesburg"
          onClose={() => undefined}
        />
      </LanguageProvider>
    );
  });
}

beforeEach(async () => {
  await resetLocalDatabase();
  vi.mocked(upsertWholesaler).mockReset();
  vi.mocked(saveWholesaleOrder).mockReset();
  vi.mocked(setWholesaleOrderStatus).mockReset();
  vi.mocked(setWholesaleItemPurchased).mockReset();
  vi.mocked(stockIn).mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Wholesale orders page', () => {
  it('suggests a line, lets the merchant edit it, and approves without receiving stock', async () => {
    vi.mocked(upsertWholesaler).mockImplementation(async (_shop, input) => ({
      value: {
        id: 'wholesaler-1',
        shopId,
        name: input.name.trim(),
        phone: null,
        note: null,
        archivedAt: null,
        createdAt: '2026-10-21T00:00:00.000Z',
        updatedAt: '2026-10-21T00:00:00.000Z',
      },
    }));
    vi.mocked(saveWholesaleOrder).mockImplementation(async (_shop, order, items) => ({ value: { order, items } }));
    vi.mocked(setWholesaleOrderStatus).mockImplementation(async (_shop, _orderId, status) => ({
      value: {
        id: 'order',
        shopId,
        wholesalerId: 'wholesaler-1',
        status,
        note: null,
        createdAt: '2026-10-21T00:00:00.000Z',
        updatedAt: '2026-10-21T00:00:00.000Z',
      },
    }));

    await render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(async () => {
      buttonNamed('Add wholesaler')?.click();
    });
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Name"]');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(name, 'Metro Cash');
      name?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      buttonNamed('Save')?.click();
    });
    await act(async () => {
      buttonNamed('New order')?.click();
    });
    const quantity = container.querySelector<HTMLInputElement>('input[aria-label="Bread Quantity"]');
    expect(quantity?.value).toBe('10');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(quantity, '4');
      quantity?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const add = container.querySelector<HTMLSelectElement>('select[aria-label="Add a product"]');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      set?.call(add, 'coke');
      add?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain('Coke');
    const cokeCard = [...container.querySelectorAll('li')].find((row) => row.textContent?.includes('Coke'));
    await act(async () => {
      [...(cokeCard?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Remove')?.click();
    });
    expect(container.querySelector('input[aria-label="Coke Quantity"]')).toBeNull();

    const wholesaler = container.querySelector<HTMLSelectElement>('select[aria-label="Wholesaler"]');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      set?.call(wholesaler, 'wholesaler-1');
      wholesaler?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      buttonNamed('Approve')?.click();
    });

    expect(saveWholesaleOrder).toHaveBeenCalledWith(
      shopId,
      expect.objectContaining({ wholesalerId: 'wholesaler-1', status: 'draft' }),
      [expect.objectContaining({ productId: 'bread', quantity: 4 })]
    );
    expect(setWholesaleOrderStatus).toHaveBeenCalledWith(shopId, expect.any(String), 'approved');
    expect(stockIn).not.toHaveBeenCalled();
  });

  it('shows the line total, shares the encoded summary, and ticks purchased without receiving stock', async () => {
    vi.mocked(upsertWholesaler).mockImplementation(async (_shop, input) => ({
      value: {
        id: 'wholesaler-1',
        shopId,
        name: input.name.trim(),
        phone: null,
        note: null,
        archivedAt: null,
        createdAt: '2026-10-21T00:00:00.000Z',
        updatedAt: '2026-10-21T00:00:00.000Z',
      },
    }));
    vi.mocked(saveWholesaleOrder).mockImplementation(async (_shop, order, items) => ({ value: { order, items } }));
    vi.mocked(setWholesaleItemPurchased).mockResolvedValue({
      value: {
        id: 'line',
        shopId,
        orderId: 'order',
        productId: 'bread',
        quantity: 4,
        estimatedUnitCost: 12.5,
        purchasedAt: '2026-10-21T12:00:00.000Z',
        updatedAt: '2026-10-21T12:00:00.000Z',
      },
    });

    await render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(async () => {
      buttonNamed('Add wholesaler')?.click();
    });
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Name"]');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(name, 'Fish & Chips');
      name?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      buttonNamed('Save')?.click();
    });
    await act(async () => {
      buttonNamed('New order')?.click();
    });
    const wholesaler = container.querySelector<HTMLSelectElement>('select[aria-label="Wholesaler"]');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      set?.call(wholesaler, 'wholesaler-1');
      wholesaler?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const quantity = container.querySelector<HTMLInputElement>('input[aria-label="Bread Quantity"]');
    const cost = container.querySelector<HTMLInputElement>('input[aria-label="Bread Estimated cost each"]');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(quantity, '4');
      quantity?.dispatchEvent(new Event('input', { bubbles: true }));
      set?.call(cost, '12.5');
      cost?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.textContent).toContain('= R 50.00');
    expect(container.textContent).toContain('Estimated total: R 50.00');
    const share = container.querySelector<HTMLAnchorElement>('a[href^="https://wa.me/"]');
    expect(share?.getAttribute('href')).toContain('Fish%20%26%20Chips');
    expect(decodeURIComponent(share?.getAttribute('href')?.split('text=')[1] ?? '')).toContain('Estimated total: R 50.00');

    const bought = container.querySelector<HTMLInputElement>('input[aria-label="Bread Purchased"]');
    await act(async () => {
      bought?.click();
    });
    expect(setWholesaleItemPurchased).toHaveBeenCalledWith(shopId, expect.any(String), true);
    expect(stockIn).not.toHaveBeenCalled();
  });
});
