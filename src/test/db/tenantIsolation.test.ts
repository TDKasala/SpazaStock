// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  addMember,
  adjust,
  createDatabase,
  createShop,
  createUser,
  errorCode,
  newProduct,
  query,
  rpc,
  sell,
  stockIn,
  voidItem,
  type User,
} from './harness';

let pg: PGlite;
let alice: User; // account owner of shop A
let mandla: User; // manager of shop A
let sipho: User; // staff of shop A
let bob: User; // owner of shop B, a stranger to shop A
let shopA: string;
let shopB: string;
let productA: string;
let batchA: string;
let siphoMemberId: string;
let saleItemA: string;

const SHOP_TABLES = [
  'shop_members',
  'products',
  'stock_batches',
  'stock_movements',
  'sales',
  'sale_items',
  'stock_discrepancies',
  'notifications',
  'subscriptions',
  'sale_item_voids',
  'expiry_alerts',
  'expiry_resolutions',
];

async function count(user: User, sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await query<{ n: number }>(pg, user, `select count(*)::int as n from ${sql}`, params);
  return row.n;
}

beforeAll(async () => {
  pg = await createDatabase();
  alice = await createUser(pg, 'alice@example.com');
  mandla = await createUser(pg, 'mandla@example.com');
  sipho = await createUser(pg, 'sipho@example.com');
  bob = await createUser(pg, 'bob@example.com');

  shopA = await createShop(pg, alice, "Alice's Spaza");
  shopB = await createShop(pg, bob, "Bob's Spaza");
  await addMember(pg, alice, shopA, mandla, 'manager');
  siphoMemberId = await addMember(pg, alice, shopA, sipho, 'staff');

  // Give every shop-A table at least one row, including a discrepancy and notifications.
  productA = (await newProduct(pg, alice, shopA)).id;
  batchA = (await stockIn(pg, alice, shopA, productA, 3)).batch.id;
  const sale = await sell(pg, sipho, shopA, [{ product_id: productA, quantity: 5 }]);
  saleItemA = sale.items[0].id;
  await voidItem(pg, alice, shopA, saleItemA, 1);

  // An expired batch, its alert, and the record of throwing it away.
  const expired = await stockIn(pg, alice, shopA, productA, 2, { expiry: '2020-01-01' });
  await pg.query('select private.generate_expiry_alerts()');
  await rpc(pg, alice, 'resolve_expired_batch', {
    p_shop_id: shopA,
    p_batch_id: expired.batch.id,
    p_action: 'discarded',
    p_new_expiry_date: null,
    p_note: null,
    p_occurred_at: null,
    p_idempotency_key: randomUUID(),
  });
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('tenant isolation', () => {
  it('lets members see their shop data', async () => {
    expect(await count(alice, 'public.shops where id = $1', [shopA])).toBe(1);
    for (const table of SHOP_TABLES) {
      expect(await count(alice, `public.${table} where shop_id = $1`, [shopA]), table).toBeGreaterThan(0);
    }
  });

  it('shows a member of another shop none of shop A rows', async () => {
    expect(await count(bob, 'public.shops where id = $1', [shopA])).toBe(0);
    for (const table of SHOP_TABLES) {
      expect(await count(bob, `public.${table} where shop_id = $1`, [shopA]), table).toBe(0);
    }
    expect(await count(bob, 'public.profiles where id <> $1', [bob.id])).toBe(0);
  });

  it("rejects every function call on another member's shop", async () => {
    const calls = [
      () => newProduct(pg, bob, shopA),
      () => stockIn(pg, bob, shopA, productA, 1),
      () => sell(pg, bob, shopA, [{ product_id: productA, quantity: 1 }]),
      () => adjust(pg, bob, shopA, batchA, -1),
      () => voidItem(pg, bob, shopA, saleItemA, 1),
      () => rpc(pg, bob, 'invite_shop_member', { p_shop_id: shopA, p_email: 'x@example.com', p_role: 'staff' }),
      () => rpc(pg, bob, 'update_member_role', { p_member_id: siphoMemberId, p_role: 'owner' }),
      () => rpc(pg, bob, 'remove_shop_member', { p_member_id: siphoMemberId }),
      () => rpc(pg, bob, 'update_shop_alert_settings', { p_shop_id: shopA, p_reminder_days: '{7}', p_timezone: 'UTC' }),
      () =>
        rpc(pg, bob, 'resolve_expired_batch', {
          p_shop_id: shopA,
          p_batch_id: batchA,
          p_action: 'discarded',
          p_new_expiry_date: null,
          p_note: null,
          p_occurred_at: null,
          p_idempotency_key: randomUUID(),
        }),
    ];
    for (const call of calls) {
      expect(await errorCode(call())).toBe('42501');
    }
    expect(await count(alice, 'public.shop_members where id = $1 and role = $2', [siphoMemberId, 'staff'])).toBe(1);
  });

  it('gives anonymous callers no tables and no functions', async () => {
    for (const table of ['shops', 'profiles', ...SHOP_TABLES]) {
      expect(await errorCode(query(pg, null, `select 1 from public.${table}`)), table).toBe('42501');
    }
    expect(await errorCode(newProduct(pg, null, shopA))).toBe('42501');
    expect(await errorCode(sell(pg, null, shopA, [{ product_id: productA, quantity: 1 }]))).toBe('42501');
    expect(await errorCode(rpc(pg, null, 'accept_shop_invite', { p_token: 'x'.repeat(64) }))).toBe('42501');
    expect(await errorCode(rpc(pg, null, 'my_shops'))).toBe('42501');
    expect(await errorCode(rpc(pg, null, 'create_shop', { p_name: 'Anon' }))).toBe('42501');
    expect(await errorCode(voidItem(pg, null, shopA, saleItemA, 1))).toBe('42501');
  });

  it("does not let a stranger void another shop's sale by passing their own shop id", async () => {
    expect(await errorCode(voidItem(pg, bob, shopB, saleItemA, 1))).toBe('P0002');
  });

  it('stops a user creating a shop for someone else', async () => {
    const code = await errorCode(
      query(pg, bob, 'insert into public.shops (owner_id, name) values ($1, $2)', [alice.id, 'Fake'])
    );
    expect(code).toBe('42501');
    expect(await errorCode(query(pg, bob, 'insert into public.shops (name) values ($1)', ['Direct']))).toBe('42501');
  });
});

describe('roles inside a shop', () => {
  it('lets staff register products, receive stock and sell', async () => {
    const product = await newProduct(pg, sipho, shopA);
    const { duplicate } = await stockIn(pg, sipho, shopA, product.id, 4);
    expect(duplicate).toBe(false);
    const sale = await sell(pg, sipho, shopA, [{ product_id: product.id, quantity: 1 }]);
    expect(sale.shortfall).toBe(0);
  });

  it('keeps adjustments, invites, shop settings, prices and billing away from staff', async () => {
    expect(await errorCode(adjust(pg, sipho, shopA, batchA, 1))).toBe('42501');
    expect(
      await errorCode(rpc(pg, sipho, 'invite_shop_member', { p_shop_id: shopA, p_email: 'y@example.com', p_role: 'staff' }))
    ).toBe('42501');
    expect(await count(sipho, 'public.subscriptions')).toBe(0);

    await query(pg, sipho, 'update public.shops set name = $1 where id = $2', ['Hacked', shopA]);
    await query(pg, sipho, 'update public.products set selling_price = 0 where id = $1', [productA]);
    await query(pg, sipho, 'update public.stock_discrepancies set resolved_at = now() where shop_id = $1', [shopA]);
    const [shop] = await query<{ name: string }>(pg, alice, 'select name from public.shops where id = $1', [shopA]);
    const [product] = await query<{ selling_price: number }>(pg, alice, 'select selling_price from public.products where id = $1', [productA]);
    expect(shop.name).toBe("Alice's Spaza");
    expect(Number(product.selling_price)).toBe(18.5);
    expect(await count(alice, 'public.stock_discrepancies where resolved_at is not null')).toBe(0);
  });

  it('lets managers adjust stock and edit products but not manage members or billing', async () => {
    const result = await adjust(pg, mandla, shopA, batchA, 2, 'count_correction');
    expect(result.duplicate).toBe(false);
    await query(pg, mandla, 'update public.products set selling_price = 19 where id = $1', [productA]);
    const [product] = await query<{ selling_price: number }>(pg, alice, 'select selling_price from public.products where id = $1', [productA]);
    expect(Number(product.selling_price)).toBe(19);

    expect(
      await errorCode(rpc(pg, mandla, 'invite_shop_member', { p_shop_id: shopA, p_email: 'z@example.com', p_role: 'staff' }))
    ).toBe('42501');
    expect(await count(mandla, 'public.subscriptions')).toBe(0);
    expect(await count(alice, 'public.subscriptions where shop_id = $1', [shopA])).toBe(1);
  });

  it('denies direct writes to the stock ledger, even for the owner', async () => {
    const writes = [
      ['insert into public.stock_batches (id, shop_id, product_id, quantity, initial_quantity) values ($1, $2, $3, 5, 5)', [randomUUID(), shopA, productA]],
      ['update public.stock_batches set quantity = 999 where id = $1', [batchA]],
      ['delete from public.stock_batches where id = $1', [batchA]],
      ["insert into public.stock_movements (id, shop_id, product_id, reason, quantity_delta, resulting_total_quantity, idempotency_key) values ($1, $2, $3, 'adjustment', 5, 5, 'x')", [randomUUID(), shopA, productA]],
      ['update public.stock_movements set quantity_delta = 1', []],
      ["insert into public.sales (id, shop_id, idempotency_key, total_amount, item_count) values ($1, $2, 'k', 0, 1)", [randomUUID(), shopA]],
      ['delete from public.sales', []],
      ['update public.sale_items set quantity = 1', []],
      ['insert into public.stock_discrepancies (shop_id, product_id, shortfall) values ($1, $2, 1)', [shopA, productA]],
      ["insert into public.notifications (shop_id, user_id, type, title) values ($1, $2, 'system', 'x')", [shopA, alice.id]],
      ["update public.subscriptions set plan = 'pro'", []],
      ["insert into public.shop_members (shop_id, user_id, role) values ($1, $2, 'owner')", [shopA, bob.id]],
      ['delete from public.products where id = $1', [productA]],
      ['update public.expiry_alerts set resolved_at = null, resolution = null', []],
      ['delete from public.expiry_resolutions', []],
      ["update public.shops set expiry_reminder_days = '{1}' where id = $1", [shopA]],
    ] as const;
    for (const [sql, params] of writes) {
      expect(await errorCode(query(pg, alice, sql, [...params])), sql).toBe('42501');
    }
  });

  it('lets staff undo only their own recent sales; owners and managers can undo any', async () => {
    const product = await newProduct(pg, alice, shopA);
    await stockIn(pg, alice, shopA, product.id, 20);
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

    const own = await sell(pg, sipho, shopA, [{ product_id: product.id, quantity: 2 }]);
    expect((await voidItem(pg, sipho, shopA, own.items[0].id, 1)).duplicate).toBe(false);

    const byOwner = await sell(pg, alice, shopA, [{ product_id: product.id, quantity: 2 }]);
    expect(await errorCode(voidItem(pg, sipho, shopA, byOwner.items[0].id, 1))).toBe('42501');

    const old = await sell(pg, sipho, shopA, [{ product_id: product.id, quantity: 2 }], { soldAt: minutesAgo(30) });
    expect(await errorCode(voidItem(pg, sipho, shopA, old.items[0].id, 1))).toBe('42501');
    expect(await errorCode(
      voidItem(pg, sipho, shopA, own.items[0].id, 1, { occurredAt: new Date(Date.now() + 10 * 60_000) })
    )).toBe('42501');

    expect((await voidItem(pg, mandla, shopA, old.items[0].id, 1)).duplicate).toBe(false);
    expect((await voidItem(pg, alice, shopA, byOwner.items[0].id, 2)).item.voided_quantity).toBe(2);
  });

  it('denies direct writes to sale voids', async () => {
    const writes = [
      ["insert into public.sale_item_voids (shop_id, sale_id, sale_item_id, quantity, idempotency_key) values ($1, $2, $2, 1, 'x')", [shopA, saleItemA]],
      ['update public.sale_item_voids set quantity = 99', []],
      ['delete from public.sale_item_voids', []],
      ['update public.sale_items set voided_quantity = 0', []],
    ] as const;
    for (const [sql, params] of writes) {
      expect(await errorCode(query(pg, alice, sql, [...params])), sql).toBe('42501');
    }
  });

  it('lets only the service role change a subscription', async () => {
    await query(pg, 'service', "update public.subscriptions set plan = 'pro', status = 'active' where shop_id = $1", [shopA]);
    const [sub] = await query<{ plan: string }>(pg, alice, 'select plan from public.subscriptions where shop_id = $1', [shopA]);
    expect(sub.plan).toBe('pro');
  });
});

describe('notifications', () => {
  it('reach owners and managers only, and only the recipient can mark them read', async () => {
    expect(await count(alice, 'public.notifications')).toBeGreaterThan(0);
    expect(await count(mandla, 'public.notifications')).toBeGreaterThan(0);
    expect(await count(sipho, 'public.notifications')).toBe(0);

    await query(pg, mandla, 'update public.notifications set read_at = now()');
    expect(await count(alice, 'public.notifications where read_at is not null')).toBe(0);
    await query(pg, alice, 'update public.notifications set read_at = now()');
    expect(await count(alice, 'public.notifications where read_at is null')).toBe(0);
  });
});

describe('invites and membership', () => {
  it('can only be claimed by the invited email address', async () => {
    const thandi = await createUser(pg, 'thandi@example.com');
    const { token } = await rpc<{ token: string }>(pg, alice, 'invite_shop_member', {
      p_shop_id: shopA,
      p_email: '  Thandi@Example.com ',
      p_role: 'staff',
    });

    expect(await errorCode(rpc(pg, bob, 'accept_shop_invite', { p_token: token }))).toBe('SS003');
    expect(await count(bob, 'public.shops where id = $1', [shopA])).toBe(0);

    await rpc(pg, thandi, 'accept_shop_invite', { p_token: token });
    expect(await count(thandi, 'public.shops where id = $1', [shopA])).toBe(1);
    expect(await errorCode(rpc(pg, thandi, 'accept_shop_invite', { p_token: token }))).toBe('SS001');
  });

  it('never leaves a shop without its account owner', async () => {
    const zola = await createUser(pg, 'zola@example.com');
    const zolaId = await addMember(pg, alice, shopA, zola, 'owner');
    const [aliceMember] = await query<{ id: string }>(
      pg,
      alice,
      'select id from public.shop_members where shop_id = $1 and user_id = $2',
      [shopA, alice.id]
    );

    expect(await errorCode(rpc(pg, zola, 'remove_shop_member', { p_member_id: aliceMember.id }))).toBe('22023');
    expect(await errorCode(rpc(pg, zola, 'update_member_role', { p_member_id: aliceMember.id, p_role: 'staff' }))).toBe('22023');
    expect(await errorCode(rpc(pg, alice, 'remove_shop_member', { p_member_id: aliceMember.id }))).toBe('22023');

    await rpc(pg, alice, 'update_member_role', { p_member_id: zolaId, p_role: 'staff' });
    await rpc(pg, zola, 'remove_shop_member', { p_member_id: zolaId });
    expect(await count(zola, 'public.shops where id = $1', [shopA])).toBe(0);
  });

  it('shows profiles only to co-members and lets users edit only their own', async () => {
    expect(await count(sipho, 'public.profiles where id = $1', [alice.id])).toBe(1);
    expect(await count(bob, 'public.profiles where id = $1', [alice.id])).toBe(0);

    await query(pg, bob, "update public.profiles set display_name = 'Bob'");
    await query(pg, bob, "update public.profiles set display_name = 'Owned' where id = $1", [alice.id]);
    const [bobProfile] = await query<{ display_name: string }>(pg, bob, 'select display_name from public.profiles where id = $1', [bob.id]);
    const [aliceProfile] = await query<{ display_name: string | null }>(pg, alice, 'select display_name from public.profiles where id = $1', [alice.id]);
    expect(bobProfile.display_name).toBe('Bob');
    expect(aliceProfile.display_name).toBeNull();
  });

  it('gives a new shop an owner membership and a free subscription', async () => {
    const [member] = await query<{ role: string }>(pg, bob, 'select role from public.shop_members where shop_id = $1', [shopB]);
    const [sub] = await query<{ plan: string; status: string }>(pg, bob, 'select plan, status from public.subscriptions where shop_id = $1', [shopB]);
    expect(member.role).toBe('owner');
    expect(sub).toEqual({ plan: 'free', status: 'active' });
  });
});
