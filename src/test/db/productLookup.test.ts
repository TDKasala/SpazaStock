// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createDatabase,
  createShop,
  createUser,
  query,
  type User,
} from './harness';

let pg: PGlite;
let owner: User;
let shop: string;

beforeAll(async () => {
  pg = await createDatabase();
  owner = await createUser(pg);
  shop = await createShop(pg, owner);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('product_lookup_cache', () => {
  it('exists and is closed to authenticated and anonymous callers', async () => {
    const { rows } = await pg.query<{ relrowsecurity: boolean }>(
      `select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'product_lookup_cache'`
    );
    expect(rows[0]?.relrowsecurity).toBe(true);

    await expect(
      query(pg, owner, `select barcode from product_lookup_cache`)
    ).rejects.toThrow();
    await expect(
      query(pg, null, `insert into product_lookup_cache (barcode, status, expires_at) values ('x', 'not_found', now())`)
    ).rejects.toThrow();
  });

  it('allows the service role to insert found and not_found rows', async () => {
    await query(
      pg,
      'service',
      `insert into product_lookup_cache (barcode, status, payload, provider, expires_at)
       values ('5449000000996', 'found', '{"name":{"value":"Coke","source":"external"}}'::jsonb, 'open_food_facts', now() + interval '30 days')`
    );
    await query(
      pg,
      'service',
      `insert into product_lookup_cache (barcode, status, payload, provider, expires_at)
       values ('4006381333931', 'not_found', null, 'open_food_facts', now() + interval '7 days')`
    );

    const rows = await query<{ barcode: string; status: string }>(
      pg,
      'service',
      `select barcode, status from product_lookup_cache where barcode in ('5449000000996', '4006381333931') order by barcode`
    );
    expect(rows).toEqual([
      { barcode: '4006381333931', status: 'not_found' },
      { barcode: '5449000000996', status: 'found' },
    ]);
  });

  it('rejects a found row without a payload', async () => {
    await expect(
      query(
        pg,
        'service',
        `insert into product_lookup_cache (barcode, status, payload, expires_at)
         values ('036000291452', 'found', null, now() + interval '1 day')`
      )
    ).rejects.toThrow();
  });
});

describe('product_lookup_rate', () => {
  it('is closed to clients and writable by the service role for a shop', async () => {
    await expect(query(pg, owner, `select * from product_lookup_rate`)).rejects.toThrow();

    await query(
      pg,
      'service',
      `insert into product_lookup_rate (shop_id, window_start, request_count) values ($1, date_trunc('minute', now()), 1)`,
      [shop]
    );
    const rows = await query<{ request_count: number }>(
      pg,
      'service',
      `select request_count from product_lookup_rate where shop_id = $1`,
      [shop]
    );
    expect(rows[0]?.request_count).toBe(1);
  });
});
