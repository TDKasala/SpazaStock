/** Hashing, tokens and signatures for the Worker's auth, on WebCrypto. */
import bcrypt from 'bcryptjs';

const enc = new TextEncoder();

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A uniformly random six-digit code. */
export function randomCode(): string {
  const limit = 4_294_000_000; // largest multiple of 1e6 below 2^32, so every code is equally likely
  for (;;) {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    if (n < limit) return String(n % 1_000_000).padStart(6, '0');
  }
}

export async function sha256(text: string): Promise<string> {
  return base64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const PBKDF2_ITERATIONS = 100_000; // the most WebCrypto allows on Workers

/** pbkdf2-sha256$<iterations>$<salt>$<hash> */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${base64url(salt)}$${await pbkdf2(password, salt, PBKDF2_ITERATIONS)}`;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return base64url(bits);
}

/**
 * Checks a password against a stored hash: PBKDF2 for accounts created or signed in on Cloudflare,
 * bcrypt for accounts imported from Supabase (rehashed by the caller after a match).
 */
export async function verifyPassword(password: string, stored: string, kind: 'bcrypt' | 'pbkdf2'): Promise<boolean> {
  if (kind === 'bcrypt') return bcrypt.compare(password, stored);
  const [scheme, iterations, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2-sha256' || !iterations || !salt || !hash) return false;
  return timingSafeEqual(await pbkdf2(password, fromBase64url(salt), Number(iterations)), hash);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export interface AccessClaims {
  sub: string;
  email: string;
  sid: string;
  /** Session may only change the password (after a reset code). */
  recovery?: boolean;
  iat: number;
  exp: number;
}

/** HS256 JWT. */
export async function signAccessToken(claims: AccessClaims, secret: string): Promise<string> {
  const header = base64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${header}.${body}`));
  return `${header}.${body}.${base64url(sig)}`;
}

export async function verifyAccessToken(token: string, secret: string, now = Date.now()): Promise<AccessClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64url(sig) as BufferSource, enc.encode(`${header}.${body}`));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const h = JSON.parse(new TextDecoder().decode(fromBase64url(header)));
    if (h.alg !== 'HS256') return null;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as AccessClaims;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
    return claims;
  } catch {
    return null;
  }
}
