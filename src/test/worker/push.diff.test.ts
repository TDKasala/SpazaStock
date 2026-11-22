// @vitest-environment node
/** Push subscriptions, sync failure reports and the push queue must match Postgres. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createD1Pair, type D1Pair } from './d1diff';
import { createShop, createUser, addMember, type User } from '../db/harness';
import { freshD1 } from './nodeD1';
import { applyEffects, claimPushBatch, completePush } from '../../../worker/d1/push';

let p: D1Pair;
let owner: User;
let staff: User;
let shopId: string;
const endpoint = 'https://push.example.com/send/abcdef123456';
const key = { p_p256dh: 'B'.repeat(87), p_auth: 'a'.repeat(22) };

beforeAll(async () => {
  p = await createD1Pair();
  owner = await createUser(p.pg, 'owner@example.com');
  staff = await createUser(p.pg, 'staff@example.com');
  shopId = await createShop(p.pg, owner, 'Push shop');
  await addMember(p.pg, owner, shopId, staff, 'staff');
}, 60_000);

afterAll(async () => {
  await p?.close();
});

async function same(user: User | null, fn: string, args: Record<string, unknown> = {}) {
  const r = await p.call(user, fn, args);
  expect(r.d1, `${fn} ${JSON.stringify(args)}`).toEqual(r.pg);
  for (const table of Object.keys(r.tables.pg)) expect(r.tables.d1[table], `${fn}: ${table}`).toEqual(r.tables.pg[table]);
}

describe('push subscriptions and sync reports', () => {
  it('saves, moves and deletes subscriptions the same way', async () => {
    await same(owner, 'save_push_subscription', { p_endpoint: endpoint, ...key, p_user_agent: 'x'.repeat(400) });
    await p.pg.query(`select public.save_push_subscription($1, $2, $3, 'ua')`, [endpoint, key.p_p256dh, key.p_auth]).catch(() => {});
    await same(staff, 'save_push_subscription', { p_endpoint: 'http://insecure.example.com/x', ...key, p_user_agent: null });
    await same(staff, 'save_push_subscription', { p_endpoint: endpoint, ...key, p_user_agent: 'staff phone' });
    await same(owner, 'delete_push_subscription', { p_endpoint: endpoint });
    await same(null, 'delete_push_subscription', { p_endpoint: endpoint });
  });

  it('records sync failure reports the same way', async () => {
    const reports = [
      { op_type: 'sale', error_code: '22023', count: 3 },
      { op_type: 'stock_in', error_code: '', count: 5000 },
    ];
    await same(staff, 'report_sync_failures', { p_shop_id: shopId, p_reports: reports });
    await same(staff, 'report_sync_failures', { p_shop_id: shopId, p_reports: [{ op_type: 'Bad Op', error_code: 'x' }] });
    await same(staff, 'report_sync_failures', { p_shop_id: shopId, p_reports: { not: 'an array' } });
  });
});

describe('push queue', () => {
  it('queues notifications for active owners/managers and claims and completes them like Postgres', async () => {
    const d1 = freshD1();
    d1.db.exec('PRAGMA foreign_keys = OFF');
    const now = new Date().toISOString();
    for (const [id, email] of [[owner.id, owner.email], [staff.id, staff.email]]) {
      d1.db.prepare(`insert into users (id, email, created_at, updated_at) values (?, ?, ?, ?)`).run(id, email, now, now);
    }
    d1.db.prepare(`insert into plans (code, name) values ('free', 'Free')`).run();
    d1.db.prepare(`insert into shops (id, owner_id, name) values (?, ?, 'Push shop')`).run(shopId, owner.id);
    d1.db.prepare(`insert into subscriptions (id, shop_id) values ('11111111-1111-4111-8111-111111111111', ?)`).run(shopId);
    d1.db.prepare(`insert into shop_members (id, shop_id, user_id, role) values ('22222222-2222-4222-8222-222222222222', ?, ?, 'owner')`).run(shopId, owner.id);
    d1.db.prepare(`insert into shop_members (id, shop_id, user_id, role) values ('33333333-3333-4333-8333-333333333333', ?, ?, 'staff')`).run(shopId, staff.id);
    d1.db.prepare(`insert into push_subscriptions (id, user_id, endpoint, p256dh, auth) values ('44444444-4444-4444-8444-444444444444', ?, ?, ?, ?)`).run(owner.id, endpoint, key.p_p256dh, key.p_auth);

    const written = await applyEffects(d1, shopId, [
      { kind: 'notify_roles', roles: ['owner', 'manager'], type: 'low_stock', title: 'Low stock: Bread', body: '1 on hand, minimum 3.', data: { product_id: 'p' }, pushAt: now },
      { kind: 'notify_roles', roles: ['owner', 'manager'], type: 'stock_discrepancy', title: 'Stock needs a recount', body: 'x', data: {} },
    ], now);
    expect(written).toBe(2); // staff is not an owner or manager

    const claimed = await claimPushBatch(d1, 50, now);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ title: 'Low stock: Bread', attempts: 1, subscriptions: [{ endpoint }] });
    expect(await claimPushBatch(d1, 50, now)).toHaveLength(0);

    await completePush(d1, [{ notification_id: claimed[0].notification_id, outcome: 'retry', error: 'HTTP 503' }], now);
    const retry = d1.db.prepare('select push_status, push_next_at, push_error from notifications where id = ?').get(claimed[0].notification_id) as Record<string, string>;
    expect(retry.push_status).toBe('pending');
    expect(Date.parse(retry.push_next_at) - Date.parse(now)).toBe(5 * 60_000);

    const later = new Date(Date.parse(now) + 6 * 60_000).toISOString();
    const again = await claimPushBatch(d1, 50, later);
    await completePush(d1, [{ notification_id: again[0].notification_id, outcome: 'sent', ok_subscription_ids: ['44444444-4444-4444-8444-444444444444'] }], later);
    const sent = d1.db.prepare('select push_status, pushed_at, push_next_at from notifications where id = ?').get(again[0].notification_id) as Record<string, string | null>;
    expect(sent).toEqual({ push_status: 'sent', pushed_at: later, push_next_at: null });

    // Same sequence on Postgres gives the same states and backoff.
    await p.pg.query(`insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4) on conflict (endpoint) do update set user_id = excluded.user_id`, [owner.id, endpoint, key.p_p256dh, key.p_auth]);
    await p.pg.query(`insert into public.notifications (shop_id, user_id, type, title, body, push_status, push_next_at) values ($1, $2, 'low_stock', 'Low stock: Bread', 'x', 'pending', $3)`, [shopId, owner.id, now]);
    const { rows } = await p.pg.query<{ c: { notification_id: string; attempts: number }[] }>('select public.claim_push_batch(50, $1::timestamptz) as c', [now]);
    expect(rows[0].c).toHaveLength(1);
    await p.pg.query('select public.complete_push($1::jsonb, $2::timestamptz)', [JSON.stringify([{ notification_id: rows[0].c[0].notification_id, outcome: 'retry', error: 'HTTP 503' }]), now]);
    const pgRetry = (await p.pg.query<{ push_status: string; push_next_at: string }>('select push_status, push_next_at from public.notifications where id = $1', [rows[0].c[0].notification_id])).rows[0];
    expect(pgRetry.push_status).toBe('pending');
    expect(new Date(pgRetry.push_next_at).getTime() - Date.parse(now)).toBe(5 * 60_000);
  });
});
