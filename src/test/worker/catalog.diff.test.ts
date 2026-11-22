// @vitest-environment node
/**
 * Catalog functions that span the shared catalog (D1) and a shop's ledger (its Durable Object)
 * must answer like Postgres, where both lived in one database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPair, type Pair } from './diff';
import { mirrorD1 } from './d1diff';
import { query, rpc } from '../db/harness';
import { catalogLinks } from '../../../worker/shop/catalog';
import { D1_FUNCTIONS } from '../../../worker/d1/functions';
import { DbError } from '../../../worker/db/errors';
import type { CatalogCtx } from '../../../worker/d1/catalog';

let p: Pair;
const oil = randomUUID();
const soap = randomUUID();

beforeEach(async () => {
  p = await createPair();
  p.known.add(oil);
  p.known.add(soap);
  await query(
    p.pg,
    'service',
    `insert into public.catalog_products (id, name, brand, category, package_size, source, verification_status, common, image_path)
     values ($1, 'Sunflower Oil', 'Sun', 'groceries', '750ml', 'user', 'verified', true, $3),
            ($2, 'Bath soap', 'Lux', 'personal_care', '100g', 'user', 'verified', false, null)`,
    [oil, soap, `catalog/${oil}.webp`]
  );
  await query(
    p.pg,
    'service',
    `insert into public.catalog_barcodes (barcode, catalog_product_id, kind, units_per_package, source)
     values ('6001000000001', $1, 'unit', null, 'user'), ('6001000000002', $1, 'alternate', null, 'user'),
            ('6001000000006', $1, 'pack', 6, 'user'), ('6002000000001', $2, 'unit', null, 'user')`,
    [oil, soap]
  );
}, 60_000);

afterEach(async () => {
  await p?.close();
});

/** inputs.catalogProduct / catalogBarcodes as the Worker reads them from D1. */
async function catalogInputs(id: string) {
  const { rows } = await p.pg.query<Record<string, unknown>>('select id, name, brand, category, package_size, image_path from public.catalog_products where id = $1', [id]);
  const { rows: codes } = await p.pg.query<{ barcode: string; kind: string; units_per_package: number | null; created_at: Date }>(
    'select barcode, kind, units_per_package, created_at from public.catalog_barcodes where catalog_product_id = $1',
    [id]
  );
  return rows[0]
    ? { catalogProduct: rows[0], catalogBarcodes: codes.map((c) => ({ ...c, created_at: new Date(c.created_at).toISOString() })), catalog: { [id]: { id, image_path: rows[0].image_path as string | null } } }
    : {};
}

async function sameShop(user: 'owner' | 'staff', fn: string, args: Record<string, unknown>, catalogId: string) {
  const r = await p.call(p[user], fn, args, await catalogInputs(catalogId));
  expect(r.sq, `${fn} ${JSON.stringify(args)}`).toEqual(r.pg);
  const t = await p.tables();
  for (const table of Object.keys(t.pg)) expect(t.sq[table], table).toEqual(t.pg[table]);
}

/** Runs a D1 catalog function against a D1 copy of Postgres, with the shop read from SQLite. */
async function sameShared(user: 'owner' | 'staff', fn: string, args: Record<string, unknown>) {
  const d1 = await mirrorD1(p.pg);
  const ctx: CatalogCtx = {
    userId: p[user].id,
    email: p[user].email,
    now: new Date().toISOString(),
    shop: () => ({
      catalogLinks: async (today) => catalogLinks(p.sql, p.shopId, today),
      usesCatalogProduct: async (id) => p.sql.all('SELECT 1 AS x FROM products WHERE catalog_product_id = ? AND archived_at IS NULL', id).length > 0,
    }),
    imageExists: async () => true,
  };
  let d1Out: unknown;
  try {
    d1Out = { data: JSON.parse(JSON.stringify((await D1_FUNCTIONS[fn](d1, ctx, args)) ?? null)) };
  } catch (err) {
    if (!(err instanceof DbError)) throw err;
    d1Out = { error: { code: err.code, message: err.message } };
  }
  let pgOut: unknown;
  try {
    pgOut = { data: await rpc(p.pg, p[user], fn, args) };
  } catch (err) {
    const e = err as { code: string; message: string };
    pgOut = { error: { code: e.code, message: e.message } };
  }
  // Ids generated inside earlier calls are random on each side; ids the test chose must match.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const strip = (v: unknown) =>
    JSON.parse(JSON.stringify(v), (k, x) =>
      k === 'created_at' || k === 'updated_at'
        ? undefined
        : typeof x === 'string' && uuid.test(x) && !p.known.has(x.toLowerCase())
          ? '<generated id>'
          : x
    );
  expect(strip(d1Out), `${fn} ${JSON.stringify(args)}`).toEqual(strip(pgOut));
  d1.db.close();
}

