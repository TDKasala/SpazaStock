import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WholesaleOrders } from '../components/wholesale/WholesaleOrders';

vi.mock('../services/productImageService', () => ({
  PRODUCT_IMAGE_BUCKET: 'product-images',
  getCachedImage: vi.fn(async () => ({
    path: 'shop/bread.webp',
    shopId: 'shop',
    bytes: new Uint8Array([1, 2, 3, 4]).buffer,
    mimeType: 'image/webp',
    pending: false,
    cachedAt: '2026-10-21T00:00:00.000Z',
  })),
  cacheImage: vi.fn(),
}));
import { LanguageProvider } from '../context/LanguageContext';
import { db, resetLocalDatabase } from '../lib/db';
import type { Product, StockBatch } from '../types';

const shopId = '11111111-1111-4111-8111-111111111111';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function product(id: string, name: string, archived = false, imagePath: string | null = null): Product {
  return {
    id,
    shopId,
    barcode: id,
    name,
    category: 'groceries',
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    archivedAt: archived ? '2026-10-20T00:00:00.000Z' : null,
    imagePath,
  };
}

function batch(id: string, productId: string, quantity: number, expiryDate: string | null): StockBatch {
  return {
    id,
    shopId,
    productId,
    quantity,
    initialQuantity: quantity,
    expiryDate,
    receivedAt: '2026-10-01T00:00:00.000Z',
  };
}

const products = [
  product('bread', 'Bread', false, 'shop/bread.webp'),
  product('coke', 'Coke'),
  product('salt', 'Salt'),
  product('soap', 'Soap', true),
];
const batches = [
  batch('bread-dated', 'bread', 4, '2026-12-01'),
  batch('bread-later', 'bread', 2, '2027-01-15'),
  batch('bread-old', 'bread', 9, '2020-01-01'),
  batch('bread-open', 'bread', 3, null),
  batch('coke-open', 'coke', 10, null),
];

let container: HTMLDivElement;
let root: Root;

function inputNamed(label: string): HTMLInputElement | null {
  return container.querySelector(`input[aria-label="${label}"]`);
}

function selectNamed(label: string): HTMLSelectElement | null {
  return container.querySelector(`select[aria-label="${label}"]`);
}

function buttonNamed(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(text));
}

async function setControl(element: HTMLInputElement | HTMLSelectElement | null, value: string) {
  if (!element) throw new Error('missing control');
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  await act(async () => {
    set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function click(text: string) {
  await act(async () => {
    buttonNamed(text)?.click();
  });
}

async function render() {
  await act(async () => {
    root.render(
      <LanguageProvider>
        <WholesaleOrders products={products} batches={batches} timezone="Africa/Johannesburg" onClose={() => undefined} />
      </LanguageProvider>
    );
  });
}

beforeEach(async () => {
  await resetLocalDatabase();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Shopping list', () => {
  it('lists every active product and its sellable stock, with a batch choice only for expiry batches', async () => {
    await render();
    const text = container.textContent ?? '';
    expect(text).toContain('Bread');
    await act(async () => {
      await Promise.resolve();
    });
    const picture = container.querySelector('img[alt="Bread"]');
    expect(picture?.getAttribute('src')?.startsWith('blob:')).toBe(true);
    expect(picture?.parentElement?.parentElement?.textContent).toContain('Bread');
    const coke = [...container.querySelectorAll('p')].find((node) => node.textContent === 'Coke');
    expect(coke?.previousElementSibling?.className).toContain('w-10');
    expect(text).toContain('Coke');
    expect(text).toContain('Salt');
    expect(text).not.toContain('Soap');
    expect(text).toContain('9 in stock');
    expect(text).toContain('10 in stock');
    expect(text).toContain('0 in stock');
    expect(text).not.toContain('Wholesaler');

    const breadBatches = selectNamed('Bread Batch');
    expect(breadBatches).toBeTruthy();
    const line = breadBatches?.closest('div');
    expect(line?.className).toContain('flex-nowrap');
    expect(line?.contains(inputNamed('Bread Quantity to buy') as Node)).toBe(true);
    expect(line?.contains(inputNamed('Bread Price') as Node)).toBe(true);
    const options = [...(breadBatches?.options ?? [])].map((option) => option.textContent ?? '');
    expect(options.some((option) => option.includes('2026') && option.includes('4 in stock'))).toBe(true);
    expect(options.some((option) => option.includes('2027') && option.includes('2 in stock'))).toBe(true);
    expect(options.some((option) => option.includes('2020'))).toBe(false);
    expect(selectNamed('Coke Batch')).toBeNull();
    expect(selectNamed('Salt Batch')).toBeNull();

    await setControl(inputNamed('Search products'), 'salt');
    expect(container.textContent).toContain('Salt');
    expect(container.textContent).not.toContain('Bread');
    await setControl(inputNamed('Search products'), '');
    expect(container.textContent).toContain('Bread');
  });

  it('reviews, edits, and shares the chosen quantities without writing stock or orders', async () => {
    await render();
    await setControl(inputNamed('Salt Quantity to buy'), 'x');
    await click('Review list');
    expect(container.textContent).toContain('Enter a whole number of units.');
    expect(container.querySelector('a')).toBeNull();

    await setControl(inputNamed('Bread Quantity to buy'), '4');
    await setControl(inputNamed('Bread Price'), '12.50');
    const breadBatches = selectNamed('Bread Batch');
    const dated = [...(breadBatches?.options ?? [])].find((option) => option.textContent?.includes('2026'));
    await setControl(breadBatches, dated?.value ?? '');
    await setControl(inputNamed('Coke Quantity to buy'), '2');
    await click('Review list');

    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('img[alt="Bread"]')?.getAttribute('src')?.startsWith('blob:')).toBe(true);
    const review = container.textContent ?? '';
    expect(review).toContain('Bread');
    expect(review).toContain('Coke');
    expect(review).not.toContain('Salt');
    expect(review).toContain(dated?.textContent?.split(' · ')[0] ?? '');
    expect(review).toContain('9 in stock');
    expect(review).toContain('R 50.00');
    expect(review).toContain('Total: R 50.00');
    expect(inputNamed('Bread Quantity to buy')?.value).toBe('4');
    expect(inputNamed('Coke Quantity to buy')?.value).toBe('2');

    const href = container.querySelector('a')?.getAttribute('href') ?? '';
    expect(href.startsWith('https://wa.me/?text=')).toBe(true);
    const decoded = decodeURIComponent(href.slice('https://wa.me/?text='.length));
    expect(decoded).toContain('Bread');
    expect(decoded).toContain('4 × R 12.50 = R 50.00');
    expect(decoded).toContain('Total: R 50.00');
    expect(decoded).toContain('Coke · 2');
    expect(decoded).not.toContain('in stock');
    expect(decoded.includes('%')).toBe(false);

    const removeCoke = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('Remove') && button.parentElement?.textContent?.includes('Coke')
    );
    await act(async () => {
      removeCoke?.click();
    });
    expect(container.textContent).not.toContain('Coke');

    await click('Back to products');
    expect(inputNamed('Bread Quantity to buy')?.value).toBe('4');
    expect(inputNamed('Coke Quantity to buy')?.value).toBe('');
    expect(await db.batches.count()).toBe(0);
    expect(await db.movements.count()).toBe(0);
    expect(await db.wholesaleOrders.count()).toBe(0);
    expect(await db.wholesalers.count()).toBe(0);
  });
});
