/**
 * Converts an export into what Cloudflare loads, and proves it before anything is sent
 * (docs/data-migration.md, steps 2 and 3).
 *
 *   npm run data:prepare -- --export scripts/migrate-data/export/<timestamp> [--out <dir>]
 *
 * 1. Converts every row (money → cents, timestamps → ISO UTC ms, booleans → 0/1, ids unchanged).
 * 2. Checks the converted rows reproduce every total in the export manifest.
 * 3. Rehearses the load on local SQLite built from every migration in migrations/d1 and
 *    worker/shop/schema.sql, with every constraint and foreign key enforced.
 * Only when all three pass does it write:
 *   <out>/d1-data.sql            rows for the shared D1 database (wrangler d1 execute --file)
 *   <out>/shops/<shop-id>.json   one bundle per shop for its Durable Object import
 *   <out>/report.json            counts and what was verified
 * The output holds password hashes and customer data, like the export: keep it private.
 */
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { ExportManifest } from './lib/exportDatabase.ts';
import { rehearse } from './lib/rehearse.ts';
import { buildLoadPlan } from './lib/transform.ts';

const ROOT = join(import.meta.dirname, '..', '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const exportDir = arg('--export');
  if (!exportDir) {
    console.error('Usage: npm run data:prepare -- --export <export folder> [--out <folder>]');
    process.exit(2);
  }
  const source = resolve(exportDir);
  const out = resolve(arg('--out') ?? join(source, 'load'));

  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')) as ExportManifest;
  if (manifest.format !== 'spazastock-export/1') throw new Error(`Unknown export format: ${manifest.format}`);

  const readLines = (file: string) =>
    createInterface({ input: createReadStream(join(source, file), 'utf8'), crlfDelay: Infinity });

  console.log(`Converting ${manifest.tables.length} tables and ${manifest.users.rows} users from ${source}`);
  const plan = await buildLoadPlan(manifest, async function* (file) {
    for await (const line of readLines(file)) if (line) yield line;
  });

  console.log(`Checked ${plan.verification.compared} totals against the export manifest`);
  if (!plan.verification.ok) {
    for (const m of plan.verification.mismatches) console.error(`  MISMATCH ${m}`);
    console.error('Nothing written: the converted data does not match the export.');
    process.exit(1);
  }

  // Every D1 migration, in order, as `wrangler d1 migrations apply` will run them.
  const migrationsDir = join(ROOT, 'migrations', 'd1');
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const d1Schema = (await Promise.all(files.map((f) => readFile(join(migrationsDir, f), 'utf8')))).join('\n');
  const shopSchema = await readFile(join(ROOT, 'worker', 'shop', 'schema.sql'), 'utf8');
  const rehearsal = rehearse(plan, d1Schema, shopSchema);
  console.log(`Rehearsed the load on local SQLite: D1 + ${plan.shops.length} shop databases`);
  if (!rehearsal.ok) {
    for (const e of rehearsal.errors.slice(0, 50)) console.error(`  REJECTED ${e}`);
    if (rehearsal.errors.length > 50) console.error(`  … and ${rehearsal.errors.length - 50} more`);
    console.error('Nothing written: the schema rejects some rows.');
    process.exit(1);
  }

  await mkdir(join(out, 'shops'), { recursive: true, mode: 0o700 });
  await writeFile(join(out, 'd1-data.sql'), `${plan.d1Statements.join('\n')}\n`, { mode: 0o600 });
  for (const bundle of plan.shops) {
    await writeFile(join(out, 'shops', `${bundle.shopId}.json`), JSON.stringify(bundle), { mode: 0o600 });
  }
  await writeFile(
    join(out, 'report.json'),
    `${JSON.stringify(
      {
        exportStartedAt: manifest.startedAt,
        preparedAt: new Date().toISOString(),
        verifiedTotals: plan.verification.compared,
        d1Rows: rehearsal.d1Rows,
        shopRows: rehearsal.shopRows,
        shops: plan.shops.length,
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );

  console.log(`Ready in ${out}`);
  console.log('Next, against the real database:');
  console.log('  npx wrangler d1 migrations apply spazastock --remote');
  console.log(`  npx wrangler d1 execute spazastock --remote --file ${join(out, 'd1-data.sql')}`);
  console.log('  then import each shops/<id>.json through the shop object (built with the shop Worker).');
}

main().catch((err: unknown) => {
  console.error('Prepare failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
