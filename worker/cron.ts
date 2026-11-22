/**
 * Cron Triggers (wrangler.jsonc "triggers"), replacing pg_cron + pg_net:
 *   every 15 minutes  expiry and low-stock alerts, each shop in its own Durable Object
 *   every 5 minutes   send due Web Push notifications
 */
import { all, type D1Like } from './db/d1';
import type { Env } from './env';
import { shopStub } from './api/rpc';
import { applyEffects, claimPushBatch, completePush, type PushResult } from './d1/push';
import { sendPush, type VapidKeys } from './push/webpush';
import {
  buildPayload,
  classifyPushStatus,
  combineResults,
  type ClaimedPush as LogicClaimedPush,
} from '../supabase/functions/expiry-push/logic.ts';

export const ALERTS_CRON = '*/15 * * * *';
export const PUSH_CRON = '*/5 * * * *';

export async function runScheduled(cron: string, env: Env): Promise<void> {
  if (cron === ALERTS_CRON) await generateAlerts(env);
  if (cron === PUSH_CRON) await sendDuePushes(env.DB, vapidKeys(env));
}

function vapidKeys(env: Env): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT };
}

/** private.generate_expiry_alerts + private.generate_low_stock_alerts, shop by shop. */
export async function generateAlerts(env: Env): Promise<{ shops: number; expiry: number; lowStock: number }> {
  const now = new Date().toISOString();
  const shops = await all<{ id: string; timezone: string; expiry_reminder_days: string; status: string }>(
    env.DB,
    'SELECT id, timezone, expiry_reminder_days, status FROM shops'
  );
  let expiry = 0;
  let lowStock = 0;
  for (const shop of shops) {
    try {
      const result = await shopStub(env, shop.id).runAlerts(
        { shopId: shop.id, userId: null, role: null, permissions: [], shopActive: shop.status === 'active', timezone: shop.timezone, now },
        { reminderDays: JSON.parse(shop.expiry_reminder_days) }
      );
      expiry += result.expiry;
      lowStock += result.lowStock;
      if (result.effects.length) await applyEffects(env.DB, shop.id, result.effects, now);
    } catch (err) {
      // One shop failing must not stop the others; the next run tries it again.
      console.error(`alerts failed for shop ${shop.id}`, err);
    }
  }
  return { shops: shops.length, expiry, lowStock };
}

const BATCH_SIZE = 50;
const MAX_ROUNDS = 5;

/** The expiry-push Edge Function's loop: claim due pushes, send, record outcomes. */
export async function sendDuePushes(db: D1Like, keys: VapidKeys | null, fetcher: typeof fetch = fetch) {
  const totals = { sent: 0, retry: 0, fail: 0 };
  if (!keys) {
    console.warn('Web Push is not configured: set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT.');
    return totals;
  }
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const now = new Date().toISOString();
    const pushes = await claimPushBatch(db, BATCH_SIZE, now);
    if (!pushes.length) break;
    const reports = await Promise.all(
      pushes.map(async (push) => {
        const payload = JSON.stringify(buildPayload(push as unknown as LogicClaimedPush));
        const results = await Promise.all(
          push.subscriptions.map(async (s) => {
            const status = await sendPush(s, payload, keys, fetcher);
            return { subscriptionId: s.id, outcome: classifyPushStatus(status), error: status === null ? 'network error' : undefined };
          })
        );
        return combineResults(push.notification_id, results);
      })
    );
    await completePush(db, reports as unknown as PushResult[], new Date().toISOString());
    for (const r of reports) totals[r.outcome]++;
    if (pushes.length < BATCH_SIZE) break;
  }
  return totals;
}
