/**
 * The Worker's auth, replacing Supabase Auth with the same behaviour the app relies on:
 * email + password sign-up confirmed by a six-digit code, sign-in by password or by emailed code,
 * password reset by code, password change, refresh and sign-out. Error codes match Supabase's
 * (src/lib/authErrors.ts maps them to messages).
 */
import { all, first, run, batch, insertStatement, type D1Like } from '../db/d1';
import {
  hashPassword,
  randomCode,
  randomToken,
  sha256,
  signAccessToken,
  timingSafeEqual,
  verifyAccessToken,
  verifyPassword,
  type AccessClaims,
} from './crypto';
import { codeEmail, type CodePurpose, type Mailer } from './email';

export const ACCESS_TOKEN_SECONDS = 3600;
const SESSION_DAYS = 60;
const CODE_MINUTES = 60;
const CODE_MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const REFRESH_REUSE_SECONDS = 10;

export class AuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'AuthApiError';
  }
}

export interface AuthDeps {
  db: D1Like;
  mailer: Mailer;
  secret: string;
  now?: () => number;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  password_kind: 'bcrypt' | 'pbkdf2' | null;
  email_confirmed_at: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  metadata: string;
}

export interface PublicUser {
  id: string;
  aud: 'authenticated';
  role: 'authenticated';
  email: string;
  email_confirmed_at: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  user_metadata: Record<string, unknown>;
  app_metadata: { provider: 'email'; providers: ['email'] };
  identities: { provider: 'email'; id: string; user_id: string }[];
}

export interface Session {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
  expires_at: number;
  user: PublicUser;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function normalizeEmail(email: unknown): string {
  return String(email ?? '').trim().toLowerCase();
}

function assertEmail(email: string): void {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 320) {
    throw new AuthError('email_address_invalid', 400, 'Email address is invalid');
  }
}

/** Supabase's minimum_password_length = 8, password_requirements = "letters_digits". */
export function assertPassword(password: unknown): string {
  const p = typeof password === 'string' ? password : '';
  if (p.length < 8 || !/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) {
    throw new AuthError('weak_password', 422, 'Password should be at least 8 characters and contain letters and digits.');
  }
  if (p.length > 72) throw new AuthError('weak_password', 422, 'Password cannot be longer than 72 characters.');
  return p;
}

function publicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: u.email,
    email_confirmed_at: u.email_confirmed_at,
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at,
    user_metadata: JSON.parse(u.metadata || '{}'),
    app_metadata: { provider: 'email', providers: ['email'] },
    identities: [{ provider: 'email', id: u.id, user_id: u.id }],
  };
}

export class Auth {
  private db: D1Like;
  private mailer: Mailer;
  private secret: string;
  private now: () => number;

  constructor(deps: AuthDeps) {
    if (!deps.secret || deps.secret.length < 32) throw new Error('AUTH_SECRET must be at least 32 characters.');
    this.db = deps.db;
    this.mailer = deps.mailer;
    this.secret = deps.secret;
    this.now = deps.now ?? Date.now;
  }

  private userByEmail(email: string) {
    return first<UserRow>(this.db, 'SELECT * FROM users WHERE email = ?', email);
  }

  private userById(id: string) {
    return first<UserRow>(this.db, 'SELECT * FROM users WHERE id = ?', id);
  }

  /** private.handle_new_user: every user gets a profile, with the display name from sign-up. */
  private async createUser(email: string, passwordHash: string | null, metadata: Record<string, unknown>): Promise<UserRow> {
    const id = crypto.randomUUID();
    const at = iso(this.now());
    const name = [...String(metadata.display_name ?? '').trim()].slice(0, 80).join('').trim() || null;
    await batch(this.db, [
      insertStatement('users', {
        id,
        email,
        password_hash: passwordHash,
        password_kind: passwordHash ? 'pbkdf2' : null,
        created_at: at,
        updated_at: at,
        metadata: JSON.stringify(metadata),
      }),
      ['INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING', id, name, at, at],
    ]);
    return (await this.userById(id))!;
  }

  private async sendCode(email: string, purpose: CodePurpose): Promise<void> {
    const now = this.now();
    const last = await first<{ created_at: string }>(
      this.db,
      'SELECT created_at FROM auth_codes WHERE email = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1',
      email,
      purpose
    );
    if (last) {
      const wait = RESEND_SECONDS - Math.floor((now - Date.parse(last.created_at)) / 1000);
      if (wait > 0) {
        throw new AuthError('over_email_send_rate_limit', 429, `For security purposes, you can only request this after ${wait} seconds.`);
      }
    }
    const code = randomCode();
    await run(
      this.db,
      'INSERT INTO auth_codes (id, email, purpose, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      crypto.randomUUID(),
      email,
      purpose,
      await sha256(`${email}:${code}`),
      iso(now),
      iso(now + CODE_MINUTES * 60_000)
    );
    await this.mailer.send({ to: email, ...codeEmail(purpose, code) });
  }

