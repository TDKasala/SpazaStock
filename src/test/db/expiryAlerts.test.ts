// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  addMember,
  createDatabase,
  createShop,
  createUser,
  errorCode,
  newProduct,
  query,
  rpc,
  sell,
  stockIn,
  type User,
} from './harness';

let pg: PGlite;
let owner: User;
let manager: User;
let staff: User;
let outsider: User;

beforeAll(async () => {
  pg = await createDatabase();
  owner = await createUser(pg);
  manager = await createUser(pg);
  staff = await createUser(pg);
  outsider = await createUser(pg);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

interface Fixture {
  shop: string;
  product: string;
}

/** A fresh shop (Africa/Johannesburg, reminders 21/14/7) with an owner, a manager and staff. */
async function fixture(): Promise<Fixture> {
  const shop = await createShop(pg, owner);
  await addMember(pg, owner, shop, manager, 'manager');
  await addMember(pg, owner, shop, staff, 'staff');
  const product = (await newProduct(pg, owner, shop)).id;
  currentShop = shop;
  return { shop, product };
}

async function batch(f: Fixture, quantity: number, expiry: string | null): Promise<string> {
  return (await stockIn(pg, owner, f.shop, f.product, quantity, { expiry })).batch.id;
}

let currentShop: string | null = null;

async function alertCount(shop: string): Promise<number> {
  const { rows } = await pg.query<{ n: number }>('select count(*) as n from public.expiry_alerts where shop_id = $1', [shop]);
  return Number(rows[0].n);
}

/**
 * Runs the scheduled generator as the database owner, like pg_cron does. It covers every shop, so
 * this returns how many alerts it created for the shop under test.
 */
async function generate(at: string): Promise<number> {
  const before = currentShop ? await alertCount(currentShop) : 0;
  await pg.query('select private.generate_expiry_alerts($1::timestamptz)', [at]);
  return currentShop ? (await alertCount(currentShop)) - before : 0;
}

/** Postgres array literal; the harness would otherwise send arrays as JSON. */
const days = (values: number[]) => `{${values.join(',')}}`;

interface AlertRow {
  id: string;
  batch_id: string;
  kind: string;
  threshold_days: number | null;
  expiry_date: string;
  quantity: number;
  resolution: string | null;
}

async function alerts(shop: string): Promise<AlertRow[]> {
  const { rows } = await pg.query<AlertRow>(
    `select id, batch_id, kind, threshold_days, to_char(expiry_date, 'YYYY-MM-DD') as expiry_date, quantity, resolution
     from public.expiry_alerts where shop_id = $1 order by created_at, threshold_days desc nulls last`,
    [shop]
  );
  return rows;
}

interface NotificationRow {
  id: string;
  user_id: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  push_status: string;
  push_attempts: number;
  push_next_at: string | null;
}

async function notifications(shop: string): Promise<NotificationRow[]> {
  const { rows } = await pg.query<NotificationRow>(
    `select id, user_id, title, body, data, push_status, push_attempts,
            to_char(push_next_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as push_next_at
     from public.notifications where shop_id = $1 and type = 'expiry' order by created_at, user_id`,
    [shop]
  );
  return rows;
}

const open = (rows: AlertRow[]) => rows.filter((r) => r.resolution === null);
const stages = (rows: AlertRow[]) => rows.map((r) => (r.kind === 'expired' ? 'expired' : r.threshold_days));

describe('expiry alert generator', () => {
  it('fires each reminder on its threshold day and nothing before', async () => {
    const f = await fixture();
    // Shop-local today is 2026-10-14 (12:00 SAST).
    const due = await batch(f, 6, '2026-11-04'); // 21 days left
    await batch(f, 4, '2026-11-05'); // 22 days left: not yet
    await batch(f, 3, null); // never

    expect(await generate('2026-10-14T10:00:00Z')).toBe(1);
    const rows = await alerts(f.shop);
    expect(rows).toEqual([
      expect.objectContaining({ batch_id: due, kind: 'reminder', threshold_days: 21, expiry_date: '2026-11-04', quantity: 6 }),
    ]);
  });

  it('walks a batch through 21, 14 and 7 days, then one overdue alert, superseding older ones', async () => {
    const f = await fixture();
    const id = await batch(f, 5, '2026-11-04');

    expect(await generate('2026-10-14T10:00:00Z')).toBe(1);
    expect(await generate('2026-10-15T10:00:00Z')).toBe(0); // 20 days: still the 21-day reminder
    expect(await generate('2026-10-21T10:00:00Z')).toBe(1); // 14
    expect(await generate('2026-10-28T10:00:00Z')).toBe(1); // 7
    expect(await generate('2026-11-04T10:00:00Z')).toBe(0); // expiry day: still sellable, 7-day reminder covers it
    expect(await generate('2026-11-05T10:00:00Z')).toBe(1); // overdue
    expect(await generate('2026-11-20T10:00:00Z')).toBe(0); // only one overdue alert, ever

    const rows = await alerts(f.shop);
    expect(stages(rows)).toEqual([21, 14, 7, 'expired']);
    expect(rows.every((r) => r.batch_id === id)).toBe(true);
    expect(rows.slice(0, 3).map((r) => r.resolution)).toEqual(['superseded', 'superseded', 'superseded']);
    expect(stages(open(rows))).toEqual(['expired']);
  });

  it('jumps straight to the right reminder for a batch received close to expiry', async () => {
    const f = await fixture();
    await batch(f, 2, '2026-10-17'); // 3 days left
    await batch(f, 2, '2026-10-01'); // already expired
    await generate('2026-10-14T10:00:00Z');
    expect(stages(await alerts(f.shop)).sort()).toEqual([7, 'expired'].sort());
  });

  it('uses the shop calendar: midnight SAST is 22:00 UTC', async () => {
    const f = await fixture();
    await batch(f, 3, '2026-10-14');

    await generate('2026-10-14T21:59:59Z'); // 23:59:59 SAST on the expiry day
    expect(stages(await alerts(f.shop))).toEqual([7]);

    await generate('2026-10-14T22:00:00Z'); // 00:00 SAST the next day
    expect(stages(open(await alerts(f.shop)))).toEqual(['expired']);
  });

  it("follows the shop's own time zone", async () => {
    const f = await fixture();
    await rpc(pg, owner, 'update_shop_alert_settings', {
      p_shop_id: f.shop,
      p_reminder_days: days([21, 14, 7]),
      p_timezone: 'Pacific/Kiritimati', // UTC+14: already 2026-10-15 at 10:00 UTC on the 14th
    });
    await batch(f, 3, '2026-10-14');
    await generate('2026-10-14T10:00:00Z');
    expect(stages(await alerts(f.shop))).toEqual(['expired']);
  });

  it('holds pushes until 07:00 shop time', async () => {
    const f = await fixture();
    await batch(f, 3, '2026-10-20');
    await generate('2026-10-14T01:00:00Z'); // 03:00 SAST
    const rows = await notifications(f.shop);
    expect(rows).toHaveLength(2);
    expect(rows.every((n) => n.push_status === 'pending' && n.push_next_at === '2026-10-14T05:00:00Z')).toBe(true);

    const later = await fixture();
    await batch(later, 3, '2026-10-20');
    await generate('2026-10-14T10:00:00Z');
    expect((await notifications(later.shop))[0].push_next_at).toBe('2026-10-14T10:00:00Z');
  });

  it('notifies owners and managers with the product, quantity, expiry date and batch', async () => {
    const f = await fixture();
    const id = await batch(f, 6, '2026-10-21');
    await generate('2026-10-14T10:00:00Z');

    const rows = await notifications(f.shop);
    expect(rows.map((n) => n.user_id).sort()).toEqual([owner.id, manager.id].sort());
    const code = id.slice(0, 6).toUpperCase();
    for (const n of rows) {
      expect(n.title).toBe('Expires in 7 days: Bread');
      expect(n.body).toMatch(new RegExp(`^6 units, expiry 2026-10-21, batch ${code} \\(received \\d{4}-\\d{2}-\\d{2}\\)\\.$`));
      expect(n.data).toMatchObject({
        kind: 'reminder',
        threshold_days: 7,
        days_left: 7,
        batch_id: id,
        batch_code: code,
        product_name: 'Bread',
        quantity: 6,
        expiry_date: '2026-10-21',
      });
    }

    const tomorrow = await fixture();
    await batch(tomorrow, 1, '2026-10-15');
    await batch(tomorrow, 1, '2026-10-14');
    await batch(tomorrow, 1, '2026-10-13');
    await generate('2026-10-14T10:00:00Z');
    expect([...new Set((await notifications(tomorrow.shop)).map((n) => n.title))].sort()).toEqual(
      ['Expired: Bread', 'Expires today: Bread', 'Expires tomorrow: Bread'].sort()
    );
  });

  it('never duplicates an alert or its notifications across re-runs, retries or a clock going back', async () => {
    const f = await fixture();
    await batch(f, 5, '2026-11-04');
    const at = '2026-10-21T10:00:00Z';
    expect(await generate(at)).toBe(1);
    expect(await generate(at)).toBe(0);
    expect(await generate('2026-10-21T10:15:00Z')).toBe(0);
    // A run with an older clock must not re-create the 21-day reminder the 14-day one replaced.
    expect(await generate('2026-10-14T10:00:00Z')).toBe(1);
    expect(await generate('2026-10-14T10:00:00Z')).toBe(0);
    expect(await generate(at)).toBe(0);

    const rows = await alerts(f.shop);
    expect(stages(rows).sort()).toEqual([14, 21].sort());
    expect(await notifications(f.shop)).toHaveLength(4);

    await expect(
      pg.query(
        `insert into public.expiry_alerts (shop_id, batch_id, product_id, kind, threshold_days, expiry_date, quantity, alert_date)
         select shop_id, batch_id, product_id, kind, threshold_days, expiry_date, quantity, alert_date
         from public.expiry_alerts where id = $1`,
        [rows[0].id]
      )
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('closes alerts when the batch sells out or its date changes', async () => {
    const f = await fixture();
    await batch(f, 2, '2026-10-20');
    await generate('2026-10-14T10:00:00Z');
    await sell(pg, staff, f.shop, [{ product_id: f.product, quantity: 2 }], { soldAt: new Date('2026-10-14T10:05:00Z') });
    await generate('2026-10-14T10:15:00Z');
    expect((await alerts(f.shop)).map((r) => r.resolution)).toEqual(['sold_out']);

    const g = await fixture();
    const id = await batch(g, 2, '2026-10-20');
    await generate('2026-10-14T10:00:00Z');
    await pg.query(`update public.stock_batches set expiry_date = '2026-12-31' where id = $1`, [id]);
    expect(await generate('2026-10-14T10:15:00Z')).toBe(0);
    expect((await alerts(g.shop)).map((r) => r.resolution)).toEqual(['expiry_corrected']);
  });

  it('applies custom reminder days', async () => {
    const f = await fixture();
    const saved = await rpc<{ expiry_reminder_days: number[] }>(pg, manager, 'update_shop_alert_settings', {
      p_shop_id: f.shop,
      p_reminder_days: days([3, 30, 3]),
      p_timezone: 'Africa/Johannesburg',
    });
    expect(saved.expiry_reminder_days).toEqual([30, 3]);

    await batch(f, 1, '2026-11-13'); // 30 days
    await batch(f, 1, '2026-10-24'); // 10 days: covered by 30
    await batch(f, 1, '2026-10-16'); // 2 days: 3
    await generate('2026-10-14T10:00:00Z');
    expect(stages(await alerts(f.shop)).sort()).toEqual([3, 30, 30].sort());
  });
});

describe('alert settings permissions and validation', () => {
  it('lets owners and managers change settings, not staff or outsiders', async () => {
    const f = await fixture();
    const args = { p_shop_id: f.shop, p_reminder_days: days([14, 7]), p_timezone: 'Africa/Johannesburg' };
    expect(await errorCode(rpc(pg, staff, 'update_shop_alert_settings', args))).toBe('42501');
    expect(await errorCode(rpc(pg, outsider, 'update_shop_alert_settings', args))).toBe('42501');
    expect(await errorCode(rpc(pg, null, 'update_shop_alert_settings', args))).toBe('42501');
    expect(await errorCode(rpc(pg, owner, 'update_shop_alert_settings', args))).toBeUndefined();
  });

  it('rejects invalid days and time zones', async () => {
    const f = await fixture();
    const call = (values: number[], tz = 'Africa/Johannesburg') =>
      errorCode(
        rpc(pg, owner, 'update_shop_alert_settings', { p_shop_id: f.shop, p_reminder_days: days(values), p_timezone: tz })
      );
    expect(await call([])).toBe('22023');
    expect(await call([0])).toBe('22023');
    expect(await call([181])).toBe('22023');
    expect(await call([1, 2, 3, 4, 5, 6])).toBe('22023');
    expect(await call([7], 'Mars/Olympus')).toBe('22023');
    expect(await call([1, 2, 3, 4, 5], 'America/New_York')).toBeUndefined();

    // Settings only change through the RPC; even a direct write is checked.
    expect(
      await errorCode(query(pg, owner, `update public.shops set timezone = 'Europe/London' where id = $1`, [f.shop]))
    ).toBe('42501');
    expect(await errorCode(pg.query(`update public.shops set timezone = 'Nowhere/Land' where id = $1`, [f.shop]))).toBe(
      '22023'
    );
    expect(
      await errorCode(pg.query(`update public.shops set expiry_reminder_days = '{0}' where id = $1`, [f.shop]))
    ).toBe('23514');
  });
});

describe('alert access', () => {
  it('lets members read their shop alerts and nobody write them', async () => {
    const f = await fixture();
    await batch(f, 1, '2026-10-01');
    await generate('2026-10-14T10:00:00Z');

    const sql = 'select id from public.expiry_alerts where shop_id = $1';
    expect(await query(pg, staff, sql, [f.shop])).toHaveLength(1);
    expect(await query(pg, outsider, sql, [f.shop])).toHaveLength(0);
    expect(await errorCode(query(pg, null, sql, [f.shop]))).toBe('42501');
    expect(
      await errorCode(query(pg, owner, `update public.expiry_alerts set resolved_at = now(), resolution = 'discarded' where shop_id = $1`, [f.shop]))
    ).toBe('42501');
    expect(await errorCode(query(pg, owner, 'delete from public.expiry_alerts where shop_id = $1', [f.shop]))).toBe('42501');
  });

  it('keeps the generator and push delivery server-only', async () => {
    expect(await errorCode(query(pg, owner, 'select private.generate_expiry_alerts()'))).toBe('42501');
    expect(await errorCode(rpc(pg, owner, 'claim_push_batch', { p_limit: 10 }))).toBe('42501');
    expect(await errorCode(rpc(pg, owner, 'complete_push', { p_results: [] }))).toBe('42501');
    expect(await errorCode(rpc(pg, owner, 'push_config'))).toBe('42501');
    expect(await errorCode(rpc(pg, 'service', 'claim_push_batch', { p_limit: 10, p_now: '2000-01-01T00:00:00Z' }))).toBeUndefined();
    // Vault is absent here, so the keys read as null rather than failing.
    expect(await rpc(pg, 'service', 'push_config')).toMatchObject({ vapid_public_key: null, cron_secret: null });
  });

  it('shows each user only their own push subscriptions', async () => {
    const endpoint = `https://push.example.com/${randomUUID()}`;
    await rpc(pg, owner, 'save_push_subscription', {
      p_endpoint: endpoint,
      p_p256dh: 'p'.repeat(40),
      p_auth: 'a'.repeat(16),
      p_user_agent: 'test',
    });
    const sql = 'select endpoint from public.push_subscriptions where endpoint = $1';
    expect(await query(pg, owner, sql, [endpoint])).toHaveLength(1);
    expect(await query(pg, manager, sql, [endpoint])).toHaveLength(0);
    expect(
      await errorCode(
        rpc(pg, null, 'save_push_subscription', { p_endpoint: endpoint, p_p256dh: 'p'.repeat(40), p_auth: 'a'.repeat(16), p_user_agent: null })
      )
    ).toBe('42501');
    expect(
      await errorCode(
        rpc(pg, owner, 'save_push_subscription', { p_endpoint: 'http://insecure.example.com/x', p_p256dh: 'p'.repeat(40), p_auth: 'a'.repeat(16), p_user_agent: null })
      )
    ).toBe('22023');
    await rpc(pg, owner, 'delete_push_subscription', { p_endpoint: endpoint });
    expect(await query(pg, owner, sql, [endpoint])).toHaveLength(0);
  });
});

describe('push delivery retries', () => {
  interface Claimed {
    notification_id: string;
    attempts: number;
    subscriptions: Array<{ id: string; endpoint: string }>;
  }

  const claim = (at: string) => rpc<Claimed[]>(pg, 'service', 'claim_push_batch', { p_limit: 50, p_now: at });
  const complete = (results: unknown[], at: string) =>
    rpc<number>(pg, 'service', 'complete_push', { p_results: results, p_now: at });

  async function subscribed(user: User): Promise<string> {
    return rpc<string>(pg, user, 'save_push_subscription', {
      p_endpoint: `https://push.example.com/${randomUUID()}`,
      p_p256dh: 'p'.repeat(40),
      p_auth: 'a'.repeat(16),
      p_user_agent: 'test',
    });
  }

  async function status(id: string) {
    const { rows } = await pg.query<{ push_status: string; push_attempts: number; next: string | null; push_error: string | null }>(
      `select push_status, push_attempts, push_error,
              to_char(push_next_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as next
       from public.notifications where id = $1`,
      [id]
    );
    return rows[0];
  }

  it('claims once, reclaims a stuck send, backs off and gives up after 5 attempts', async () => {
    // Earlier tests left pending pushes; deliver only this shop's by timing it far in the future.
    await pg.query(`update public.notifications set push_status = 'skipped' where push_status in ('pending', 'sending')`);
    const ownerSub = await subscribed(owner);
    const f = await fixture();
    await batch(f, 3, '2026-10-20');
    await generate('2026-10-14T10:00:00Z');

    // The manager has no subscription, so their copy is skipped; the owner's is claimed.
    const first = await claim('2026-10-14T10:00:00Z');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ attempts: 1, subscriptions: [{ id: ownerSub }] });
    const id = first[0].notification_id;
    const managerRow = (await notifications(f.shop)).find((n) => n.user_id === manager.id)!;
    expect(managerRow.push_status).toBe('skipped');

    // While it is being sent, nobody else claims it.
    expect(await claim('2026-10-14T10:01:00Z')).toHaveLength(0);
    // A send that never reported back is picked up again after 10 minutes.
    expect((await claim('2026-10-14T10:11:00Z')).map((c) => [c.notification_id, c.attempts])).toEqual([[id, 2]]);

    expect(await complete([{ notification_id: id, outcome: 'retry', error: '503' }], '2026-10-14T10:12:00Z')).toBe(1);
    expect(await status(id)).toMatchObject({ push_status: 'pending', push_attempts: 2, next: '2026-10-14T10:42:00Z', push_error: '503' });
    // A repeated or late report changes nothing.
    expect(await complete([{ notification_id: id, outcome: 'sent' }], '2026-10-14T10:13:00Z')).toBe(0);
    expect(await claim('2026-10-14T10:41:00Z')).toHaveLength(0);

    let at = new Date('2026-10-14T10:42:00Z');
    for (const attempts of [3, 4, 5]) {
      const [c] = await claim(at.toISOString());
      expect(c).toMatchObject({ notification_id: id, attempts });
      await complete([{ notification_id: id, outcome: 'retry', error: 'timeout' }], at.toISOString());
      at = new Date(at.getTime() + 7 * 3_600_000);
    }
    expect(await status(id)).toMatchObject({ push_status: 'failed', push_attempts: 5, next: null });
    expect(await claim(new Date('2026-10-20T00:00:00Z').toISOString())).toHaveLength(0);

    await rpc(pg, owner, 'delete_push_subscription', {
      p_endpoint: (await query<{ endpoint: string }>(pg, owner, 'select endpoint from public.push_subscriptions where id = $1', [ownerSub]))[0].endpoint,
    });
  });

  it('marks a delivered push sent and removes subscriptions the push service says are gone', async () => {
    await pg.query(`update public.notifications set push_status = 'skipped' where push_status in ('pending', 'sending')`);
    const live = await subscribed(owner);
    const gone = await subscribed(owner);
    const f = await fixture();
    await batch(f, 3, '2026-10-20');
    await generate('2026-10-14T10:00:00Z');

    const [c] = await claim('2026-10-14T10:00:00Z');
    expect(c.subscriptions.map((s) => s.id).sort()).toEqual([live, gone].sort());
    await complete(
      [{ notification_id: c.notification_id, outcome: 'sent', ok_subscription_ids: [live], gone_subscription_ids: [gone] }],
      '2026-10-14T10:00:30Z'
    );
    expect(await status(c.notification_id)).toMatchObject({ push_status: 'sent', next: null, push_error: null });
    const remaining = await query<{ id: string }>(pg, owner, 'select id from public.push_subscriptions');
    expect(remaining.map((r) => r.id)).toEqual([live]);

    expect(await errorCode(complete([{ notification_id: c.notification_id, outcome: 'maybe' }], '2026-10-14T10:01:00Z'))).toBe('22023');
  });

  it('skips pushes for someone who has left the shop', async () => {
    await pg.query(`update public.notifications set push_status = 'skipped' where push_status in ('pending', 'sending')`);
    const leaver = await createUser(pg);
    await subscribed(leaver);
    const f = await fixture();
    await addMember(pg, owner, f.shop, leaver, 'manager');
    await batch(f, 3, '2026-10-20');
    await generate('2026-10-14T10:00:00Z');
    await pg.query('delete from public.shop_members where shop_id = $1 and user_id = $2', [f.shop, leaver.id]);

    const claimed = await claim('2026-10-14T10:00:00Z');
    const leaverRow = (await notifications(f.shop)).find((n) => n.user_id === leaver.id)!;
    expect(claimed.map((c) => c.notification_id)).not.toContain(leaverRow.id);
    expect(leaverRow.push_status).toBe('skipped');
  });
});

describe('expired stock', () => {
  async function ledger(product: string) {
    const one = async (sql: string) => Number((await pg.query<{ n: number }>(sql, [product])).rows[0].n);
    return {
      stock: await one('select coalesce(sum(quantity), 0) as n from public.stock_batches where product_id = $1'),
      movements: await one('select coalesce(sum(quantity_delta), 0) as n from public.stock_movements where product_id = $1'),
    };
  }

  it('is never sold, but stays sellable until the end of its expiry day in shop time', async () => {
    const f = await fixture();
    const expired = await batch(f, 5, '2026-10-13');
    const fresh = await batch(f, 2, '2026-12-01');

    // 23:00 SAST on the 13th (e.g. an offline sale synced later): the batch was still in date.
    const late = await sell(pg, staff, f.shop, [{ product_id: f.product, quantity: 1 }], {
      soldAt: new Date('2026-10-13T21:00:00Z'),
    });
    expect(late.items[0].allocations.map((a) => a.batchId)).toEqual([expired]);

    const result = await sell(pg, staff, f.shop, [{ product_id: f.product, quantity: 2 }], {
      soldAt: new Date('2026-10-14T10:00:00Z'),
    });
    expect(result.items[0].allocations.map((a) => a.batchId)).toEqual([fresh]);
    expect(result.shortfall).toBe(0);
    expect(result.stock_totals[f.product]).toBe(4);
    expect((result as unknown as { sellable_totals: Record<string, number> }).sellable_totals[f.product]).toBe(0);

    // Only expired units remain: the sale is recorded as a shortfall to recount, never taken from them.
    const over = await sell(pg, staff, f.shop, [{ product_id: f.product, quantity: 1 }], {
      soldAt: new Date('2026-10-14T10:05:00Z'),
    });
    expect(over.shortfall).toBe(1);
    expect(over.items[0].allocations).toEqual([]);
    const { rows } = await pg.query<{ quantity: number }>('select quantity from public.stock_batches where id = $1', [expired]);
    expect(rows[0].quantity).toBe(4);

    const books = await ledger(f.product);
    expect(books.movements).toBe(books.stock);
  });

  it('records discarding expired stock with a write-off and a permanent resolution', async () => {
    const f = await fixture();
    const id = await batch(f, 5, '2026-10-01');
    await generate('2026-10-14T10:00:00Z');

    const args = {
      p_shop_id: f.shop,
      p_batch_id: id,
      p_action: 'discarded',
      p_new_expiry_date: null,
      p_note: 'Binned',
      p_occurred_at: '2026-10-14T11:00:00Z',
      p_idempotency_key: 'resolve-1',
    };
    expect(await errorCode(rpc(pg, staff, 'resolve_expired_batch', args))).toBe('42501');
    expect(await errorCode(rpc(pg, outsider, 'resolve_expired_batch', args))).toBe('42501');

    const res = await rpc<{ duplicate: boolean; total_quantity: number; batch: { quantity: number }; resolution: { quantity: number; action: string } }>(
      pg,
      manager,
      'resolve_expired_batch',
      args
    );
    expect(res).toMatchObject({ duplicate: false, total_quantity: 0, batch: { quantity: 0 }, resolution: { quantity: 5, action: 'discarded' } });

    const again = await rpc<{ duplicate: boolean }>(pg, manager, 'resolve_expired_batch', args);
    expect(again.duplicate).toBe(true);

    const { rows: moves } = await pg.query<{ reason: string; quantity_delta: number; idempotency_key: string }>(
      `select reason, quantity_delta, idempotency_key from public.stock_movements where batch_id = $1 and reason <> 'stock_in'`,
      [id]
    );
    expect(moves).toEqual([{ reason: 'write_off_expired', quantity_delta: -5, idempotency_key: 'expiry:resolve-1' }]);
    expect((await alerts(f.shop)).map((r) => r.resolution)).toEqual(['discarded']);

    const records = await query<{ action: string; note: string; resolved_by: string }>(
      pg,
      staff,
      'select action, note, resolved_by from public.expiry_resolutions where batch_id = $1',
      [id]
    );
    expect(records).toEqual([{ action: 'discarded', note: 'Binned', resolved_by: manager.id }]);
    expect(await query(pg, outsider, 'select 1 from public.expiry_resolutions where batch_id = $1', [id])).toHaveLength(0);

    expect(
      await errorCode(rpc(pg, owner, 'resolve_expired_batch', { ...args, p_idempotency_key: 'resolve-2' }))
    ).toBe('22023');
    const books = await ledger(f.product);
    expect(books.movements).toBe(books.stock);
  });

  it('records a return to the supplier', async () => {
    const f = await fixture();
    const id = await batch(f, 3, '2026-10-01');
    await rpc(pg, owner, 'resolve_expired_batch', {
      p_shop_id: f.shop,
      p_batch_id: id,
      p_action: 'returned_to_supplier',
      p_new_expiry_date: null,
      p_note: null,
      p_occurred_at: null,
      p_idempotency_key: randomUUID(),
    });
    const { rows } = await pg.query<{ reason: string; quantity_delta: number }>(
      `select reason, quantity_delta from public.stock_movements where batch_id = $1 and reason <> 'stock_in'`,
      [id]
    );
    expect(rows).toEqual([{ reason: 'supplier_return', quantity_delta: -3 }]);
  });

  it('corrects a wrongly captured date without moving stock, and alerts follow the new date', async () => {
    const f = await fixture();
    const id = await batch(f, 4, '2026-10-01');
    await generate('2026-10-14T10:00:00Z');

    const call = (date: string | null) =>
      rpc(pg, owner, 'resolve_expired_batch', {
        p_shop_id: f.shop,
        p_batch_id: id,
        p_action: 'expiry_corrected',
        p_new_expiry_date: date,
        p_note: 'Misread',
        p_occurred_at: null,
        p_idempotency_key: randomUUID(),
      });
    expect(await errorCode(call(null))).toBe('22023');
    await call('2026-10-20');

    const { rows } = await pg.query<{ quantity: number; expiry: string }>(
      `select quantity, to_char(expiry_date, 'YYYY-MM-DD') as expiry from public.stock_batches where id = $1`,
      [id]
    );
    expect(rows[0]).toEqual({ quantity: 4, expiry: '2026-10-20' });
    const [record] = await query<{ previous_expiry_date: string; new_expiry_date: string; quantity: number }>(
      pg,
      owner,
      'select previous_expiry_date::text, new_expiry_date::text, quantity from public.expiry_resolutions where batch_id = $1',
      [id]
    );
    expect(record).toEqual({ previous_expiry_date: '2026-10-01', new_expiry_date: '2026-10-20', quantity: 0 });

    expect(await generate('2026-10-14T10:15:00Z')).toBe(1);
    const all = await alerts(f.shop);
    expect(all.map((r) => [r.kind, r.threshold_days, r.resolution])).toEqual([
      ['expired', null, 'expiry_corrected'],
      ['reminder', 7, null],
    ]);
  });

  it('sets a date on a batch that had none and moves a date that has not expired yet', async () => {
    const f = await fixture();
    const undated = await batch(f, 2, null);
    const later = await batch(f, 5, '2026-10-20');
    expect(await generate('2026-10-14T10:00:00Z')).toBe(1);

    const correct = (caller: typeof owner, id: string, date: string) =>
      rpc(pg, caller, 'resolve_expired_batch', {
        p_shop_id: f.shop,
        p_batch_id: id,
        p_action: 'expiry_corrected',
        p_new_expiry_date: date,
        p_note: null,
        p_occurred_at: null,
        p_idempotency_key: randomUUID(),
      });
    expect(await errorCode(correct(staff, later, '2027-03-01'))).toBe('42501');
    await correct(owner, undated, '2026-10-16');
    await correct(manager, later, '2027-03-01');

    const records = await query<{ batch_id: string; previous_expiry_date: string | null; new_expiry_date: string }>(
      pg,
      owner,
      `select batch_id, previous_expiry_date::text, new_expiry_date::text from public.expiry_resolutions
       where shop_id = $1 order by created_at, new_expiry_date`,
      [f.shop]
    );
    expect(records).toEqual([
      { batch_id: undated, previous_expiry_date: null, new_expiry_date: '2026-10-16' },
      { batch_id: later, previous_expiry_date: '2026-10-20', new_expiry_date: '2027-03-01' },
    ]);

    expect(await generate('2026-10-14T10:15:00Z')).toBe(1);
    const all = await alerts(f.shop);
    expect(all.map((r) => [r.batch_id, r.expiry_date, r.resolution])).toEqual([
      [later, '2026-10-20', 'expiry_corrected'],
      [undated, '2026-10-16', null],
    ]);
  });

  it('rejects unknown batches and actions', async () => {
    const f = await fixture();
    const base = {
      p_shop_id: f.shop,
      p_batch_id: randomUUID(),
      p_action: 'discarded',
      p_new_expiry_date: null,
      p_note: null,
      p_occurred_at: null,
      p_idempotency_key: randomUUID(),
    };
    expect(await errorCode(rpc(pg, owner, 'resolve_expired_batch', base))).toBe('P0002');
    const id = await batch(f, 1, '2026-10-01');
    expect(await errorCode(rpc(pg, owner, 'resolve_expired_batch', { ...base, p_batch_id: id, p_action: 'eaten' }))).toBe('22023');
    expect(await errorCode(rpc(pg, owner, 'resolve_expired_batch', { ...base, p_batch_id: id, p_idempotency_key: ' ' }))).toBe('22023');
  });
});
