/** Input rules shared by the sign-in, registration, reset and invite forms. */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const PASSWORD_MIN_LENGTH = 8;
// bcrypt, which Supabase Auth uses, ignores everything after 72 bytes.
export const PASSWORD_MAX_LENGTH = 72;
export const DISPLAY_NAME_MAX_LENGTH = 80;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  const value = email.trim();
  return value.length <= 254 && EMAIL_RE.test(value);
}

export function isValidCode(code: string): boolean {
  return /^\d{6}$/.test(code.trim());
}

/** Translation key describing what is wrong with the password, or null when it is acceptable. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return 'auth.errors.passwordTooShort';
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_LENGTH) return 'auth.errors.passwordTooLong';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'auth.errors.passwordNeedsMix';
  return null;
}

export function normalizeDisplayName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function isValidDisplayName(name: string): boolean {
  const value = normalizeDisplayName(name);
  return value.length >= 1 && value.length <= DISPLAY_NAME_MAX_LENGTH;
}
