import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LanguageProvider } from '../context/LanguageContext';
import { useSaleRegister, type SaleRegister } from '../hooks/useSaleRegister';
import { db, resetLocalDatabase } from '../lib/db';
import { createProduct } from '../services/productService';
import { getProductTotalStock, stockIn } from '../services/stockService';
import type { Product } from '../types';
import { SHOP_ID, setOnline } from './helpers';

vi.mock('../hooks/useSyncStatus', () => ({
  useSyncStatus: () => ({
    status: {
      enabled: false,
      isOnline: true,
      isSyncing: false,
      pending: 0,
      failed: 0,
      lastSyncedAt: null,
      lastError: null,
      blocked: null,
    },
    syncNow: async () => undefined,
    retryFailed: async () => undefined,
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BREAD = '6001007300123';
const COLA = '5449000000996';

const registerRef: { current: SaleRegister | null } = { current: null };

function Probe() {
  const register = useSaleRegister(SHOP_ID, () => undefined);
  registerRef.current = register;
  return null;
}

let container: HTMLDivElement;
let root: Root;

async function renderProbe() {
  await act(async () => {
    root.render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>
    );
  });
}

async function makeProduct(barcode: string, name: string, quantity: number): Promise<Product> {
  const { product } = await createProduct(
    { barcode, name, category: 'bakery', sellingPrice: 10 },
    SHOP_ID
  );
  await stockIn({ productId: product!.id, quantity, expiryDate: null }, SHOP_ID);
  return product!;
}

describe('staged rapid scans', () => {
  beforeEach(async () => {
    await resetLocalDatabase();
    setOnline(true);
    registerRef.current = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await renderProbe();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('sells the first product before a second barcode replaces it', async () => {
    const bread = await makeProduct(BREAD, 'Albany White Bread', 5);
    const cola = await makeProduct(COLA, 'Coca-Cola 330ml', 5);
    const register = registerRef.current!;

    await act(async () => {
      const first = register.stageBarcode(BREAD);
      const second = register.stageBarcode(COLA);
      await Promise.all([first, second]);
    });

    expect(await getProductTotalStock(bread.id, SHOP_ID)).toBe(4);
    expect(await getProductTotalStock(cola.id, SHOP_ID)).toBe(5);
    expect(registerRef.current!.pendingScan).toMatchObject({ product: { id: cola.id }, quantity: 1 });
    expect(await db.sales.count()).toBe(1);
  });

  it('adds one when the same product is scanned again', async () => {
    await makeProduct(BREAD, 'Albany White Bread', 5);
    const register = registerRef.current!;

    await act(async () => {
      await register.stageBarcode(BREAD);
      await register.stageBarcode(BREAD);
    });

    expect(registerRef.current!.pendingScan?.quantity).toBe(2);
    expect(await db.sales.count()).toBe(0);
  });

  it('keeps the staged sale when it cannot be recorded', async () => {
    const bread = await makeProduct(BREAD, 'Albany White Bread', 1);
    const register = registerRef.current!;

    await act(async () => {
      await register.stageBarcode(BREAD);
    });
    act(() => {
      registerRef.current!.setPendingQuantity(5);
    });

    let committed = true;
    await act(async () => {
      committed = await registerRef.current!.commitPendingSale();
    });

    expect(committed).toBe(false);
    expect(registerRef.current!.pendingScan).toMatchObject({ product: { id: bread.id }, quantity: 5 });
    expect(await getProductTotalStock(bread.id, SHOP_ID)).toBe(1);
    expect(await db.sales.count()).toBe(0);
  });

  it('does not stage a new product when the previous sale fails', async () => {
    const bread = await makeProduct(BREAD, 'Albany White Bread', 1);
    await makeProduct(COLA, 'Coca-Cola 330ml', 5);
    const register = registerRef.current!;

    await act(async () => {
      await register.stageBarcode(BREAD);
    });
    act(() => {
      registerRef.current!.setPendingQuantity(5);
    });

    let staged = true;
    await act(async () => {
      staged = await registerRef.current!.stageBarcode(COLA);
    });

    expect(staged).toBe(false);
    expect(registerRef.current!.pendingScan?.product.id).toBe(bread.id);
    expect(await db.sales.count()).toBe(0);
  });

  it('treats Done with nothing staged as ready to close', async () => {
    let closed = false;
    await act(async () => {
      closed = await registerRef.current!.commitPendingSale();
    });
    expect(closed).toBe(true);
  });
});
