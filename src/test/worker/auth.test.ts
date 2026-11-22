// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { Auth, AuthError } from '../../../worker/auth/service';
import { verifyAccessToken } from '../../../worker/auth/crypto';
import { freshD1 } from './nodeD1';

const SECRET = 'test-secret-that-is-long-enough-1234567890';
let clock = Date.parse('2026-11-22T10:00:00Z');
let sent: { to: string; subject: string; text: string }[] = [];
let d1: ReturnType<typeof freshD1>;
let auth: Auth;

const lastCode = () => /\b(\d{6})\b/.exec(sent[sent.length - 1].text)![1];
async function code<T>(p: Promise<T>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as AuthError).code;
  }
}

beforeEach(() => {
  clock = Date.parse('2026-11-22T10:00:00Z');
  sent = [];
  d1 = freshD1();
  auth = new Auth({ db: d1, mailer: { send: async (m) => void sent.push(m) }, secret: SECRET, now: () => clock });
});

describe('sign-up and confirmation', () => {
  it('creates an unconfirmed user with a profile, emails a code, and signs in once confirmed', async () => {
    const res = await auth.signUp(' Thandi@Example.com ', 'spaza2026', { display_name: '  Thandi  ' });
    expect(res.session).toBeNull();
    expect(res.user.email).toBe('thandi@example.com');
    expect(res.user.identities).toHaveLength(1);
    expect(sent[0].subject).toBe('Confirm your SpazaStock account');
    const profile = d1.db.prepare('select display_name from profiles where id = ?').get(res.user.id) as { display_name: string };
    expect(profile.display_name).toBe('Thandi');

    expect(await code(auth.signInWithPassword('thandi@example.com', 'spaza2026'))).toBe('email_not_confirmed');
    const session = await auth.verifyOtp('thandi@example.com', lastCode(), 'email');
    expect(session.user.email_confirmed_at).not.toBeNull();
    const claims = await verifyAccessToken(session.access_token, SECRET, clock);
    expect(claims?.sub).toBe(res.user.id);
    expect((await auth.signInWithPassword('THANDI@example.com', 'spaza2026')).user.id).toBe(res.user.id);
  });

  it('hides whether a confirmed address is registered, like Supabase', async () => {
    await auth.signUp('a@example.com', 'spaza2026');
    await auth.verifyOtp('a@example.com', lastCode(), 'email');
    clock += 120_000;
    const again = await auth.signUp('a@example.com', 'other2026');
    expect(again.user.identities).toEqual([]);
    expect(await code(auth.signInWithPassword('a@example.com', 'other2026'))).toBe('invalid_credentials');
  });

  it('refuses weak passwords and bad addresses with Supabase error codes', async () => {
    expect(await code(auth.signUp('a@example.com', 'short1'))).toBe('weak_password');
    expect(await code(auth.signUp('a@example.com', 'lettersonly'))).toBe('weak_password');
    expect(await code(auth.signUp('not-an-email', 'spaza2026'))).toBe('email_address_invalid');
  });

  it('limits codes to one a minute per address and purpose', async () => {
    await auth.signUp('a@example.com', 'spaza2026');
    expect(await code(auth.resendSignup('a@example.com'))).toBe('over_email_send_rate_limit');
    clock += 61_000;
    await auth.resendSignup('a@example.com');
    expect(sent).toHaveLength(2);
  });
});

