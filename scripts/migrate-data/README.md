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
