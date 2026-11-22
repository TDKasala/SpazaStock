// @vitest-environment node
/**
 * The WebCrypto Web Push implementation, checked from the receiving side with Node's own crypto:
 * a browser's decryption of the aes128gcm body (RFC 8291) and a push service's check of the VAPID
 * JWT (RFC 8292).
 */
import { describe, it, expect } from 'vitest';
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify, randomBytes } from 'node:crypto';
import { encryptPayload, sendPush, vapidAuthorization } from '../../../worker/push/webpush';
import { sendDuePushes } from '../../../worker/cron';
import { freshD1 } from './nodeD1';

const b64u = (b: Buffer) => b.toString('base64url');

function hmac(key: Buffer, data: Buffer) {
  return createHmac('sha256', key).update(data).digest();
}

/** What the browser does with a push body (RFC 8291 section 3.4 and RFC 8188). */
function browserDecrypt(body: Buffer, uaPrivate: ReturnType<typeof createECDH>, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  expect(rs).toBe(4096);
  const shared = uaPrivate.computeSecret(asPublic);
  const uaPublic = uaPrivate.getPublicKey();
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

function subscription() {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  return { ua, auth, target: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };
}

function vapidKeys() {
  const k = createECDH('prime256v1');
  k.generateKeys();
  return { publicKey: b64u(k.getPublicKey()), privateKey: b64u(k.getPrivateKey()), subject: 'mailto:ops@example.com' };
}

describe('web push', () => {
  it('encrypts a payload the browser can decrypt', async () => {
    const { ua, auth, target } = subscription();
    const payload = JSON.stringify({ title: 'Expires tomorrow: Bread', body: '5 units', url: '/?tab=alerts' });
    const body = Buffer.from(await encryptPayload(target, payload));
    expect(browserDecrypt(body, ua, auth)).toBe(payload);
  });

  it('signs a VAPID token the push service accepts', async () => {
    const keys = vapidKeys();
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc123', keys, Date.parse('2026-11-22T10:00:00Z'));
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(m[2]).toBe(keys.publicKey);
    const [h, c, s] = m[1].split('.');
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: Date.parse('2026-11-22T22:00:00Z') / 1000, sub: 'mailto:ops@example.com' });
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('sends with the headers push services require', async () => {
    const { ua, auth, target } = subscription();
    let seen: { url: string; init: RequestInit } | null = null;
    const status = await sendPush(target, '{"title":"x"}', vapidKeys(), (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch);
    expect(status).toBe(201);
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers.TTL).toBe('86400');
    expect(browserDecrypt(Buffer.from(seen!.init.body as Uint8Array), ua, auth)).toBe('{"title":"x"}');
  });

  it('runs the cron sender: claims, sends, drops gone subscriptions, records outcomes', async () => {
    const d1 = freshD1();
    d1.db.exec('PRAGMA foreign_keys = OFF');
    const now = new Date(Date.now() - 1000).toISOString();
    const { target } = subscription();
    d1.db.exec(`insert into plans (code, name) values ('free', 'Free')`);
    d1.db.exec(`insert into users (id, email, created_at, updated_at) values ('u1', 'a@example.com', '${now}', '${now}')`);
    d1.db.exec(`insert into shops (id, owner_id, name) values ('s1', 'u1', 'Shop')`);
    d1.db.exec(`insert into subscriptions (id, shop_id) values ('sub', 's1')`);
    d1.db.exec(`insert into shop_members (id, shop_id, user_id, role) values ('m1', 's1', 'u1', 'owner')`);
    d1.db.prepare(`insert into push_subscriptions (id, user_id, endpoint, p256dh, auth) values ('ok', 'u1', ?, ?, ?)`).run(target.endpoint, target.p256dh, target.auth);
    d1.db.prepare(`insert into push_subscriptions (id, user_id, endpoint, p256dh, auth) values ('gone', 'u1', ?, ?, ?)`).run(`${target.endpoint}-old`, target.p256dh, target.auth);
    d1.db.prepare(`insert into notifications (id, shop_id, user_id, type, title, push_status, push_next_at) values ('n1', 's1', 'u1', 'low_stock', 'Low stock: Bread', 'pending', ?)`).run(now);

    const totals = await sendDuePushes(d1, vapidKeys(), (async (url: string) => new Response(null, { status: url.endsWith('-old') ? 410 : 201 })) as unknown as typeof fetch);
    expect(totals).toEqual({ sent: 1, retry: 0, fail: 0 });
    expect(d1.db.prepare(`select push_status from notifications where id = 'n1'`).get()).toEqual({ push_status: 'sent' });
    expect(d1.db.prepare(`select id from push_subscriptions order by id`).all().map((r) => ({ ...r }))).toEqual([{ id: 'ok' }]);
  });
});
