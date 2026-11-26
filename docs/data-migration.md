# Moving the Supabase data to Cloudflare

Companion to [`cloudflare-migration.md`](cloudflare-migration.md). That document covers the code.
This one covers the data that is in production today and how it gets moved without losing anything.

## 1. What is in production (Supabase project `Spazastock`, measured 2026-11-21)

Read-only inspection through the Supabase connector. All 40 migrations in `supabase/migrations/`
are applied, so the live schema matches the repository.

| Data | Rows / size | Notes |
|---|---|---|
| Users (`auth.users`) | 19 | all email + password, all confirmed, all bcrypt (`$2a$`) |
| Shops / members | 19 / 20 | 15 shops have products, 7 have sales |
| Products | 579 | 537 have a picture |
| Stock batches / movements | 518 / 567 | the stock ledger (must reconcile exactly) |
| Sales / sale items | 44 / 44 | last sale 2026-11-03 |
| Shared catalog products / barcodes | 310 / 310 | 304 with a stored picture, 86 with an external image URL |
| Expiry alerts / notifications | 395 / 402 | 0 pushes waiting |
| Push subscriptions | 7 | only survive if the **same VAPID keys** are kept |
| Platform admins / audit log | 1 / 64 | |
| Wholesale orders | 0 | |
| Product pictures (`product-images` bucket, private) | 629 files, 15.8 MB | 325 under `<shop-id>/…`, 304 under `catalog/…`; none orphaned |
| Vault secrets | 5 | `vapid_public_key`, `vapid_private_key`, `vapid_subject`, `project_url`, `expiry_push_secret` |
| Cron jobs | 3 | `expiry-alerts-generate`, `expiry-alerts-push`, `low-stock-alerts-generate` |

About 4,000 application rows and 16 MB of files in total. The copy itself takes minutes. The work
is in transforming the data correctly and proving that nothing changed.

Type facts that shape the transform:
- 10 `numeric` money/quantity columns. No money value has more than 2 decimals, so prices can become
  **integer cents** with no rounding.
- 92 `timestamptz` columns → ISO-8601 UTC text. 118 `uuid` columns → text, with the **same values**.
- 5 `jsonb` columns → JSON text. One array column (`shops.expiry_reminder_days`) → JSON text.

## 2. What moves, what doesn't

| Moves | Doesn't move (rebuilt or temporary) |
|---|---|
| All `public` and `private` tables except those on the right | `product_lookup_rate` (1-minute rate windows) |
| `auth.users`: id, email, bcrypt hash, confirmed-at, created/last-sign-in, metadata | `auth.sessions`, `refresh_tokens`, `one_time_tokens`, `flow_state`: everyone signs in once more |
| `storage.objects` files → R2, same object keys | `cron.*`, `net.*`: replaced by Cron Triggers |
| Vault secrets → `wrangler secret put` (VAPID keys **unchanged**) | `project_url`, `expiry_push_secret`: not needed on Workers |
| `product_lookup_cache` (optional; saves Open Food Facts calls) | `auth` MFA/SSO/OAuth tables: all empty / unused |

## 3. How the move works

The whole process lives in `scripts/migrate-data/`, run three ways: **export** (written: `npm run data:export`, see its [README](../scripts/migrate-data/README.md)), **load** and **verify**.
It is run against a staging Cloudflare environment as many times as needed before production.

### Step 1: export (read-only on Supabase)

- For each table in dependency order (users → shops → members → catalog → products → packagings/barcodes →
  batches → sales → sale items → movements → alerts → …), select every row ordered by primary key and write
  `export/<table>.jsonl`.
- Connection: the database's direct Postgres URL (Supabase → Connect). It is read-only work, but it is a password,
  so it is set as an environment variable on the machine that runs the script. It is never committed or
  pasted into chat.
- Users: `select id, email, encrypted_password, email_confirmed_at, created_at, last_sign_in_at, raw_user_meta_data from auth.users`.
  The hashes go only into the export folder, which is git-ignored and deleted after cutover.
- Files: list `storage.objects` and download each one with the service-role key → `export/files/<same key>`,
  recording size + SHA-256.