describe('catalog adoption', () => {
  it('adopts a catalog product with its barcodes and packs, and replays, the same way', async () => {
    const id = randomUUID();
    const args = { p_id: id, p_shop_id: p.shopId, p_catalog_product_id: oil, p_buying_price: 30, p_selling_price: 42.99, p_created_at: new Date(Date.now() - 60_000).toISOString() };
    await sameShop('staff', 'adopt_catalog_product', args, oil);
    await sameShop('staff', 'adopt_catalog_product', { ...args, p_id: randomUUID() }, oil);
    await sameShop('staff', 'adopt_catalog_product', { ...args, p_buying_price: -1 }, oil);
    const missing = randomUUID();
    p.known.add(missing);
    await sameShop('staff', 'adopt_catalog_product', { ...args, p_catalog_product_id: missing }, missing);
  });

  it('links an existing shop product with the same barcode instead of duplicating it', async () => {
    const existing = randomUUID();
    await p.call(p.owner, 'upsert_product', { p_id: existing, p_shop_id: p.shopId, p_barcode: '6002000000001', p_name: 'My soap', p_category: 'other', p_buying_price: 5, p_selling_price: 8, p_created_at: null });
    await sameShop('owner', 'adopt_catalog_product', { p_id: randomUUID(), p_shop_id: p.shopId, p_catalog_product_id: soap }, soap);
  });
});

describe('catalog search and links', () => {
  it('searches by name, brand and barcode with shop filters the same way', async () => {
    await sameShop('owner', 'adopt_catalog_product', { p_id: randomUUID(), p_shop_id: p.shopId, p_catalog_product_id: oil }, oil);
    for (const extra of [
      {},
      { p_query: 'oil' },
      { p_query: 'LUX' },
      { p_query: '600100000000' },
      { p_query: '100%_' },
      { p_in_shop: true },
      { p_in_shop: false },
      { p_stock: 'out' },
      { p_stock: 'in' },
      { p_category: 'groceries', p_limit: 1, p_offset: 0 },
      { p_category: 'cars' },
      { p_stock: 'plenty' },
    ]) {
      await sameShared('staff', 'search_catalog', { p_shop_id: p.shopId, ...extra });
    }
    await sameShared('staff', 'list_common_catalog', { p_shop_id: p.shopId });
  });

  it('links catalog barcodes and pictures the same way', async () => {
    await sameShared('staff', 'link_catalog_barcode', { p_shop_id: p.shopId, p_catalog_product_id: oil, p_barcode: '6001000000099', p_kind: 'alternate' });
    await sameShop('owner', 'adopt_catalog_product', { p_id: randomUUID(), p_shop_id: p.shopId, p_catalog_product_id: soap }, soap);
    await sameShared('staff', 'link_catalog_barcode', { p_shop_id: p.shopId, p_catalog_product_id: soap, p_barcode: '6001000000001', p_kind: 'alternate' });
    await sameShared('staff', 'link_catalog_barcode', { p_shop_id: p.shopId, p_catalog_product_id: soap, p_barcode: '6002000000024', p_kind: 'pack', p_units_per_package: 1 });
    await sameShared('staff', 'link_catalog_barcode', { p_shop_id: p.shopId, p_catalog_product_id: soap, p_barcode: '6002000000002', p_kind: 'alternate', p_units_per_package: 3 });
    await sameShared('staff', 'set_catalog_image', { p_shop_id: p.shopId, p_catalog_product_id: soap, p_image_path: `catalog/${oil}.webp` });
    await sameShared('staff', 'set_catalog_image', { p_shop_id: p.shopId, p_catalog_product_id: oil, p_image_path: `catalog/${oil}.webp` });
  });
});

