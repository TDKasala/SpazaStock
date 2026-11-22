/**
 * Export the production Supabase data for the move to Cloudflare (docs/data-migration.md, step 1).
 *
 *   npm run data:export                 tables, users, manifest and every product picture
 *   npm run data:export -- --skip-files tables, users and manifest only
 *   npm run data:export -- --out <dir>  choose the output folder (default: a timestamped folder in
 *                                       scripts/migrate-data/export/, which git ignores)
 *
 * Settings come from the environment or scripts/migrate-data/.env (git-ignored):
 *   SUPABASE_DB_URL            Postgres connection string (Supabase → Connect → direct or session pooler)
 *   SUPABASE_URL               https://<project-ref>.supabase.co   (only needed for pictures)
 *   SUPABASE_SERVICE_ROLE_KEY  service-role or sb_secret_ key       (only needed for pictures)
 *   SUPABASE_DB_SSL            "disable" for a local database; TLS is required otherwise
 *
 * Read-only: one REPEATABLE READ, READ ONLY transaction for every table and check, then plain GETs
 * for the pictures. The output holds password hashes and customer data: keep it on your machine,
 * never commit or share it, and delete it after the cutover.
 */
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import postgres from 'postgres';
import { exportDatabase, listStorageObjects, type Query, type Sink } from './lib/exportDatabase.ts';
import { exportFiles, type FileStore } from './lib/exportFiles.ts';

const SCRIPT_DIR = import.meta.dirname;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}. Set it in the environment or in scripts/migrate-data/.env.`);
    process.exit(2);
  }
  return value;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable URL)';
  }
}

/** Private files: folders 0700, files 0600. */
function fsSink(root: string): Sink & FileStore {
  const made = new Set<string>();
  async function ensureDir(file: string): Promise<string> {
    const full = join(root, file);
    const dir = dirname(full);
    if (!made.has(dir)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      made.add(dir);
    }
    return full;
  }
  return {
    async appendLines(file, lines) {
      const full = await ensureDir(file);
      await appendFile(full, lines.map((l) => `${l}\n`).join(''), { mode: 0o600 });
    },
    async writeJson(file, value) {
      const full = await ensureDir(file);
      await writeFile(full, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    },
    async stat(file) {
      try {
        const full = join(root, file);
        const info = await stat(full);
        const bytes = await readFile(full);
        return { size: info.size, sha256: createHash('sha256').update(bytes).digest('hex') };
      } catch {
        return null;
      }
    },
    async write(file, bytes) {
      const full = await ensureDir(file);
      await writeFile(full, bytes, { mode: 0o600 });
      await chmod(full, 0o600);
    },
  };
}

async function main(): Promise<void> {
  const skipFiles = process.argv.includes('--skip-files');
  const dbUrl = requireEnv('SUPABASE_DB_URL');
  const supabaseUrl = skipFiles ? '' : requireEnv('SUPABASE_URL');
  const serviceKey = skipFiles ? '' : requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = resolve(arg('--out') ?? join(SCRIPT_DIR, 'export', stamp));
  await mkdir(out, { recursive: true, mode: 0o700 });
  const sink = fsSink(out);

  console.log(`Exporting from ${hostOf(dbUrl)} into ${out}`);

  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false, // works through the Supabase pooler as well as a direct connection
    ssl: process.env.SUPABASE_DB_SSL === 'disable' ? false : 'require',
    onnotice: () => {},
  });

  let objects: Awaited<ReturnType<typeof listStorageObjects>> = [];
  try {
    const manifest = await sql.begin('isolation level repeatable read read only', async (tx) => {
      const query: Query = (text, params) => tx.unsafe(text, (params ?? []) as never[]) as unknown as Promise<
        Record<string, unknown>[]
      >;
      const result = await exportDatabase(query, sink, {
        onTable: (name, rows) => console.log(`  ${name.padEnd(42)} ${String(rows).padStart(7)} rows`),
      });
      objects = await listStorageObjects(query);
      return result;
    });

    let filesSummary: Record<string, unknown> = { skipped: true };
    let failed = 0;
    if (!skipFiles) {
      console.log(`Downloading ${objects.length} pictures from ${hostOf(supabaseUrl)}`);
      const result = await exportFiles(objects, sink, {
        supabaseUrl,
        serviceKey,
        onFile: (done, total) => {
          if (done % 50 === 0 || done === total) console.log(`  ${done}/${total}`);
        },
      });
      await sink.appendLines('files.jsonl', result.files.map((f) => JSON.stringify(f)));
      failed = result.failed.length;
      filesSummary = { objects: objects.length, downloaded: result.files.length, bytes: result.bytes, failed: result.failed };
    }

    await sink.writeJson('manifest.json', { ...manifest, files: filesSummary });

    const images = manifest.checks.images as { missing_objects?: number | string } | undefined;
    const ledger = Number(manifest.checks.ledger_out_of_balance ?? 0);
    console.log('');
    console.log(`Tables: ${manifest.tables.length}, rows: ${manifest.tables.reduce((n, t) => n + t.rows, 0)}, users: ${manifest.users.rows}`);
    if (manifest.cyclicTables.length) console.log(`Foreign-key cycles (loader defers these): ${manifest.cyclicTables.join(', ')}`);
    if (Number(images?.missing_objects ?? 0) > 0) console.warn(`Warning: ${images?.missing_objects} picture paths point at no stored file.`);
    if (ledger > 0) console.warn(`Warning: ${ledger} products have batch stock that differs from their movement history.`);
    if (failed > 0) {
      console.error(`${failed} pictures failed to download (listed in manifest.json). Run again to resume.`);
      process.exitCode = 1;
    }
    console.log(`Done: ${join(out, 'manifest.json')}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  // postgres.js errors never include the password; print the message only.
  console.error('Export failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
