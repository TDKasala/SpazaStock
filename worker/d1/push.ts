/**
 * Push subscriptions, the push queue (claim/complete, used by the cron sender), sync failure
 * reports, and applying notification effects returned by shop objects. Ported from the Postgres
 * functions of the same names.
 */
import { all, batch, first, run, type D1Like } from '../db/d1';
import { forbidden, invalid } from '../db/errors';
import type { ShopEffect } from '../shop/context';
import { entitled, membership, shopIsActive, uuidArg, type D1Ctx, type Stmt } from './common';

type Args = Record<string, unknown>;

/** public.save_push_subscription: one row per browser endpoint, moved to whoever signs in on it. */
export async function savePushSubscription(db: D1Like, ctx: D1Ctx, a: Args): Promise<string> {
  if (!ctx.userId) throw forbidden('Sign in to turn on notifications.');
  const endpoint = typeof a.p_endpoint === 'string' ? a.p_endpoint : null;
  const p256dh = String(a.p_p256dh ?? '');
  const auth = String(a.p_auth ?? '');
  if (
    endpoint === null ||
    !endpoint.toLowerCase().startsWith('https://') ||
    endpoint.length < 12 ||
    endpoint.length > 1000 ||
    p256dh.length < 20 ||
    p256dh.length > 200 ||
    auth.length < 8 ||
    auth.length > 100
  ) {
    throw invalid('Invalid push subscription.');
  }
  const agent = a.p_user_agent == null ? null : [...String(a.p_user_agent)].slice(0, 300).join('');
  await run(
    db,
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
       user_agent = excluded.user_agent, failure_count = 0`,
    crypto.randomUUID(),
    ctx.userId,
    endpoint,
    p256dh,
    auth,
    agent,
    ctx.now,
    ctx.now
  );
  return (await first<{ id: string }>(db, 'SELECT id FROM push_subscriptions WHERE endpoint = ?', endpoint))!.id;
}

/** public.delete_push_subscription */
export async function deletePushSubscription(db: D1Like, ctx: D1Ctx, a: Args): Promise<null> {
  if (!ctx.userId) throw forbidden('Sign in to turn off notifications.');
  await run(db, 'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', a.p_endpoint == null ? null : String(a.p_endpoint), ctx.userId);
  return null;
}

/** public.report_sync_failures: phones report sync errors so operations can see them. */
export async function reportSyncFailures(db: D1Like, ctx: D1Ctx, a: Args): Promise<number> {
  const shopId = uuidArg(a.p_shop_id);
  // Suspended shops may still report, so this checks membership only.
  const m = shopId ? await membership(db, shopId, ctx.userId) : null;
  if (!ctx.userId || !m) throw forbidden();
  const reports = a.p_reports;
  if (!Array.isArray(reports) || reports.length > 50) throw invalid('Reports must be an array of at most 50 entries.');
  const day = ctx.now.slice(0, 10);
  const stmts: Stmt[] = [];
  for (const r of reports as Record<string, unknown>[]) {
    const op = r?.op_type == null ? null : String(r.op_type);
    const code = r?.error_code == null || r.error_code === '' ? 'unknown' : String(r.error_code);
    const count = Math.min(Math.max(r?.count == null ? 1 : Math.trunc(Number(r.count)), 1), 1000);
    if (op === null || !/^[a-z_]{1,40}$/.test(op) || !/^[A-Za-z0-9_]{1,16}$/.test(code)) throw invalid('Invalid sync failure report.');
    stmts.push([
      `INSERT INTO sync_failure_reports (shop_id, user_id, day, op_type, error_code, occurrences, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (shop_id, user_id, day, op_type, error_code) DO UPDATE
         SET occurrences = min(sync_failure_reports.occurrences + excluded.occurrences, 1000000), last_seen = excluded.last_seen`,
      shopId!,
      ctx.userId,
      day,
      op,
      code,
      count,
      ctx.now,
      ctx.now,
    ]);
  }
  if (stmts.length) await batch(db, stmts);
  return stmts.length;
}

/**
 * Writes the notifications a shop object asked for: one per active owner/manager (the
 * skip_inactive_recipient trigger kept others out). Pushes are queued only when pushAt is set.
 */
export async function applyEffects(db: D1Like, shopId: string, effects: ShopEffect[], now: string): Promise<number> {
  const notify = effects.filter((e) => e.kind === 'notify_roles');
  if (!notify.length) return 0;
  const members = await all<{ user_id: string; role: string }>(
    db,
    `SELECT user_id, role FROM shop_members WHERE shop_id = ? AND user_id IS NOT NULL AND status = 'active'`,
    shopId
  );
  const stmts: Stmt[] = [];
  for (const e of notify) {
    for (const m of members) {
      if (!e.roles.includes(m.role as never)) continue;
      stmts.push([
        `INSERT INTO notifications (id, shop_id, user_id, type, title, body, data, push_status, push_next_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        shopId,
        m.user_id,
        e.type,
        e.title,
        e.body,
        JSON.stringify(e.data),
        e.pushAt ? 'pending' : 'skipped',
        e.pushAt ?? null,
        now,
        now,
      ]);
    }
  }
  if (stmts.length) await batch(db, stmts);
  return stmts.length;
}

