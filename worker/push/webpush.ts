/**
 * Web Push on WebCrypto (the web-push npm package needs Node's https and ECDH, which Workers
 * lack): VAPID authentication (RFC 8292) and aes128gcm payload encryption (RFC 8291).
 *
 * VAPID keys are the same base64url strings web-push used and Supabase Vault stored: the public
 * key is the 65-byte uncompressed P-256 point, the private key the 32-byte scalar.
 */
import { base64url, fromBase64url } from '../auth/crypto';

const enc = new TextEncoder();

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as BufferSource));
}

/** HKDF (RFC 5869) with a single output block, which is all RFC 8291 needs. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

async function vapidSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  const pub = fromBase64url(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point.');
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: base64url(pub.slice(1, 33)),
    y: base64url(pub.slice(33, 65)),
    d: keys.privateKey,
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** Authorization header value for one push service origin (RFC 8292, valid 12 hours). */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, now = Date.now()): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = base64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = base64url(enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: keys.subject })));
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await vapidSigningKey(keys),
    enc.encode(`${header}.${claims}`)
  );
  return `vapid t=${header}.${claims}.${base64url(signature)}, k=${keys.publicKey}`;
}

/** RFC 8291 aes128gcm body for one subscription: a single record. */
export async function encryptPayload(
  target: Pick<PushTarget, 'p256dh' | 'auth'>,
  payload: string,
  ephemeral?: CryptoKeyPair,
  salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16))
): Promise<Uint8Array> {
  const uaPublic = fromBase64url(target.p256dh);
  const authSecret = fromBase64url(target.auth);
  const pair =
    ephemeral ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as never, pair.privateKey, 256)
  );

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const plaintext = concat(enc.encode(payload), new Uint8Array([2])); // 0x02: last record, no padding
  const key = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, plaintext as BufferSource));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/** Sends one push; returns the push service's HTTP status (or null on a network error). */
export async function sendPush(target: PushTarget, payload: string, keys: VapidKeys, fetcher: typeof fetch = fetch): Promise<number | null> {
  try {
    const body = await encryptPayload(target, payload);
    const res = await fetcher(target.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuthorization(target.endpoint, keys),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(60 * 60 * 24),
        Urgency: 'high',
      },
      body: body as BodyInit,
    });
    return res.status;
  } catch {
    return null;
  }
}
