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
