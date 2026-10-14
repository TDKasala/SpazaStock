# SpazaStock

SpazaStock is a mobile-first Progressive Web App for spaza shop owners in South Africa. It records deliveries as expiry-dated batches, sells by barcode scan, warns about stock nearing expiry, and works without an internet connection. It is available in English, isiZulu, Amharic (አማርኛ) and Somali (Soomaali).

**Languages.** The language picker (globe icon) is in the header, on the landing page and on the sign-in screens. On the first visit the app picks the phone's language if it is one of the four, otherwise English, and remembers the choice on that phone. Text lives in `src/locales/` (`en.ts` is the source; the others must have exactly the same keys, which TypeScript and `src/test/i18n.test.ts` enforce). The Amharic and Somali text has not yet been reviewed by native speakers, so have it checked before relying on it with customers. Notifications created on the server, such as push alerts, are still in English.

## How it works

**Offline first.** Every action (registering a product, receiving stock, making a sale) is written to IndexedDB on the phone in a single transaction, so the app works fully offline and nothing is lost on reload. The same transaction appends the change to an **outbox**.

**Supabase is the shared source of truth.** When the phone is online, the sync engine sends outbox items to Supabase in order, through idempotent Postgres functions, and then pulls rows other devices have changed. Every row ID is a UUID generated on the device, so retries never create duplicates.

**Each shop's data is private to its members.** Users register with their name, email and a password, and confirm the email with a 6-digit code (Supabase Auth). They can also sign in with an emailed code instead of the password, and reset a forgotten password with a code. Row Level Security limits every table to shops the signed-in user is an active member of, and stock can only change through checked database functions (see [Database design](#database-design)).

### Shops and teams

- **Owners create shops.** The person who creates a shop is its account owner and can never be removed, demoted or deactivated. One account can own or work in several shops. Tap the shop name in the header to switch shops, add a shop, open *Team* or *Account*, or sign out.
- **Inviting a worker.** Under *Team → Invite someone* the owner enters the worker's email and picks **Worker** (scan, add stock, sell, view stock and alerts) or **Manager** (also edit products and prices, correct stock, handle expiry). The app makes a single-use invite link that expires after 7 days, to send by WhatsApp, SMS or copy and paste. The worker opens it, creates an account **with that email address** and their own password, confirms the email code and joins. Nobody ever sees or shares anyone else's password.
- **Invite security.** Only a SHA-256 hash of the link's token is stored. Accepting needs the token, a signed-in account whose email matches the invite, and a confirmed email. The token is cleared on use, *New invite link* replaces it (the old link stops working), and *Cancel invite* deletes it.
- **Managing the team.** The team screen lists each person's name, email, role and status (Active, Invite sent, Invite expired, Deactivated). The owner can change roles, deactivate and reactivate, and remove people, each after a confirmation. Deactivation and removal take effect immediately on every phone, because every policy and database function checks for an *active* membership. Queued push notifications for that person are cancelled. On their phone, the shop's local data, including unsynced changes, is deleted the next time the app is online. Nobody can change their own role or access.
- **Audit.** Every invite, resend, cancellation, join, role change, deactivation, reactivation and removal is written to `membership_events` by a database trigger, with who did it. Owners see the recent history on the team screen.

**Landing page and sign-in.** Signed-out visitors see a short landing page with the sign-in card next to it. Anyone can create an account there (*Create a free account*), confirm the email code, and then set up their own shop. Workers should open their invite link first, so they join the right shop. Sign-in is always required: a build without the Supabase settings shows the landing page with an "Accounts are not set up on this site yet" notice instead of opening the app.

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

### Barcode scanner

The scanner uses the phone's own barcode detector where the browser has one (Chrome on Android uses Google's ML Kit). Other browsers, such as Safari and desktop Firefox, use ZXing compiled to WebAssembly. The ~1.1 MB decoder is served by the app and precached by the service worker, so scanning works offline.

