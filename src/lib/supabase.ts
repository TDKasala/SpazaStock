import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { envConfig } from './env';
import { createCloudClient } from './cloud/cloudClient';

let supabaseClient: SupabaseClient | null = null;

if (envConfig.isValid && envConfig.backend === 'cloudflare') {
  // Same calls, served by the Worker (src/lib/cloud/cloudClient.ts mirrors the supabase-js API the app uses).
  supabaseClient = createCloudClient(envConfig.apiBase ?? '') as unknown as SupabaseClient;
} else if (envConfig.isValid && envConfig.supabaseUrl && envConfig.supabaseAnonKey) {
  try {
    supabaseClient = createClient(envConfig.supabaseUrl, envConfig.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
  } catch (err) {
    console.warn('Failed to initialize Supabase client:', err);
  }
}

/**
 * Returns the active Supabase client or null if credentials are not yet configured.
 * Never invents mock credentials or fake database responses.
 */
export function getSupabase(): SupabaseClient | null {
  return supabaseClient;
}

export function isSupabaseConfigured(): boolean {
  return supabaseClient !== null;
}
