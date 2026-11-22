# Moving SpazaStock from Supabase + Vercel to Cloudflare

Audit date: 2026-11-21. Starting point: commit `38dba60`.

Moving the existing data is planned separately in [`data-migration.md`](data-migration.md).

This document has three parts: what the app uses today, how each piece maps onto Cloudflare,
and the order to move it in. Phase 1 (hosting) is already in the repository and works next to
Vercel, so nothing in production changes until DNS is switched.

## 0. Status (2026-11-22): Option A is built; deploy and data load are next

**Decision:** Option A, fully Cloudflare. Shared data lives in D1. Each shop's ledger lives in its
own Durable Object (SQLite).

| Piece | State | Where |
|---|---|---|
| Hosting (PWA, headers, SPA routes) | done | `wrangler.jsonc`, `public/_headers`, `worker/index.ts` |
| Auth (code sign-up/sign-in, passwords, reset, sessions) | done, tested | `worker/auth`, `migrations/d1/0002_auth.sql` |
| Shop ledger: stock, sales, voids, expiry, products, packs, barcodes, wholesale, alerts | done, checked call-by-call against Postgres | `worker/shop` |
| Shared functions: shops, team, invites, push, sync reports, catalog (search, adopt, review, confirm, intake, submissions) | done, checked against Postgres | `worker/d1` |
| Sync pull, direct table reads, pictures (R2), product lookup | done | `worker/api`, `worker/productLookup.ts` |
| Cron alerts + Web Push (WebCrypto) | done, tested with an independent receiver | `worker/cron.ts`, `worker/push` |
| App switch | done: `VITE_BACKEND=cloudflare` uses `src/lib/cloud/cloudClient.ts`, without it the app still uses Supabase | `src/lib/supabase.ts` |
| Data export, convert, verify, rehearse | done | `scripts/migrate-data` |
| Platform admin console (27 `admin_*` functions) | **not yet ported** | see task list below |
| Cloudflare resources | created: D1 `spazastock` (b231f3db…), `spazastock-staging` (bf9e655e…), R2 `spazastock-product-images[-staging]` | |
| Staging/production deploy | **not done** (needs your Cloudflare API token on the machine that deploys) | runbook below |

Proof so far: the differential tests in `src/test/worker` run each ported function against the original
Postgres function (PGlite with the real migrations) and the TypeScript port, then compare results, error
codes and messages, and the rows left behind. On `wrangler dev`, the real app in a browser signed in,
loaded its shop and synced stock through the Worker with no errors.

### Deploy runbook (staging first)

Run on a machine with `CLOUDFLARE_API_TOKEN` set (Workers, D1, R2, Durable Objects edit):

```bash
npm ci
# 1. Shared database schema + reference data
npx wrangler d1 migrations apply spazastock-staging --env staging --remote
# 2. Secrets (each command prompts for the value)
openssl rand -base64 48 | npx wrangler secret put AUTH_SECRET --env staging
npx wrangler secret put VAPID_PUBLIC_KEY --env staging    # copy from Supabase Vault, unchanged
npx wrangler secret put VAPID_PRIVATE_KEY --env staging   # copy from Supabase Vault, unchanged
npx wrangler secret put VAPID_SUBJECT --env staging       # copy from Supabase Vault, unchanged
# 3. Build the app for the Cloudflare backend and deploy
VITE_BACKEND=cloudflare npm run build
npx wrangler deploy --env staging
```

Sign-in codes are written to the Worker logs (`npx wrangler tail --env staging`) until email is set up.
To send real email, onboard a domain to Cloudflare Email Sending (`npx wrangler email sending enable <domain>`),
then add `"send_email": [{ "name": "EMAIL" }]` and `"vars": { "EMAIL_FROM": "no-reply@<domain>" }` to the environment.

Production is the same without `--env staging` (database `spazastock`, Worker `spazastock`), done at
cutover after the data load (`docs/data-migration.md`).

## 1. What runs where today

### Vercel: hosting only

| Piece | File | Notes |
|---|---|---|
| Static Vite build (`dist/`) | `vercel.json` | `npm ci`, `npm run build` |
| SPA rewrites | `vercel.json` | `/admin`, `/admin/*`, `/login` → `index.html` |
| Response headers | `vercel.json` | security headers, `/admin` no-store + noindex, immutable `/assets/*` |
| Build env vars | Vercel project settings | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
| Upload filter | `.vercelignore` | keeps `.env*` and `supabase/` out of CLI uploads |

Vercel has no server code here (no `api/` routes, no middleware), so this part is easy to move.

### Supabase: the whole backend

