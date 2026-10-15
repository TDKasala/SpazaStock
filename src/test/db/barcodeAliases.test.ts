// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  addMember,
  bootstrapSuperadmin,
  createDatabase,
  createShop,
  createUser,
  errorCode,
  newProduct,
  query,
  REASON,
  rpc,
  sell,
  stockIn,
  type Caller,
  type User,
} from './harness';

let pg: PGlite;
let owner: User;
let manager: User;
let staff: User;
let outsider: User;
let shop: string;
let otherShop: string;

interface Packaging {
  id: string;
  shop_id: string;
  product_id: string;
  name: string;
  units_per_package: number;
  retired_at: string | null;
}

interface Link {
  id: string;
  product_id: string;
  packaging_id: string | null;
  barcode: string;
  unlinked_at: string | null;
  unlink_reason: string | null;
}

interface Batch {
  id: string;
  quantity: number;
  initial_quantity: number;
  expiry_date: string | null;
  cost_price_per_unit: number;
  packaging_id: string | null;
  package_quantity: number | null;
  units_per_package: number | null;
  received_barcode_id: string | null;
}

interface StockInResult {
  batch: Batch;
  duplicate: boolean;
  total_quantity: number;
}

interface UnlinkResult {
  barcode: Link;
  duplicate: boolean;
  reversed: Array<{ batch_id: string; quantity: number }>;
  kept: Array<{ batch_id: string; quantity: number; initial_quantity: number }>;
  total_quantity?: number;
}

function code(): string {
  return randomUUID().replace(/-/g, '').slice(0, 13);
}

function packaging(
  caller: Caller,
  productId: string,
  units: number,
  options: { id?: string; name?: string; shopId?: string } = {}
) {
  return rpc<Packaging>(pg, caller, 'create_product_packaging', {
    p_id: options.id ?? randomUUID(),
    p_shop_id: options.shopId ?? shop,
    p_product_id: productId,
    p_name: options.name ?? (units === 24 ? 'Case' : 'Pack'),
    p_units_per_package: units,
  });
}

function link(
  caller: Caller,
  productId: string,
  packagingId: string | null,
  barcode: string,
  options: { id?: string; shopId?: string } = {}
) {
  return rpc<Link>(pg, caller, 'link_product_barcode', {
    p_id: options.id ?? randomUUID(),
    p_shop_id: options.shopId ?? shop,
    p_product_id: productId,
    p_packaging_id: packagingId,
    p_barcode: barcode,
  });
}

function receive(
  caller: Caller,
  productId: string,
  quantity: number,
  options: {
    packagingId?: string;
    packages?: number;
    barcodeId?: string;
    expiry?: string | null;
    cost?: number;
    batchId?: string;
    key?: string | null;
  } = {}
) {
  return rpc<StockInResult>(pg, caller, 'record_stock_in', {
    p_batch_id: options.batchId ?? randomUUID(),
    p_shop_id: shop,
    p_product_id: productId,
    p_quantity: quantity,
    p_expiry_date: options.expiry ?? null,
    p_cost_price_per_unit: options.cost ?? 9.5,
    p_received_at: new Date().toISOString(),
    p_idempotency_key: options.key ?? null,
    p_packaging_id: options.packagingId ?? null,
    p_package_quantity: options.packages ?? null,
    p_barcode_id: options.barcodeId ?? null,
  });
}

function unlink(caller: Caller, barcodeId: string, reverse = false, reason = 'Scanned the wrong case') {
  return rpc<UnlinkResult>(pg, caller, 'unlink_product_barcode', {
    p_shop_id: shop,
    p_barcode_id: barcodeId,
    p_reason: reason,
    p_reverse_unsold: reverse,
  });
}

async function stockOf(productId: string): Promise<number> {
  const { rows } = await pg.query<{ n: number }>(
    'select coalesce(sum(quantity), 0)::int as n from public.stock_batches where product_id = $1',
    [productId]
  );
  return rows[0].n;
}

