// expiry-push: sends due expiry notifications as Web Push messages.
//
// Called every 5 minutes by pg_cron through pg_net (see migrations/*_expiry_schedule.sql) with
// `Authorization: Bearer <expiry_push_secret>`. Deployed with verify_jwt = false because the
// caller is the database, not a signed-in user; the shared secret is checked instead.
// The VAPID keys and the secret are read from Supabase Vault through push_config(), which only
// the service role may call. The service role key is provided by the Edge runtime.

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import {
  bearerToken,
  buildPayload,
  classifyPushStatus,
  combineResults,
  timingSafeEqual,
  type ClaimedPush,
  type ClaimedSubscription,
  type CompletionReport,
  type SubscriptionResult,
} from './logic.ts';

const BATCH_SIZE = 50;
const MAX_ROUNDS = 5;

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface PushConfig {
  vapid_public_key: string | null;
  vapid_private_key: string | null;
  vapid_subject: string | null;
  cron_secret: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function sendOne(subscription: ClaimedSubscription, payload: string): Promise<SubscriptionResult> {
  try {
    const response = await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      payload,
      { TTL: 60 * 60 * 24, urgency: 'high' }
    );
    return { subscriptionId: subscription.id, outcome: classifyPushStatus(response.statusCode) };
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode ?? null;
    const message = err instanceof Error ? err.message : String(err);
    return { subscriptionId: subscription.id, outcome: classifyPushStatus(status), error: message.slice(0, 300) };
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const { data: config, error: configError } = await supabase.rpc('push_config');
  if (configError) return json({ error: 'Could not read push configuration.' }, 500);
  const { vapid_public_key, vapid_private_key, vapid_subject, cron_secret } = (config ?? {}) as PushConfig;

  const token = bearerToken(req.headers.get('Authorization'));
  if (!cron_secret || !token || !timingSafeEqual(token, cron_secret)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  if (!vapid_public_key || !vapid_private_key || !vapid_subject) {
    return json({ error: 'Push keys are not configured in Vault.' }, 503);
  }
  webpush.setVapidDetails(vapid_subject, vapid_public_key, vapid_private_key);

  const totals = { sent: 0, retry: 0, fail: 0 };
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { data: claimed, error: claimError } = await supabase.rpc('claim_push_batch', { p_limit: BATCH_SIZE });
    if (claimError) return json({ error: 'Could not claim pushes.', totals }, 500);
    const pushes = (claimed ?? []) as ClaimedPush[];
    if (pushes.length === 0) break;

    const reports: CompletionReport[] = await Promise.all(
      pushes.map(async (push) => {
        const payload = JSON.stringify(buildPayload(push));
        const results = await Promise.all(push.subscriptions.map((s) => sendOne(s, payload)));
        return combineResults(push.notification_id, results);
      })
    );

    // If this fails, the rows stay 'sending' and are reclaimed after 10 minutes.
    const { error: completeError } = await supabase.rpc('complete_push', { p_results: reports });
    if (completeError) return json({ error: 'Could not record push results.', totals }, 500);

    for (const report of reports) totals[report.outcome]++;
    if (pushes.length < BATCH_SIZE) break;
  }

  return json({ ok: true, totals });
});
