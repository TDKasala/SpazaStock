// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
let shop: string;
let otherShop: string;

beforeAll(async () => {
  pg = await createDatabase();
  owner = await createUser(pg);
  manager = await createUser(pg);
  staff = await createUser(pg);
  outsider = await createUser(pg);
  shop = await createShop(pg, owner, 'Alert shop');
  otherShop = await createShop(pg, outsider, 'Quiet shop');
  await addMember(pg, owner, shop, manager, 'manager');
  await addMember(pg, owner, shop, staff, 'staff');
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

async function shopToday(shopId: string): Promise<string> {
  const [row] = await query<{ today: string }>(
    pg,
    'service',
    `select (timezone(coalesce(s.timezone, 'Africa/Johannesburg'), now()))::date::text as today
     from public.shops s where s.id = $1`,
    [shopId]
  );
  return row.today;
}

function shiftDate(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function notifyCount(shopId: string, productId?: string): Promise<number> {
  const { rows } = await pg.query<{ n: number }>(
    productId
      ? `select count(*)::int as n from public.notifications
         where shop_id = $1 and type = 'low_stock' and data ->> 'product_id' = $2`
      : `select count(*)::int as n from public.notifications where shop_id = $1 and type = 'low_stock'`,
    productId ? [shopId, productId] : [shopId]
  );
  return Number(rows[0].n);
}

async function generate(at: string): Promise<number> {
  const { rows } = await pg.query<{ generate_low_stock_alerts: number }>(
    'select private.generate_low_stock_alerts($1::timestamptz)',
    [at]
  );
  return Number(rows[0].generate_low_stock_alerts);
}

describe('low stock phone alerts', () => {
  it('notifies the owner and manager once, then again only after stock recovers', async () => {
    const today = await shopToday(shop);
    const bread = await newProduct(pg, owner, shop);
    await rpc(pg, owner, 'update_product', {
      p_shop_id: shop,
      p_product_id: bread.id,
      p_barcode: bread.barcode,
      p_name: 'Bread',
      p_category: 'bakery',
      p_buying_price: 12,
      p_selling_price: 18.5,
    });
    await rpc(pg, owner, 'set_product_min_stock', { p_shop_id: shop, p_product_id: bread.id, p_min_stock: 5 });
    await stockIn(pg, owner, shop, bread.id, 2, { expiry: shiftDate(today, 10) });
    await stockIn(pg, owner, shop, bread.id, 10, { expiry: shiftDate(today, -1) });

    const quiet = await newProduct(pg, outsider, otherShop);
    await rpc(pg, outsider, 'set_product_min_stock', { p_shop_id: otherShop, p_product_id: quiet.id, p_min_stock: 1 });
    await stockIn(pg, outsider, otherShop, quiet.id, 20);

    const at = `${today}T02:00:00Z`;
    expect(await generate(at)).toBe(2);
    expect(await notifyCount(shop, bread.id)).toBe(2);
    expect(await notifyCount(otherShop)).toBe(0);

    const { rows: notes } = await pg.query<{ user_id: string; title: string; body: string; push_next_at: string }>(
      `select user_id, title, body, push_next_at
       from public.notifications where shop_id = $1 and type = 'low_stock'`,
      [shop]
    );
    expect(notes.map((row) => row.user_id).sort()).toEqual([owner.id, manager.id].sort());
    expect(notes.every((row) => row.title === 'Low stock: Bread' && row.body === '2 on hand, minimum 5.')).toBe(true);
    expect(notes.every((row) => new Date(row.push_next_at).toISOString() === `${today}T05:00:00.000Z`)).toBe(true);
    expect(await notifyCount(shop)).toBe(2);

    expect(await generate(at)).toBe(0);
    expect(await notifyCount(shop, bread.id)).toBe(2);

    await stockIn(pg, owner, shop, bread.id, 10, { expiry: shiftDate(today, 10) });
    expect(await generate(at)).toBe(0);
    const { rows: episodes } = await pg.query<{ n: number }>(
      'select count(*)::int as n from private.low_stock_episodes where shop_id = $1 and product_id = $2',
      [shop, bread.id]
    );
    expect(Number(episodes[0].n)).toBe(0);

    await sell(pg, owner, shop, [{ product_id: bread.id, quantity: 20 }]);
    expect(await generate(at)).toBe(2);
    expect(await notifyCount(shop, bread.id)).toBe(4);
  });

  it('stays quiet for a dismissed product and for staff', async () => {
    const milk = await newProduct(pg, owner, shop);
    await rpc(pg, owner, 'update_product', {
      p_shop_id: shop,
      p_product_id: milk.id,
      p_barcode: milk.barcode,
      p_name: 'Milk',
      p_category: 'dairy',
      p_buying_price: 10,
      p_selling_price: 15,
    });
    await rpc(pg, owner, 'set_product_min_stock', { p_shop_id: shop, p_product_id: milk.id, p_min_stock: 1 });
    await rpc(pg, staff, 'dismiss_low_stock', { p_shop_id: shop, p_product_id: milk.id });

    expect(await generate('2026-10-21T02:00:00Z')).toBe(0);
    expect(await notifyCount(shop, milk.id)).toBe(0);
    const { rows: staffNotes } = await pg.query<{ n: number }>(
      `select count(*)::int as n from public.notifications where shop_id = $1 and user_id = $2 and type = 'low_stock'`,
      [shop, staff.id]
    );
    expect(Number(staffNotes[0].n)).toBe(0);
    expect(await errorCode(query(pg, owner, 'select private.generate_low_stock_alerts()'))).toBe('42501');
  });

  it('still delivers a low-stock push when expiry pushes are turned off', async () => {
    await rpc(pg, owner, 'save_push_subscription', {
      p_endpoint: 'https://push.example.com/low-stock',
      p_p256dh: 'p'.repeat(40),
      p_auth: 'a'.repeat(16),
      p_user_agent: 'test',
    });
    await pg.query(`update public.platform_features set enabled = false where key = 'expiry_push'`);
    await pg.query(`update public.notifications set push_status = 'skipped' where push_status in ('pending', 'sending')`);
    const { rows: inserted } = await pg.query<{ id: string; type: string }>(
      `insert into public.notifications (shop_id, user_id, type, title, push_status, push_next_at)
       values ($1, $2, 'expiry', 'Expiring soon', 'pending', now()),
              ($1, $2, 'low_stock', 'Low stock: Bread', 'pending', now())
       returning id, type`,
      [shop, owner.id]
    );
    const claimed = await rpc<{ notification_id: string }[]>(pg, 'service', 'claim_push_batch', {
      p_limit: 50,
      p_now: new Date(Date.now() + 60_000).toISOString(),
    });
    const claimedIds = new Set(claimed.map((row) => row.notification_id));
    const expiry = inserted.find((row) => row.type === 'expiry');
    const low = inserted.find((row) => row.type === 'low_stock');
    expect(claimedIds.has(expiry?.id ?? '')).toBe(false);
    expect(claimedIds.has(low?.id ?? '')).toBe(true);
    await pg.query(`update public.platform_features set enabled = true where key = 'expiry_push'`);
  });
});
