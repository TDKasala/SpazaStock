import { EnvValidationResult } from '../types';

/**
 * Validates runtime and build-time environment variables for SpazaStock.
 * Ensures the app handles missing or placeholder Supabase credentials safely
 * without crashing or inventing fake keys.
 */
export function validateEnv(): EnvValidationResult {
  const errors: string[] = [];
  
  // Safely read from import.meta.env
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  const appName = import.meta.env.VITE_APP_NAME?.trim() || 'SpazaStock';

  const isPlaceholderUrl = !supabaseUrl || 
    supabaseUrl.includes('your-project') || 
    supabaseUrl.includes('placeholder') || 
    supabaseUrl === 'MY_SUPABASE_URL';

  const isPlaceholderKey = !supabaseAnonKey || 
    supabaseAnonKey.includes('your-anon-key') || 
    supabaseAnonKey.includes('placeholder') || 
    supabaseAnonKey.length < 20;

  if (!supabaseUrl) {
    errors.push('VITE_SUPABASE_URL is not set.');
  } else if (isPlaceholderUrl) {
    errors.push('VITE_SUPABASE_URL contains placeholder value.');
  } else {
    try {
      const parsed = new URL(supabaseUrl);
      if (!parsed.protocol.startsWith('http')) {
        errors.push('VITE_SUPABASE_URL must be a valid HTTP/HTTPS URL.');
      }
    } catch {
      errors.push('VITE_SUPABASE_URL format is invalid.');
    }
  }

  if (!supabaseAnonKey) {
    errors.push('VITE_SUPABASE_ANON_KEY is not set.');
  } else if (isPlaceholderKey) {
    errors.push('VITE_SUPABASE_ANON_KEY contains placeholder value.');
  }

  const isValid = errors.length === 0;

  return {
    isValid,
    supabaseUrl: isValid ? supabaseUrl : undefined,
    supabaseAnonKey: isValid ? supabaseAnonKey : undefined,
    appName,
    errors,
  };
}

export const envConfig = validateEnv();