beforeAll(async () => {
  pg = await createDatabase();
  owner = await createUser(pg);
  manager = await createUser(pg);
  staff = await createUser(pg);
  outsider = await createUser(pg);
  shop = await createShop(pg, owner);
  otherShop = await createShop(pg, outsider);
  await addMember(pg, owner, shop, manager, 'manager');
  await addMember(pg, owner, shop, staff, 'staff');
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('restocking through a linked case barcode', () => {
  it('restocks a product that has no stock left', async () => {
    const cola = await newProduct(pg, owner, shop);
    expect(await stockOf(cola.id)).toBe(0);

    const caseOf24 = await packaging(owner, cola.id, 24);
    const caseCode = code();
    const alias = await link(owner, cola.id, caseOf24.id, caseCode);
    const result = await receive(staff, cola.id, 48, {
      packagingId: caseOf24.id,
      packages: 2,
      barcodeId: alias.id,
    });

    expect(result.duplicate).toBe(false);
    expect(result.total_quantity).toBe(48);
    expect(result.batch).toMatchObject({
      quantity: 48,
      initial_quantity: 48,
      packaging_id: caseOf24.id,
      package_quantity: 2,
      units_per_package: 24,
      received_barcode_id: alias.id,
    });
  });

  it('adds to the stock that is already there', async () => {
    const cola = await newProduct(pg, owner, shop);
    await stockIn(pg, owner, shop, cola.id, 7);
    const caseOf24 = await packaging(manager, cola.id, 24);
    const alias = await link(manager, cola.id, caseOf24.id, code());

    const result = await receive(staff, cola.id, 24, {
      packagingId: caseOf24.id,
      packages: 1,
      barcodeId: alias.id,
    });
    expect(result.total_quantity).toBe(31);
    expect(await stockOf(cola.id)).toBe(31);
  });

  it('converts a single item, a pack of 6 and a case of 24 to units', async () => {
    const juice = await newProduct(pg, owner, shop);
    const pack = await packaging(owner, juice.id, 6);
    const crate = await packaging(owner, juice.id, 24);

    expect((await receive(owner, juice.id, 1)).total_quantity).toBe(1);
    expect((await receive(owner, juice.id, 6, { packagingId: pack.id, packages: 1 })).total_quantity).toBe(7);
    expect((await receive(owner, juice.id, 72, { packagingId: crate.id, packages: 3 })).total_quantity).toBe(79);
  });

  it('keeps deliveries with different expiry dates and costs in separate batches', async () => {
    const milk = await newProduct(pg, owner, shop);
    const tray = await packaging(owner, milk.id, 12, { name: 'Tray' });
    const first = await receive(owner, milk.id, 12, {
      packagingId: tray.id,
      packages: 1,
      expiry: '2099-01-10',
      cost: 10,
    });
    const second = await receive(owner, milk.id, 24, {
      packagingId: tray.id,
      packages: 2,
      expiry: '2099-02-10',
      cost: 11,
    });

    expect(first.batch.id).not.toBe(second.batch.id);
    const batches = await query<Batch>(
      pg,
      owner,
      'select quantity, expiry_date::text as expiry_date, cost_price_per_unit from public.stock_batches where product_id = $1 order by expiry_date',
      [milk.id]
    );
    expect(batches.map((b) => [b.quantity, b.expiry_date, Number(b.cost_price_per_unit)])).toEqual([
      [12, '2099-01-10', 10],
      [24, '2099-02-10', 11],
    ]);

    // FEFO still works in units: 15 units take the whole first tray and 3 from the second.
    const sale = await sell(pg, staff, shop, [{ product_id: milk.id, quantity: 15 }]);
    expect(sale.stock_totals[milk.id]).toBe(21);
  });

  it('rejects a quantity that does not match the packages', async () => {
    const water = await newProduct(pg, owner, shop);
    const caseOf24 = await packaging(owner, water.id, 24);
    expect(await errorCode(receive(owner, water.id, 47, { packagingId: caseOf24.id, packages: 2 }))).toBe('22023');
    expect(await errorCode(receive(owner, water.id, 24, { packagingId: caseOf24.id }))).toBe('22023');
    expect(await errorCode(receive(owner, water.id, 24, { packages: 1 }))).toBe('22023');
    expect(await stockOf(water.id)).toBe(0);
  });

  it('refuses a packaging that belongs to another product', async () => {
    const a = await newProduct(pg, owner, shop);
    const b = await newProduct(pg, owner, shop);
    const bCase = await packaging(owner, b.id, 24);
    expect(await errorCode(receive(owner, a.id, 24, { packagingId: bCase.id, packages: 1 }))).toBe('P0002');
    expect(await errorCode(link(owner, a.id, bCase.id, code()))).toBe('P0002');
  });

  it('does not record the scanned barcode when it belongs to another product', async () => {
    const a = await newProduct(pg, owner, shop);
    const b = await newProduct(pg, owner, shop);
    const bAlias = await link(owner, b.id, null, code());
    const result = await receive(owner, a.id, 3, { barcodeId: bAlias.id });
    expect(result.batch.received_barcode_id).toBeNull();
    expect(result.total_quantity).toBe(3);
  });
});

describe('one meaning per barcode', () => {
  it('refuses an alias that is another product barcode', async () => {
    const a = await newProduct(pg, owner, shop);
    const b = await newProduct(pg, owner, shop);
    const error = await link(owner, a.id, null, b.barcode).catch((err: Error) => err);
    expect((error as { code?: string }).code).toBe('23505');
    expect((error as Error).message).toContain('Bread');
  });

  it('refuses a second active link for the same barcode', async () => {
    const a = await newProduct(pg, owner, shop);
    const b = await newProduct(pg, owner, shop);
    const shared = code();
    await link(owner, a.id, null, shared);
    expect(await errorCode(link(owner, b.id, null, shared))).toBe('23505');
    const aCase = await packaging(owner, a.id, 24);
    expect(await errorCode(link(owner, a.id, aCase.id, shared))).toBe('23505');
  });

  it('refuses a product barcode that is already an alias', async () => {
    const a = await newProduct(pg, owner, shop);
    const aliasCode = code();
    await link(owner, a.id, null, aliasCode);
    const b = await newProduct(pg, owner, shop);
    expect(
      await errorCode(
        rpc(pg, owner, 'update_product', {
          p_shop_id: shop,
          p_product_id: b.id,
          p_barcode: aliasCode,
          p_name: 'Bread',
          p_category: 'bakery',
          p_buying_price: 12,
          p_selling_price: 18.5,
        })
      )
    ).toBe('23505');
    // Direct writes are blocked too, whoever makes them.
    expect(
      await errorCode(
        pg.query(
          `insert into public.products (id, shop_id, barcode, name, category, buying_price, selling_price)
           values ($1, $2, $3, 'Copy', 'other', 1, 2)`,
          [randomUUID(), shop, aliasCode]
        )
      )
    ).toBe('23505');
  });

  it('remaps upsert_product to the product a single-item alias belongs to', async () => {
    const a = await newProduct(pg, owner, shop);
    const aliasCode = code();
    await link(owner, a.id, null, aliasCode);
    const registered = await newProduct(pg, staff, shop, aliasCode);
    expect(registered.id).toBe(a.id);
  });

  it('refuses upsert_product with a case barcode', async () => {
    const a = await newProduct(pg, owner, shop);
    const aCase = await packaging(owner, a.id, 24);
    const caseCode = code();
    await link(owner, a.id, aCase.id, caseCode);
    expect(await errorCode(newProduct(pg, staff, shop, caseCode))).toBe('23505');
  });

  it('lets another shop use the same barcode', async () => {
    const a = await newProduct(pg, owner, shop);
    const elsewhere = await newProduct(pg, outsider, otherShop);
    const aliasCode = code();
    await link(owner, a.id, null, aliasCode);
    const linked = await link(outsider, elsewhere.id, null, aliasCode, { shopId: otherShop });
    expect(linked.barcode).toBe(aliasCode);
  });
});

describe('replays from offline phones', () => {
  it('returns the same link when it is sent again', async () => {
    const a = await newProduct(pg, owner, shop);
    const id = randomUUID();
    const aliasCode = code();
    const first = await link(owner, a.id, null, aliasCode, { id });
    const again = await link(owner, a.id, null, aliasCode, { id });
    expect(again).toEqual(first);

    // The same link made on another phone with its own id keeps the first row.
    const twin = await link(manager, a.id, null, aliasCode);
    expect(twin.id).toBe(id);
    expect(await errorCode(link(owner, a.id, null, code(), { id }))).toBe('23505');
  });

  it('adds a package delivery only once', async () => {
    const a = await newProduct(pg, owner, shop);
    const caseOf24 = await packaging(owner, a.id, 24);
    const batchId = randomUUID();
    const first = await receive(owner, a.id, 48, {
      packagingId: caseOf24.id,
      packages: 2,
      batchId,
      key: 'delivery-1',
    });
    const replay = await receive(owner, a.id, 48, {
      packagingId: caseOf24.id,
      packages: 2,
      batchId,
      key: 'delivery-1',
    });
    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.total_quantity).toBe(48);
    expect(await stockOf(a.id)).toBe(48);
  });

  it('returns the same packaging when it is sent again', async () => {
    const a = await newProduct(pg, owner, shop);
    const id = randomUUID();
    const first = await packaging(owner, a.id, 6, { id });
    expect(await packaging(owner, a.id, 6, { id })).toEqual(first);
    expect(await errorCode(packaging(owner, a.id, 12, { id }))).toBe('23505');
  });
});

describe('packagings keep their history', () => {
  it('never changes a conversion', async () => {
    const a = await newProduct(pg, owner, shop);
    const pack = await packaging(owner, a.id, 6);
    expect(
      await errorCode(pg.query('update public.product_packagings set units_per_package = 12 where id = $1', [pack.id]))
    ).toBe('22023');
    expect(
      await errorCode(
        query(pg, owner, 'update public.product_packagings set name = $2 where id = $1', [pack.id, 'Six'])
      )
    ).toBe('42501');
  });

  it('retires a pack, unlinks its barcodes and keeps past deliveries', async () => {
    const a = await newProduct(pg, owner, shop);
    const pack = await packaging(owner, a.id, 6);
    const alias = await link(owner, a.id, pack.id, code());
    const delivery = await receive(owner, a.id, 12, {
      packagingId: pack.id,
      packages: 2,
      barcodeId: alias.id,
    });

    expect(
      await errorCode(rpc(pg, staff, 'retire_product_packaging', { p_shop_id: shop, p_packaging_id: pack.id }))
    ).toBe('42501');
    const retired = await rpc<Packaging>(pg, manager, 'retire_product_packaging', {
      p_shop_id: shop,
      p_packaging_id: pack.id,
    });
    expect(retired.retired_at).not.toBeNull();
    const again = await rpc<Packaging>(pg, manager, 'retire_product_packaging', {
      p_shop_id: shop,
      p_packaging_id: pack.id,
    });
    expect(again.retired_at).toBe(retired.retired_at);

    const [row] = await query<Link>(pg, owner, 'select * from public.product_barcodes where id = $1', [alias.id]);
    expect(row.unlinked_at).not.toBeNull();
    expect(row.unlink_reason).toBe('Packaging retired');

    const [batch] = await query<Batch>(pg, owner, 'select * from public.stock_batches where id = $1', [
      delivery.batch.id,
    ]);
    expect(batch).toMatchObject({
      packaging_id: pack.id,
      package_quantity: 2,
      units_per_package: 6,
      quantity: 12,
    });

    // No new links, but a delivery scanned offline before the retirement still syncs.
    expect(await errorCode(link(owner, a.id, pack.id, code()))).toBe('22023');
    expect((await receive(staff, a.id, 6, { packagingId: pack.id, packages: 1 })).total_quantity).toBe(18);
  });
});

describe('unlinking a mistaken barcode', () => {
  it('takes back a delivery that has not been sold', async () => {
    const a = await newProduct(pg, owner, shop);
    await stockIn(pg, owner, shop, a.id, 5);
    const caseOf24 = await packaging(owner, a.id, 24);
    const alias = await link(owner, a.id, caseOf24.id, code());
    const delivery = await receive(staff, a.id, 24, {
      packagingId: caseOf24.id,
      packages: 1,
      barcodeId: alias.id,
    });

    const result = await unlink(manager, alias.id, true);
    expect(result.duplicate).toBe(false);
    expect(result.reversed).toEqual([{ batch_id: delivery.batch.id, quantity: 24 }]);
    expect(result.kept).toEqual([]);
    expect(result.total_quantity).toBe(5);
    expect(result.barcode.unlink_reason).toBe('Scanned the wrong case');

    const movements = await query<{ reason: string; quantity_delta: number }>(
      pg,
      owner,
      `select reason, quantity_delta from public.stock_movements where batch_id = $1 order by occurred_at, quantity_delta`,
      [delivery.batch.id]
    );
    expect(movements).toEqual(
      expect.arrayContaining([
        { reason: 'stock_in', quantity_delta: 24 },
        { reason: 'count_correction', quantity_delta: -24 },
      ])
    );

    const replay = await unlink(manager, alias.id, true);
    expect(replay.duplicate).toBe(true);
    expect(await stockOf(a.id)).toBe(5);

    // The barcode is free again and can be linked to the right product.
    const right = await newProduct(pg, owner, shop);
    expect((await link(owner, right.id, null, alias.barcode)).product_id).toBe(right.id);
  });

  it('leaves a delivery that has been partly sold', async () => {
    const a = await newProduct(pg, owner, shop);
    const pack = await packaging(owner, a.id, 6);
    const alias = await link(owner, a.id, pack.id, code());
    const delivery = await receive(owner, a.id, 6, {
      packagingId: pack.id,
      packages: 1,
      barcodeId: alias.id,
    });
    await sell(pg, staff, shop, [{ product_id: a.id, quantity: 2 }]);

    const result = await unlink(owner, alias.id, true);
    expect(result.reversed).toEqual([]);
    expect(result.kept).toEqual([{ batch_id: delivery.batch.id, quantity: 4, initial_quantity: 6 }]);
    expect(await stockOf(a.id)).toBe(4);
  });

  it('only unlinks when no reversal is asked for', async () => {
    const a = await newProduct(pg, owner, shop);
    const alias = await link(owner, a.id, null, code());
    await receive(owner, a.id, 3, { barcodeId: alias.id });
    const result = await unlink(owner, alias.id, false);
    expect(result.reversed).toEqual([]);
    expect(result.kept).toHaveLength(1);
    expect(await stockOf(a.id)).toBe(3);
  });

  it('needs a reason', async () => {
    const a = await newProduct(pg, owner, shop);
    const alias = await link(owner, a.id, null, code());
    expect(await errorCode(unlink(owner, alias.id, false, '  '))).toBe('22023');
  });
});

describe('who can do what', () => {
  it('keeps linking and packaging to owners and managers', async () => {
    const a = await newProduct(pg, owner, shop);
    expect(await errorCode(packaging(staff, a.id, 6))).toBe('42501');
    expect(await errorCode(link(staff, a.id, null, code()))).toBe('42501');
    const alias = await link(owner, a.id, null, code());
    expect(await errorCode(unlink(staff, alias.id))).toBe('42501');
    expect(await errorCode(link(null, a.id, null, code()))).toBe('42501');
  });

  it('keeps other shops out', async () => {
    const a = await newProduct(pg, owner, shop);
    const alias = await link(owner, a.id, null, code());
    expect(await errorCode(packaging(outsider, a.id, 6))).toBe('42501');
    expect(await errorCode(link(outsider, a.id, null, code(), { shopId: otherShop }))).toBe('P0002');
    expect(await errorCode(packaging(outsider, a.id, 6, { shopId: otherShop }))).toBe('P0002');
    expect(
      await errorCode(
        rpc(pg, outsider, 'unlink_product_barcode', {
          p_shop_id: otherShop,
          p_barcode_id: alias.id,
          p_reason: 'Not mine',
        })
      )
    ).toBe('P0002');

    expect(await query(pg, outsider, 'select * from public.product_barcodes where shop_id = $1', [shop])).toEqual([]);
    expect(await query(pg, outsider, 'select * from public.product_packagings where shop_id = $1', [shop])).toEqual([]);
    expect((await query(pg, staff, 'select id from public.product_barcodes where id = $1', [alias.id])).length).toBe(1);
  });

  it('blocks direct writes from the app', async () => {
    const a = await newProduct(pg, owner, shop);
    expect(
      await errorCode(
        query(
          pg,
          owner,
          `insert into public.product_barcodes (id, shop_id, product_id, barcode) values ($1, $2, $3, $4)`,
          [randomUUID(), shop, a.id, code()]
        )
      )
    ).toBe('42501');
  });

  it('refuses everything in a suspended shop', async () => {
    const root = await createUser(pg);
    await bootstrapSuperadmin(pg, root);
    const shopOwner = await createUser(pg);
    const suspended = await createShop(pg, shopOwner);
    const a = await newProduct(pg, shopOwner, suspended);
    await rpc(pg, root, 'admin_set_shop_status', {
      p_shop_id: suspended,
      p_status: 'suspended',
      p_reason: REASON,
    });

    expect(await errorCode(packaging(shopOwner, a.id, 6, { shopId: suspended }))).toBe('SP001');
    expect(await errorCode(link(shopOwner, a.id, null, code(), { shopId: suspended }))).toBe('SP001');
  });
});

describe('phones that have not updated yet', () => {
  it('still create, edit and restock products without the new fields', async () => {
    const a = await newProduct(pg, owner, shop);
    await rpc(pg, owner, 'update_product', {
      p_shop_id: shop,
      p_product_id: a.id,
      p_barcode: a.barcode,
      p_name: 'Coca-Cola',
      p_category: 'beverages',
      p_buying_price: 9,
      p_selling_price: 15,
      p_brand: 'Coca-Cola',
      p_size: '330ml',
    });

    // An older phone saves the product without brand and size: they stay.
    const edited = await rpc<{ brand: string | null; size: string | null; name: string }>(pg, owner, 'update_product', {
      p_shop_id: shop,
      p_product_id: a.id,
      p_barcode: a.barcode,
      p_name: 'Coke',
      p_category: 'beverages',
      p_buying_price: 9,
      p_selling_price: 15,
    });
    expect(edited).toMatchObject({ name: 'Coke', brand: 'Coca-Cola', size: '330ml' });

    // A blank value clears it.
    const cleared = await rpc<{ brand: string | null }>(pg, owner, 'update_product', {
      p_shop_id: shop,
      p_product_id: a.id,
      p_barcode: a.barcode,
      p_name: 'Coke',
      p_category: 'beverages',
      p_buying_price: 9,
      p_selling_price: 15,
      p_brand: '',
    });
    expect(cleared.brand).toBeNull();

    expect((await stockIn(pg, staff, shop, a.id, 4)).total_quantity).toBe(4);
  });

  it('stores brand and size on new products', async () => {
    const created = await rpc<{ brand: string; size: string }>(pg, staff, 'upsert_product', {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_barcode: code(),
      p_name: 'Sprite',
      p_category: 'beverages',
      p_buying_price: 8,
      p_selling_price: 14,
      p_created_at: new Date().toISOString(),
      p_brand: ' Sprite ',
      p_size: '2L',
    });
    expect(created).toMatchObject({ brand: 'Sprite', size: '2L' });
    expect(
      await errorCode(
        rpc(pg, staff, 'upsert_product', {
          p_id: randomUUID(),
          p_shop_id: shop,
          p_barcode: code(),
          p_name: 'Too long',
          p_category: 'other',
          p_buying_price: 1,
          p_selling_price: 2,
          p_created_at: new Date().toISOString(),
          p_size: 'x'.repeat(41),
        })
      )
    ).toBe('22023');
  });
});