- **Fast.** It opens the rear camera at up to 1080p with continuous autofocus and decodes each new video frame, one at a time. Only the centre band inside the green frame is read.
- **Accurate.** It reads EAN-13, EAN-8, UPC-A, UPC-E, Code 128 and ITF-14 (QR codes are ignored). EAN and UPC codes must pass their check digit, and a code is accepted only after two matching reads in a row (within half a second). Codes are trimmed, never changed.
- **Feedback.** A beep and a vibration confirm each scan. Use the torch button in dark shops, or type the code under *Manual Entry*.

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

Push notifications need permission. On Android and desktop, tap *Turn on alerts*. On iPhone (iOS 16.4 or later), add SpazaStock to the Home Screen first.
## Setup

Requirements: Node.js 24 and npm.

```bash
npm install
cp .env.example .env.local   # then fill in the values below
npm run dev                  # http://localhost:3000
```

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are required. Without them the app only shows the landing page with a "not set up" notice.

### Connecting Supabase

1. Create a Supabase project.
2. Apply the migrations in `supabase/migrations`:
   ```bash
   npx supabase link --project-ref <project-ref>
   npx supabase db push
   ```
   You can also paste the files, in filename order, into the SQL editor. Migrations only move forward; never edit one that has already been applied, add a new file instead.
3. **Auth settings (required).** Local development (`supabase start`) picks these up from `supabase/config.toml`; on a hosted project set them in the dashboard:
   - *Authentication → Sign In / Providers*: keep **Allow new users to sign up** on, so shop owners can register themselves from the landing page.
   - *Authentication → Sign In / Providers → Email*: turn on **Confirm email**. Invites can only be accepted by a confirmed email address, so without this anyone who gets hold of an invite link could register with the invited address and join without proving they own it. Set the minimum password length to **8** and require **letters and digits**, to match the app's checks.
   - *Authentication → Email Templates*: the app asks for 6-digit codes, not links. Paste `supabase/templates/confirmation.html` into **Confirm signup**, `supabase/templates/recovery.html` into **Reset password** and `supabase/templates/magic_link.html` into **Magic Link** (or any templates that include `{{ .Token }}`).
   - *Authentication → Emails → SMTP Settings*: set up a **custom SMTP provider** (for example Resend, Brevo, SendGrid or Amazon SES). Supabase's built-in email only delivers to the project's team members and is limited to a few messages an hour, so shop owners and workers would not receive their codes without it.
4. In *Project Settings → API*, copy the Project URL and the anon public key into `.env.local`:
   ```env
   VITE_SUPABASE_URL="https://<project-ref>.supabase.co"
   VITE_SUPABASE_ANON_KEY="<anon-public-key>"
   ```
5. Rebuild and redeploy. After registering, the owner is asked to name their shop.

