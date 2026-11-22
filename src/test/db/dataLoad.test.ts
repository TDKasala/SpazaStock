// @vitest-environment node
/**
 * The whole Supabase → Cloudflare data path on realistic data made by the real database functions:
 * export → convert → verify against the export's own totals → load into SQLite built from the
 * generated D1 and shop schemas, with every constraint and foreign key enforced.
 * Also fails when migrations/d1/0001_initial.sql or worker/shop/schema.sql are out of date.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  addMember,
  adjust,
  bootstrapSuperadmin,
  createDatabase,
  createShop,
  createUser,
  newProduct,
  query,
  rpc,
  sell,
  stockIn,
  voidItem,
  type User,
} from './harness';
import { exportDatabase, type ExportManifest, type Query } from '../../../scripts/migrate-data/lib/exportDatabase';
import { generateSchemas, type GeneratedSchemas } from '../../../scripts/migrate-data/lib/sqliteSchema';
import {
  buildLoadPlan,
  decimalToCents,
  parseExact,
  toIsoMillis,
  ExactNumber,
  type LoadPlan,
} from '../../../scripts/migrate-data/lib/transform';
import { rehearse } from '../../../scripts/migrate-data/lib/rehearse';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const allD1Migrations = () =>
  readdirSync(join(ROOT, 'migrations', 'd1'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(ROOT, 'migrations', 'd1', f), 'utf8'))
    .join('\n');
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let pg: PGlite;
let schemas: GeneratedSchemas;
let manifest: ExportManifest;
let plan: LoadPlan;
const files = new Map<string, string[]>();
let ownerA: User;
let shopA: string;
let shopB: string;

beforeAll(async () => {
  pg = await createDatabase();
  const asOwner: Query = async (text, params) => (await pg.query<Record<string, unknown>>(text, params)).rows;
  schemas = await generateSchemas(asOwner);

  await pg.exec(`alter table auth.users add column encrypted_password text, add column updated_at timestamptz`);
  ownerA = await createUser(pg, 'owner.a@example.com');
  const ownerB = await createUser(pg, 'owner.b@example.com');
  const staff = await createUser(pg, 'staff@example.com');
  await pg.query(`update auth.users set encrypted_password = '$2a$10$' || repeat('x', 53)`);
  await bootstrapSuperadmin(pg, ownerB);

  // Shared catalog, adopted by shop A with prices.
  const catalogId = randomUUID();
  await query(
    pg,
    'service',
    `insert into public.catalog_products (id, name, brand, category, package_size, package_quantity, package_unit, source, verification_status, common)
     values ($1, 'Sunflower oil', 'Sun', 'groceries', '750ml', 0.75, 'l', 'user', 'verified', true)`,
    [catalogId]
  );
  await query(
    pg,
    'service',
    `insert into public.catalog_barcodes (barcode, catalog_product_id, kind, units_per_package, source)
     values ('6001234567890', $1, 'unit', null, 'user'), ('6001234567891', $1, 'pack', 6, 'user')`,
    [catalogId]
  );

  shopA = await createShop(pg, ownerA, 'Shop A');
  shopB = await createShop(pg, ownerB, 'Shop B');
  await addMember(pg, ownerA, shopA, staff, 'staff');
  await rpc(pg, ownerA, 'review_shop_catalog', {
    p_shop_id: shopA,
    p_decisions: [{ catalog_product_id: catalogId, decision: 'sell', buying_price: 10, selling_price: 15.99 }],
  });

  // Stock in (one batch expiring soon), sell at awkward prices, void one unit, write one off.
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const product = await newProduct(pg, ownerA, shopA);
  const batch = await stockIn(pg, ownerA, shopA, product.id, 12, { cost: 0.29, expiry: soon });
  await stockIn(pg, staff, shopA, product.id, 4, { cost: 7.1 });
  const sale = await sell(pg, staff, shopA, [{ product_id: product.id, quantity: 3, unit_price: 0.29 }]);
  await voidItem(pg, ownerA, shopA, sale.items[0].id, 1);
  await adjust(pg, ownerA, shopA, (batch as unknown as { batch: { id: string } }).batch.id, -1, 'write_off_damaged');
  const other = await newProduct(pg, ownerB, shopB);
  await stockIn(pg, ownerB, shopB, other.id, 5);
  await sell(pg, ownerB, shopB, [{ product_id: other.id, quantity: 2 }]);
  await pg.query('select private.generate_expiry_alerts(now())');

  const sink = {
    async appendLines(path: string, lines: string[]) {
      files.set(path, [...(files.get(path) ?? []), ...lines]);
    },
    async writeJson() {},
  };
  manifest = await pg.transaction(async (tx) => {
    await tx.exec('set transaction isolation level repeatable read, read only');
    return exportDatabase(async (text, params) => (await tx.query<Record<string, unknown>>(text, params)).rows, sink);
  });
  plan = await buildLoadPlan(manifest, (file) => files.get(file) ?? []);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

describe('generated Cloudflare schemas', () => {
  it('are up to date with supabase/migrations (run npm run data:schema)', () => {
    expect(readFileSync(join(ROOT, 'migrations', 'd1', '0001_initial.sql'), 'utf8')).toBe(schemas.d1);
    expect(readFileSync(join(ROOT, 'worker', 'shop', 'schema.sql'), 'utf8')).toBe(schemas.shop);
  });

  it('keeps foreign keys only inside one store and lists the rest for the Worker', () => {
    expect(schemas.shop).not.toMatch(/REFERENCES (shops|users|catalog_products) /);
    expect(schemas.d1).toMatch(/FOREIGN KEY \(owner_id\) REFERENCES users \(id\) ON DELETE CASCADE/);
    expect(schemas.notes.shop.some((n) => n.kind === 'foreign_key' && n.detail.includes('catalog_products'))).toBe(true);
  });

  it('treats NULL thresholds as equal in the expiry alert dedupe, like NULLS NOT DISTINCT', () => {
    expect(schemas.shop).toContain("ON expiry_alerts (batch_id, expiry_date, kind, ifnull(threshold_days, x'00'))");
  });
});

describe('converted data', () => {
  it('reproduces every total in the export manifest', () => {
    expect(plan.verification.mismatches).toEqual([]);
    expect(plan.verification.ok).toBe(true);
    expect(plan.shops.map((s) => s.shopId).sort()).toEqual([shopA, shopB].sort());
  });

  it('loads into the generated schemas with every constraint and foreign key enforced', () => {
    const result = rehearse(plan, allD1Migrations(), schemas.shop);
    expect(result.errors).toEqual([]);
    for (const t of manifest.tables) {
      const name = t.name.slice(t.name.indexOf('.') + 1);
      const loaded = (result.d1Rows[name] ?? 0) + (result.shopRows[name] ?? 0);
      expect(loaded, t.name).toBe(t.rows);
    }
    expect(result.d1Rows.users).toBe(manifest.users.rows);
    expect(result.shopRows.expiry_alerts).toBeGreaterThan(0);
  });

  it('turns money into exact cents under renamed columns', () => {
    const rows = (table: string) => plan.shops.find((s) => s.shopId === shopA)!.tables.find((t) => t.table === table)!.rows;
    const item = rows('sale_items')[0];
    expect(item.unit_price_cents).toBe(29);
    expect(item.line_total_cents).toBe(87);
    expect(item).not.toHaveProperty('unit_price');
    expect(rows('stock_batches').map((b) => b.cost_price_per_unit_cents).sort()).toEqual([29, 710]);
    expect(rows('products').some((p) => p.selling_price_cents === 1599)).toBe(true);
  });

  it('writes timestamps as UTC milliseconds, booleans as 0/1 and arrays as JSON', () => {
    const shop = plan.d1Statements.find((s) => s.startsWith('INSERT INTO shops ') && s.includes(shopA))!;
    expect(shop).toContain("'[21,14,7]'");
    const sales = plan.shops.find((s) => s.shopId === shopA)!.tables.find((t) => t.table === 'sales')!.rows;
    expect(String(sales[0].created_at)).toMatch(ISO_MS);
    const products = plan.shops.find((s) => s.shopId === shopA)!.tables.find((t) => t.table === 'products')!.rows;
    expect(products.every((p) => p.listed === 0 || p.listed === 1)).toBe(true);
  });

  it('carries users over with the same id and their bcrypt hash marked for rehashing', () => {
    const insert = plan.d1Statements.find((s) => s.startsWith('INSERT INTO users ') && s.includes(ownerA.id))!;
    expect(insert).toContain("'owner.a@example.com'");
    expect(insert).toContain("'bcrypt'");
  });

  it('refuses to pass when the converted data differs from the export', async () => {
    const tampered = structuredClone(manifest);
    (tampered.checks.shops as Record<string, Record<string, unknown>>)[shopA].sales_total = '999.99';
    const again = await buildLoadPlan(tampered, (file) => files.get(file) ?? []);
    expect(again.verification.ok).toBe(false);
    expect(again.verification.mismatches.join('\n')).toContain(`shop ${shopA} sales total (cents)`);
  });

  it('reports rows the schema rejects instead of loading them', () => {
    const broken = structuredClone(plan);
    const products = broken.shops.find((s) => s.shopId === shopA)!.tables.find((t) => t.table === 'products')!;
    products.rows[0].selling_price_cents = -1;
    expect(rehearse(broken, allD1Migrations(), schemas.shop).errors.join('\n')).toMatch(/CHECK constraint failed/);
  });
});

describe('value conversion', () => {
  it('converts decimal text to cents without floating point', () => {
    expect(decimalToCents('0.29')).toBe(29);
    expect(decimalToCents('18.5')).toBe(1850);
    expect(decimalToCents('12')).toBe(1200);
    expect(decimalToCents('15.990')).toBe(1599);
    expect(decimalToCents('-0.05')).toBe(-5);
    expect(() => decimalToCents('1.005')).toThrow();
    expect(() => decimalToCents('1e3')).toThrow();
  });

  it('normalises any offset to UTC and drops sub-millisecond digits', () => {
    expect(toIsoMillis('2026-11-03T07:48:20.256789+00:00')).toBe('2026-11-03T07:48:20.256Z');
    expect(toIsoMillis('2026-11-03T09:48:20+02:00')).toBe('2026-11-03T07:48:20.000Z');
    expect(toIsoMillis('2026-11-03T07:48:20.9999-05:30')).toBe('2026-11-03T13:18:20.999Z');
    expect(() => toIsoMillis('yesterday')).toThrow();
  });

  it('keeps the exact source text of every number', () => {
    const row = parseExact('{"price": 0.10, "nested": {"n": 1.50}}');
    expect(row.price).toEqual(new ExactNumber('0.10'));
    expect((row.nested as Record<string, unknown>).n).toEqual(new ExactNumber('1.50'));
  });
});
