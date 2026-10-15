import { describe, it, expect, beforeEach } from 'vitest';
import { createProduct, findProducts, resolveBarcode, updateProduct } from '../services/productService';
import {
  createPackaging,
  getBatchesReceivedThrough,
  linkBarcode,
  retirePackaging,
  unlinkBarcode,
} from '../services/barcodeLinkService';
import { getProductBatches, getProductTotalStock, stockIn } from '../services/stockService';
import { createScanSeller } from '../services/scanSell';
import { saveShopSettings } from '../lib/shopSettings';
import { db, resetLocalDatabase } from '../lib/db';
import type { Product } from '../types';
import { OTHER_SHOP_ID, SHOP_ID, setOnline } from './helpers';

const CAN = '5449000000996';
const CASE = '15449000000993';

async function product(
  barcode: string,
  name: string,
  details: { brand?: string; size?: string; category?: Product['category']; price?: number } = {}
): Promise<Product> {
  const { product: created, error } = await createProduct(
    {
      barcode,
      name,
      category: details.category ?? 'beverages',
      sellingPrice: details.price ?? 12,
      brand: details.brand,
      size: details.size,
    },
    SHOP_ID
  );
  if (!created) throw new Error(error);
  return created;
}

async function cokeWithCase() {
  const coke = await product(CAN, 'Coca-Cola Can', { brand: 'Coca-Cola', size: '330ml' });
  const { packaging } = await createPackaging({ productId: coke.id, name: 'Case', unitsPerPackage: 24 }, SHOP_ID);
  const { link } = await linkBarcode({ productId: coke.id, packagingId: packaging!.id, barcode: CASE }, SHOP_ID);
  return { coke, caseOf24: packaging!, link: link! };
}

beforeEach(async () => {
  await resetLocalDatabase();
  setOnline(true);
  await saveShopSettings(SHOP_ID, { role: 'owner' });
});

describe('recognising barcodes', () => {
  it('finds a product by its own barcode and by a linked case barcode', async () => {
    const { coke, caseOf24, link } = await cokeWithCase();
    expect(await resolveBarcode(CAN, SHOP_ID)).toEqual({ product: coke, packaging: null, barcodeId: null });
    expect(await resolveBarcode(` ${CASE} `, SHOP_ID)).toEqual({ product: coke, packaging: caseOf24, barcodeId: link.id });
    expect(await resolveBarcode(CASE, OTHER_SHOP_ID)).toBeNull();
  });

  it('stops recognising an unlinked barcode', async () => {
    const { link } = await cokeWithCase();
    await unlinkBarcode({ barcodeId: link.id, reason: 'Wrong product', reverseUnsold: false }, SHOP_ID);
    expect(await resolveBarcode(CASE, SHOP_ID)).toBeNull();
  });

  it('refuses a barcode that already means something else', async () => {
    const { coke } = await cokeWithCase();
    const fanta = await product('5449000011527', 'Fanta Orange');

    const taken = await linkBarcode({ productId: fanta.id, packagingId: null, barcode: CASE }, SHOP_ID);
    expect(taken).toMatchObject({ errorCode: 'duplicate', conflict: { id: coke.id } });
    const own = await linkBarcode({ productId: fanta.id, packagingId: null, barcode: CAN }, SHOP_ID);
    expect(own).toMatchObject({ errorCode: 'duplicate', conflict: { id: coke.id } });

    // Registering or editing a product cannot take a linked barcode either.
    expect(await createProduct({ barcode: CASE, name: 'Copy', category: 'other' }, SHOP_ID)).toMatchObject({
      isDuplicate: true,
      product: { id: coke.id },
    });
    expect(await updateProduct(fanta.id, { ...fanta, barcode: CASE }, SHOP_ID)).toMatchObject({
      errorCode: 'duplicate',
    });
  });

  it('keeps linking to owners and managers', async () => {
    const coke = await product(CAN, 'Coca-Cola Can');
    await saveShopSettings(SHOP_ID, { role: 'staff' });
    expect(await linkBarcode({ productId: coke.id, packagingId: null, barcode: CASE }, SHOP_ID)).toMatchObject({
      errorCode: 'forbidden',
    });
    expect(
      await createPackaging({ productId: coke.id, name: 'Case', unitsPerPackage: 24 }, SHOP_ID)
    ).toMatchObject({ errorCode: 'forbidden' });
    expect((await db.outbox.toArray()).filter((q) => q.type === 'barcode_link' || q.type === 'packaging_create')).toEqual(
      []
    );
  });
});

