# SpazaStock

SpazaStock is a mobile-first Progressive Web App for spaza shop owners in South Africa. It records deliveries as expiry-dated batches, sells by barcode scan, warns about stock nearing expiry, and works without an internet connection. It is available in English and isiZulu.

## How it works

**Offline first.** Every action (registering a product, receiving stock, making a sale) is written to IndexedDB on the phone in a single transaction, so the app works fully offline and nothing is lost on reload. The same transaction appends the change to an **outbox**.

**Supabase is the shared source of truth.** When the phone is online, the sync engine sends outbox items to Supabase in order, through idempotent Postgres functions, and then pulls rows other devices have changed. Every row ID is a UUID generated on the device, so retries never create duplicates.

**Each owner sees only their own shop.** Users sign in with a 6-digit code sent by email (Supabase Auth). Row Level Security limits every table to shops the signed-in user owns.

**Device-only mode.** If no Supabase credentials are configured, the app skips sign-in and keeps everything on the phone. A banner explains that the data is not backed up.

### Sync details

| Situation | What happens |
| --- | --- |
| Offline | Changes queue in the outbox. The header shows how many are waiting. |
| Back online, app opened, tab focused, every 60 s, or 1.5 s after a local change | A sync runs. Only one browser tab syncs at a time (Web Locks). |
| Network error, timeout or expired session | The item stays queued and retries with exponential backoff (5 s up to 10 min). Later items wait behind it so their order is kept. |
| Server rejects the change (Postgres error class 22, 23, 42 or P0) | The item is marked **failed** and shown in a red banner with a Retry button. It is never silently dropped. |
| Two phones registered the same barcode offline | The server keeps the first product. The second phone remaps its local product, batches and queued items to that product's ID. |
| Two phones sold the same last units offline | Both sales are kept, because the goods have left the shop. The server records a **stock discrepancy**, which appears under Alerts → "Needs recount". |
| Pull | Incremental by `updated_at`, in 500-row pages with a 2-minute overlap. It is skipped while local changes are still waiting to be pushed. |

Sales deduct stock **first-expired-first-out**, both on the device and on the server. The server's allocation is the one that is kept.

## Setup

Requirements: Node.js 24 and npm.

```bash
npm install
cp .env.example .env.local   # then fill in the values below
npm run dev                  # http://localhost:3000
```

Leave `.env.local` unset to run in device-only mode.

### Connecting Supabase

1. Create a Supabase project.
2. Apply the migrations in `supabase/migrations` (schema, RLS policies, write functions):
   ```bash
   npx supabase link --project-ref <project-ref>
   npx supabase db push
   ```
   You can also paste the three files, in filename order, into the SQL editor.
3. **Email template (required).** By default Supabase emails a magic link, but the app asks for a 6-digit code. In *Authentication → Email Templates → Magic Link*, use the contents of `supabase/templates/magic_link.html`, or any template that includes `{{ .Token }}`. Local development (`supabase start`) picks this up from `supabase/config.toml`.
4. In *Project Settings → API*, copy the Project URL and the anon public key into `.env.local`:
   ```env
   VITE_SUPABASE_URL="https://<project-ref>.supabase.co"
   VITE_SUPABASE_ANON_KEY="<anon-public-key>"
   ```
5. Rebuild and redeploy. On first sign-in the owner is asked to name their shop.

Run the database advisors after applying the migrations (*Advisors* in the dashboard, or `npx supabase db lint`).

### Deploying to Vercel

`vercel.json` holds the build settings (Vite, `npm ci`, output `dist`), long-lived caching for hashed `/assets/*`, no caching for the service worker and manifest so updates reach installed apps, and security headers. `Permissions-Policy` allows the camera for this site only, which the barcode scanner needs.

1. Import the GitHub repo in Vercel (or run `vercel link`). The framework is detected from `vercel.json`.
2. Add the environment variables for **Production** and **Preview**. `VITE_*` values are baked in at build time, so redeploy after changing them:
   ```bash
   vercel env add VITE_SUPABASE_URL production
   vercel env add VITE_SUPABASE_ANON_KEY production
   ```
   The anon key can be the legacy anon JWT or a `sb_publishable_…` key.
3. In Supabase *Authentication → URL Configuration*, set **Site URL** to the production domain (for example `https://spazastock.vercel.app`) and add `https://*-<team>.vercel.app/**` to **Redirect URLs** for preview deployments. Sign-in uses the 6-digit code, but the email still contains a link that points at these URLs.
4. Deploy, then open the site on a phone: install the PWA, allow the camera, and do a test stock-in and sale to confirm sync.

`.vercelignore` keeps `.env*` files out of CLI uploads, so the Vercel environment variables are always the ones used.

### Upgrading from the localStorage version

Earlier builds stored data in `localStorage`. On first launch, products and remaining batch quantities are imported once into the current shop and queued for sync. Old sales history is not imported, because its effect is already reflected in the remaining batch quantities.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server on port 3000 |
| `npm run build` | Production build, including the service worker |
| `npm run preview` | Serve the production build |
| `npm run lint` | Type-check (`tsc --noEmit`, strict mode) |
| `npm test` | Run all tests once |
| `npm run generate-pwa-assets` | Regenerate the PNG icons and favicon from `public/icon.svg` |

## Tests

`npm test` runs Vitest with `happy-dom`, `fake-indexeddb` and the time zone pinned to `Africa/Johannesburg`, so bugs where a UTC date is used instead of the local date show up.

- `productService`, `stockService`, `salesService`: local repositories, including idempotency across reloads, concurrent sales of the last units, and "today" just after local midnight.
- `syncEngine`, `syncController`: push and pull against a fake Supabase client. Covers rejected and retryable errors, backoff, product ID remapping, and online/offline behaviour.
- `migrations`: applies the real migrations to [PGlite](https://pglite.dev) (Postgres in WebAssembly) and checks RLS isolation between owners, anonymous access, idempotent RPCs, FEFO deduction and discrepancy creation.
- `dates`, `legacyMigration`, `i18n`: local-date helpers, the one-time localStorage import, and key and `{{placeholder}}` parity between English and isiZulu, plus a check that every `t('...')` key used in the code exists.

## Project layout

```
supabase/
  migrations/              schema, RLS policies, write functions (upsert_product, record_stock_in, record_sale)
  templates/magic_link.html  sign-in email with the 6-digit code
src/
  lib/db.ts                Dexie (IndexedDB) schema, outbox types, write lock
  lib/dates.ts             local-time-zone date helpers
  lib/legacyMigration.ts   one-time import of localStorage data
  services/                product, stock and sales repositories (all writes are transactional + queued)
  sync/                    outbox, sync engine (push/pull) and controller (triggers, status)
  context/                 Language, Auth (email OTP), Shop, Sync providers
  hooks/useSaleRegister.ts shared scan-to-sell logic for camera scans and the Sales tab
  components/              UI: auth, dashboard, views, scanner (lazy-loaded), stock, sales, sync banner
  locales/                 en.ts and zu.ts
  test/                    Vitest suites
public/                    icon.svg and generated PWA icons
```