- Write `export/manifest.json`: row count per table, file count/bytes, and the checks in step 3 computed **on Supabase**.

### Step 2: transform + load

Status: schemas (`npm run data:schema`) and conversion + verification + local rehearsal
(`npm run data:prepare`) are written and tested; D1 loading uses `wrangler d1 execute`. Shop import
(`npm run data:import`) and the post-load verification are written too; see
[`scripts/migrate-data/README.md`](../scripts/migrate-data/README.md).

- Types as listed in section 1: numeric → integer cents (columns renamed `*_cents`), timestamps → ISO UTC with milliseconds, uuid/jsonb/array → text. The
  same UUIDs are kept everywhere, so every reference stays valid and phones' local IndexedDB copies still match.
- **Option A (D1 + a Durable Object per shop):** global tables (users, shops index, members, invites, catalog,
  plans, subscriptions, admins, audit log, push subscriptions) → `wrangler d1 execute --file` in batches.
  Each shop's rows (products, batches, movements, sales, alerts, wholesale…) → posted to a one-time,
  admin-only `POST /api/admin/import-shop/:shopId` that writes them in one `transactionSync` inside
  that shop's object.
- **Option B (Postgres via Hyperdrive):** a straight `pg_dump --data-only` of `public` + `private` into the
  new database, plus the users into the Worker's user table. No type changes needed.
- Files → R2 bucket `product-images` with the **same keys**. `image_path` values then need no rewrite.
  16 MB is small enough for `wrangler r2 object put` in a loop, or R2 Super Slurper using Supabase's S3 endpoint.
- Users: imported with their bcrypt hash and a `hash_kind = 'bcrypt'` flag. On first sign-in the Worker checks
  bcrypt and rehashes with PBKDF2. With 19 users this costs nothing.
- Secrets: the VAPID key pair is copied from Vault into Worker secrets by the owner. Keeping the same pair
  means the 7 existing phone subscriptions keep receiving alerts with no re-prompt.

### Step 3: verify (must match the manifest exactly before go-live)

- Row count of every table.
- Per shop: number of products, total units in stock (`sum(stock_batches.quantity)`), and the ledger rule
  that batch quantity = initial quantity + sum of its movements.
- Per shop: number of sales and `sum(total_amount)` in cents. Voided items reconcile with `sale_item_voids`.
- Catalog: products/barcodes count, and that every barcode points at an existing product.
- Files: 629 objects, 15,783,176 bytes, every SHA-256 equal, and every `image_path` in products/catalog
  resolves in R2.
- Functional smoke test on staging: sign in as a test user with the old password, see the stock list,
  make a sale, open `/admin`, receive a test push.

## 4. Order of events

1. **Done:** export script + production export (read-only) into gitignored `scripts/migrate-data/export/`.
2. **Done:** load + verify into staging, then production D1/R2 (2026-11-23).
3. **Done (cutover 2026-11-23):** Cloudflare production is canonical at
   https://spazastock.kasalatechnologies.co.za (backup https://spazastock.deniskasala17.workers.dev).
   Workers Builds deploys `main` with `VITE_BACKEND=cloudflare`. Email Sending is on
   `swipe-a-bill.com` (`noreply@swipe-a-bill.com`).
4. **Rollback window (~30 days):** keep the Supabase project and the Vercel `spazastock` project as-is
   for emergency rollback. Do not point users at `spazastock.vercel.app` for day-to-day use.
5. **After 30 days:** final `pg_dump` + bucket archive in R2 (cold), pause/delete Supabase, retire the
   Vercel project.

## 5. What I need from you

- **The database choice (A or B).** It changes step 2 only.
- A **Cloudflare API token** (Workers, D1, R2 edit) for this session. The Cloudflare connector failed to connect
  here, so I'd use `wrangler` with the token instead.
- For the export: the **database connection string** and **service-role key**. These are best kept on your machine,
  where you run the script, or added as secrets on this environment. They should never be pasted in chat.
- Copy the VAPID keys yourself from Vault to `wrangler secret put` at cutover, so the private key never
  passes through me.