describe('finding a product by hand', () => {
  it('matches every word against name, brand and size, ignoring case and accents', async () => {
    const coke = await product(CAN, 'Coke Can', { brand: 'Coca-Cola', size: '330ml' });
    await product('5449000011527', 'Fanta Orange', { brand: 'Coca-Cola', size: '2L' });
    await product('6001240100011', 'Crème Soda', { size: '330ml' });

    expect((await findProducts('coca 330', SHOP_ID)).map((m) => m.product.id)).toEqual([coke.id]);
    expect((await findProducts('creme', SHOP_ID)).map((m) => m.product.name)).toEqual(['Crème Soda']);
    expect((await findProducts('330ML', SHOP_ID)).map((m) => m.product.name)).toEqual(['Coke Can', 'Crème Soda']);
    expect(await findProducts('pepsi', SHOP_ID)).toEqual([]);
  });

  it('filters by category and shows stock, including none', async () => {
    const coke = await product(CAN, 'Coke Can');
    await product('6001007300123', 'Bread', { category: 'bakery' });
    await stockIn({ productId: coke.id, quantity: 5 }, SHOP_ID);

    const drinks = await findProducts('', SHOP_ID, { category: 'beverages' });
    expect(drinks).toEqual([{ product: expect.objectContaining({ id: coke.id }), totalQuantity: 5 }]);
    const bakery = await findProducts('', SHOP_ID, { category: 'bakery' });
    expect(bakery[0].totalQuantity).toBe(0);
  });

  it('never merges products with similar names', async () => {
    const coke = await product(CAN, 'Coca-Cola 330ml');
    const { product: lookalike } = await createProduct(
      { barcode: '5449000214911', name: 'Coca-Cola 330ml', category: 'beverages' },
      SHOP_ID
    );
    expect(lookalike?.id).not.toBe(coke.id);
    expect(await db.products.count()).toBe(2);
    expect(await db.barcodes.count()).toBe(0);
    expect((await findProducts('coca-cola', SHOP_ID)).length).toBe(2);
  });
});

describe('receiving packages', () => {
  it('converts packages to units and keeps the conversion on the delivery', async () => {
    const { coke, caseOf24, link } = await cokeWithCase();
    const { packaging: six } = await createPackaging({ productId: coke.id, name: 'Pack', unitsPerPackage: 6 }, SHOP_ID);

    await stockIn({ productId: coke.id, quantity: 1 }, SHOP_ID);
    await stockIn({ productId: coke.id, quantity: 1, packagingId: six!.id }, SHOP_ID);
    const { result } = await stockIn(
      { productId: coke.id, quantity: 2, packagingId: caseOf24.id, barcodeId: link.id, expiryDate: '2099-05-01' },
      SHOP_ID
    );

    expect(result?.batch).toMatchObject({
      quantity: 48,
      initialQuantity: 48,
      packagingId: caseOf24.id,
      packageQuantity: 2,
      unitsPerPackage: 24,
      receivedBarcodeId: link.id,
    });
    expect(result?.movement.quantityDelta).toBe(48);
    expect(await getProductTotalStock(coke.id, SHOP_ID)).toBe(1 + 6 + 48);
    expect(await getProductBatches(coke.id, SHOP_ID)).toHaveLength(3);
  });

  it('restocks a sold-out product through a newly linked case', async () => {
    const coke = await product(CAN, 'Coca-Cola Can');
    await stockIn({ productId: coke.id, quantity: 2 }, SHOP_ID);
    await createScanSeller(SHOP_ID).sell(coke, 2);
    expect(await getProductTotalStock(coke.id, SHOP_ID)).toBe(0);

    const { packaging } = await createPackaging({ productId: coke.id, name: 'Case', unitsPerPackage: 24 }, SHOP_ID);
    const { link } = await linkBarcode({ productId: coke.id, packagingId: packaging!.id, barcode: CASE }, SHOP_ID);
    const resolved = await resolveBarcode(CASE, SHOP_ID);
    await stockIn(
      { productId: resolved!.product.id, quantity: 1, packagingId: resolved!.packaging!.id, barcodeId: link!.id },
      SHOP_ID
    );
    expect(await getProductTotalStock(coke.id, SHOP_ID)).toBe(24);
  });

  it('rejects a packaging of another product', async () => {
    const { caseOf24 } = await cokeWithCase();
    const fanta = await product('5449000011527', 'Fanta Orange');
    expect(await stockIn({ productId: fanta.id, quantity: 1, packagingId: caseOf24.id }, SHOP_ID)).toEqual({
      error: 'Packaging not found for this product.',
    });
  });

  it('reuses a pack with the same name and size instead of adding another', async () => {
    const { coke, caseOf24 } = await cokeWithCase();
    const again = await createPackaging({ productId: coke.id, name: 'case', unitsPerPackage: 24 }, SHOP_ID);
    expect(again.packaging?.id).toBe(caseOf24.id);
    expect(await db.packagings.count()).toBe(1);
  });
});

