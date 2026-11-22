/**
 * Cutover step: push the prepared shop bundles and the product pictures to the deployed Worker,
 * then verify every shop against the export manifest (docs/data-migration.md, steps 2 and 3).
 *
 *   IMPORT_TOKEN=... npm run data:import -- --export <export folder> --url https://<worker host> [--replace]
 *
 * Needs the Worker deployed with the same IMPORT_TOKEN secret (`wrangler secret put IMPORT_TOKEN`)
 * and the D1 rows already loaded (`wrangler d1 execute <db> --remote --file <export>/load/d1-data.sql`).
 * Run `npm run data:prepare` first: it writes <export>/load/shops/*.json.
 * Safe to run again: a shop that already has data is skipped unless --replace is given, and
 * pictures are simply overwritten with the same bytes.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ExportManifest } from './lib/exportDatabase.ts';
import { decimalToCents } from './lib/transform.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const source = resolve(arg('--export') ?? '');
  const base = (arg('--url') ?? '').replace(/\/+$/, '');
  const token = process.env.IMPORT_TOKEN ?? '';
  const replace = process.argv.includes('--replace');
  if (!arg('--export') || !base || token.length < 32) {
    console.error('Usage: IMPORT_TOKEN=<32+ chars> npm run data:import -- --export <folder> --url https://<worker host> [--replace]');
    process.exit(2);
  }
  const headers = { Authorization: `Bearer ${token}` };
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')) as ExportManifest;
  const shopsDir = join(source, 'load', 'shops');
  const files = (await readdir(shopsDir)).filter((f) => f.endsWith('.json')).sort();

  let failed = 0;
  console.log(`Importing ${files.length} shops into ${base}`);
  for (const file of files) {
    const shopId = file.replace(/\.json$/, '');
    const res = await fetch(`${base}/api/migrate/shop/${shopId}${replace ? '?replace=1' : ''}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: await readFile(join(shopsDir, file), 'utf8'),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    if (!res.ok) {
      const alreadyThere = body.error?.code === '23505';
      console.log(`  ${shopId}: ${alreadyThere ? 'already imported (skipped)' : `FAILED ${res.status} ${body.error?.message ?? ''}`}`);
      if (!alreadyThere) failed++;
    } else {
      console.log(`  ${shopId}: imported`);
    }
  }

  // Pictures, with the same keys as in Supabase Storage.
  const listed = await readFile(join(source, 'files.jsonl'), 'utf8').catch(() => '');
  const pictures = listed.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { key: string; path: string; mimetype: string | null });
  console.log(`Uploading ${pictures.length} pictures`);
  for (const [i, p] of pictures.entries()) {
    const res = await fetch(`${base}/api/migrate/image/${p.key.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': p.mimetype ?? 'image/webp' },
      body: await readFile(join(source, p.path)),
    });
    if (!res.ok) {
      console.log(`  ${p.key}: FAILED ${res.status}`);
      failed++;
    }
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${pictures.length}`);
  }

  // Verify each shop's ledger against the totals Postgres computed at export time.
  console.log('Verifying shops against the export manifest');
  const perShop = manifest.checks.shops as Record<string, Record<string, unknown>>;
  let mismatches = 0;
  for (const [shopId, expected] of Object.entries(perShop)) {
    const res = await fetch(`${base}/api/migrate/shop/${shopId}/stats`, { headers });
    const stats = (await res.json()) as Record<string, number>;
    const checks: [string, unknown, unknown][] = [
      ['products', stats['rows:products'], expected.products],
      ['batches', stats['rows:stock_batches'], expected.batches],
      ['units in stock', stats.units_in_stock, expected.units_in_stock],
      ['movements', stats['rows:stock_movements'], expected.movements],
      ['movement units', stats.movement_units, expected.movement_units],
      ['sales', stats['rows:sales'], expected.sales],
      ['sales total (cents)', stats.sales_total_cents, decimalToCents(String(expected.sales_total))],
      ['sale items', stats['rows:sale_items'], expected.sale_items],
      ['voided units', stats.voided_units, expected.voided_units],
    ];
    for (const [label, got, want] of checks) {
      if (String(got ?? 0) !== String(want)) {
        console.log(`  MISMATCH shop ${shopId} ${label}: got ${got}, expected ${want}`);
        mismatches++;
      }
    }
  }
  console.log(mismatches === 0 ? `All ${Object.keys(perShop).length} shops match the export.` : `${mismatches} mismatches.`);
  if (failed || mismatches) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('Import failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