describe('codes', () => {
  it('signs in by emailed code, refuses wrong, reused, expired and over-guessed codes', async () => {
    await auth.signInWithOtp('b@example.com');
    const good = lastCode();
    const wrong = good === '000000' ? '111111' : '000000';
    expect(await code(auth.verifyOtp('b@example.com', wrong, 'email'))).toBe('otp_expired');
    const session = await auth.verifyOtp('b@example.com', good, 'email');
    expect(session.user.email).toBe('b@example.com');
    expect(await code(auth.verifyOtp('b@example.com', good, 'email'))).toBe('otp_expired');

    clock += 61_000;
    await auth.signInWithOtp('b@example.com');
    clock += 61 * 60_000;
    expect(await code(auth.verifyOtp('b@example.com', lastCode(), 'email'))).toBe('otp_expired');

    await auth.signInWithOtp('b@example.com');
    const fresh = lastCode();
    const other = fresh === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await code(auth.verifyOtp('b@example.com', other, 'email'));
    expect(await code(auth.verifyOtp('b@example.com', fresh, 'email'))).toBe('otp_expired');
  });

  it('resets a password with a recovery code and signs out other devices', async () => {
    await auth.signUp('c@example.com', 'spaza2026');
    await auth.verifyOtp('c@example.com', lastCode(), 'email');
    const other = await auth.signInWithPassword('c@example.com', 'spaza2026');
    clock += 61_000;
    await auth.requestRecovery('c@example.com');
    expect(sent[sent.length - 1].subject).toBe('Reset your SpazaStock password');
    const recovery = await auth.verifyOtp('c@example.com', lastCode(), 'recovery');
    const claims = (await verifyAccessToken(recovery.access_token, SECRET, clock))!;
    expect(claims.recovery).toBe(true);
    expect(await code(auth.updatePassword(claims, 'spaza2026'))).toBe('same_password');
    await auth.updatePassword(claims, 'newpass2027');
    expect(await auth.userForToken(other.access_token)).toBeNull();
    expect(await auth.userForToken(recovery.access_token)).not.toBeNull();
    expect((await auth.signInWithPassword('c@example.com', 'newpass2027')).user.email).toBe('c@example.com');
  });

  it('stays silent for unknown addresses on reset and resend', async () => {
    await auth.requestRecovery('nobody@example.com');
    await auth.resendSignup('nobody@example.com');
    expect(sent).toHaveLength(0);
  });
});

describe('imported Supabase accounts', () => {
  it('accepts the bcrypt hash once and replaces it with PBKDF2', async () => {
    const hash = bcrypt.hashSync('imported2025', 10).replace(/^\$2b\$/, '$2a$');
    d1.db.prepare(
      `insert into users (id, email, password_hash, password_kind, email_confirmed_at, created_at, updated_at)
       values ('11111111-1111-4111-8111-111111111111', 'old@example.com', ?, 'bcrypt', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z')`
    ).run(hash);
    expect(await code(auth.signInWithPassword('old@example.com', 'wrong2025'))).toBe('invalid_credentials');
    const session = await auth.signInWithPassword('old@example.com', 'imported2025');
    expect(session.user.id).toBe('11111111-1111-4111-8111-111111111111');
    const row = d1.db.prepare('select password_kind, password_hash from users where email = ?').get('old@example.com') as { password_kind: string; password_hash: string };
    expect(row.password_kind).toBe('pbkdf2');
    expect(row.password_hash.startsWith('pbkdf2-sha256$100000$')).toBe(true);
    expect((await auth.signInWithPassword('old@example.com', 'imported2025')).user.email).toBe('old@example.com');
  });
});

describe('sessions', () => {
  it('rotates refresh tokens, tolerates a quick double refresh, and signs out', async () => {
    await auth.signInWithOtp('d@example.com');
    const s1 = await auth.verifyOtp('d@example.com', lastCode(), 'email');
    const s2 = await auth.refresh(s1.refresh_token);
    expect(s2.refresh_token).not.toBe(s1.refresh_token);
    clock += 5_000;
    await auth.refresh(s1.refresh_token); // second tab, within 10 seconds
    clock += 30_000;
    expect(await code(auth.refresh(s1.refresh_token))).toBe('refresh_token_not_found');

    const claims = (await verifyAccessToken(s2.access_token, SECRET, clock))!;
    await auth.signOut(claims);
    expect(await auth.userForToken(s2.access_token)).toBeNull();
  });

  it('refuses expired and tampered access tokens', async () => {
    await auth.signInWithOtp('e@example.com');
    const s = await auth.verifyOtp('e@example.com', lastCode(), 'email');
    const [h, b, sig] = s.access_token.split('.');
    expect(await auth.userForToken(`${h}.${b}.${sig.slice(0, -2)}xx`)).toBeNull();
    clock += 3601_000;
    expect(await auth.userForToken(s.access_token)).toBeNull();
  });
});
