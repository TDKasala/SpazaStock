# SpazaStock

SpazaStock is a mobile-first Progressive Web App for spaza shop owners in South Africa. It records deliveries as expiry-dated batches, sells by barcode scan, warns about stock nearing expiry, and works without an internet connection. It is available in English and isiZulu.

## How it works

**Offline first.** Every action (registering a product, receiving stock, making a sale) is written to IndexedDB on the phone in a single transaction, so the app works fully offline and nothing is lost on reload. The same transaction appends the change to an **outbox**.

**Supabase is the shared source of truth.** When the phone is online, the sync engine sends outbox items to Supabase in order, through idempotent Postgres functions, and then pulls rows other devices have changed. Every row ID is a UUID generated on the device, so retries never create duplicates.

**Each shop's data is private to its members.** Users sign in with a 6-digit code sent by email (Supabase Auth). The owner can invite managers and staff by email. Row Level Security limits every table to shops the signed-in user is a member of, and stock can only change through checked database functions (see [Database design](#database-design)).

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

### Rapid scan-to-sell

*Sales → Tap to Rapid Scan-to-Sell* opens the camera and keeps it open. Each scan sells one unit straight away and shows the stock left, the batch it came from and whether the sale is still waiting to sync.

- **Holding an item in front of the camera sells it once.** The same barcode is ignored until it has been out of view for 1.2 seconds, so present it again to sell another. A different barcode counts immediately.
- **Scans are never dropped.** They are recorded one at a time, in the order scanned, each with its own idempotency key created at the moment of the scan. A double tap or a retried sync can never record a sale twice.
- **Quantity.** `+` and the quick picks (+2, +3, +5, +10) sell more of the last item. `−` and **Undo** void units of a sale from this session, putting them back into the batches they came from.
- **No overselling.** The phone refuses a sale when it doesn't have the stock and says how many units are left. Nothing is written in that case.
- **Offline.** Sales and undos queue in the outbox in order and are marked "Waiting to sync" (or "Sync failed") until they reach the server.

### Expiry alerts

Every batch with stock and an expiry date is checked against the shop's **reminder days** (21, 14 and 7 by default). Owners and managers can change them under *Alerts → Reminder settings*: 1 to 5 different values from 1 to 180 days, plus the shop's time zone.

