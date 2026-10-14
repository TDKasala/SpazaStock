// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  auditRows,
  bootstrapSuperadmin,
  createDatabase,
  createShop,
  createUser,
  errorCode,
  grantAdmin,
  invite,
  query,
  REASON,
  rpc,
  type User,
} from './harness';

let pg: PGlite;
let root: User;
let billing: User;
let owner: User;
let shop: string;

const DAY = 24 * 3600 * 1000;
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY).toISOString();

type Result = { ok: boolean; code?: string; [key: string]: unknown };

function setEntitlement(plan: string, key: string, enabled: boolean, limit: number | null) {
  return rpc<Result>(pg, root, 'admin_set_entitlement', { p_plan: plan, p_key: key, p_enabled: enabled, p_limit: limit, p_reason: REASON });
}

function setSubscription(
  caller: User,
  plan: string,
  status: string,
  dates: { trialEndsAt?: string | null; periodEnd?: string | null } = {}
) {
  return rpc<Result>(pg, caller, 'admin_update_subscription', {
    p_shop_id: shop,
    p_plan: plan,
    p_status: status,
    p_trial_ends_at: dates.trialEndsAt ?? null,
    p_current_period_end: dates.periodEnd ?? null,
    p_reason: REASON,
  });
}

function setFeature(key: string, enabled: boolean) {
  return rpc<Result>(pg, root, 'admin_set_feature', { p_key: key, p_enabled: enabled, p_reason: REASON });
}

async function effectivePlan(): Promise<string> {
  const { rows } = await pg.query<{ plan: string }>('select private.effective_plan($1) as plan', [shop]);
  return rows[0].plan;
}

async function myShop(user: User = owner) {
  const shops = await rpc<{ id: string; status: string; entitlements: Record<string, unknown> }[]>(pg, user, 'my_shops');
  return shops.find((s) => s.id === shop)!;
}