describe('shop set-up from the common catalogue', () => {
  async function entries(ids: string[]) {
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      const inputs = (await catalogInputs(id)) as { catalogProduct?: Record<string, unknown>; catalogBarcodes?: unknown[] };
      if (!inputs.catalogProduct) continue;
      const { rows } = await p.pg.query<{ common: boolean }>('select common from public.catalog_products where id = $1', [id]);
      out[id] = { product: { ...inputs.catalogProduct, common: rows[0].common }, barcodes: inputs.catalogBarcodes };
    }
    return out;
  }

  it('lists the review and confirms selections the same way', async () => {
    for (const extra of [{}, { p_status: 'open' }, { p_status: 'selling' }, { p_status: 'nope' }, { p_query: 'sun' }]) {
      await sameShared('staff', 'list_shop_catalog_review', { p_shop_id: p.shopId, ...extra });
    }
    const selections = [
      { catalog_product_id: oil, buying_price: '30', selling_price: 42.5 },
      { catalog_product_id: oil },
      { catalog_product_id: soap },
    ];
    const run = async (user: 'owner' | 'staff', sel: unknown[]) => {
      const r = await p.call(p[user], 'confirm_shop_catalog', { p_shop_id: p.shopId, p_selections: sel }, { catalogEntries: await entries([oil, soap]) });
      expect(r.sq).toEqual(r.pg);
      const t = await p.tables();
      for (const table of Object.keys(t.pg)) expect(t.sq[table], table).toEqual(t.pg[table]);
      return r;
    };
    await run('staff', [selections[0]]);
    await run('owner', selections);
    const ok = await run('owner', [selections[0], selections[1]]);
    expect(ok.effects).toEqual([{ kind: 'clear_catalog_prompt' }]);
    await run('owner', [{ catalog_product_id: 'not-a-uuid' }]);
    await run('owner', [{ catalog_product_id: oil, selling_price: -1 }]);
    await sameShared('staff', 'list_shop_catalog_review', { p_shop_id: p.shopId, p_status: 'selling' });
  });
});

describe('catalogue review', () => {
  it('sells and hides common catalogue products the same way', async () => {
    const { rows } = await p.pg.query<{ id: string }>('select id from public.catalog_products');
    const entriesFor = async () => {
      const out: Record<string, unknown> = {};
      for (const { id } of rows) {
        const i = (await catalogInputs(id)) as { catalogProduct?: Record<string, unknown>; catalogBarcodes?: unknown[] };
        const { rows: c } = await p.pg.query<{ common: boolean }>('select common from public.catalog_products where id = $1', [id]);
        out[id] = { product: { ...i.catalogProduct, common: c[0].common }, barcodes: i.catalogBarcodes };
      }
      return out;
    };
    const run = async (decisions: unknown) => {
      const r = await p.call(p.owner, 'review_shop_catalog', { p_shop_id: p.shopId, p_decisions: decisions }, { catalogEntries: await entriesFor() });
      expect(r.sq).toEqual(r.pg);
      const t = await p.tables();
      for (const table of Object.keys(t.pg)) expect(t.sq[table], table).toEqual(t.pg[table]);
    };
    await run([{ catalog_product_id: oil, decision: 'hide' }]);
    await run([{ catalog_product_id: oil, decision: 'sell', buying_price: 30, selling_price: '45.5' }]);
    await run([{ catalog_product_id: oil, decision: 'maybe' }]);
    await run([{ catalog_product_id: soap, decision: 'sell' }]);
    await run([]);
    await run(Array.from({ length: 51 }, () => ({ catalog_product_id: oil, decision: 'sell' })));
  });
});