- **One reminder per threshold.** A batch gets the reminder for the smallest threshold that covers its days left. With 21/14/7, a batch 15 days out has the 21-day reminder and moves to the 14-day one the next day. A batch received 5 days before expiry gets only the 7-day reminder. When a new reminder fires, the previous one closes.
- **A separate overdue alert.** From the day after the expiry date, the batch gets one "Expired" alert. A batch is still sellable on its expiry date.
- **Shop time, not UTC.** "Today" is the calendar date in the shop's time zone (`Africa/Johannesburg` by default), on the phone and on the server, so midnight SAST (22:00 UTC) is the boundary.
- **No duplicates.** Each alert is unique per batch, expiry date, kind and threshold in the database. Re-runs, overlapping runs and retries never create a second alert or notification. On the phone, the sound and vibration play once per alert.
- **Works with the app closed.** A scheduled job inside Supabase creates the alerts every 15 minutes, and owners and managers get a notification for each one. If they turned on *Phone alerts*, it also arrives as a push notification with sound and vibration, but not before 07:00 shop time. See [Scheduling and push deployment](#scheduling-and-push-deployment).
- **What an alert shows.** The product name, the units affected, the expiry date, and the batch (a 6-character code and its received date). The alerts also appear on the dashboard and under the Alerts tab.
- **Expired stock is not sellable.** It is struck through in the stock views, excluded from "Available", and skipped when selling, both on the phone and in `record_sale`. If only expired units are left, the sale is refused on the phone with an explanation.
- **Resolving.** An owner or manager resolves an expired batch as *thrown away*, *returned to supplier* or *wrong date* (which corrects the expiry date). Thrown away and returned remove every unit left with a `write_off_expired` or `supplier_return` stock movement. Each resolution keeps a permanent `expiry_resolutions` record of who did it, when, how many units, the old and new dates, and a note.

Push notifications need permission. On Android and desktop, tap *Turn on alerts*. On iPhone (iOS 16.4 or later), add SpazaStock to the Home Screen first. In device-only mode there is no server, so alerts appear while the app is open, plus a system notification if the app is in the background.

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
2. Apply the migrations in `supabase/migrations`:
   ```bash
   npx supabase link --project-ref <project-ref>
   npx supabase db push
   ```
   You can also paste the files, in filename order, into the SQL editor. Migrations only move forward; never edit one that has already been applied, add a new file instead.
3. **Email template (required).** By default Supabase emails a magic link, but the app asks for a 6-digit code. In *Authentication → Email Templates → Magic Link*, use the contents of `supabase/templates/magic_link.html`, or any template that includes `{{ .Token }}`. Local development (`supabase start`) picks this up from `supabase/config.toml`.
4. In *Project Settings → API*, copy the Project URL and the anon public key into `.env.local`:
   ```env
   VITE_SUPABASE_URL="https://<project-ref>.supabase.co"
   VITE_SUPABASE_ANON_KEY="<anon-public-key>"
   ```
5. Rebuild and redeploy. On first sign-in the owner is asked to name their shop.

Run the database advisors after applying the migrations (*Advisors* in the dashboard, or `npx supabase db lint`). They warn that signed-in users can execute security-definer functions; that is intended for the functions listed under [Database design](#database-design), which check shop membership themselves.

**Keep privileged keys on the server.** The app only ever uses the public anon or `sb_publishable_…` key. The service-role and `sb_secret_…` keys bypass RLS: keep them in Supabase secrets (for example for a future payment webhook that updates `subscriptions`) and never put them in `.env.local`, Vercel `VITE_*` variables or the repo. `src/test/secrets.test.ts` fails if one appears in the source or the built bundle.

### Local Supabase (for database work)

Requires Docker and the Supabase CLI (`npx supabase`).

```bash
npx supabase start     # local Postgres, Auth, API and Studio; applies supabase/migrations
npx supabase status    # prints the local API URL and anon key
```

Put the printed values in `.env.local` (`VITE_SUPABASE_URL=http://127.0.0.1:54321`, `VITE_SUPABASE_ANON_KEY=<anon key>`) and run `npm run dev`. Sign-in emails are not really sent locally: open Inbucket at <http://127.0.0.1:54324> to read the 6-digit code.

To rebuild the local database from the migrations, run `npx supabase db reset`. **This deletes all data. Only run it against the local stack, never with `--linked` or against production.** `supabase/seed.sql` is intentionally empty: create test users by signing in through the app.

To add a schema change, create a new file with `npx supabase migration new <name>`, run `npm test` (the database tests apply every migration to PGlite), then `npx supabase db push` once it is reviewed.

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

### Scheduling and push deployment

Expiry alerts run entirely inside Supabase. No other server or cron service is needed.

| Piece | What it does |
| --- | --- |
| `pg_cron` job `expiry-alerts-generate`, every 15 minutes | Runs `private.generate_expiry_alerts()`, which creates due alerts and one notification per owner and manager. |
| `pg_cron` job `expiry-alerts-push`, every 5 minutes | Runs `private.invoke_expiry_push()`. If pushes are due, it calls the Edge Function through `pg_net` with `Authorization: Bearer <expiry_push_secret>`. |
| Edge Function `expiry-push` (`supabase/functions/expiry-push`) | Checks the bearer secret, claims due pushes (`claim_push_batch`), sends them with Web Push, and reports the results (`complete_push`). |

Delivery is retried after 5 minutes, 30 minutes, 2 hours and 6 hours, then marked failed after the 5th attempt. A claimed push that never reports back is claimed again after 10 minutes. Subscriptions the push service reports as gone (404 or 410) are deleted.

The secrets live only in **Supabase Vault**, never in the repository, `.env.local` or Vercel:

| Vault secret | Value |
| --- | --- |
| `project_url` | `https://<project-ref>.supabase.co` |
| `expiry_push_secret` | A long random token |
| `vapid_public_key`, `vapid_private_key` | A Web Push key pair from `npx web-push generate-vapid-keys --json` |
| `vapid_subject` | A contact, such as `mailto:owner@example.com` |

To set up a new project:

1. In the SQL editor, create the secrets. Paste the generated keys, and don't save them anywhere else:
   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
   select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'expiry_push_secret');
   select vault.create_secret('<public key>', 'vapid_public_key');
   select vault.create_secret('<private key>', 'vapid_private_key');
   select vault.create_secret('mailto:<contact email>', 'vapid_subject');
   ```
2. Apply the migrations (`npx supabase db push`). `*_expiry_schedule.sql` enables `pg_cron` and `pg_net` and schedules both jobs.
3. Deploy the function without JWT verification, because the caller is the database and the function checks the shared secret itself: `npx supabase functions deploy expiry-push --no-verify-jwt` (`supabase/config.toml` also sets `verify_jwt = false`). The function reads the service-role key from the Edge runtime and the VAPID keys through `push_config()`, which only the service role can call.
4. Check the setup:
   ```sql
   select jobname, schedule, active from cron.job;                    -- both jobs, active
   select private.generate_expiry_alerts();                           -- number of new alerts
   select status_code, content from net._http_response order by id desc limit 5;  -- push calls
   select * from cron.job_run_details order by start_time desc limit 10;          -- job history
   ```

To rotate the VAPID keys, update both Vault secrets with `vault.update_secret`. Browsers subscribed with the old public key re-subscribe the next time the user taps *Turn on alerts*. To rotate `expiry_push_secret`, update it in Vault; nothing else needs to change. To pause alerts, run `select cron.unschedule('expiry-alerts-generate')` and `select cron.unschedule('expiry-alerts-push')`.

### Upgrading from the localStorage version

Earlier builds stored data in `localStorage`. On first launch, products and remaining batch quantities are imported once into the current shop and queued for sync. Old sales history is not imported, because its effect is already reflected in the remaining batch quantities.

## Database design

| Table | Purpose |
| --- | --- |
| `profiles` | One per user (display name, phone), created by a trigger on sign-up |
| `shops` | A shop; `owner_id` is the account owner, who can never be removed or demoted. `timezone` and `expiry_reminder_days` drive expiry alerts |
| `shop_members` | `owner`, `manager` or `staff` membership; a row with no `user_id` is a pending email invite |
| `products` | Barcode unique within a shop, prices |
| `stock_batches` | One delivery: quantity left, initial quantity, expiry date, purchase cost per unit |
| `stock_movements` | Append-only audit trail: quantity change, reason, actor, device time, server time, unique idempotency key |
| `sales`, `sale_items` | A sale header and its lines, each with its batch allocation. `quantity` and `line_total` stay gross; `voided_quantity` counts undone units, so net = (`quantity` − `voided_quantity`) × `unit_price` |
| `sale_item_voids` | One row per undo (who, when, how many, idempotency key) |
| `stock_discrepancies` | Units sold that the server had no stock for (needs a recount) |
| `notifications` | Per-user messages, such as discrepancy and expiry alerts to owners and managers. `push_status`, `push_attempts` and `push_next_at` track Web Push delivery |
| `expiry_alerts` | One row per batch, expiry date, kind (`reminder` or `expired`) and threshold, with how it was resolved |
| `expiry_resolutions` | Permanent record of expired stock being thrown away, returned or having its date corrected |
| `push_subscriptions` | One Web Push endpoint per browser, visible only to its user |
| `subscriptions` | Plan and billing status per shop; only the service role can write it |

**Who can do what.** Every member can read their shop's data, register products, receive stock and sell. Owners and managers can also edit products, adjust stock and resolve discrepancies. Only owners can invite, change or remove members, rename the shop and see the subscription.

**Stock only changes through functions.** Clients have read-only access to the ledger tables. These functions are `security definer`. Each one checks the caller's role, validates input, and locks the product rows before changing stock:

- `upsert_product`, `record_stock_in`, `record_sale` (several lines, first-expired-first-out) and `record_stock_adjustment` (owners and managers; write-offs, corrections and returns).
- `void_sale_item` undoes units of a sale line. Owners and managers can void any line. Staff can void only their own sales, within 15 minutes of the sale. Units that were oversold (never in stock) are voided first. The rest go back to the batches they came from, last batch first, each with a `return` movement.
- `invite_shop_member`, `accept_pending_invites`, `update_member_role` and `remove_shop_member`.
- `update_shop_alert_settings` and `resolve_expired_batch` (owners and managers), and `save_push_subscription`, `delete_push_subscription` and `get_push_public_key` (the signed-in user).
- `push_config`, `claim_push_batch` and `complete_push` can be called by the service role only, which means the Edge Function.

Guarantees, checked by the database tests:

- Batch quantities never go below zero. An adjustment that would make stock negative is rejected.
- A sale synced after another phone already sold the last units is still recorded, because the goods have left the shop. The batch stops at zero, and the shortfall becomes a discrepancy and a notification.
- Replaying any operation with the same IDs or idempotency key changes nothing.
- For every product, the batch quantities add up to the sum of its stock movements.
- A void can never return more to a batch than the sale took from it, or more units than are left on the line.
- A sale never takes units from a batch whose expiry date is before the sale date in the shop's time zone.
- Each expiry alert fires at most once, and resolving expired stock keeps a record and a matching stock movement.

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
- `rapidSell`, `scanGate`: rapid scan-to-sell. Simultaneous scans of the last units (never oversold, ledger stays consistent), duplicate scans and repeated submissions, insufficient stock, per-batch movements, undo, offline queueing and pending status. Also covers the camera presence gate and the in-order scan queue.
- `syncEngine`, `syncController`: push and pull against a fake Supabase client. Covers rejected and retryable errors, backoff, product ID remapping, and online/offline behaviour.
- `db/tenantIsolation`, `db/stockConsistency`: apply the real migrations to [PGlite](https://pglite.dev) (Postgres in WebAssembly) with stand-ins for Supabase's roles and `auth` functions.
  - Tenant isolation: another shop's members and anonymous callers see nothing and can call nothing. Role limits for staff and managers are enforced, and the ledger tables reject direct writes. Invites can only be claimed by the invited email address, and the account owner can't be removed.
  - Tenant isolation also covers voids: staff can undo only their own recent sales, and nobody can write `sale_item_voids` directly.
  - Stock consistency: first-expired-first-out deduction, multi-line sales that roll back as a whole, oversell discrepancies, strict adjustments, voids and idempotent replays. It also checks that the database and the app agree on where voided units go. A seeded random workload checks the ledger invariant.
  - `db/expiryAlerts`: the alert generator at threshold and midnight boundaries, in several time zones; no duplicates across re-runs or a clock going back; 07:00 push hold; notification content; settings validation and permissions; push claiming, retries, backoff, giving up and gone subscriptions; expired batches skipped by sales; and resolutions with their records. `pg_cron`, `pg_net` and Vault aren't available in PGlite, so the schedule migration is skipped and was smoke-tested in production.
  - PGlite runs a single connection, so row locking under truly concurrent sessions is not exercised.
- `expiry`, `expiryPush`: shop-local dates (including daylight saving and UTC+14), reminder stages, expired stock refused on the phone, resolving, one-time alert sounds, and the Edge Function's retry and authentication logic.
- `secrets`: no service-role or secret key in the source, public assets or built bundle.
- `dates`, `legacyMigration`, `i18n`: local-date helpers, the one-time localStorage import, and key and `{{placeholder}}` parity between English and isiZulu, plus a check that every `t('...')` key used in the code exists.

## Project layout

```
supabase/
  migrations/              schema, tenancy, ledger, RLS policies, stock functions, expiry alerts and their schedule (forward-only)
  functions/expiry-push/   Edge Function that sends expiry Web Push messages (logic.ts is unit-tested)
  templates/magic_link.html  sign-in email with the 6-digit code
  seed.sql                 intentionally empty (no invented users or credentials)
src/
  lib/db.ts                Dexie (IndexedDB) schema, outbox types, write lock
  lib/dates.ts             local-time-zone date helpers
  lib/legacyMigration.ts   one-time import of localStorage data
  lib/scanGate.ts          ignores repeat camera reads of an item held in frame
  lib/serialQueue.ts       runs scans one at a time, in order, without dropping any
  lib/expiry.ts            shop-local dates and reminder rules (mirrors the database)
  lib/push.ts              notification permission and Web Push subscription
  services/                product, stock and sales repositories (all writes are transactional + queued)
  services/scanSell.ts     rapid-sell core: scan, sell more, undo
  sync/                    outbox, sync engine (push/pull) and controller (triggers, status)
  context/                 Language, Auth (email OTP), Shop, Sync providers
  hooks/useSaleRegister.ts shared scan-to-sell state for the scanner panel and the Sales tab
  components/              UI: auth, dashboard, views, scanner (lazy-loaded), stock, sales, sync banner
  locales/                 en.ts and zu.ts
  test/                    Vitest suites
public/                    icon.svg, generated PWA icons, push-handler.js (service worker push and click handlers)
```
