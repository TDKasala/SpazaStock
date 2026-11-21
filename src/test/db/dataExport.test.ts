// @vitest-environment node
/**
 * Runs the production data export (scripts/migrate-data) against every migration on PGlite, so
 * a schema change that breaks the export, or a table it would silently miss, fails here first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createDatabase, createShop, createUser, newProduct, sell, stockIn, type User } from './harness';
import {
  exportDatabase,
  listStorageObjects,
  loadOrder,
  type ExportManifest,
  type Query,
  type Sink,
  type TableInfo,
} from '../../../scripts/migrate-data/lib/exportDatabase';
import { authHeaders, exportFiles, objectUrl, safeLocalPath } from '../../../scripts/migrate-data/lib/exportFiles';

let pg: PGlite;
let owner: User;
let shop: string;
let manifest: ExportManifest;
const files = new Map<string, string[]>();

function memorySink(): Sink {
  return {
    async appendLines(path, lines) {
      files.set(path, [...(files.get(path) ?? []), ...lines]);
    },
    async writeJson(path, value) {
      files.set(path, [JSON.stringify(value)]);
    },
  };
}

beforeAll(async () => {
  pg = await createDatabase();
  // Columns the real auth.users has and the stand-in lacks.
  await pg.exec(`alter table auth.users add column encrypted_password text, add column updated_at timestamptz`);
  owner = await createUser(pg, 'owner@example.com');
  await pg.query(`update auth.users set encrypted_password = '$2a$10$abcdefghijklmnopqrstuv' where id = $1`, [owner.id]);
  shop = await createShop(pg, owner);
  const product = await newProduct(pg, owner, shop);
  await stockIn(pg, owner, shop, product.id, 10, { expiry: '2099-01-01' });
  await sell(pg, owner, shop, [{ product_id: product.id, quantity: 3 }]);
  await pg.query(`insert into storage.buckets (id, name) values ('product-images', 'product-images') on conflict do nothing`);
  await pg.query(
    `insert into storage.objects (bucket_id, name, metadata) values ('product-images', $1, '{"size": 4, "mimetype": "image/webp"}')`,
    [`${shop}/a.webp`]
  );

  // Exported as the database owner, inside one read-only snapshot, like the CLI does.
  manifest = await pg.transaction(async (tx) => {
    await tx.exec('set transaction isolation level repeatable read, read only');
    const query: Query = async (text, params) => (await tx.query<Record<string, unknown>>(text, params)).rows;
    return exportDatabase(query, memorySink(), { now: () => new Date('2026-11-21T00:00:00Z') });
  });
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('data export', () => {
  it('exports every public and private table except the skipped ones', async () => {
    const { rows } = await pg.query<{ name: string }>(
      `select table_schema || '.' || table_name as name from information_schema.tables
        where table_schema in ('public', 'private') and table_type = 'BASE TABLE' order by 1`
    );
    const expected = rows.map((r) => r.name).filter((n) => n !== 'public.product_lookup_rate');
    expect(manifest.tables.map((t) => t.name).sort()).toEqual(expected);
    expect(manifest.skippedTables).toEqual(['public.product_lookup_rate']);
  });

  it('lists every table after the tables it references', () => {
    const position = new Map(manifest.tables.map((t, i) => [t.name, i]));
    for (const table of manifest.tables) {
      if (manifest.cyclicTables.includes(table.name)) continue;
      for (const parent of table.dependsOn) expect(position.get(parent)!).toBeLessThan(position.get(table.name)!);
    }
    expect(position.get('public.shops')!).toBeLessThan(position.get('public.products')!);
    expect(position.get('public.products')!).toBeLessThan(position.get('public.stock_batches')!);
  });

  it('writes one JSON line per row with the row count in the manifest', () => {
    for (const table of manifest.tables) {
      expect(files.get(table.file)?.length ?? 0, table.name).toBe(table.rows);
    }
    const sale = JSON.parse(files.get('db/public.sales.jsonl')![0]);
    expect(sale.shop_id).toBe(shop);
    expect(sale.total_amount).toBe(55.5);
  });

  it('keeps exact decimal text instead of rounding through JavaScript', () => {
    const line = files.get('db/public.products.jsonl')![0];
    expect(line).toContain('"selling_price": 18.5');
    expect(line).toContain('"buying_price": 12');
  });

  it('exports users with their password hash and only the needed columns', () => {
    const users = files.get('auth/users.jsonl')!.map((l) => JSON.parse(l));
    expect(manifest.users.rows).toBe(users.length);
    const row = users.find((u) => u.id === owner.id);
    expect(row.encrypted_password).toBe('$2a$10$abcdefghijklmnopqrstuv');
    expect(Object.keys(row).sort()).toEqual([...manifest.users.columns].sort());
  });

  it('records the totals the loader must reproduce', () => {
    const shops = manifest.checks.shops as Record<string, Record<string, unknown>>;
    expect(shops[shop]).toMatchObject({
      products: 1,
      batches: 1,
      units_in_stock: '7',
      movement_units: '7',
      sales: 1,
      sales_total: '55.50',
      sale_items: 1,
    });
    expect(Number(manifest.checks.ledger_out_of_balance)).toBe(0);
    expect(manifest.checks.images).toMatchObject({ objects: 1, bytes: '4', missing_objects: 0 });
  });

  it('lists the stored pictures from the same snapshot', async () => {
    const query: Query = async (text, params) => (await pg.query<Record<string, unknown>>(text, params)).rows;
    expect(await listStorageObjects(query)).toEqual([
      { bucket: 'product-images', name: `${shop}/a.webp`, size: 4, mimetype: 'image/webp' },
    ]);
  });
});

describe('load order', () => {
  const table = (name: string, dependsOn: string[] = []): TableInfo => ({
    name,
    schema: 'public',
    table: name,
    primaryKey: ['id'],
    columns: [],
    dependsOn,
  });

  it('puts tables in a foreign-key cycle last and reports them', () => {
    const { ordered, cyclic } = loadOrder([table('a', ['b']), table('b', ['a']), table('c'), table('d', ['c'])]);
    expect(ordered.map((t) => t.name)).toEqual(['c', 'd', 'a', 'b']);
    expect(cyclic).toEqual(['a', 'b']);
  });
});

describe('picture download', () => {
  const objects = [
    { bucket: 'product-images', name: 'shop-1/a b.webp', size: 3, mimetype: 'image/webp' },
    { bucket: 'product-images', name: 'catalog/x.webp', size: 2, mimetype: 'image/webp' },
  ];

  function memoryStore() {
    const written = new Map<string, Uint8Array>();
    return {
      written,
      async stat(path: string) {
        const bytes = written.get(path);
        return bytes ? { size: bytes.byteLength, sha256: 'cached' } : null;
      },
      async write(path: string, bytes: Uint8Array) {
        written.set(path, bytes);
      },
    };
  }

  it('builds the authenticated object URL with each path segment encoded', () => {
    expect(objectUrl('https://ref.supabase.co/', 'product-images', 'shop-1/a b.webp')).toBe(
      'https://ref.supabase.co/storage/v1/object/authenticated/product-images/shop-1/a%20b.webp'
    );
  });

  it('sends sb_secret_ keys as apikey only and legacy JWTs in both headers', () => {
    expect(authHeaders('sb_secret_abc')).toEqual({ apikey: 'sb_secret_abc' });
    expect(authHeaders('eyJx.eyJy.z')).toEqual({ apikey: 'eyJx.eyJy.z', Authorization: 'Bearer eyJx.eyJy.z' });
  });

  it('refuses keys that would leave the output folder', () => {
    expect(() => safeLocalPath('product-images', '../etc/passwd')).toThrow();
    expect(safeLocalPath('product-images', 'catalog/x.webp')).toBe('files/product-images/catalog/x.webp');
  });

  it('downloads, hashes, retries server errors and reports what still fails', async () => {
    const store = memoryStore();
    let calls = 0;
    const fakeFetch = (async (url: string) => {
      calls++;
      if (url.endsWith('a%20b.webp')) return calls === 1 ? new Response('busy', { status: 503 }) : new Response('abc');
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await exportFiles(objects, store, {
      supabaseUrl: 'https://ref.supabase.co',
      serviceKey: 'sb_secret_abc',
      fetch: fakeFetch,
      concurrency: 1,
      sleep: async () => {},
    });

    expect(result.files).toEqual([
      {
        bucket: 'product-images',
        key: 'shop-1/a b.webp',
        path: 'files/product-images/shop-1/a b.webp',
        size: 3,
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        mimetype: 'image/webp',
      },
    ]);
    expect(result.failed).toEqual([{ bucket: 'product-images', key: 'catalog/x.webp', error: 'HTTP 404' }]);
    expect(result.bytes).toBe(3);
  });

  it('keeps a file already downloaded with the right size when run again', async () => {
    const store = memoryStore();
    store.written.set('files/product-images/catalog/x.webp', new Uint8Array([1, 2]));
    const fakeFetch = (async () => new Response('abc')) as unknown as typeof fetch;
    const result = await exportFiles([objects[1]], store, {
      supabaseUrl: 'https://ref.supabase.co',
      serviceKey: 'k',
      fetch: fakeFetch,
    });
    expect(result.files[0]).toMatchObject({ key: 'catalog/x.webp', size: 2, sha256: 'cached' });
  });
});