beforeAll(async () => {
  pg = await createDatabase();
  root = await createUser(pg);
  billing = await createUser(pg);
  owner = await createUser(pg);
  await bootstrapSuperadmin(pg, root);
  await grantAdmin(pg, root, billing, 'billing');
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('new shops', () => {
  it('start on the free plan, and the shop list carries status and entitlements', async () => {
    const created = await rpc<Record<string, unknown>>(pg, owner, 'create_shop', { p_name: 'Plan Spaza' });
    shop = created.id as string;
    const expected = { plan: 'free', expiry_push: true, team_max_members: null };
    expect(created).toMatchObject({ status: 'active', entitlements: expected });
    expect(await myShop()).toMatchObject({ status: 'active', entitlements: expected });

    const { rows } = await pg.query<{ event: string; new_plan: string; new_status: string }>(
      'select event, new_plan, new_status from public.subscription_events where shop_id = $1',
      [shop]
    );
    expect(rows).toEqual([{ event: 'created', new_plan: 'free', new_status: 'active' }]);
  });
});

describe('team member limit', () => {
  let cancelled: string;

  it('counts the owner, joined members and unexpired invites, at invite time', async () => {
    await setEntitlement('free', 'team.max_members', true, 3);
    expect((await myShop()).entitlements.team_max_members).toBe(3);
    await invite(pg, owner, shop, 'a@example.com');
    cancelled = (await invite(pg, owner, shop, 'b@example.com')).member_id;
    expect(await errorCode(invite(pg, owner, shop, 'c@example.com'))).toBe('SP002');
  });

  it('checks again when an invite is accepted', async () => {
    const joiner = await createUser(pg, 'joiner@example.com');
    await rpc(pg, owner, 'remove_shop_member', { p_member_id: cancelled });
    const token = (await invite(pg, owner, shop, joiner.email)).token;
    await setEntitlement('free', 'team.max_members', true, 2);
    expect(await errorCode(rpc(pg, joiner, 'accept_shop_invite', { p_token: token }))).toBe('SP002');

    await setEntitlement('free', 'team.max_members', true, null);
    await rpc(pg, joiner, 'accept_shop_invite', { p_token: token });
    expect((await myShop(joiner)).status).toBe('active');
  });

  it('treats a disabled limit as zero and an unlimited plan as no limit', async () => {
    await setEntitlement('free', 'team.max_members', false, null);
    expect((await myShop()).entitlements.team_max_members).toBe(0);
    expect(await errorCode(invite(pg, owner, shop, 'd@example.com'))).toBe('SP002');

    expect((await setSubscription(billing, 'pro', 'active')).effective_plan).toBe('pro');
    expect((await myShop()).entitlements.team_max_members).toBeNull();
    expect((await invite(pg, owner, shop, 'd@example.com')).token).toBeTruthy();
    await setEntitlement('free', 'team.max_members', true, null);
  });
});

describe('effective plan', () => {
  it('follows trials, grace periods and cancellations', async () => {
    await setSubscription(billing, 'pro', 'trialing');
    expect(await effectivePlan()).toBe('pro');
    const { rows } = await pg.query<{ trial_ends_at: string }>('select trial_ends_at from public.subscriptions where shop_id = $1', [shop]);
    const trialDays = (new Date(rows[0].trial_ends_at).getTime() - Date.now()) / DAY;
    expect(trialDays).toBeGreaterThan(13.9);
    expect(trialDays).toBeLessThanOrEqual(14);

    await setSubscription(billing, 'pro', 'trialing', { trialEndsAt: daysFromNow(-1) });
    expect(await effectivePlan()).toBe('free');

    await setSubscription(billing, 'pro', 'past_due', { periodEnd: daysFromNow(-3) });
    expect(await effectivePlan()).toBe('pro');
    await setSubscription(billing, 'pro', 'past_due', { periodEnd: daysFromNow(-8) });
    expect(await effectivePlan()).toBe('free');

    await setSubscription(billing, 'pro', 'canceled');
    expect(await effectivePlan()).toBe('free');
    expect((await myShop()).entitlements.plan).toBe('free');
  });

  it('rejects subscriptions that cannot be honoured', async () => {
    expect(await errorCode(setSubscription(billing, 'free', 'trialing'))).toBe('22023');
    expect(await errorCode(setSubscription(billing, 'pro', 'past_due'))).toBe('22023');
    expect(await errorCode(setSubscription(billing, 'gold', 'active'))).toBe('22023');
    expect(await errorCode(setSubscription(billing, 'pro', 'paused'))).toBe('22023');
  });

  it('records every change as a subscription event and an audit entry', async () => {
    const { rows } = await pg.query<{ event: string; actor_id: string }>(
      `select event, actor_id from public.subscription_events where shop_id = $1 and event <> 'created' order by id`,
      [shop]
    );
    expect(rows.map((r) => r.event)).toEqual([
      'plan_changed',
      'status_changed',
      'updated',
      'status_changed',
      'updated',
      'status_changed',
    ]);
    expect(rows.every((r) => r.actor_id === billing.id)).toBe(true);
    const audit = await auditRows(pg, { actor: billing, action: 'billing.subscription_changed' });
    expect(audit).toHaveLength(rows.length);
    expect(audit.at(-1)?.details).toMatchObject({ before: { status: 'past_due' }, after: { status: 'canceled' } });
  });

  it('keeps subscription history append-only and away from clients', async () => {
    expect(await errorCode(query(pg, owner, `update public.subscriptions set plan = 'pro', status = 'active'`))).toBe('42501');
    expect(await errorCode(query(pg, owner, 'select 1 from public.subscription_events'))).toBe('42501');
    const { rows } = await pg.query<{ id: number }>('select id from public.subscription_events where shop_id = $1 limit 1', [shop]);
    expect(await errorCode(pg.query('update public.subscription_events set event = $1 where id = $2', ['updated', rows[0].id]))).toBe('42501');
    expect(await errorCode(pg.query('delete from public.subscription_events where id = $1', [rows[0].id]))).toBe('42501');
  });
});

describe('expiry push entitlement', () => {
  let subscriber: User;

  async function pendingPush(): Promise<string> {
    await pg.query(`update public.notifications set push_status = 'skipped' where push_status in ('pending', 'sending')`);
    const { rows } = await pg.query<{ id: string }>(
      `insert into public.notifications (shop_id, user_id, type, title, push_status, push_next_at)
       values ($1, $2, 'expiry', 'Expiring soon', 'pending', now()) returning id`,
      [shop, subscriber.id]
    );
    return rows[0].id;
  }

  async function claimed(id: string): Promise<boolean> {
    const batch = await rpc<{ notification_id: string }[]>(pg, 'service', 'claim_push_batch', {
      p_limit: 50,
      p_now: daysFromNow(0.01),
    });
    const { rows } = await pg.query<{ push_status: string }>('select push_status from public.notifications where id = $1', [id]);
    const sent = batch.some((c) => c.notification_id === id);
    expect(rows[0].push_status).toBe(sent ? 'sending' : 'skipped');
    return sent;
  }

  beforeAll(async () => {
    subscriber = owner;
    await rpc(pg, owner, 'save_push_subscription', {
      p_endpoint: `https://push.example.com/${randomUUID()}`,
      p_p256dh: 'p'.repeat(40),
      p_auth: 'a'.repeat(16),
      p_user_agent: 'test',
    });
    await setEntitlement('free', 'expiry_push', false, null);
  });

  it('sends pushes only when the shop plan includes them', async () => {
    await setSubscription(billing, 'free', 'active');
    expect((await myShop()).entitlements.expiry_push).toBe(false);
    expect(await claimed(await pendingPush())).toBe(false);

    await setSubscription(billing, 'pro', 'active');
    expect(await claimed(await pendingPush())).toBe(true);
  });

  it('lets the global switch turn pushes off for every plan', async () => {
    await setFeature('expiry_push', false);
    expect((await myShop()).entitlements.expiry_push).toBe(false);
    expect(await claimed(await pendingPush())).toBe(false);
    await setFeature('expiry_push', true);
    expect(await claimed(await pendingPush())).toBe(true);
  });

  it('sends nothing for a suspended shop', async () => {
    await rpc(pg, root, 'admin_set_shop_status', { p_shop_id: shop, p_status: 'suspended', p_reason: REASON });
    expect(await claimed(await pendingPush())).toBe(false);
    await rpc(pg, root, 'admin_set_shop_status', { p_shop_id: shop, p_status: 'active', p_reason: REASON });
  });
});

describe('plan administration', () => {
  const plan = (overrides: Record<string, unknown> = {}) =>
    rpc<Result>(pg, root, 'admin_upsert_plan', {
      p_code: 'business',
      p_name: 'Business',
      p_price_cents: 19900,
      p_currency: 'ZAR',
      p_billing_interval: 'month',
      p_trial_days: 7,
      p_grace_days: 5,
      p_is_active: true,
      p_reason: REASON,
      ...overrides,
    });

  it('creates plans with every entitlement on, then updates them', async () => {
    expect(await plan()).toEqual({ ok: true, created: true });
    const { rows } = await pg.query<{ key: string; enabled: boolean; limit_value: number | null }>(
      `select key, enabled, limit_value from public.plan_entitlements where plan_code = 'business' order by key`
    );
    expect(rows).toEqual([
      { key: 'expiry_push', enabled: true, limit_value: null },
      { key: 'team.max_members', enabled: true, limit_value: null },
    ]);
    expect(await plan({ p_price_cents: 24900, p_is_active: false })).toEqual({ ok: true, created: false });
    const [updated] = (await auditRows(pg, { action: 'plan.updated' })).slice(-1);
    expect(updated.details).toMatchObject({ before: { price_cents: 19900 }, after: { price_cents: 24900, is_active: false } });
    expect(await errorCode(setSubscription(billing, 'business', 'active'))).toBe('22023');
  });

  it('validates plans, entitlements and features', async () => {
    expect(await errorCode(plan({ p_code: 'X' }))).toBe('22023');
    expect(await errorCode(plan({ p_currency: 'rand' }))).toBe('22023');
    expect(await errorCode(plan({ p_billing_interval: 'week' }))).toBe('22023');
    expect(await errorCode(plan({ p_trial_days: 400 }))).toBe('22023');
    expect(await errorCode(plan({ p_grace_days: -1 }))).toBe('22023');
    expect(await errorCode(plan({ p_price_cents: -5 }))).toBe('22023');
    expect(await errorCode(plan({ p_code: 'free', p_name: 'Free', p_is_active: false }))).toBe('22023');

    expect(await errorCode(setEntitlement('gold', 'expiry_push', true, null))).toBe('22023');
    expect(await errorCode(setEntitlement('pro', 'reports', true, null))).toBe('22023');
    expect(await errorCode(setEntitlement('pro', 'expiry_push', true, 5))).toBe('22023');
    expect(await errorCode(setEntitlement('pro', 'team.max_members', true, -1))).toBe('22023');
    expect(await errorCode(setFeature('team.max_members', false))).toBe('22023');
    expect(await errorCode(setFeature('reports', false))).toBe('22023');
  });

  it('lets billing administrators read plans but not change them', async () => {
    const report = await rpc<Result>(pg, billing, 'admin_list_plans');
    expect(report.ok).toBe(true);
    expect((report.plans as { code: string }[]).map((p) => p.code)).toEqual(expect.arrayContaining(['free', 'pro', 'business']));
    expect(
      await rpc(pg, billing, 'admin_set_entitlement', { p_plan: 'pro', p_key: 'expiry_push', p_enabled: false, p_limit: null, p_reason: REASON })
    ).toEqual({ ok: false, code: 'forbidden' });
  });
});
