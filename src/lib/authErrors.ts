import { isAuthRetryableFetchError } from '@supabase/supabase-js';

const CODE_KEYS: Record<string, string> = {
  invalid_credentials: 'auth.errors.invalidCredentials',
  email_not_confirmed: 'auth.errors.emailNotConfirmed',
  user_already_exists: 'auth.errors.emailInUse',
  email_exists: 'auth.errors.emailInUse',
  weak_password: 'auth.errors.weakPassword',
  same_password: 'auth.errors.samePassword',
  otp_expired: 'auth.errors.codeInvalid',
  over_email_send_rate_limit: 'auth.errors.rateLimited',
  over_request_rate_limit: 'auth.errors.rateLimited',
  signup_disabled: 'auth.errors.signupDisabled',
  email_address_invalid: 'auth.errors.invalidEmail',
};

/** Maps a Supabase Auth error to a translation key, so users see a message in their language. */
export function authErrorKey(error: unknown): string {
  if (!error) return 'auth.errors.generic';
  if (isAuthRetryableFetchError(error)) return 'auth.errors.network';

  const { code, status, message } = error as { code?: string; status?: number; message?: string };
  if (code && CODE_KEYS[code]) return CODE_KEYS[code];
  if (status === 429) return 'auth.errors.rateLimited';

  const text = (message ?? '').toLowerCase();
  if (text.includes('invalid login credentials')) return 'auth.errors.invalidCredentials';
  if (text.includes('email not confirmed')) return 'auth.errors.emailNotConfirmed';
  if (text.includes('expired') || (text.includes('invalid') && text.includes('token'))) return 'auth.errors.codeInvalid';
  if (text.includes('failed to fetch') || text.includes('network')) return 'auth.errors.network';
  return 'auth.errors.generic';
}
