import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StockView } from '../components/views/StockView';
import { LanguageProvider } from '../context/LanguageContext';
import type { Product, ProductCategory, ProductStockSummary } from '../types';

vi.mock('../context/ShopContext', () => ({
  useShopId: () => '11111111-1111-4111-8111-111111111111',
  useShop: () => ({ settings: { role: 'owner', timezone: 'Africa/Johannesburg', reminderDays: [7] } }),
}));

vi.mock('../services/stockService', () => ({
  getAllProductsStockSummary: vi.fn(),
}));

vi.mock('../services/productService', () => ({
  getArchivedProducts: vi.fn(async () => []),
  setProductArchived: vi.fn(),
}));

vi.mock('../components/stock/CatalogAdoptDialog', () => ({
  CatalogAdoptDialog: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function summary(name: string, category: ProductCategory, quantity: number, min: number | null = null): ProductStockSummary {
  const product: Product = {
    id: name,
    shopId: '11111111-1111-4111-8111-111111111111',
    barcode: name,
    name,
    category,
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    minStockUnits: min,
  };
  return {
    product,
    totalQuantity: quantity,
    expiredQuantity: 0,
    batches: [],
    earliestExpiry: null,
    isExpired: false,
    isExpiringSoon: false,
  };
}

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(
      <LanguageProvider>
        <StockView onOpenScanner={() => undefined} onSelectProduct={() => undefined} onQuickStockIn={() => undefined} />
      </LanguageProvider>
    );
  });
}

function clickChip(label: string) {
  const chip = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(label));
  if (!chip) throw new Error(`Missing chip ${label}`);
  return act(async () => {
    chip.click();
  });
}

beforeEach(() => {
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

describe('stock page filters', () => {
  it('filters the list by the categories the shop actually stocks', async () => {
    const { getAllProductsStockSummary } = await import('../services/stockService');
    vi.mocked(getAllProductsStockSummary).mockResolvedValue([
      summary('Albany Loaf', 'bakery', 4),
      summary('Coke', 'beverages', 0),
      summary('Fanta', 'beverages', 1, 3),
    ]);

    await render();
    expect(container.textContent).toContain('Albany Loaf');
    expect(container.textContent).toContain('Beverages & Soft Drinks');
    expect(container.textContent).not.toContain('Dairy & Eggs');

    await clickChip('Beverages & Soft Drinks');
    expect(container.textContent).toContain('Coke');
    expect(container.textContent).toContain('Fanta');
    expect(container.textContent).not.toContain('Albany Loaf');

    await clickChip('Out of stock');
    expect(container.textContent).toContain('Coke');
    expect(container.textContent).not.toContain('Fanta');

    await clickChip('All categories');
    expect(container.textContent).toContain('Coke');
    expect(container.textContent).not.toContain('Fanta');
    expect(container.textContent).not.toContain('Albany Loaf');
  });
});