  private async newSession(user: UserRow, recovery: boolean, userAgent: string | null): Promise<Session> {
    const now = this.now();
    const refresh = randomToken();
    const sid = crypto.randomUUID();
    await run(
      this.db,
      `INSERT INTO sessions (id, user_id, refresh_hash, created_at, last_used_at, expires_at, recovery, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sid,
      user.id,
      await sha256(refresh),
      iso(now),
      iso(now),
      iso(now + SESSION_DAYS * 86_400_000),
      recovery ? 1 : 0,
      userAgent ? userAgent.slice(0, 300) : null
    );
    return this.sessionResponse(user, sid, refresh, recovery);
  }

  private async sessionResponse(user: UserRow, sid: string, refresh: string, recovery: boolean): Promise<Session> {
    const iat = Math.floor(this.now() / 1000);
    const claims: AccessClaims = { sub: user.id, email: user.email, sid, iat, exp: iat + ACCESS_TOKEN_SECONDS };
    if (recovery) claims.recovery = true;
    return {
      access_token: await signAccessToken(claims, this.secret),
      refresh_token: refresh,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_SECONDS,
      expires_at: claims.exp,
      user: publicUser(user),
    };
  }

  /** supabase.auth.signUp: never reveals whether the address is registered. */
  async signUp(emailIn: unknown, password: unknown, metadata: Record<string, unknown> = {}): Promise<{ user: PublicUser; session: null }> {
    const email = normalizeEmail(emailIn);
    assertEmail(email);
    const pass = assertPassword(password);
    const existing = await this.userByEmail(email);
    if (existing?.email_confirmed_at) {
      // Supabase's obfuscated user: no identities, so the app shows "email in use".
      return { user: { ...publicUser(existing), id: crypto.randomUUID(), identities: [] }, session: null };
    }
    let user = existing;
    if (user) {
      await run(this.db, `UPDATE users SET password_hash = ?, password_kind = 'pbkdf2', updated_at = ? WHERE id = ?`, await hashPassword(pass), iso(this.now()), user.id);
    } else {
      user = await this.createUser(email, await hashPassword(pass), metadata);
    }
    await this.sendCode(email, 'signup');
    return { user: publicUser(user), session: null };
  }

  /** supabase.auth.signInWithOtp: emails a sign-in code, creating a passwordless account if needed. */
  async signInWithOtp(emailIn: unknown): Promise<void> {
    const email = normalizeEmail(emailIn);
    assertEmail(email);
    if (!(await this.userByEmail(email))) await this.createUser(email, null, {});
    await this.sendCode(email, 'signin');
  }

  /** supabase.auth.resend({ type: 'signup' }): only for accounts still waiting for confirmation. */
  async resendSignup(emailIn: unknown): Promise<void> {
    const email = normalizeEmail(emailIn);
    assertEmail(email);
    const user = await this.userByEmail(email);
    if (user && !user.email_confirmed_at) await this.sendCode(email, 'signup');
  }

  /** supabase.auth.resetPasswordForEmail: silent when the address is unknown. */
  async requestRecovery(emailIn: unknown): Promise<void> {
    const email = normalizeEmail(emailIn);
    assertEmail(email);
    if (await this.userByEmail(email)) await this.sendCode(email, 'recovery');
  }

  /**
   * supabase.auth.verifyOtp. type 'email' accepts sign-up confirmation and sign-in codes; 'recovery'
   * accepts a reset code and starts a session that may only change the password.
   */
  async verifyOtp(emailIn: unknown, token: unknown, type: unknown, userAgent: string | null = null): Promise<Session> {
    const email = normalizeEmail(emailIn);
    const code = String(token ?? '').trim();
    const purposes: CodePurpose[] =
      type === 'recovery' ? ['recovery'] : type === 'signup' ? ['signup'] : type === 'email' || type === 'magiclink' ? ['signup', 'signin'] : [];
    const invalid = new AuthError('otp_expired', 403, 'Token has expired or is invalid');
    if (!purposes.length || !/^\d{6}$/.test(code)) throw invalid;
    const now = this.now();
    const marks = purposes.map(() => '?').join(', ');
    const candidates = await all<{ id: string; purpose: CodePurpose; code_hash: string; attempts: number }>(
      this.db,
      `SELECT id, purpose, code_hash, attempts FROM auth_codes
        WHERE email = ? AND purpose IN (${marks}) AND consumed_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC LIMIT 5`,
      email,
      ...purposes,
      iso(now)
    );
    const hash = await sha256(`${email}:${code}`);
    const match = candidates.find((c) => c.attempts < CODE_MAX_ATTEMPTS && timingSafeEqual(c.code_hash, hash));
    if (!match) {
      if (candidates[0]) await run(this.db, 'UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?', candidates[0].id);
      throw invalid;
    }
    const consumed = await run(this.db, 'UPDATE auth_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', iso(now), match.id);
    if (consumed === 0) throw invalid;
    const user = await this.userByEmail(email);
    if (!user) throw invalid;
    // Entering any emailed code proves the address.
    await run(
      this.db,
      'UPDATE users SET email_confirmed_at = coalesce(email_confirmed_at, ?), last_sign_in_at = ?, updated_at = ? WHERE id = ?',
      iso(now),
      iso(now),
      iso(now),
      user.id
    );
    return this.newSession((await this.userById(user.id))!, match.purpose === 'recovery', userAgent);
  }

  /** supabase.auth.signInWithPassword. Imported bcrypt hashes are replaced by PBKDF2 on success. */
  async signInWithPassword(emailIn: unknown, password: unknown, userAgent: string | null = null): Promise<Session> {
    const email = normalizeEmail(emailIn);
    const pass = typeof password === 'string' ? password : '';
    const wrong = new AuthError('invalid_credentials', 400, 'Invalid login credentials');
    const user = await this.userByEmail(email);
    if (!user || !user.password_hash || !user.password_kind) throw wrong;
    if (!(await verifyPassword(pass, user.password_hash, user.password_kind))) throw wrong;
    if (!user.email_confirmed_at) throw new AuthError('email_not_confirmed', 400, 'Email not confirmed');
    const now = iso(this.now());
    if (user.password_kind === 'bcrypt') {
      await run(this.db, `UPDATE users SET password_hash = ?, password_kind = 'pbkdf2', updated_at = ? WHERE id = ?`, await hashPassword(pass), now, user.id);
    }
    await run(this.db, 'UPDATE users SET last_sign_in_at = ? WHERE id = ?', now, user.id);
    return this.newSession((await this.userById(user.id))!, false, userAgent);
  }

  /** The signed-in user for an access token, or null. Sessions signed out since are refused. */
  async userForToken(accessToken: string | null): Promise<{ user: PublicUser; claims: AccessClaims } | null> {
    if (!accessToken) return null;
    const claims = await verifyAccessToken(accessToken, this.secret, this.now());
    if (!claims) return null;
    const session = await first<{ id: string }>(this.db, 'SELECT id FROM sessions WHERE id = ? AND user_id = ?', claims.sid, claims.sub);
    if (!session) return null;
    const user = await this.userById(claims.sub);
    return user ? { user: publicUser(user), claims } : null;
  }

  /** supabase.auth.updateUser({ password }). */
  async updatePassword(claims: AccessClaims, password: unknown): Promise<PublicUser> {
    const pass = assertPassword(password);
    const user = await this.userById(claims.sub);
    if (!user) throw new AuthError('user_not_found', 404, 'User not found');
    if (user.password_hash && user.password_kind && (await verifyPassword(pass, user.password_hash, user.password_kind))) {
      throw new AuthError('same_password', 422, 'New password should be different from the old password.');
    }
    const now = iso(this.now());
    await batch(this.db, [
      [`UPDATE users SET password_hash = ?, password_kind = 'pbkdf2', updated_at = ? WHERE id = ?`, await hashPassword(pass), now, user.id],
      // The reset is done: this device keeps its session, and every other device is signed out.
      ['UPDATE sessions SET recovery = 0 WHERE id = ?', claims.sid],
      ...(claims.recovery ? ([['DELETE FROM sessions WHERE user_id = ? AND id <> ?', user.id, claims.sid]] as [string, string, string][]) : []),
    ]);
    return publicUser((await this.userById(user.id))!);
  }

  /** Rotates the refresh token; the previous one is accepted for a few seconds (two tabs at once). */
  async refresh(refreshToken: unknown): Promise<Session> {
    const token = typeof refreshToken === 'string' ? refreshToken : '';
    const notFound = new AuthError('refresh_token_not_found', 400, 'Invalid Refresh Token: Refresh Token Not Found');
    if (!token) throw notFound;
    const hash = await sha256(token);
    const now = this.now();
    let session = await first<{ id: string; user_id: string; expires_at: string; recovery: number }>(
      this.db,
      'SELECT id, user_id, expires_at, recovery FROM sessions WHERE refresh_hash = ?',
      hash
    );
    if (!session) {
      const reused = await first<{ id: string; user_id: string; expires_at: string; recovery: number; rotated_at: string | null }>(
        this.db,
        'SELECT id, user_id, expires_at, recovery, rotated_at FROM sessions WHERE previous_refresh_hash = ?',
        hash
      );
      if (!reused || !reused.rotated_at || now - Date.parse(reused.rotated_at) > REFRESH_REUSE_SECONDS * 1000) throw notFound;
      session = reused;
    }
    if (Date.parse(session.expires_at) <= now) {
      await run(this.db, 'DELETE FROM sessions WHERE id = ?', session.id);
      throw new AuthError('session_expired', 400, 'Session expired');
    }
    const user = await this.userById(session.user_id);
    if (!user) throw notFound;
    const next = randomToken();
    await run(
      this.db,
      `UPDATE sessions SET previous_refresh_hash = refresh_hash, refresh_hash = ?, rotated_at = ?, last_used_at = ?, expires_at = ?
        WHERE id = ?`,
      await sha256(next),
      iso(now),
      iso(now),
      iso(now + SESSION_DAYS * 86_400_000),
      session.id
    );
    return this.sessionResponse(user, session.id, next, session.recovery === 1);
  }

  /** supabase.auth.signOut({ scope: 'local' }): this device only. */
  async signOut(claims: AccessClaims): Promise<void> {
    await run(this.db, 'DELETE FROM sessions WHERE id = ?', claims.sid);
  }
}
