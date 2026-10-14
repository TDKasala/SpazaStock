// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  addMember,
  adjust,
  createDatabase,
  createShop,
  createUser,
  errorCode,
  newProduct,
  rpc,
  sell,
  stockIn,
  type User,
} from './harness';

let pg: PGlite;
let owner: User;
let manager: User;
let staff: User;
let shop: string;

beforeAll(async () => {
  pg = await createDatabase();
  owner = await createUser(pg);
  manager = await createUser(pg);
  staff = await createUser(pg);
  shop = await createShop(pg, owner);
  await addMember(pg, owner, shop, manager, 'manager');
  await addMember(pg, owner, shop, staff, 'staff');
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

/** Reads as the database owner (bypassing RLS) to check the books. */
async function ledger(productId: string) {
  const one = async (sql: string) =>
    Number((await pg.query<{ n: number }>(sql, [productId])).rows[0].n);
  return {
    stock: await one('select coalesce(sum(quantity), 0) as n from public.stock_batches where product_id = $1'),
    movements: await one('select coalesce(sum(quantity_delta), 0) as n from public.stock_movements where product_id = $1'),
    sold: await one('select coalesce(sum(quantity), 0) as n from public.sale_items where product_id = $1'),
    saleMovements: await one(
      "select coalesce(-sum(quantity_delta), 0) as n from public.stock_movements where product_id = $1 and reason = 'sale'"
    ),
    shortfall: await one('select coalesce(sum(shortfall), 0) as n from public.stock_discrepancies where product_id = $1'),
    negativeBatches: await one('select count(*) as n from public.stock_batches where product_id = $1 and quantity < 0'),
  };
}

async function expectConsistent(productId: string, expectedStock?: number) {
  const books = await ledger(productId);
  expect(books.negativeBatches).toBe(0);
  expect(books.movements).toBe(books.stock);
  expect(books.saleMovements + books.shortfall).toBe(books.sold);
  if (expectedStock !== undefined) expect(books.stock).toBe(expectedStock);
}

describe('products', () => {
  it('is idempotent on the client id and normalises the barcode', async () => {
    const id = randomUUID();
    const args = {
      p_id: id,
      p_shop_id: shop,
      p_barcode: '600 700 800',
      p_name: ' Maize Meal ',
      p_category: 'groceries',
      p_buying_price: null,
      p_selling_price: 89.99,
      p_created_at: new Date().toISOString(),
    };
    const first = await rpc<{ id: string; barcode: string; name: string }>(pg, staff, 'upsert_product', args);
    const again = await rpc<{ id: string }>(pg, staff, 'upsert_product', args);
    expect(first).toMatchObject({ id, barcode: '600700800', name: 'Maize Meal' });
    expect(again.id).toBe(id);
  });

  it('keeps barcodes unique within a shop but not across shops', async () => {
    const original = await newProduct(pg, owner, shop, '6009999000001');
    const fromOtherPhone = await newProduct(pg, staff, shop, '6009999000001');
    expect(fromOtherPhone.id).toBe(original.id);

    const other = await createUser(pg);
    const otherShop = await createShop(pg, other);
    const elsewhere = await newProduct(pg, other, otherShop, '6009999000001');
    expect(elsewhere.id).not.toBe(original.id);
  });

  it('rejects invalid input with a permanent error code', async () => {
    const base = {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_barcode: '123',
      p_name: 'x',
      p_category: 'other',
      p_buying_price: null,
      p_selling_price: null,
      p_created_at: null,
    };
    expect(await errorCode(rpc(pg, owner, 'upsert_product', { ...base, p_barcode: '  ' }))).toBe('22023');
    expect(await errorCode(rpc(pg, owner, 'upsert_product', { ...base, p_selling_price: -1 }))).toBe('22023');
  });
});

describe('stock in', () => {
  it('stores quantity, expiry and purchase cost, once per delivery', async () => {
    const product = await newProduct(pg, owner, shop);
    const batchId = randomUUID();
    const first = await stockIn(pg, staff, shop, product.id, 12, { expiry: '2026-11-01', batchId, key: 'delivery-1' });
    const sameBatch = await stockIn(pg, staff, shop, product.id, 12, { expiry: '2026-11-01', batchId, key: 'delivery-1' });
    const sameKeyNewId = await stockIn(pg, staff, shop, product.id, 12, { key: 'delivery-1' });
    expect(first).toMatchObject({ duplicate: false, total_quantity: 12 });
    expect(sameBatch).toMatchObject({ duplicate: true, total_quantity: 12 });
    expect(sameKeyNewId).toMatchObject({ duplicate: true, total_quantity: 12 });

    const { rows } = await pg.query<{ quantity: number; expiry_date: string; cost_price_per_unit: string; received_by: string }>(
      "select quantity, to_char(expiry_date, 'YYYY-MM-DD') as expiry_date, cost_price_per_unit, received_by from public.stock_batches where product_id = $1",
      [product.id]
    );
    expect(rows).toEqual([{ quantity: 12, expiry_date: '2026-11-01', cost_price_per_unit: '9.50', received_by: staff.id }]);
    await expectConsistent(product.id, 12);
  });

  it('records reason, actor, time and idempotency key on the movement', async () => {
    const product = await newProduct(pg, owner, shop);
    await stockIn(pg, staff, shop, product.id, 3, { key: 'k-77' });
    const { rows } = await pg.query<Record<string, unknown>>(
      'select reason, actor_id, quantity_delta, idempotency_key, occurred_at is not null as has_time from public.stock_movements where product_id = $1',
      [product.id]
    );
    expect(rows).toEqual([
      { reason: 'stock_in', actor_id: staff.id, quantity_delta: 3, idempotency_key: 'stock_in:k-77', has_time: true },
    ]);
  });

  it('rejects quantities outside 1 to 1,000,000', async () => {
    const product = await newProduct(pg, owner, shop);
    expect(await errorCode(stockIn(pg, owner, shop, product.id, 0))).toBe('22023');
    expect(await errorCode(stockIn(pg, owner, shop, product.id, 1_000_001))).toBe('22023');
  });
});

describe('sales', () => {
  it('deducts first-expired-first-out with one movement per batch', async () => {
    const product = await newProduct(pg, owner, shop);
    await stockIn(pg, owner, shop, product.id, 3, { expiry: '2026-12-01' });
    await stockIn(pg, owner, shop, product.id, 4, { expiry: null });
    await stockIn(pg, owner, shop, product.id, 5, { expiry: '2026-11-01' });

    const result = await sell(pg, staff, shop, [{ product_id: product.id, quantity: 7 }]);
    expect(result).toMatchObject({ duplicate: false, shortfall: 0 });
    expect(result.stock_totals[product.id]).toBe(5);
    expect(Number(result.sale.total_amount)).toBe(129.5);
    expect(result.items[0].allocations.map((a) => [a.batchExpiryDate, a.quantityDeducted])).toEqual([
      ['2026-11-01', 5],
      ['2026-12-01', 2],
    ]);

    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from public.stock_movements where sale_id = $1 and reason = 'sale'",
      [result.sale.id]
    );
    expect(rows[0].n).toBe(2);
    await expectConsistent(product.id, 5);
  });

  it('records several products in one sale', async () => {
    const bread = await newProduct(pg, owner, shop);
    const milk = await newProduct(pg, owner, shop);
    await stockIn(pg, owner, shop, bread.id, 10);
    await stockIn(pg, owner, shop, milk.id, 10);

    const result = await sell(pg, staff, shop, [
      { product_id: bread.id, quantity: 2, unit_price: 18.5 },
      { product_id: milk.id, quantity: 3, unit_price: 22 },
    ]);
    expect(result.sale.item_count).toBe(2);
    expect(Number(result.sale.total_amount)).toBe(103);
    expect(result.stock_totals).toEqual({ [bread.id]: 8, [milk.id]: 7 });
    await expectConsistent(bread.id, 8);
    await expectConsistent(milk.id, 7);
  });

  it('does not deduct twice for a replayed sale id or idempotency key', async () => {
    const product = await newProduct(pg, owner, shop);
    await stockIn(pg, owner, shop, product.id, 10);
    const saleId = randomUUID();
    const lineId = randomUUID();
    const line = [{ id: lineId, product_id: product.id, quantity: 2 }];
    await sell(pg, staff, shop, line, { key: 'scan-1', saleId });

    const sameId = await sell(pg, staff, shop, line, { key: 'scan-1', saleId });
    const sameKey = await sell(pg, staff, shop, [{ product_id: product.id, quantity: 2 }], { key: 'scan-1' });
    expect(sameId).toMatchObject({ duplicate: true });
    expect(sameKey).toMatchObject({ duplicate: true });
    expect(sameKey.sale.id).toBe(saleId);
    await expectConsistent(product.id, 8);
  });

  it('keeps an oversold sale at zero stock and flags it for owners and managers', async () => {
    const product = await newProduct(pg, owner, shop);
    await stockIn(pg, owner, shop, product.id, 2);

    const result = await sell(pg, staff, shop, [{ product_id: product.id, quantity: 5 }]);
    expect(result).toMatchObject({ duplicate: false, shortfall: 3 });
    expect(result.stock_totals[product.id]).toBe(0);

    const discrepancies = await pg.query<{ shortfall: number; sale_id: string }>(
      'select shortfall, sale_id from public.stock_discrepancies where product_id = $1',
      [product.id]
    );
    expect(discrepancies.rows).toEqual([{ shortfall: 3, sale_id: result.sale.id }]);

    const notified = await pg.query<{ user_id: string }>(
      "select user_id from public.notifications where type = 'stock_discrepancy' and data ->> 'product_id' = $1 order by user_id",
      [product.id]
    );
    expect(notified.rows.map((r) => r.user_id).sort()).toEqual([owner.id, manager.id].sort());
    await expectConsistent(product.id, 0);
  });

  it('rolls back the whole sale when any line fails', async () => {
    const bread = await newProduct(pg, owner, shop);
    const milk = await newProduct(pg, owner, shop);
    await stockIn(pg, owner, shop, bread.id, 5);
    await stockIn(pg, owner, shop, milk.id, 5);
    const earlier = await sell(pg, staff, shop, [{ product_id: milk.id, quantity: 1 }]);

    // The second line reuses an existing line id, which fails after the first line was deducted.
    const failing = sell(pg, staff, shop, [
      { product_id: bread.id, quantity: 2 },
      { id: earlier.items[0].id, product_id: milk.id, quantity: 1 },
    ]);
    expect(await errorCode(failing)).toBe('23505');
    await expectConsistent(bread.id, 5);
    await expectConsistent(milk.id, 4);

    expect(await errorCode(sell(pg, staff, shop, [{ product_id: bread.id, quantity: 0 }]))).toBe('22023');
    expect(await errorCode(sell(pg, staff, shop, [{ product_id: randomUUID(), quantity: 1 }]))).toBe('P0002');
    expect(await errorCode(sell(pg, staff, shop, []))).toBe('22023');
    await expectConsistent(bread.id, 5);
  });
});

describe('adjustments', () => {
  it('never lets a deliberate adjustment take stock below zero', async () => {
    const product = await newProduct(pg, owner, shop);
    const { batch } = await stockIn(pg, owner, shop, product.id, 4);

    expect(await errorCode(adjust(pg, manager, shop, batch.id, -5, 'write_off_damaged'))).toBe('22023');
    const ok = await adjust(pg, manager, shop, batch.id, -4, 'write_off_expired');
    expect(ok).toMatchObject({ duplicate: false, total_quantity: 0 });
    expect(await errorCode(adjust(pg, manager, shop, batch.id, -1, 'count_correction'))).toBe('22023');
    await expectConsistent(product.id, 0);
  });

  it('checks the direction of write-offs and returns', async () => {
    const product = await newProduct(pg, owner, shop);
    const { batch } = await stockIn(pg, owner, shop, product.id, 4);
    expect(await errorCode(adjust(pg, owner, shop, batch.id, 1, 'write_off_expired'))).toBe('22023');
    expect(await errorCode(adjust(pg, owner, shop, batch.id, -1, 'return'))).toBe('22023');
    expect(await errorCode(adjust(pg, owner, shop, batch.id, 0, 'adjustment'))).toBe('22023');
    expect(await errorCode(adjust(pg, owner, shop, batch.id, 1, 'stolen'))).toBe('22023');
  });

  it('applies a replayed adjustment once', async () => {
    const product = await newProduct(pg, owner, shop);
    const { batch } = await stockIn(pg, owner, shop, product.id, 4);
    await adjust(pg, owner, shop, batch.id, 2, 'return', 'adj-1');
    const replay = await adjust(pg, owner, shop, batch.id, 2, 'return', 'adj-1');
    expect(replay).toMatchObject({ duplicate: true, total_quantity: 6 });
    await expectConsistent(product.id, 6);
  });
});

describe('ledger invariant under a random workload', () => {
  /** Small deterministic PRNG so a failure can be replayed. */
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('keeps batches, movements, sales and discrepancies in agreement', async () => {
    const random = mulberry32(20261014);
    const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
    const products = [
      (await newProduct(pg, owner, shop)).id,
      (await newProduct(pg, owner, shop)).id,
      (await newProduct(pg, owner, shop)).id,
    ];
    const expected = new Map(products.map((id) => [id, 0]));
    const batches = new Map<string, { productId: string; quantity: number }>();
    const history: Array<() => Promise<unknown>> = [];

    for (let step = 0; step < 120; step++) {
      const roll = random();
      if (roll < 0.35 || batches.size === 0) {
        const productId = pick(products);
        const quantity = 1 + Math.floor(random() * 10);
        const batchId = randomUUID();
        const key = randomUUID();
        const op = () => stockIn(pg, staff, shop, productId, quantity, { batchId, key, expiry: random() < 0.5 ? '2026-12-01' : null });
        await op();
        history.push(op);
        batches.set(batchId, { productId, quantity });
        expected.set(productId, expected.get(productId)! + quantity);
      } else if (roll < 0.75) {
        const lines = [...new Set([pick(products), pick(products)])].map((productId) => ({
          id: randomUUID(),
          product_id: productId,
          quantity: 1 + Math.floor(random() * 8),
        }));
        const saleId = randomUUID();
        const key = randomUUID();
        const op = () => sell(pg, staff, shop, lines, { saleId, key });
        const result = await op();
        history.push(op);
        for (const line of lines) {
          expected.set(line.product_id, Math.max(0, expected.get(line.product_id)! - line.quantity));
        }
        for (const item of result.items) {
          for (const a of item.allocations) batches.get(a.batchId)!.quantity -= a.quantityDeducted;
        }
      } else if (roll < 0.9) {
        const [batchId, batch] = pick([...batches.entries()]);
        const delta = Math.floor(random() * 9) - 6 || 1;
        const key = randomUUID();
        const op = () => adjust(pg, manager, shop, batchId, delta, 'count_correction', key);
        if (batch.quantity + delta < 0) {
          expect(await errorCode(op())).toBe('22023');
        } else {
          await op();
          history.push(op);
          batch.quantity += delta;
          expected.set(batch.productId, expected.get(batch.productId)! + delta);
        }
      } else if (history.length > 0) {
        await pick(history)(); // a sync retry of an earlier operation must change nothing
      }
    }

    for (const productId of products) {
      await expectConsistent(productId, expected.get(productId));
    }
  }, 60_000);
});