describe('selling with a pack barcode', () => {
  it('sells the whole case at the unit price', async () => {
    const { coke, caseOf24 } = await cokeWithCase();
    await stockIn({ productId: coke.id, quantity: 2, packagingId: caseOf24.id }, SHOP_ID);
    const seller = createScanSeller(SHOP_ID);

    const caseSale = await seller.scan(CASE);
    expect(caseSale).toMatchObject({
      kind: 'sold',
      packaging: { id: caseOf24.id },
      result: { sale: { quantity: 24, unitPrice: 12, totalAmount: 288 }, remainingTotalStock: 24 },
    });
    const canSale = await seller.scan(CAN);
    expect(canSale).toMatchObject({ kind: 'sold', result: { sale: { quantity: 1 }, remainingTotalStock: 23 } });
    expect(canSale).not.toHaveProperty('packaging');
  });

  it('refuses a case when fewer units are left', async () => {
    const { coke } = await cokeWithCase();
    await stockIn({ productId: coke.id, quantity: 10 }, SHOP_ID);
    expect(await createScanSeller(SHOP_ID).scan(CASE)).toMatchObject({ kind: 'insufficient_stock', available: 10 });
    expect(await getProductTotalStock(coke.id, SHOP_ID)).toBe(10);
  });
});

describe('correcting a wrong link', () => {
  it('takes back unsold deliveries and keeps partly sold ones', async () => {
    const { coke, caseOf24, link } = await cokeWithCase();
    const first = (await stockIn({ productId: coke.id, quantity: 1, packagingId: caseOf24.id, barcodeId: link.id }, SHOP_ID))
      .result!.batch;
    await createScanSeller(SHOP_ID).sell(coke, 3);
    const second = (
      await stockIn(
        { productId: coke.id, quantity: 1, packagingId: caseOf24.id, barcodeId: link.id, expiryDate: '2099-01-01' },
        SHOP_ID
      )
    ).result!.batch;
    expect((await getBatchesReceivedThrough(link.id, SHOP_ID)).map((b) => b.id)).toEqual([first.id, second.id]);

    const outcome = await unlinkBarcode({ barcodeId: link.id, reason: 'Was Fanta', reverseUnsold: true }, SHOP_ID);
    expect(outcome.result?.reversed.map((b) => b.id)).toEqual([second.id]);
    expect(outcome.result?.kept.map((b) => b.id)).toEqual([first.id]);
    expect(await getProductTotalStock(coke.id, SHOP_ID)).toBe(21);
    expect(await db.barcodes.get(link.id)).toMatchObject({ unlinkReason: 'Was Fanta' });

    const queued = (await db.outbox.toArray()).filter((q) => q.type === 'barcode_unlink');
    expect(queued.map((q) => q.payload)).toEqual([
      { barcodeId: link.id, reason: 'Was Fanta', reverseUnsold: true, occurredAt: expect.any(String) },
    ]);
  });

  it('needs stock.adjust to take stock back, and a reason', async () => {
    const { link } = await cokeWithCase();
    expect(await unlinkBarcode({ barcodeId: link.id, reason: ' ', reverseUnsold: false }, SHOP_ID)).toMatchObject({
      errorCode: 'invalid',
    });
    await saveShopSettings(SHOP_ID, { role: 'staff' });
    expect(await unlinkBarcode({ barcodeId: link.id, reason: 'x', reverseUnsold: true }, SHOP_ID)).toMatchObject({
      errorCode: 'forbidden',
    });
  });

  it('retires a pack, unlinks its barcodes and keeps its deliveries', async () => {
    const { coke, caseOf24, link } = await cokeWithCase();
    await stockIn({ productId: coke.id, quantity: 1, packagingId: caseOf24.id }, SHOP_ID);
    await retirePackaging(caseOf24.id, SHOP_ID);

    expect((await db.packagings.get(caseOf24.id))?.retiredAt).toBeTruthy();
    expect((await db.barcodes.get(link.id))?.unlinkedAt).toBeTruthy();
    expect(await resolveBarcode(CASE, SHOP_ID)).toBeNull();
    expect(await getProductTotalStock(coke.id, SHOP_ID)).toBe(24);
    expect(await linkBarcode({ productId: coke.id, packagingId: caseOf24.id, barcode: '999' }, SHOP_ID)).toMatchObject({
      errorCode: 'retired',
    });
  });
});

describe('brand and size', () => {
  it('stores them on new products and keeps them when an edit leaves them out', async () => {
    const coke = await product(CAN, 'Coke', { brand: ' Coca-Cola ', size: '330ml' });
    expect(coke).toMatchObject({ brand: 'Coca-Cola', size: '330ml' });

    const { product: edited } = await updateProduct(
      coke.id,
      { barcode: CAN, name: 'Coke Can', category: 'beverages', sellingPrice: 12 },
      SHOP_ID
    );
    expect(edited).toMatchObject({ name: 'Coke Can', brand: 'Coca-Cola', size: '330ml' });

    const { product: cleared } = await updateProduct(coke.id, { ...edited!, brand: '' }, SHOP_ID);
    expect(cleared?.brand).toBeNull();
  });
});