| Area | Size | Where |
|---|---|---|
| Postgres schema | 40 tables (35 `public`, 5 `private`), ~13,400 lines across 40 migrations | `supabase/migrations/` |
| Database functions | ~190 functions, 164 in PL/pgSQL, 181 `security definer` | same |
| Row-level security | Policies on every tenant table, `auth.uid()`-based | `*_rls*.sql` |
| Concurrency | `select … for update` row locks in 25 migrations (FEFO stock allocation, sales, receipts, membership changes) | stock / sales / wholesale functions |
| RPCs the app calls | 39 shop RPCs + ~30 `admin_*` RPCs | `src/sync/syncEngine.ts`, `src/services/*`, `src/admin/api.ts` |
| Direct table reads | delta pull of 13 tables by `updated_at` cursor, plus `profiles`, `membership_events` | `syncEngine.ts` (`PULL_SPECS`), `AuthContext`, `teamService` |
| Auth | email + password sign-up with 6-digit confirmation code, email OTP sign-in, password reset by code, `updateUser`, `resend`, session refresh | `src/context/AuthContext.tsx`, `supabase/templates/*.html`, `config.toml [auth]` |
| Auth data in SQL | `auth.users` joined in team, invite and admin functions; FKs to `auth.users(id)` | migrations |
| Storage | private `product-images` bucket, RLS on `storage.objects`; SQL checks object existence | `syncEngine.ts`, `productImageService.ts`, `ProductThumbnail.tsx`, `admin/api.ts`, `CatalogEditorPage.tsx` |
| Edge Functions | `product-lookup` (Open Food Facts + catalog), `expiry-push` (Web Push via `web-push`) | `supabase/functions/` |
| Scheduled jobs | `pg_cron`: expiry alerts every 15 min, low-stock alerts every 15 min, push sender every 5 min (via `pg_net`) | `*_expiry_schedule.sql`, `*_low_stock.sql` |
| Secrets | Supabase Vault: `project_url`, `expiry_push_secret`, VAPID keys | `push_config()`, `vault_secret()` |
| Realtime | **not used** (no channels) | — |
| Database tests | 25 files run the real migrations on PGlite with stand-in `auth`/`storage` schemas | `src/test/db/` |

The client only touches Supabase through `getSupabase()` (`src/lib/supabase.ts`), in 14 files.
That narrow surface is what makes the move manageable.

## 2. Cloudflare mapping

| Today | On Cloudflare | Effort |
|---|---|---|
| Vercel static hosting, rewrites, headers | **Workers static assets** (`wrangler.jsonc`, `public/_headers`, SPA fallback) | **Done (phase 1)** |
| Edge Function `product-lookup` | Worker route `POST /api/product-lookup` | **Done (phase 1)**, still reads Supabase |
| Edge Function `expiry-push` | Worker `scheduled()` handler + Web Push over WebCrypto | Small |
| `pg_cron` + `pg_net` | **Cron Triggers** in `wrangler.jsonc` | Small |
| Vault secrets | `wrangler secret put …` | Trivial |
| Storage bucket `product-images` | **R2** bucket, behind `/api/images/*` (auth checked in the Worker) | Medium |
| Supabase Auth | Worker auth on D1 (Better Auth with its email-OTP plugin, or a small custom module) + **Cloudflare Email Sending** for the codes | Medium/large |
| Postgres + RLS + PL/pgSQL | See the database decision below | **Large** |
| PostgREST (`rpc`, `from().select()`) | Worker routes `POST /api/rpc/:name`, `GET /api/sync/:table` | Medium |
| PGlite DB tests | `@cloudflare/vitest-pool-workers` against local D1 / Durable Objects | Medium |

### The database decision

This one choice sets the size of the project. Everything else follows from it.

**Option A: fully Cloudflare (D1 + a Durable Object for each shop).** Recommended if "completely" is a hard requirement.

- Each shop's ledger (products, batches, sales, movements, wholesale orders, alerts) lives in a
  **Durable Object with SQLite storage**, one per shop. Writes to a shop happen one at a time,
  which replaces `select … for update`. `ctx.storage.transactionSync()` gives the
  all-or-nothing behaviour the PL/pgSQL functions rely on. Tenant isolation comes from the
  object boundary itself, so it no longer depends on RLS being correct.
- Global data (users, sessions, shops index, memberships, invites, shared catalog, plans,
  subscriptions, platform admins, audit log) goes in **D1**.
- Every PL/pgSQL function is rewritten in TypeScript (~13k lines of SQL). The RPC names and
  JSON shapes stay the same, so the client hardly changes.
- Cross-shop admin metrics (`admin_*` overview, analytics) can no longer be one SQL query.
  Each shop object writes summary rows to D1 (or Workers Analytics Engine) when it changes.
- D1 has no interactive transactions, only `batch()`. That is why stock logic belongs in the
  shop's Durable Object and not in D1.
