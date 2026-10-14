/**
 * Web Push for expiry alerts. The server (pg_cron + the expiry-push Edge Function) sends the
 * messages; this module asks permission, subscribes the browser and registers the subscription.
 * iOS only supports Web Push in a PWA added to the Home Screen (iOS 16.4+).
 */
import { getSupabase } from './supabase';

export type PushSupport = 'unsupported' | 'needs_install' | 'denied' | 'default' | 'granted';

export type EnablePushResult =
  | { ok: true; serverPush: boolean }
  | { ok: false; reason: 'unsupported' | 'needs_install' | 'denied' | 'failed' };

function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function hasPushApis(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

export function getPushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!hasPushApis()) return isIos() && !isStandalone() ? 'needs_install' : 'unsupported';
  const permission = Notification.permission;
  return permission === 'granted' ? 'granted' : permission === 'denied' ? 'denied' : 'default';
}

/** VAPID public keys are URL-safe base64; PushManager wants the raw bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Subscribes this browser and stores the subscription for the signed-in user. Returns false when
 * the server has no push keys yet (alerts still show in the app).
 */
async function registerServerSubscription(): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { data: publicKey, error: keyError } = await supabase.rpc('get_push_public_key');
  if (keyError || typeof publicKey !== 'string' || !publicKey) return false;

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const json = subscription.toJSON();
  const { error } = await supabase.rpc('save_push_subscription', {
    p_endpoint: subscription.endpoint,
    p_p256dh: json.keys?.p256dh ?? '',
    p_auth: json.keys?.auth ?? '',
    p_user_agent: navigator.userAgent.slice(0, 300),
  });
  if (error) throw new Error(error.message);
  return true;
}

/** Asks for notification permission (needs a user gesture) and subscribes for server push. */
export async function enablePushNotifications(): Promise<EnablePushResult> {
  const support = getPushSupport();
  if (support === 'unsupported' || support === 'needs_install') return { ok: false, reason: support };

  const permission = support === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  try {
    return { ok: true, serverPush: await registerServerSubscription() };
  } catch (err) {
    console.warn('Push subscription failed:', err);
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Re-registers an existing subscription after sign-in, since browsers rotate endpoints and a
 * shared phone may have a new user. Never prompts.
 */
export async function refreshPushSubscription(): Promise<void> {
  if (getPushSupport() !== 'granted') return;
  try {
    await registerServerSubscription();
  } catch (err) {
    console.warn('Could not refresh push subscription:', err);
  }
}

/** Shows a system notification from the app itself (device-only mode, where no server pushes). */
export async function showLocalNotification(title: string, body: string, tag: string): Promise<void> {
  if (getPushSupport() !== 'granted') return;
  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(title, {
      body,
      tag,
      icon: '/pwa-192x192.png',
      badge: '/pwa-64x64.png',
      data: { url: '/?tab=alerts' },
      // vibrate is supported on Android but missing from TypeScript's NotificationOptions.
      ...({ vibrate: [200, 100, 200, 100, 300] } as NotificationOptions),
    });
  } catch (err) {
    console.warn('Could not show notification:', err);
  }
}
