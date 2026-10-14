import { getSupabase } from './supabase';

/**
 * The signed-in user's platform administrator role, or null. Only decides whether to show the
 * admin link; every admin function checks the role again on the server.
 */
export async function fetchPlatformRole(): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.rpc('admin_whoami');
    if (error || !data) return null;
    return ((data as { role?: string | null }).role ?? null) || null;
  } catch {
    return null;
  }
}

const FRESH_SIGN_IN_KEY = 'spazastock_fresh_sign_in';

/**
 * Remembers, for this tab only, that the user has just signed in, so a platform admin is taken to
 * the console once. Reopening the app with a saved session does not count, so "Back to shop" works.
 */
export function markFreshSignIn(): void {
  try {
    sessionStorage.setItem(FRESH_SIGN_IN_KEY, '1');
  } catch {
    // Storage unavailable: admins use the link in the shop menu instead.
  }
}

export function hasFreshSignIn(): boolean {
  try {
    return sessionStorage.getItem(FRESH_SIGN_IN_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearFreshSignIn(): void {
  try {
    sessionStorage.removeItem(FRESH_SIGN_IN_KEY);
  } catch {
    // Nothing stored.
  }
}

/** Where to go after a fresh sign-in: the admin console for platform admins, otherwise stay. */
export async function postSignInDestination(
  fetchRole: () => Promise<string | null> = fetchPlatformRole
): Promise<'/admin' | null> {
  const role = await fetchRole();
  clearFreshSignIn();
  return role ? '/admin' : null;
}
