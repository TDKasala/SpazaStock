/**
 * Pure helpers for the expiry-push Edge Function. No Deno or network APIs here, so Vitest can
 * import this file directly.
 */

export type PushOutcome = 'sent' | 'retry' | 'gone' | 'fail';

export interface ClaimedSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** One notification returned by claim_push_batch(). */
export interface ClaimedPush {
  notification_id: string;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  attempts: number;
  subscriptions: ClaimedSubscription[];
}

export interface PushPayload {
  title: string;
  body: string;
  /** The service worker replaces a shown notification with the same tag instead of stacking it. */
  tag: string;
  url: string;
  data: Record<string, unknown>;
}

export interface SubscriptionResult {
  subscriptionId: string;
  outcome: PushOutcome;
  error?: string;
}

/** Shape complete_push() expects for one notification. */
export interface CompletionReport {
  notification_id: string;
  outcome: 'sent' | 'retry' | 'fail';
  error?: string;
  ok_subscription_ids: string[];
  gone_subscription_ids: string[];
}

/** Mirrors private.push_backoff and the 5-attempt limit in complete_push(). */
export const PUSH_BACKOFF_MINUTES = [5, 30, 120, 360] as const;
export const MAX_PUSH_ATTEMPTS = 5;

export function backoffMinutes(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), PUSH_BACKOFF_MINUTES.length) - 1;
  return PUSH_BACKOFF_MINUTES[index];
}

/**
 * Maps a push service HTTP status to what to do next. `null` means the request never got a
 * response (network error or timeout), which is worth retrying.
 */
export function classifyPushStatus(status: number | null | undefined): PushOutcome {
  if (status == null) return 'retry';
  if (status >= 200 && status < 300) return 'sent';
  if (status === 404 || status === 410) return 'gone';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'fail';
}

export function buildPayload(push: ClaimedPush): PushPayload {
  const data = push.data ?? {};
    if (data.kind === 'low_stock') {
      return {
        title: push.title,
        body: push.body ?? '',
        tag: `low-stock:${String(data.product_id ?? push.notification_id)}`,
        url: '/?tab=alerts',
        data: { ...data, notification_id: push.notification_id },
      };
    }
    const threshold = data.threshold_days ?? 'expired';
    return {
      title: push.title,
      body: push.body ?? '',
      tag: `expiry:${String(data.batch_id ?? push.notification_id)}:${String(data.kind ?? 'alert')}:${String(threshold)}`,
      url: '/?tab=alerts',
      data: { ...data, notification_id: push.notification_id },
    };
}

/**
 * Folds per-subscription results into one report. Delivered to any device counts as sent, so a
 * retry never re-sends to devices that already got it.
 */
export function combineResults(notificationId: string, results: SubscriptionResult[]): CompletionReport {
  const ok = results.filter((r) => r.outcome === 'sent').map((r) => r.subscriptionId);
  const gone = results.filter((r) => r.outcome === 'gone').map((r) => r.subscriptionId);
  const firstError = results.find((r) => r.outcome !== 'sent')?.error;

  let outcome: CompletionReport['outcome'];
  if (ok.length > 0) outcome = 'sent';
  else if (results.some((r) => r.outcome === 'retry')) outcome = 'retry';
  else outcome = 'fail';

  return {
    notification_id: notificationId,
    outcome,
    ...(outcome === 'sent' ? {} : { error: firstError ?? 'No active push subscriptions.' }),
    ok_subscription_ids: ok,
    gone_subscription_ids: gone,
  };
}

export function bearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? '');
  return match ? match[1].trim() : null;
}

/** Compares secrets without leaking how many leading characters matched. */
export function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
