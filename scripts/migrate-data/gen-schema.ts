/**
 * Regenerates the Cloudflare SQLite schemas from supabase/migrations:
 *   migrations/d1/0001_initial.sql   shared D1 database
 *   worker/shop/schema.sql           per-shop Durable Object database
 *
 *   npm run data:schema
 *
 * Runs every migration on PGlite (no network, no Supabase) and translates the resulting catalog.
 * src/test/db/sqliteSchema.test.ts fails if the committed files are out of date.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createDatabase } from '../../src/test/db/harness.ts';
import { generateSchemas } from './lib/sqliteSchema.ts';

export const ROOT = join(import.meta.dirname, '..', '..');
export const D1_SCHEMA_PATH = join(ROOT, 'migrations', 'd1', '0001_initial.sql');
export const SHOP_SCHEMA_PATH = join(ROOT, 'worker', 'shop', 'schema.sql');

const pg = await createDatabase();
try {
  const schemas = await generateSchemas(async (text, params) => (await pg.query<Record<string, unknown>>(text, params)).rows);
  for (const [path, sql] of [
    [D1_SCHEMA_PATH, schemas.d1],
    [SHOP_SCHEMA_PATH, schemas.shop],
  ] as const) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, sql);
    console.log(`wrote ${path.slice(ROOT.length + 1)}`);
  }
  console.log(`D1: ${schemas.notes.d1.length} rules left to the Worker; shop: ${schemas.notes.shop.length}`);
} finally {
  await pg.close();
}
