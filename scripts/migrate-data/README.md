# Data migration scripts

Moves the production Supabase data to Cloudflare. The plan, and what each step must prove, are in
[`docs/data-migration.md`](../../docs/data-migration.md).

## Export (step 1, read-only)

1. `cp scripts/migrate-data/.env.example scripts/migrate-data/.env`, then fill it in (the file is git-ignored):
   - `SUPABASE_DB_URL`: Supabase dashboard → **Connect** → *Direct connection* (or *Session pooler* if
     your network has no IPv6). Use the database password.
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: only needed for the product pictures.
2. `npm ci`, then `npm run data:export` (or `npm run data:export -- --skip-files` for tables only).

The output goes to `scripts/migrate-data/export/<timestamp>/` (git-ignored, owner-only permissions):

| Path | Content |
|---|---|
| `manifest.json` | load order, columns and row count per table, foreign-key cycles, source migrations, the totals the loader must reproduce, and the picture download summary |
| `db/<schema>.<table>.jsonl` | one row per line, exactly as Postgres renders it (`to_jsonb(row)::text`) |
| `auth/users.jsonl` | id, email, **bcrypt password hash**, confirmation and sign-in times, metadata |
| `files/<bucket>/<key>` + `files.jsonl` | every stored picture with its size and SHA-256 |

All tables and totals come from one `REPEATABLE READ, READ ONLY` transaction, so they agree with each other
even if a shop keeps selling during the export. Run it again with the same `--out` folder to resume picture
downloads; pictures already there with the right size are kept.

**The export holds password hashes and every shop's data.** Keep it on your own machine, never commit,
upload or paste it anywhere, and delete it once the cutover is verified.

`src/test/db/dataExport.test.ts` runs the export against all migrations on PGlite, so a schema change
that would break it, or a new table it would miss, fails the test suite.

## Schemas (Option A: D1 + one Durable Object per shop)

`npm run data:schema` regenerates both SQLite schemas from `supabase/migrations` (on PGlite, no network):

| File | Database | Holds |
|---|---|---|
| `migrations/d1/0001_initial.sql` | shared D1 (`DB` binding) | users, shops, members, invites, profiles, notifications and push, plans and subscriptions, shared catalog, platform admin and audit |
| `worker/shop/schema.sql` | each shop's Durable Object | products, packagings, barcodes, batches, movements, sales, voids, discrepancies, expiry and low-stock alerts, wholesale orders |

Which table goes where is set in `lib/partition.ts`; the generator refuses a table that is not listed.
Conventions: tables are `STRICT`; ids stay the same; money becomes whole cents in `<name>_cents` columns;
timestamps are ISO-8601 UTC with milliseconds (`2026-11-21T14:00:00.123Z`, same as JavaScript's
`toISOString()`); booleans are 0/1; jsonb and arrays are JSON text.

The end of each file lists what SQLite cannot express and the Worker must enforce: regex CHECKs (phone,
email, image path, codes), defaults taken from the signed-in user (`auth.uid()`) or `gen_random_uuid()`,
and foreign keys between D1 and a shop object (`shop_id`, user ids, a product's catalog link).
Two more differences to keep in mind when porting code:
- SQLite's `lower()` only folds ASCII. `wholesalers_active_name_idx` relies on it, so the Worker should
  store or compare a Unicode-lowercased name.
- Catalog search used Postgres trigram indexes; on D1 it needs an FTS5 table (to add with the catalog port).

`src/test/db/dataLoad.test.ts` fails when the committed schemas are out of date with the migrations.

## Prepare the load (steps 2 and 3)

```
npm run data:prepare -- --export scripts/migrate-data/export/<timestamp>
```

1. Converts every row as above (money from the exact decimal text, never through floating point).
2. Recomputes every total in the export manifest from the converted rows: row counts per table, users,
   and per shop members, products, batches, units in stock, movements, sales count and total in cents,
   sale items and voided units. Any difference stops it.
3. Rehearses the load into local SQLite built from both schemas, with every type, CHECK, UNIQUE and
   foreign key enforced. Any rejected row stops it.

Only then it writes, into `<export>/load/` (private, git-ignored like the export):
`d1-data.sql` for D1, `shops/<shop-id>.json` per shop for its Durable Object, and `report.json`.

Loading D1 (needs the database created and its id in `wrangler.jsonc`):

```
npx wrangler d1 migrations apply spazastock --remote
npx wrangler d1 execute spazastock --remote --file <export>/load/d1-data.sql
```

The same two commands with `--local` load a local D1 for testing. The shop bundles are imported by the
shop Durable Object, which is built next.