Run the database advisors after applying the migrations (*Advisors* in the dashboard, or `npx supabase db lint`). They warn that signed-in users can execute security-definer functions; that is intended for the functions listed under [Database design](#database-design), which check shop membership themselves.

**Keep privileged keys on the server.** The app only ever uses the public anon or `sb_publishable_…` key. The service-role and `sb_secret_…` keys bypass RLS: keep them in Supabase secrets (for example for a future payment webhook that updates `subscriptions`) and never put them in `.env.local`, Vercel `VITE_*` variables or the repo. `src/test/secrets.test.ts` fails if one appears in the source or the built bundle.

### Local Supabase (for database work)

Requires Docker and the Supabase CLI (`npx supabase`).

```bash
npx supabase start     # local Postgres, Auth, API and Studio; applies supabase/migrations
npx supabase status    # prints the local API URL and anon key
```

Put the printed values in `.env.local` (`VITE_SUPABASE_URL=http://127.0.0.1:54321`, `VITE_SUPABASE_ANON_KEY=<anon key>`) and run `npm run dev`. Emails are not really sent locally: open Inbucket at <http://127.0.0.1:54324> to read the sign-up, sign-in and reset codes.

To rebuild the local database from the migrations, run `npx supabase db reset`. **This deletes all data. Only run it against the local stack, never with `--linked` or against production.** `supabase/seed.sql` is intentionally empty: create test users by signing in through the app.

To add a schema change, create a new file with `npx supabase migration new <name>`, run `npm test` (the database tests apply every migration to PGlite), then `npx supabase db push` once it is reviewed.

### Deploying to Vercel

`vercel.json` holds the build settings (Vite, `npm ci`, output `dist`), long-lived caching for hashed `/assets/*`, no caching for the service worker and manifest so updates reach installed apps, and security headers. `Permissions-Policy` allows the camera for this site only, which the barcode scanner needs.

1. Import the GitHub repo in Vercel (or run `vercel link`). The framework is detected from `vercel.json`.
2. Add the environment variables for **Production** and **Preview**. They are mandatory: without them the deployed site cannot sign anyone in and only shows the "not set up" notice. `VITE_*` values are baked in at build time, so redeploy after adding or changing them:
   ```bash
   vercel env add VITE_SUPABASE_URL production
   vercel env add VITE_SUPABASE_ANON_KEY production
   ```
   The anon key can be the legacy anon JWT or a `sb_publishable_…` key.
3. In Supabase *Authentication → URL Configuration*, set **Site URL** to the production domain (for example `https://spazastock.vercel.app`) and add `https://*-<team>.vercel.app/**` to **Redirect URLs** for preview deployments. Sign-in uses the 6-digit code, but the email still contains a link that points at these URLs. Invite links use the domain the owner is on when they create the invite.
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
| `profiles` | One per user (display name, phone), created by a trigger on sign-up with the name given at registration |
| `shops` | A shop; `owner_id` is the account owner, who can never be removed, demoted or deactivated. Created only through `create_shop`. `timezone` and `expiry_reminder_days` drive expiry alerts |
| `shop_members` | `owner`, `manager` or `staff` (shown as "Worker") membership with a `status` of `active` or `deactivated`. A row with no `user_id` is a pending invite, holding the SHA-256 hash of its token (never readable by clients) and its expiry. Members see only their own row; owners see the whole team |
| `membership_events` | Append-only audit trail of invites, joins, role changes, deactivations and removals, written by a trigger; owners can read it |
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

**Who can do what.** Every active member can read their shop's data, register products, receive stock and sell. Owners and managers can also edit products, adjust stock, handle expiry and resolve discrepancies. Only owners can manage the team, rename the shop and see the subscription. Deactivated members can do nothing. The permission matrix lives in `private.role_permissions` (used by `private.has_permission` in the team functions) and is mirrored in `src/lib/permissions.ts` for the UI; a test fails if the two differ. To change a permission, add a migration that edits the table and update the TypeScript copy.

**Stock only changes through functions.** Clients have read-only access to the ledger tables. These functions are `security definer`. Each one checks the caller's role, validates input, and locks the product rows before changing stock:

- `upsert_product`, `record_stock_in`, `record_sale` (several lines, first-expired-first-out) and `record_stock_adjustment` (owners and managers; write-offs, corrections and returns).
- `void_sale_item` undoes units of a sale line. Owners and managers can void any line. Staff can void only their own sales, within 15 minutes of the sale. Units that were oversold (never in stock) are voided first. The rest go back to the batches they came from, last batch first, each with a `return` movement.
- Team (owners only): `invite_shop_member` and `resend_shop_invite` return the invite token once, plus `list_shop_team`, `update_member_role`, `set_member_status` and `remove_shop_member` (owners, or a member leaving). `accept_shop_invite` is for the invited person, and `preview_shop_invite` can be called before signing in so the invitee sees which shop and email the link is for. `my_shops` and `create_shop` cover the signed-in user's own shops.
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
- `barcode`: check digits for EAN, UPC and ITF-14, Code 128 rules, the two-read confirmation, the scan band crop, camera error messages, and choosing the native detector or the WASM fallback (mocked).
- `syncEngine`, `syncController`: push and pull against a fake Supabase client. Covers rejected and retryable errors, backoff, product ID remapping, and online/offline behaviour.
- `db/tenantIsolation`, `db/stockConsistency`: apply the real migrations to [PGlite](https://pglite.dev) (Postgres in WebAssembly) with stand-ins for Supabase's roles and `auth` functions.
  - Tenant isolation: another shop's members and anonymous callers see nothing and can call nothing. Role limits for staff and managers are enforced, and the ledger tables reject direct writes. Invites can only be claimed by the invited email address, and the account owner can't be removed.
  - `db/teamManagement`: invite tokens (hashed, single use, expiry, resend replaces the old link, revoke), the email match and confirmed-email checks, duplicate memberships, workers and managers unable to manage the team or change their own role, protection of the account owner, deactivation and removal cutting off reads, product writes, stock-in and sales at once (and reactivation restoring them), notifications and queued pushes stopping, a user in two shops with a different role in each, the audit trail, `create_shop` ownership, and the permission matrix matching `src/lib/permissions.ts`.
  - Tenant isolation also covers voids: staff can undo only their own recent sales, and nobody can write `sale_item_voids` directly.
  - Stock consistency: first-expired-first-out deduction, multi-line sales that roll back as a whole, oversell discrepancies, strict adjustments, voids and idempotent replays. It also checks that the database and the app agree on where voided units go. A seeded random workload checks the ledger invariant.
  - `db/expiryAlerts`: the alert generator at threshold and midnight boundaries, in several time zones; no duplicates across re-runs or a clock going back; 07:00 push hold; notification content; settings validation and permissions; push claiming, retries, backoff, giving up and gone subscriptions; expired batches skipped by sales; and resolutions with their records. `pg_cron`, `pg_net` and Vault aren't available in PGlite, so the schedule migration is skipped and was smoke-tested in production.
  - PGlite runs a single connection, so row locking under truly concurrent sessions is not exercised.
- `expiry`, `expiryPush`: shop-local dates (including daylight saving and UTC+14), reminder stages, expired stock refused on the phone, resolving, one-time alert sounds, and the Edge Function's retry and authentication logic.
- `secrets`: no service-role or secret key in the source, public assets or built bundle.
- `dates`, `legacyMigration`, `i18n`: local-date helpers, the one-time localStorage import, and key and `{{placeholder}}` parity between English and every other language (isiZulu, Amharic, Somali), checks that each one is actually translated (Amharic in Ethiopic script), the phone-language detection, plus a check that every `t('...')` key used in the code exists.

## Project layout

```
supabase/
  migrations/              schema, tenancy, ledger, RLS policies, stock functions, expiry alerts and their schedule, team management (forward-only)
  functions/expiry-push/   Edge Function that sends expiry Web Push messages (logic.ts is unit-tested)
  templates/               sign-in, sign-up confirmation and password reset emails with the 6-digit code
  seed.sql                 intentionally empty (no invented users or credentials)
src/
  lib/db.ts                Dexie (IndexedDB) schema, outbox types, write lock
  lib/dates.ts             local-time-zone date helpers
  lib/legacyMigration.ts   one-time import of localStorage data
  lib/scanGate.ts          ignores repeat camera reads of an item held in frame
  lib/barcode/             decoder choice (native or WASM), code validation, two-read confirmation, crop, beep
  hooks/useBarcodeCamera.ts rear camera, torch and the frame-by-frame decode loop
  lib/serialQueue.ts       runs scans one at a time, in order, without dropping any
  lib/expiry.ts            shop-local dates and reminder rules (mirrors the database)
  lib/push.ts              notification permission and Web Push subscription
  services/                product, stock and sales repositories (all writes are transactional + queued)
  services/scanSell.ts     rapid-sell core: scan, sell more, undo
  sync/                    outbox, sync engine (push/pull) and controller (triggers, status)
  lib/permissions.ts       role permission matrix (mirrors private.role_permissions)
  lib/invite.ts            invite link building and capture from the address bar
  lib/authValidation.ts    email, password and name rules shared by the auth forms
  services/teamService.ts  team, invite and profile calls to the database functions
  context/                 Language, Auth (password, email codes, reset), Shop (several shops), Sync providers
  components/team/         team screen and invite dialog
  hooks/useSaleRegister.ts shared scan-to-sell state for the scanner panel and the Sales tab
  components/              UI: auth, dashboard, views, scanner (lazy-loaded), stock, sales, sync banner
  locales/                 en.ts and zu.ts
  test/                    Vitest suites
public/                    icon.svg, generated PWA icons, push-handler.js (service worker push and click handlers)
```