export interface ClaimedPush {
  notification_id: string;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  attempts: number;
  subscriptions: { id: string; endpoint: string; p256dh: string; auth: string }[];
}

/**
 * public.claim_push_batch: skips pushes nobody can receive, then claims up to `limit` due ones
 * (status 'sending', retried after 10 minutes if the sender never reports back).
 */
export async function claimPushBatch(db: D1Like, limit: number, now: string): Promise<ClaimedPush[]> {
  const due = await all<{ id: string; shop_id: string; user_id: string; type: string }>(
    db,
    `SELECT id, shop_id, user_id, type FROM notifications WHERE push_status IN ('pending', 'sending') AND push_next_at <= ?`,
    now
  );
  const skip: string[] = [];
  const cache = new Map<string, { active: boolean; expiryPush: boolean }>();
  for (const n of due) {
    let shop = cache.get(n.shop_id);
    if (!shop) {
      shop = { active: await shopIsActive(db, n.shop_id), expiryPush: await entitled(db, n.shop_id, 'expiry_push', now) };
      cache.set(n.shop_id, shop);
    }
    const hasSub = await first(db, 'SELECT 1 AS x FROM push_subscriptions WHERE user_id = ?', n.user_id);
    const isMember = await first(db, 'SELECT 1 AS x FROM shop_members WHERE shop_id = ? AND user_id = ?', n.shop_id, n.user_id);
    if (!hasSub || !isMember || !shop.active || (n.type !== 'low_stock' && !shop.expiryPush)) skip.push(n.id);
  }
  if (skip.length) {
    await batch(db, skip.map((id): Stmt => [`UPDATE notifications SET push_status = 'skipped', push_next_at = NULL WHERE id = ?`, id]));
  }

  const size = Math.max(1, Math.min(limit || 50, 200));
  const claimable = await all<{ id: string }>(
    db,
    `SELECT id FROM notifications WHERE push_status IN ('pending', 'sending') AND push_next_at <= ? ORDER BY push_next_at, id LIMIT ?`,
    now,
    size
  );
  const retryAt = new Date(Date.parse(now) + 10 * 60_000).toISOString();
  const claimed: ClaimedPush[] = [];
  for (const { id } of claimable) {
    // Only one sender wins a row: the update checks it is still due.
    const changed = await run(
      db,
      `UPDATE notifications SET push_status = 'sending', push_attempts = push_attempts + 1, push_next_at = ?
        WHERE id = ? AND push_status IN ('pending', 'sending') AND push_next_at <= ?`,
      retryAt,
      id,
      now
    );
    if (!changed) continue;
    const n = (await first<{ id: string; user_id: string; title: string; body: string | null; data: string; push_attempts: number }>(
      db,
      'SELECT id, user_id, title, body, data, push_attempts FROM notifications WHERE id = ?',
      id
    ))!;
    claimed.push({
      notification_id: n.id,
      title: n.title,
      body: n.body,
      data: JSON.parse(n.data),
      attempts: n.push_attempts,
      subscriptions: await all(db, 'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? ORDER BY created_at', n.user_id),
    });
  }
  return claimed;
}

export interface PushResult {
  notification_id: string;
  outcome: 'sent' | 'retry' | 'fail';
  error?: string;
  gone_subscription_ids?: string[];
  ok_subscription_ids?: string[];
}

/** private.push_backoff */
function backoffMs(attempts: number): number {
  if (attempts <= 1) return 5 * 60_000;
  if (attempts === 2) return 30 * 60_000;
  if (attempts === 3) return 2 * 3_600_000;
  return 6 * 3_600_000;
}

/** public.complete_push: records each push's outcome; expired browser subscriptions are dropped. */
export async function completePush(db: D1Like, results: PushResult[], now: string): Promise<number> {
  let updated = 0;
  for (const r of results) {
    if (!['sent', 'retry', 'fail'].includes(r.outcome)) throw invalid('Unknown push outcome.');
    const stmts: Stmt[] = [];
    for (const id of r.gone_subscription_ids ?? []) stmts.push(['DELETE FROM push_subscriptions WHERE id = ?', id]);
    for (const id of r.ok_subscription_ids ?? []) stmts.push(['UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE id = ?', now, id]);
    if (stmts.length) await batch(db, stmts);
    const n = await first<{ push_attempts: number }>(db, `SELECT push_attempts FROM notifications WHERE id = ? AND push_status = 'sending'`, r.notification_id);
    if (!n) continue;
    const status = r.outcome === 'sent' ? 'sent' : r.outcome === 'fail' || n.push_attempts >= 5 ? 'failed' : 'pending';
    const next = r.outcome === 'retry' && n.push_attempts < 5 ? new Date(Date.parse(now) + backoffMs(n.push_attempts)).toISOString() : null;
    updated += await run(
      db,
      `UPDATE notifications SET push_status = ?, pushed_at = CASE WHEN ? = 'sent' THEN ? ELSE pushed_at END, push_next_at = ?, push_error = ?
        WHERE id = ? AND push_status = 'sending'`,
      status,
      r.outcome,
      now,
      next,
      r.outcome === 'sent' ? null : r.error == null ? null : [...String(r.error)].slice(0, 500).join(''),
      r.notification_id
    );
  }
  return updated;
}
