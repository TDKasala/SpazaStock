// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  addMember,
  adjust,
  auditRows,
  bootstrapSuperadmin,
  createDatabase,
  createShop,
  createUser,
  errorCode,
  grantAdmin,
  invite,
  newProduct,
  query,
  REASON,
  rpc,
  sell,
  stockIn,
  voidItem,
  type User,
} from './harness';

let pg: PGlite;
let root: User;
let support: User;
let owner: User;
let manager: User;
let staff: User;
let invitee: User;
let neighbour: User;
let shop: string;
let otherShop: string;
let product: string;
let batch: string;
let expiredBatch: string;
let saleItem: string;
let discrepancy: string;
let staffMemberId: string;
let inviteToken: string;

function setStatus(caller: User, status: 'active' | 'suspended', reason: string | null = REASON) {
  return rpc<{ ok: boolean; code?: string; unchanged?: boolean }>(pg, caller, 'admin_set_shop_status', {
    p_shop_id: shop,
    p_status: status,
    p_reason: reason,
  });
}

async function productCount(): Promise<number> {
  const { rows } = await pg.query<{ n: number }>('select count(*)::int as n from public.products where shop_id = $1', [shop]);
  return rows[0].n;
}

beforeAll(async () => {
  pg = await createDatabase();
  root = await createUser(pg);
  support = await createUser(pg);
  owner = await createUser(pg);
  manager = await createUser(pg);
  staff = await createUser(pg);
  invitee = await createUser(pg);
  neighbour = await createUser(pg);
  await bootstrapSuperadmin(pg, root);
  await grantAdmin(pg, root, support, 'support');

  shop = await createShop(pg, owner, 'Corner Spaza');
  otherShop = await createShop(pg, neighbour, 'Neighbour Spaza');
  await addMember(pg, owner, shop, manager, 'manager');
  staffMemberId = await addMember(pg, owner, shop, staff, 'staff');
  inviteToken = (await invite(pg, owner, shop, invitee.email)).token;

  product = (await newProduct(pg, owner, shop)).id;
  batch = (await stockIn(pg, owner, shop, product, 3)).batch.id;
  const sale = await sell(pg, staff, shop, [{ product_id: product, quantity: 5 }]);
  saleItem = sale.items[0].id;
  const { rows } = await pg.query<{ id: string }>('select id from public.stock_discrepancies where shop_id = $1', [shop]);
  discrepancy = rows[0].id;
  expiredBatch = (await stockIn(pg, owner, shop, product, 2, { expiry: '2020-01-01' })).batch.id;
  await pg.query('select private.generate_expiry_alerts()');
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('suspending a shop', () => {
  it('needs tenants.manage and a reason', async () => {
    expect(await setStatus(support, 'suspended')).toEqual({ ok: false, code: 'forbidden' });
    expect(await setStatus(owner, 'suspended')).toEqual({ ok: false, code: 'forbidden' });
    expect(await errorCode(setStatus(root, 'suspended', 'because'))).toBe('22023');
    expect(await errorCode(setStatus(root, 'closed' as 'active'))).toBe('22023');
    const [row] = await query<{ status: string }>(pg, owner, 'select status from public.shops where id = $1', [shop]);
    expect(row.status).toBe('active');
  });

  it('records who, why and when, and tells owners and managers', async () => {
    expect(await setStatus(root, 'suspended')).toMatchObject({ ok: true, unchanged: false });
    expect(await setStatus(root, 'suspended')).toMatchObject({ ok: true, unchanged: true });

    const { rows } = await pg.query<{ status: string; suspended_by: string; suspension_reason: string; suspended_at: string }>(
      'select status, suspended_by, suspension_reason, suspended_at from public.shops where id = $1',
      [shop]
    );
    expect(rows[0]).toMatchObject({ status: 'suspended', suspended_by: root.id, suspension_reason: REASON });
    expect(rows[0].suspended_at).not.toBeNull();

    const audit = await auditRows(pg, { actor: root, action: 'tenant.suspended' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ shop_id: shop, reason: REASON, details: { before: 'active', after: 'suspended' } });

    const notified = await pg.query<{ user_id: string; body: string }>(
      `select user_id, body from public.notifications where shop_id = $1 and type = 'system' and data->>'kind' = 'shop_status'`,
      [shop]
    );
    expect(notified.rows.map((r) => r.user_id).sort()).toEqual([owner.id, manager.id].sort());
    expect(notified.rows[0].body).toContain('Sign-in is refused');
  });

  it('hides who suspended the shop and why from shop members', async () => {
    expect(await errorCode(query(pg, owner, 'select suspension_reason from public.shops where id = $1', [shop]))).toBe('42501');
    expect(await errorCode(query(pg, owner, 'select suspended_by from public.shops where id = $1', [shop]))).toBe('42501');
  });

  it('rejects every write with SP001 and changes nothing', async () => {
    const before = await productCount();
    const writes: [string, () => Promise<unknown>][] = [
      ['upsert_product', () => newProduct(pg, owner, shop)],
      ['record_stock_in', () => stockIn(pg, owner, shop, product, 1)],
      ['record_sale', () => sell(pg, staff, shop, [{ product_id: product, quantity: 1 }])],
      ['void_sale_item', () => voidItem(pg, owner, shop, saleItem, 1)],
      ['record_stock_adjustment', () => adjust(pg, manager, shop, batch, -1)],
      [
        'update_product',
        () =>
          rpc(pg, owner, 'update_product', {
            p_shop_id: shop, p_product_id: product, p_barcode: 'X1', p_name: 'Renamed', p_category: 'other',
            p_buying_price: 1, p_selling_price: 2,
          }),
      ],
      ['set_product_archived', () => rpc(pg, owner, 'set_product_archived', { p_shop_id: shop, p_product_id: product, p_archived: true })],
      [
        'resolve_expired_batch',
        () =>
          rpc(pg, owner, 'resolve_expired_batch', {
            p_shop_id: shop, p_batch_id: expiredBatch, p_action: 'discarded', p_new_expiry_date: null,
            p_note: null, p_occurred_at: null, p_idempotency_key: randomUUID(),
          }),
      ],
      [
        'update_shop_alert_settings',
        () => rpc(pg, owner, 'update_shop_alert_settings', { p_shop_id: shop, p_reminder_days: '{3}', p_timezone: 'UTC' }),
      ],
      ['invite_shop_member', () => invite(pg, owner, shop, 'new@example.com')],
      ['accept_shop_invite', () => rpc(pg, invitee, 'accept_shop_invite', { p_token: inviteToken })],
      ['update_member_role', () => rpc(pg, owner, 'update_member_role', { p_member_id: staffMemberId, p_role: 'manager' })],
      [
        'products insert',
        () =>
          query(pg, owner, 'insert into public.products (id, shop_id, barcode, name) values ($1, $2, $3, $4)', [
            randomUUID(), shop, 'DIRECT1', 'Direct',
          ]),
      ],
      ['shops update', () => query(pg, owner, 'update public.shops set name = $1 where id = $2', ['Renamed', shop])],
      [
        'stock_discrepancies update',
        () => query(pg, owner, 'update public.stock_discrepancies set resolved_at = now() where id = $1', [discrepancy]),
      ],
    ];
    for (const [name, write] of writes) {
      expect(await errorCode(write()), name).toBe('SP001');
    }

    expect(await productCount()).toBe(before);
    const { rows } = await pg.query<{ name: string; resolved_at: string | null; role: string }>(
      `select s.name, d.resolved_at, m.role from public.shops s
       join public.stock_discrepancies d on d.shop_id = s.id
       join public.shop_members m on m.shop_id = s.id and m.id = $2
       where s.id = $1`,
      [shop, staffMemberId]
    );
    expect(rows[0]).toEqual({ name: 'Corner Spaza', resolved_at: null, role: 'staff' });
    const pending = await pg.query('select 1 from public.shop_members where shop_id = $1 and user_id = $2', [shop, invitee.id]);
    expect(pending.rows).toHaveLength(0);
  });

  it('keeps every read working', async () => {
    for (const table of ['products', 'stock_batches', 'sales', 'sale_items', 'stock_movements', 'stock_discrepancies', 'notifications']) {
      const rows = await query(pg, staff, `select 1 from public.${table} where shop_id = $1`, [shop]);
      if (table !== 'notifications') expect(rows.length, table).toBeGreaterThan(0);
    }
    const shops = await rpc<{ id: string; status: string }[]>(pg, staff, 'my_shops');
    expect(shops).toEqual([expect.objectContaining({ id: shop, status: 'suspended' })]);
    const team = await rpc<unknown[]>(pg, owner, 'list_shop_team', { p_shop_id: shop });
    expect(team.length).toBeGreaterThanOrEqual(3);
  });

  it('still accepts sync failure reports from members', async () => {
    const recorded = await rpc<number>(pg, staff, 'report_sync_failures', {
      p_shop_id: shop,
      p_reports: [{ op_type: 'record_sale', error_code: 'SP001', count: 2 }],
    });
    expect(recorded).toBe(1);
  });

  it('leaves other shops untouched', async () => {
    const created = await newProduct(pg, neighbour, otherShop);
    expect(created.id).toBeTruthy();
    const shops = await rpc<{ status: string }[]>(pg, neighbour, 'my_shops');
    expect(shops[0].status).toBe('active');
  });

  it('still lets the account that suspended the shop be deleted', async () => {
    const temporary = await createUser(pg);
    await grantAdmin(pg, root, temporary, 'superadmin');
    expect((await setStatus(temporary, 'active')).ok).toBe(true);
    expect((await setStatus(temporary, 'suspended')).ok).toBe(true);

    await pg.query('delete from auth.users where id = $1', [temporary.id]);
    const { rows } = await pg.query<{ status: string; suspended_by: string | null }>(
      'select status, suspended_by from public.shops where id = $1',
      [shop]
    );
    expect(rows[0]).toEqual({ status: 'suspended', suspended_by: null });
  });
});

describe('reactivating a shop', () => {
  it('restores writes and is recorded', async () => {
    expect(await setStatus(root, 'active')).toMatchObject({ ok: true, unchanged: false });
    const { rows } = await pg.query<{ suspended_at: string | null; suspension_reason: string | null }>(
      'select suspended_at, suspension_reason from public.shops where id = $1',
      [shop]
    );
    expect(rows[0]).toEqual({ suspended_at: null, suspension_reason: null });
    expect(await auditRows(pg, { actor: root, action: 'tenant.reactivated' })).toHaveLength(1);

    expect((await newProduct(pg, owner, shop)).id).toBeTruthy();
    expect((await sell(pg, staff, shop, [{ product_id: product, quantity: 1 }])).sale.id).toBeTruthy();
    await rpc(pg, invitee, 'accept_shop_invite', { p_token: inviteToken });
    const shops = await rpc<{ id: string; status: string }[]>(pg, invitee, 'my_shops');
    expect(shops).toEqual([expect.objectContaining({ id: shop, status: 'active' })]);
  });
});
