import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LinkBarcodeDialog } from '../components/stock/LinkBarcodeDialog';
import { QuickStockInModal } from '../components/stock/QuickStockInModal';
import { UnknownBarcodeDialog } from '../components/stock/UnknownBarcodeDialog';
import { LanguageProvider } from '../context/LanguageContext';
import { createProduct, resolveBarcode } from '../services/productService';
import { getProductBatches, getProductTotalStock } from '../services/stockService';
import { saveShopSettings } from '../lib/shopSettings';
import { resetLocalDatabase } from '../lib/db';
import type { Product, ResolvedBarcode } from '../types';
import { SHOP_ID } from './helpers';

vi.mock('../context/ShopContext', () => ({
  useShopId: () => '11111111-1111-4111-8111-111111111111',
  useShop: () => ({ settings: { role: 'owner', timezone: 'Africa/Johannesburg', reminderDays: [21, 14, 7] } }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CASE = '15449000000993';

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i += 1) await flush(20);
  expect(check()).toBe(true);
}

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(<LanguageProvider>{element}</LanguageProvider>);
  });
  await flush(20);
}

const buttonNamed = (name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function click(el: Element | undefined | null) {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush(20);
}

async function typeInto(input: HTMLInputElement | null, value: string) {
  expect(input).toBeTruthy();
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush(20);
}

async function makeProducts(): Promise<Product> {
  const { product } = await createProduct(
    { barcode: '5449000000996', name: 'Coke Can', category: 'beverages', brand: 'Coca-Cola', size: '330ml' },
    SHOP_ID
  );
  await createProduct({ barcode: '5449000011527', name: 'Fanta Orange', category: 'beverages' }, SHOP_ID);
  return product!;
}

beforeEach(async () => {
  await resetLocalDatabase();
  await saveShopSettings(SHOP_ID, { role: 'owner' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.style.overflow = '';
});

describe('unknown barcode during stock-in', () => {
  it('offers linking only to people who can link', async () => {
    const props = { isOpen: true, barcode: CASE, onLinkExisting: vi.fn(), onCreateNew: vi.fn(), onClose: vi.fn() };
    await render(<UnknownBarcodeDialog {...props} canLink />);
    expect(buttonNamed('Link to a product I already haveThe same product in a pack or case, or a new barcode from the supplier.')).toBeTruthy();

    await render(<UnknownBarcodeDialog {...props} canLink={false} />);
    expect(container.textContent).not.toContain('Link to a product I already have');
    expect(container.textContent).toContain('ask an owner or manager');
    await click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Create a new product')));
    expect(props.onCreateNew).toHaveBeenCalled();
  });
});

describe('linking a case barcode and receiving it', () => {
  it('searches, confirms a new case of 24 and receives 2 cases as 48 units', async () => {
    const coke = await makeProducts();
    let linked: ResolvedBarcode | null = null;
    await render(
      <LinkBarcodeDialog isOpen barcode={CASE} onClose={() => undefined} onLinked={(r) => (linked = r)} />
    );

    await typeInto(container.querySelector('input'), 'coca 330');
    await waitFor(() => container.querySelectorAll('ul li button').length === 1);
    const results = [...container.querySelectorAll('ul li button')];
    expect(results).toHaveLength(1);
    expect(results[0].textContent).toContain('Coke Can');
    expect(results[0].textContent).toContain('0 in stock');
    await click(results[0]);

    await click(buttonNamed('A new pack or case…'));
    await click(buttonNamed('Case'));
    await click(buttonNamed('24'));
    expect(byTestId('link-summary')?.textContent).toBe(`Barcode ${CASE} = 1 Case of 24 × Coke Can`);
    await click(byTestId('confirm-link'));
    await waitFor(() => linked !== null);

    expect(linked).toMatchObject({ product: { id: coke.id }, packaging: { name: 'Case', unitsPerPackage: 24 } });
    const resolved = await resolveBarcode(CASE, SHOP_ID);
    expect(resolved?.packaging?.unitsPerPackage).toBe(24);

    await render(
      <QuickStockInModal
        isOpen
        product={resolved!.product}
        packagingId={resolved!.packaging!.id}
        barcodeId={resolved!.barcodeId}
        onClose={() => undefined}
      />
    );
    const quantity = container.querySelector<HTMLInputElement>('input[type="number"]');
    await typeInto(quantity, '2');
    await waitFor(() => byTestId('units-preview') !== null);
    expect(byTestId('units-preview')?.textContent).toBe('= 48 units');

    await click(buttonNamed('Confirm & Increase Stock'));
    await waitFor(() => byTestId('stock-in-packages') !== null);
    expect(byTestId('stock-in-packages')?.textContent).toBe('2 × Case of 24 = 48 units');
    expect(await getProductTotalStock(coke.id, SHOP_ID)).toBe(48);
    const [batch] = await getProductBatches(coke.id, SHOP_ID);
    expect(batch).toMatchObject({
      quantity: 48,
      packageQuantity: 2,
      unitsPerPackage: 24,
      costPricePerUnit: null,
      receivedBarcodeId: resolved!.barcodeId,
    });
  });

  it('shows the product that already uses a barcode instead of linking it', async () => {
    await makeProducts();
    await render(<LinkBarcodeDialog isOpen barcode="5449000011527" onClose={() => undefined} onLinked={() => undefined} />);
    await typeInto(container.querySelector('input'), 'coke');
    await waitFor(() => container.querySelector('ul li button') !== null);
    await click(container.querySelector('ul li button'));
    await click(byTestId('confirm-link'));
    await waitFor(() => container.textContent?.includes('already used by') ?? false);
    expect(container.textContent).toContain('This barcode is already used by "Fanta Orange".');
  });
});