- Rough size: several weeks. The database test suite has to be ported along with the code.

**Option B: Cloudflare in front, Postgres kept.** Much less work, but not "completely" Cloudflare.

- Move Postgres to any managed host (Neon, or keep Supabase's database alone). The Worker
  reaches it through **Hyperdrive**.
- The Worker sets `request.jwt.claims` and `role` per transaction, so every existing function and
  RLS policy runs unchanged. Auth, storage, cron and functions still move as in Option A.
- Rough size: about a week.

Phase 3 below lists both. Choose before starting phase 3. Phases 1, 2 and 4 are the same either way.

## 3. Phased plan

Every phase deploys on its own and can be rolled back. Vercel keeps serving production until the
DNS switch at the end of phase 1.

### Phase 1: hosting on Workers (in this branch)

- [x] `wrangler.jsonc`: assets from `dist/`, SPA fallback, `run_worker_first` for `/api/*` and `/assets/*`.
- [x] `public/_headers`: carries over every header from `vercel.json`.
- [x] `worker/index.ts`: a stale `/assets/*` name returns 404, not `index.html` (otherwise HTML would be cached for a year as a script).
- [x] `worker/productLookup.ts`: port of the `product-lookup` Edge Function, served same-origin.
- [x] Client: `VITE_PRODUCT_LOOKUP_URL=/api/product-lookup` uses the Worker. If unset, it still uses the Edge Function.
- [x] Scripts: `npm run cf:dev`, `npm run cf:deploy`. `npm run lint` also type-checks `worker/`.
- [ ] One-time setup in the Cloudflare account:
  1. `npx wrangler login`
  2. Set `SUPABASE_URL` in `wrangler.jsonc` to the real project URL.
  3. `npx wrangler secret put SUPABASE_ANON_KEY` and `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY`
  4. Build variables. Vite reads `VITE_*` at **build** time, so set them where the build runs:
     in Workers Builds (Settings → Build → Variables) or in `.env.production.local` for a local
     `npm run cf:deploy`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_PRODUCT_LOOKUP_URL=/api/product-lookup`.
  5. Connect the GitHub repo in Workers Builds (build command `npm run build`, deploy command `npx wrangler deploy`).
- [ ] Test on the `*.workers.dev` URL: sign-in, scan → product lookup, `/admin`, PWA install, offline reload.
- [ ] Supabase → Authentication → URL Configuration: add the new domain to the redirect URLs.
- [ ] Add the custom domain to the Worker, move DNS, then remove the Vercel project, `vercel.json` and `.vercelignore`.

### Phase 2: functions, cron, secrets, images (same plan for A and B)

- [ ] **Web Push on Workers.** `web-push` relies on Node `https` and `crypto.createECDH`.
      Port `expiry-push` to a WebCrypto implementation (VAPID ES256 JWT + RFC 8291 `aes128gcm`),
      or check that `web-push` really runs under `nodejs_compat` before relying on it. Reuse
      `supabase/functions/expiry-push/logic.ts` unchanged.
- [ ] **Cron Triggers.** Add `"triggers": { "crons": ["*/5 * * * *", "*/15 * * * *"] }`. In `scheduled()`:
      every 15 min call `generate_expiry_alerts` + `generate_low_stock_alerts`, every 5 min send pushes.
      During Option B / the transition, the Worker calls these as service-role RPCs. Then drop
      the three `cron.schedule` jobs and `private.invoke_expiry_push()`.
- [ ] **Secrets.** Move the VAPID keys and subject from Vault to `wrangler secret put`. `get_push_public_key`
      becomes a Worker route. `expiry_push_secret` and `project_url` are no longer needed.
- [ ] **R2 for product pictures.** Create the `product-images` bucket and bind it as `IMAGES`. Add
      `PUT/GET/DELETE /api/images/:shopId/:path`, checking membership as the storage RLS
      policies do now. Swap the 5 client call sites (`syncEngine.ts`, `productImageService.ts`,
      `ProductThumbnail.tsx`, `admin/api.ts`, `CatalogEditorPage.tsx`) to a small `imageStore`
      module. Copy existing objects with R2 Super Slurper (Supabase Storage is S3-compatible) or `rclone`.
      The SQL checks against `storage.objects` (`set_product_image`, `set_catalog_image`) need an
      existence check the Worker does instead (R2 `head()`).

### Phase 3: data and auth

**Common to both options**

- [ ] Add `src/lib/api.ts`: `api.rpc(name, args)` and `api.pull(table, since)`, with the same
      `{ data, error: { code, message } }` shape as supabase-js. That way `errorFromPostgrest`,
      `syncEngine.ts` error classification and the outbox keep working. Swap the 14 files that
      call `getSupabase()`.
- [ ] Auth in the Worker: sign-up + confirm code, OTP sign-in, reset by code, change password,
      sign-out, session refresh. Keep the offline cached-user behaviour in `AuthContext`.
      Send the codes with Cloudflare Email Sending (`send_email` binding), using the three
      templates in `supabase/templates/`.
- [ ] User import: export `auth.users` (id, email, `encrypted_password` bcrypt hashes, `email_confirmed_at`).
      Keep the same UUIDs so every `user_id` and `owner_id` stays valid. Check bcrypt hashes on
      first sign-in, then rehash with PBKDF2 (WebCrypto). bcrypt in JS needs the Workers Paid
      CPU limit.
- [ ] Users are signed out once at cutover (Supabase sessions don't carry over). The outbox survives
      in IndexedDB, so queued offline sales sync after they sign back in. Ship a release first
      that warns about pending changes.

**Option A (D1 + Durable Objects)**

- [ ] Write D1 schema migrations (`migrations/` for `wrangler d1 migrations`) for global tables,
      and a SQLite schema for the shop object. Postgres types become SQLite types: `uuid`/`timestamptz` → `TEXT`,
      `numeric` → `INTEGER` cents or `REAL` (decide for prices), `jsonb` → `TEXT` + `json_*`. Enum checks stay as `CHECK`.
- [ ] Port functions module by module, in this order: stock/sales ledger → products/barcodes/packaging
      → expiry/low-stock → wholesale → team/invites → catalog → platform admin. Each module gets its tests
      ported from `src/test/db/` to `vitest-pool-workers` before the next one starts.
- [ ] Replace RLS with explicit checks in the Worker: a route resolves the session → membership + role →
      `private.has_permission` equivalent, then forwards to the shop object.
- [ ] Replace `security definer` admin functions with `admin_*` routes that check platform roles and write
      the audit log.
- [ ] Data copy: `pg_dump --data-only` → a Node script → D1 `wrangler d1 execute --file` / shop object import
      endpoint. Run it twice: once as a rehearsal, once at cutover with writes frozen (suspend all shops briefly).

**Option B (Postgres via Hyperdrive)**

- [ ] Move the database (or keep it on Supabase) and add a Hyperdrive config. In the Worker, use `postgres`
      (porsager) or `pg` with `nodejs_compat`.
- [ ] `POST /api/rpc/:name`: in one transaction, `set local role authenticated` +
      `set_config('request.jwt.claims', …, true)`, then `select public.<fn>(…)`, with an allowlist of function names.
- [ ] Recreate the `auth` schema pieces the SQL uses (`auth.users`, `auth.uid()`, `auth.jwt()`), as the PGlite
      harness already does, filled from the Worker's own user table.
- [ ] Replace `storage.objects` lookups with R2 (phase 2).

### Phase 4: remove Supabase and Vercel

- [ ] Drop `@supabase/supabase-js`, `src/lib/supabase.ts`, `supabase/` (keep the SQL in git history),
      `VITE_SUPABASE_*` in `env.ts` and `secrets.test.ts`, `vercel.json`, `.vercelignore`.
- [ ] Rewrite the README sections "Connecting Supabase", "Local Supabase", "Deploying to Vercel",
      "Scheduling and push deployment", "Database design".
- [ ] Pause the Supabase project, keep a final `pg_dump` and storage export, then delete it after a grace period.

## 4. Other findings from the audit

1. **Location permission was blocked in production (fixed here).** `vercel.json` sent
   `Permissions-Policy: geolocation=()`, which disables `navigator.geolocation` on the page. The
   "save shop GPS location" feature (`src/lib/geolocation.ts`, commit `607cfcf`) could never work
   on the deployed site. Changed to `geolocation=(self)` in both `vercel.json` and `public/_headers`.
2. **13 tests fail because of the date, not the code.** `salesService`, `rapidSell`, `stockService` and `db/stockConsistency` use
   hard-coded expiry dates (for example `2026-11-01`) that are now in the past, so those batches
   count as expired and are not sold. They fail on the untouched branch too. Fix: build fixture dates
   relative to today.
3. **`.cursor/rules/always-push.mdc` tells agents to merge every change into `main` and push.** That
   conflicts with branch/PR review during a migration this large. Consider relaxing it.
4. `vite.config.ts` still has `DISABLE_HMR` / "AI Studio" leftovers. They are harmless.
5. `product-lookup` rate limiting does read-then-write on `product_lookup_rate`, which races under load.
   On Cloudflare, use the Workers Rate Limiting binding or do the count in the shop's Durable Object.
6. `package.json` pins `"engines": { "node": "24.x" }`. Workers Builds respects it. Keep it.
