// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  addMember,
  createDatabase,
  createShop,
  createUser,
  errorCode,
  newProduct,
  query,
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

interface ProductRow {
  id: string;
  barcode: string;
  name: string;
  category: string;
  buying_price: number | null;
  selling_price: number | null;
  archived_at: string | null;
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

function edit(caller: Caller, productId: string, changes: Partial<Record<string, unknown>> = {}, shopId = shop) {
  return rpc<ProductRow>(pg, caller, 'update_product', {
    p_shop_id: shopId,
    p_product_id: productId,
    p_barcode: '6001007300123',
    p_name: 'White Bread 700g',
    p_category: 'bakery',
    p_buying_price: 13,
    p_selling_price: 19.99,
    ...changes,
  });
}

function archive(caller: Caller, productId: string, archived: boolean, shopId = shop) {
  return rpc<ProductRow>(pg, caller, 'set_product_archived', {
    p_shop_id: shopId,
    p_product_id: productId,
    p_archived: archived,
  });
}

describe('update_product', () => {
  it('lets owners and managers edit, normalising the barcode and trimming the name', async () => {
    const product = await newProduct(pg, owner, shop);
    const edited = await edit(manager, product.id, { p_barcode: ' 600 100 73 ', p_name: '  Bread  ' });
    expect(edited).toMatchObject({ id: product.id, barcode: '60010073', name: 'Bread', selling_price: 19.99 });

    const byOwner = await edit(owner, product.id, { p_barcode: '60010073', p_selling_price: 21 });
    expect(Number(byOwner.selling_price)).toBe(21);
  });

  it('refuses staff, other shops and anonymous callers', async () => {
    const product = await newProduct(pg, owner, shop);
    expect(await errorCode(edit(staff, product.id))).toBe('42501');
    expect(await errorCode(edit(outsider, product.id))).toBe('42501');
    expect(await errorCode(edit(null, product.id))).toBe('42501');
    // Passing their own shop id does not reach another shop's product.
    expect(await errorCode(edit(outsider, product.id, {}, otherShop))).toBe('P0002');
  });

  it('rejects a barcode used by another product, including an archived one', async () => {
    const a = await newProduct(pg, owner, shop, 'DUP-A');
    const b = await newProduct(pg, owner, shop, 'DUP-B');
    expect(await errorCode(edit(owner, b.id, { p_barcode: 'DUP-A' }))).toBe('23505');
    await archive(owner, a.id, true);
    expect(await errorCode(edit(owner, b.id, { p_barcode: 'DUP-A' }))).toBe('23505');
    // Keeping its own barcode is fine.
    expect((await edit(owner, b.id, { p_barcode: 'DUP-B' })).barcode).toBe('DUP-B');
  });

  it('validates input', async () => {
    const product = await newProduct(pg, owner, shop);
    const bad: Array<Record<string, unknown>> = [
      { p_barcode: '   ' },
      { p_barcode: 'x'.repeat(65) },
      { p_name: '  ' },
      { p_name: 'x'.repeat(201) },
      { p_category: 'weapons' },
      { p_category: null },
      { p_selling_price: -1 },
      { p_product_id: null },
    ];
    for (const changes of bad) {
      expect(await errorCode(edit(owner, product.id, changes)), JSON.stringify(changes)).toBe('22023');
    }
  });

  it('denies direct updates to products, even for the owner', async () => {
    const product = await newProduct(pg, owner, shop);
    expect(
      await errorCode(query(pg, owner, 'update public.products set selling_price = 1 where id = $1', [product.id]))
    ).toBe('42501');
    expect(
      await errorCode(query(pg, owner, 'update public.products set archived_at = now() where id = $1', [product.id]))
    ).toBe('42501');
  });
});

describe('set_product_archived', () => {
  it('archives and restores idempotently, for owners and managers only', async () => {
    const product = await newProduct(pg, owner, shop);
    expect(await errorCode(archive(staff, product.id, true))).toBe('42501');
    expect(await errorCode(archive(outsider, product.id, true, otherShop))).toBe('P0002');

    const first = await archive(manager, product.id, true);
    expect(first.archived_at).not.toBeNull();
    const again = await archive(owner, product.id, true);
    expect(again.archived_at).toBe(first.archived_at);

    expect((await archive(owner, product.id, false)).archived_at).toBeNull();
    expect((await archive(owner, product.id, false)).archived_at).toBeNull();
  });

  it('still records sales and deliveries of an archived product, so offline sales sync', async () => {
    const product = await newProduct(pg, owner, shop);
    await stockIn(pg, owner, shop, product.id, 5);
    await archive(owner, product.id, true);

    const delivery = await stockIn(pg, staff, shop, product.id, 2);
    expect(delivery.total_quantity).toBe(7);
    const sale = await sell(pg, staff, shop, [{ product_id: product.id, quantity: 3 }]);
    expect(sale.shortfall).toBe(0);
    expect(sale.stock_totals[product.id]).toBe(4);
  });

  it('closes open expiry alerts and stops new ones while archived', async () => {
    const product = await newProduct(pg, owner, shop);
    await stockIn(pg, owner, shop, product.id, 4, { expiry: '2020-01-01' });
    await pg.query('select private.generate_expiry_alerts()');
    const open = () =>
      query<{ n: number }>(pg, owner, 'select count(*)::int as n from public.expiry_alerts where product_id = $1 and resolved_at is null', [product.id]);
    expect((await open())[0].n).toBe(1);

    await archive(owner, product.id, true);
    expect((await open())[0].n).toBe(0);
    const [closed] = await query<{ resolution: string }>(
      pg,
      owner,
      'select resolution from public.expiry_alerts where product_id = $1',
      [product.id]
    );
    expect(closed.resolution).toBe('product_archived');

    // A second expired batch for the archived product gets no alert.
    await stockIn(pg, owner, shop, product.id, 2, { expiry: '2020-06-01' });
    await pg.query('select private.generate_expiry_alerts()');
    expect((await open())[0].n).toBe(0);

    await archive(owner, product.id, false);
    await pg.query('select private.generate_expiry_alerts()');
    expect((await open())[0].n).toBe(1);
  });
});