describe('catalogue submissions', () => {
  it('adds, merges and files corrections the same way', async () => {
    const base = { p_shop_id: p.shopId, p_category: 'snacks' };
    await sameShared('staff', 'submit_catalog_product', { ...base, p_barcode: ' 6009000000001 ', p_name: 'Chips', p_brand: 'Simba', p_package_quantity: 0.12, p_package_unit: 'kg', p_image_url: 'http://not-https.example.com/x.jpg' });
    await sameShared('staff', 'submit_catalog_product', { ...base, p_barcode: '6009000000002', p_name: '', p_brand: null });
    await sameShared('staff', 'submit_catalog_product', { ...base, p_barcode: '6009000000003', p_name: 'X', p_category: 'cars' });
    await sameShared('staff', 'submit_catalog_product', { ...base, p_barcode: '6009000000004', p_name: 'X', p_package_quantity: 0 });
    // Verified product (oil): differences become a correction.
    await sameShared('staff', 'submit_catalog_product', { ...base, p_barcode: '6001000000001', p_name: 'Sunflower Oil 2L', p_category: 'groceries', p_brand: 'Sun' });
    await sameShared('staff', 'submit_catalog_product', { ...base, p_barcode: '6001000000001', p_name: 'Sunflower Oil', p_category: 'groceries' });
    // Unverified product: merged by trust (external < user_submitted).
    await query(p.pg, 'service', `insert into public.catalog_products (id, name, category, source, verification_status) values ($1, 'Old name', 'other', 'open_food_facts', 'external')`, [soap.replace(/.$/, 'f')]);
    p.known.add(soap.replace(/.$/, 'f'));
    await query(p.pg, 'service', `insert into public.catalog_barcodes (barcode, catalog_product_id, kind, source) values ('6009000000009', $1, 'unit', 'open_food_facts')`, [soap.replace(/.$/, 'f')]);
    await sameShared('staff', 'submit_catalog_product', { ...base, p_barcode: '6009000000009', p_name: 'Better name', p_brand: 'Brand' });
  });
});

describe('catalogue intake', () => {
  it('adopts and stocks counted products, replays and refuses bad batches the same way', async () => {
    const entries = async () => {
      const out: Record<string, unknown> = {};
      for (const id of [oil, soap]) {
        const i = (await catalogInputs(id)) as { catalogProduct?: Record<string, unknown>; catalogBarcodes?: unknown[] };
        out[id] = { product: { ...i.catalogProduct, common: true }, barcodes: i.catalogBarcodes };
      }
      return out;
    };
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const run = async (items: unknown) => {
      const r = await p.call(p.staff, 'confirm_catalog_intake', { p_shop_id: p.shopId, p_items: items }, { catalogEntries: await entries() });
      expect(r.sq).toEqual(r.pg);
      const t = await p.tables();
      for (const table of Object.keys(t.pg)) expect(t.sq[table], table).toEqual(t.pg[table]);
    };
    const productId = randomUUID();
    const b1 = randomUUID();
    const b2 = randomUUID();
    const first = [{ catalog_product_id: oil, product_id: productId, buying_price: 31.555, selling_price: 45, batches: [{ id: b1, quantity: 6, expiry_date: day(30) }, { id: b2, quantity: '4', expiry_date: '' }] }];
    await run(first);
    await run(first);
    await run([{ catalog_product_id: soap, product_id: randomUUID(), batches: [{ id: randomUUID(), quantity: 1, expiry_date: day(-1) }] }]);
    await run([{ catalog_product_id: soap, product_id: randomUUID(), batches: [{ id: randomUUID(), quantity: 1.5 }] }]);
    await run([{ catalog_product_id: soap, product_id: randomUUID(), batches: [] }]);
    await run([{ catalog_product_id: oil, product_id: randomUUID(), batches: [{ id: randomUUID(), quantity: 2 }] }]);
    await run([]);
  });
});
