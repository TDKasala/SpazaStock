// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  addMember,
  createDatabase,
  createShop,
  createUser,
  errorCode,
  invite,
  newProduct,
  query,
  rpc,
  sell,
  stockIn,
  type User,
} from './harness';
import { ROLE_PERMISSIONS } from '../../lib/permissions';

let pg: PGlite;
let owner: User;
let shop: string;
let otherShop: string;
let otherOwner: User;

interface TeamMember {
  member_id: string;
  user_id: string | null;
  email: string;
  display_name: string | null;
  role: string;
  status: string;
  is_account_owner: boolean;
  is_you: boolean;
}

async function team(caller: User, shopId = shop): Promise<TeamMember[]> {
  return rpc<TeamMember[]>(pg, caller, 'list_shop_team', { p_shop_id: shopId });
}

async function events(shopId = shop): Promise<Array<{ action: string; target_email: string | null; actor_id: string | null }>> {
  const { rows } = await pg.query<{ action: string; target_email: string | null; actor_id: string | null }>(
    'select action, target_email, actor_id from public.membership_events where shop_id = $1 order by created_at, id',
    [shopId]
  );
  return rows;
}

async function canSee(user: User, shopId: string): Promise<boolean> {
  const [row] = await query<{ n: number }>(pg, user, 'select count(*)::int as n from public.shops where id = $1', [shopId]);
  return row.n === 1;
}

beforeAll(async () => {
  pg = await createDatabase();
  owner = await createUser(pg, 'owner@example.com', { displayName: '  Nomsa Dlamini ' });
  otherOwner = await createUser(pg, 'other@example.com');
  shop = await createShop(pg, owner, 'Nomsa Spaza');
  otherShop = await createShop(pg, otherOwner, 'Other Spaza');
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('registration and shops', () => {
  it('copies the registration name into the profile', async () => {
    const [profile] = await query<{ display_name: string }>(pg, owner, 'select display_name from public.profiles where id = $1', [owner.id]);
    expect(profile.display_name).toBe('Nomsa Dlamini');
  });

  it('makes the caller the account owner of a new shop, whatever they send', async () => {
    const created = await rpc<{ id: string; role: string; is_account_owner: boolean }>(pg, otherOwner, 'create_shop', {
      p_name: '  Second shop  ',
    });
    expect(created).toMatchObject({ role: 'owner', is_account_owner: true });
    const [row] = await query<{ owner_id: string; name: string }>(pg, otherOwner, 'select owner_id, name from public.shops where id = $1', [created.id]);
    expect(row).toEqual({ owner_id: otherOwner.id, name: 'Second shop' });
    expect(await errorCode(rpc(pg, otherOwner, 'create_shop', { p_name: '   ' }))).toBe('22023');
  });

  it('lists only the shops the caller is an active member of', async () => {
    const mine = await rpc<Array<{ id: string; role: string }>>(pg, otherOwner, 'my_shops');
    expect(mine.map((s) => s.id)).toContain(otherShop);
    expect(mine.map((s) => s.id)).not.toContain(shop);
    expect(mine.every((s) => s.role === 'owner')).toBe(true);
  });
});

describe('invitations', () => {
  it('issues a single-use token that only the invited, confirmed email can accept', async () => {
    const worker = await createUser(pg, 'worker1@example.com');
    const stranger = await createUser(pg, 'stranger@example.com');
    const sent = await invite(pg, owner, shop, ' Worker1@Example.com ', 'staff');
    expect(sent.token).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.email).toBe('worker1@example.com');

    // The raw token is never stored.
    const { rows } = await pg.query<{ invite_token_hash: string }>(
      'select invite_token_hash from public.shop_members where id = $1',
      [sent.member_id]
    );
    expect(rows[0].invite_token_hash).not.toBe(sent.token);
    expect(rows[0].invite_token_hash).toHaveLength(64);

    const preview = await rpc<{ shop_name: string; role: string; email: string; invited_by: string; expired: boolean }>(
      pg,
      null,
      'preview_shop_invite',
      { p_token: sent.token }
    );
    expect(preview).toMatchObject({
      shop_name: 'Nomsa Spaza',
      role: 'staff',
      email: 'worker1@example.com',
      invited_by: 'Nomsa Dlamini',
      expired: false,
    });

    expect(await errorCode(rpc(pg, stranger, 'accept_shop_invite', { p_token: sent.token }))).toBe('SS003');
    const joined = await rpc<{ shop_id: string; role: string }>(pg, worker, 'accept_shop_invite', { p_token: sent.token });
    expect(joined).toMatchObject({ shop_id: shop, role: 'staff' });
    expect(await canSee(worker, shop)).toBe(true);
    expect(await canSee(stranger, shop)).toBe(false);

    expect(await errorCode(rpc(pg, worker, 'accept_shop_invite', { p_token: sent.token }))).toBe('SS001');
    expect(await rpc(pg, null, 'preview_shop_invite', { p_token: sent.token })).toBeNull();
  });

  it('rejects unknown, malformed, expired and unconfirmed-email acceptances', async () => {
    const late = await createUser(pg, 'late@example.com');
    const unconfirmed = await createUser(pg, 'unconfirmed@example.com', { unconfirmed: true });

    expect(await errorCode(rpc(pg, late, 'accept_shop_invite', { p_token: 'f'.repeat(64) }))).toBe('SS001');
    expect(await errorCode(rpc(pg, late, 'accept_shop_invite', { p_token: 'short' }))).toBe('SS001');
    expect(await rpc(pg, null, 'preview_shop_invite', { p_token: 'f'.repeat(64) })).toBeNull();

    const expired = await invite(pg, owner, shop, late.email);
    await pg.query("update public.shop_members set invite_expires_at = now() - interval '1 minute' where id = $1", [expired.member_id]);
    expect(await errorCode(rpc(pg, late, 'accept_shop_invite', { p_token: expired.token }))).toBe('SS002');
    expect((await rpc<{ expired: boolean }>(pg, null, 'preview_shop_invite', { p_token: expired.token })).expired).toBe(true);
    expect((await team(owner)).find((m) => m.member_id === expired.member_id)?.status).toBe('expired');

    const pending = await invite(pg, owner, shop, unconfirmed.email);
    expect(await errorCode(rpc(pg, unconfirmed, 'accept_shop_invite', { p_token: pending.token }))).toBe('SS004');
    expect(await canSee(unconfirmed, shop)).toBe(false);
  });

  it('invalidates the old link when an invite is resent', async () => {
    const thabo = await createUser(pg, 'thabo@example.com');
    const first = await invite(pg, owner, shop, thabo.email);
    const resent = await rpc<{ token: string; member_id: string }>(pg, owner, 'resend_shop_invite', { p_member_id: first.member_id });
    expect(resent.member_id).toBe(first.member_id);
    expect(resent.token).not.toBe(first.token);

    expect(await errorCode(rpc(pg, thabo, 'accept_shop_invite', { p_token: first.token }))).toBe('SS001');
    await rpc(pg, thabo, 'accept_shop_invite', { p_token: resent.token });
    expect(await canSee(thabo, shop)).toBe(true);
    expect(await errorCode(rpc(pg, owner, 'resend_shop_invite', { p_member_id: first.member_id }))).toBe('22023');
  });

  it('prevents duplicate memberships and owner invites', async () => {
    const lerato = await createUser(pg, 'lerato@example.com');
    await addMember(pg, owner, shop, lerato, 'staff');
    expect(await errorCode(invite(pg, owner, shop, 'LERATO@example.com'))).toBe('23505');
    expect(await errorCode(invite(pg, owner, shop, owner.email))).toBe('23505');
    expect(
      await errorCode(rpc(pg, owner, 'invite_shop_member', { p_shop_id: shop, p_email: 'boss@example.com', p_role: 'owner' }))
    ).toBe('22023');
    expect(await errorCode(invite(pg, owner, shop, 'not-an-email'))).toBe('22023');

    // Re-inviting the same pending email keeps one row.
    const a = await invite(pg, owner, shop, 'twice@example.com');
    const b = await invite(pg, owner, shop, 'twice@example.com', 'manager');
    expect(b.member_id).toBe(a.member_id);
    expect(b.role).toBe('manager');
  });

  it('can be revoked before it is used', async () => {
    const zanele = await createUser(pg, 'zanele@example.com');
    const sent = await invite(pg, owner, shop, zanele.email);
    await rpc(pg, owner, 'remove_shop_member', { p_member_id: sent.member_id });
    expect(await errorCode(rpc(pg, zanele, 'accept_shop_invite', { p_token: sent.token }))).toBe('SS001');
  });
});

describe('permissions', () => {
  let manager: User;
  let worker: User;
  let managerId: string;
  let workerId: string;

  beforeAll(async () => {
    manager = await createUser(pg, 'manager@example.com');
    worker = await createUser(pg, 'worker@example.com');
    managerId = await addMember(pg, owner, shop, manager, 'manager');
    workerId = await addMember(pg, owner, shop, worker, 'staff');
  });

  it('keeps team management away from managers and workers', async () => {
    const others: Array<[User, string]> = [
      [manager, workerId],
      [worker, managerId],
    ];
    for (const [caller, otherId] of others) {
      expect(await errorCode(invite(pg, caller, shop, 'new@example.com'))).toBe('42501');
      expect(await errorCode(rpc(pg, caller, 'list_shop_team', { p_shop_id: shop }))).toBe('42501');
      expect(await errorCode(rpc(pg, caller, 'update_member_role', { p_member_id: otherId, p_role: 'owner' }))).toBe('42501');
      expect(await errorCode(rpc(pg, caller, 'set_member_status', { p_member_id: otherId, p_status: 'deactivated' }))).toBe('42501');
      expect(await errorCode(rpc(pg, caller, 'remove_shop_member', { p_member_id: otherId }))).toBe('42501');
    }
  });

  it('stops anyone changing their own role or access, and protects the account owner', async () => {
    const [own] = await query<{ id: string }>(pg, owner, 'select id from public.shop_members where shop_id = $1 and user_id = $2', [shop, owner.id]);
    const [workerRow] = await query<{ id: string }>(pg, worker, 'select id from public.shop_members where shop_id = $1 and user_id = $2', [shop, worker.id]);
    expect(await errorCode(rpc(pg, worker, 'update_member_role', { p_member_id: workerRow.id, p_role: 'owner' }))).toBe('42501');
    expect(await errorCode(rpc(pg, owner, 'update_member_role', { p_member_id: own.id, p_role: 'staff' }))).toBe('22023');
    expect(await errorCode(rpc(pg, owner, 'set_member_status', { p_member_id: own.id, p_status: 'deactivated' }))).toBe('22023');

    const coOwner = await createUser(pg, 'coowner@example.com');
    const coOwnerId = await addMember(pg, owner, shop, coOwner, 'owner');
    expect(await errorCode(rpc(pg, coOwner, 'set_member_status', { p_member_id: own.id, p_status: 'deactivated' }))).toBe('22023');
    expect(await errorCode(rpc(pg, coOwner, 'update_member_role', { p_member_id: own.id, p_role: 'manager' }))).toBe('22023');
    await rpc(pg, owner, 'remove_shop_member', { p_member_id: coOwnerId });
  });

  it('shows workers only their own membership row and never the token hash', async () => {
    const rows = await query<{ user_id: string }>(pg, worker, 'select user_id from public.shop_members where shop_id = $1', [shop]);
    expect(rows).toEqual([{ user_id: worker.id }]);
    expect(await errorCode(query(pg, owner, 'select invite_token_hash from public.shop_members'))).toBe('42501');
    expect(await errorCode(query(pg, worker, 'select * from public.membership_events'))).toBeUndefined();
    expect(await query(pg, worker, 'select * from public.membership_events')).toEqual([]);
  });

  it('lists the team with names, emails, roles and statuses for the owner', async () => {
    const members = await team(owner);
    const me = members.find((m) => m.is_you);
    expect(me).toMatchObject({ role: 'owner', is_account_owner: true, status: 'active', display_name: 'Nomsa Dlamini' });
    expect(members.find((m) => m.user_id === worker.id)).toMatchObject({ email: 'worker@example.com', role: 'staff', status: 'active' });
    expect(members.some((m) => m.status === 'invited')).toBe(true);
    expect(await errorCode(rpc(pg, otherOwner, 'list_shop_team', { p_shop_id: shop }))).toBe('42501');
  });

  it('matches the permission matrix in src/lib/permissions.ts', async () => {
    const { rows } = await pg.query<{ role: string; permission: string }>(
      'select role, permission from private.role_permissions order by role, permission'
    );
    const fromDb = new Map<string, string[]>();
    for (const row of rows) fromDb.set(row.role, [...(fromDb.get(row.role) ?? []), row.permission]);
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      expect([...permissions].sort(), role).toEqual((fromDb.get(role) ?? []).sort());
    }
  });
});

describe('deactivation and removal', () => {
  it('cuts off a deactivated member immediately and restores them on reactivation', async () => {
    const worker = await createUser(pg, 'deactivate-me@example.com');
    const memberId = await addMember(pg, owner, shop, worker, 'staff');
    const product = await newProduct(pg, owner, shop);
    await stockIn(pg, owner, shop, product.id, 10);
    expect(await canSee(worker, shop)).toBe(true);

    await rpc(pg, owner, 'set_member_status', { p_member_id: memberId, p_status: 'deactivated' });
    expect(await canSee(worker, shop)).toBe(false);
    const [products] = await query<{ n: number }>(pg, worker, 'select count(*)::int as n from public.products where shop_id = $1', [shop]);
    expect(products.n).toBe(0);
    expect(await errorCode(newProduct(pg, worker, shop))).toBe('42501');
    expect(await errorCode(stockIn(pg, worker, shop, product.id, 1))).toBe('42501');
    expect(await errorCode(sell(pg, worker, shop, [{ product_id: product.id, quantity: 1 }]))).toBe('42501');
    expect(await rpc(pg, worker, 'my_shops')).toEqual([]);
    // Their own row stays visible, so the app can say why access ended.
    const [own] = await query<{ status: string }>(pg, worker, 'select status from public.shop_members where id = $1', [memberId]);
    expect(own.status).toBe('deactivated');
    expect(await errorCode(rpc(pg, owner, 'update_member_role', { p_member_id: memberId, p_role: 'manager' }))).toBe('22023');

    await rpc(pg, owner, 'set_member_status', { p_member_id: memberId, p_status: 'active' });
    expect(await canSee(worker, shop)).toBe(true);
    const sale = await sell(pg, worker, shop, [{ product_id: product.id, quantity: 1 }]);
    expect(sale.shortfall).toBe(0);
  });

  it('stops notifications and queued pushes for deactivated managers', async () => {
    const manager = await createUser(pg, 'notify-manager@example.com');
    const memberId = await addMember(pg, owner, shop, manager, 'manager');
    await pg.query(
      "insert into public.notifications (shop_id, user_id, type, title, push_status, push_next_at) values ($1, $2, 'expiry', 'Queued', 'pending', now())",
      [shop, manager.id]
    );
    await rpc(pg, owner, 'set_member_status', { p_member_id: memberId, p_status: 'deactivated' });

    const { rows: queued } = await pg.query<{ push_status: string }>(
      'select push_status from public.notifications where user_id = $1',
      [manager.id]
    );
    expect(queued.map((r) => r.push_status)).toEqual(['skipped']);

    await pg.query(
      "insert into public.notifications (shop_id, user_id, type, title) values ($1, $2, 'system', 'Dropped')",
      [shop, manager.id]
    );
    const { rows } = await pg.query<{ n: number }>('select count(*)::int as n from public.notifications where user_id = $1', [manager.id]);
    expect(rows[0].n).toBe(1);
  });

  it('removes access when a member is removed or leaves', async () => {
    const worker = await createUser(pg, 'remove-me@example.com');
    const memberId = await addMember(pg, owner, shop, worker, 'staff');
    await rpc(pg, owner, 'remove_shop_member', { p_member_id: memberId });
    expect(await canSee(worker, shop)).toBe(false);
    expect(await errorCode(newProduct(pg, worker, shop))).toBe('42501');

    const leaver = await createUser(pg, 'leaver@example.com');
    const leaverId = await addMember(pg, owner, shop, leaver, 'staff');
    await rpc(pg, leaver, 'remove_shop_member', { p_member_id: leaverId });
    expect(await canSee(leaver, shop)).toBe(false);
  });
});

describe('several shops', () => {
  it('keeps a person who works in two shops scoped to the right data and role in each', async () => {
    const both = await createUser(pg, 'both@example.com');
    await addMember(pg, owner, shop, both, 'staff');
    await addMember(pg, otherOwner, otherShop, both, 'manager');

    const shops = await rpc<Array<{ id: string; role: string }>>(pg, both, 'my_shops');
    expect(new Map(shops.map((s) => [s.id, s.role]))).toEqual(
      new Map([
        [shop, 'staff'],
        [otherShop, 'manager'],
      ])
    );

    const product = await newProduct(pg, otherOwner, otherShop);
    const batch = await stockIn(pg, otherOwner, otherShop, product.id, 5);
    // Manager in the other shop may adjust there, but is only staff here.
    expect(
      await errorCode(
        rpc(pg, both, 'record_stock_adjustment', {
          p_shop_id: otherShop,
          p_batch_id: batch.batch.id,
          p_quantity_delta: -1,
          p_reason: 'count_correction',
          p_occurred_at: new Date().toISOString(),
          p_idempotency_key: 'two-shops-adjust',
        })
      )
    ).toBeUndefined();
    const here = await newProduct(pg, owner, shop);
    const hereBatch = await stockIn(pg, owner, shop, here.id, 5);
    expect(
      await errorCode(
        rpc(pg, both, 'record_stock_adjustment', {
          p_shop_id: shop,
          p_batch_id: hereBatch.batch.id,
          p_quantity_delta: -1,
          p_reason: 'count_correction',
          p_occurred_at: new Date().toISOString(),
          p_idempotency_key: 'two-shops-adjust-2',
        })
      )
    ).toBe('42501');

    // A batch from one shop cannot be used through the other shop's id.
    expect(await errorCode(stockIn(pg, both, shop, product.id, 1))).not.toBeUndefined();
    expect(await errorCode(rpc(pg, both, 'list_shop_team', { p_shop_id: otherShop }))).toBe('42501');
  });
});

describe('audit trail', () => {
  it('records invites, joins, role changes, deactivation and removal with the actor', async () => {
    const audited = await createUser(pg, 'audited@example.com');
    const sent = await invite(pg, owner, shop, audited.email);
    await rpc(pg, owner, 'resend_shop_invite', { p_member_id: sent.member_id }).then((r) =>
      rpc(pg, audited, 'accept_shop_invite', { p_token: (r as { token: string }).token })
    );
    await rpc(pg, owner, 'update_member_role', { p_member_id: sent.member_id, p_role: 'manager' });
    await rpc(pg, owner, 'set_member_status', { p_member_id: sent.member_id, p_status: 'deactivated' });
    await rpc(pg, owner, 'set_member_status', { p_member_id: sent.member_id, p_status: 'active' });
    await rpc(pg, owner, 'remove_shop_member', { p_member_id: sent.member_id });

    const trail = (await events()).filter((e) => e.target_email === 'audited@example.com');
    expect(trail.map((e) => e.action)).toEqual([
      'invited',
      'invite_resent',
      'joined',
      'role_changed',
      'deactivated',
      'reactivated',
      'removed',
    ]);
    expect(trail.find((e) => e.action === 'joined')?.actor_id).toBe(audited.id);
    expect(trail.filter((e) => e.action !== 'joined').every((e) => e.actor_id === owner.id)).toBe(true);

    const visible = await query<{ action: string }>(pg, owner, 'select action from public.membership_events where shop_id = $1', [shop]);
    expect(visible.length).toBeGreaterThan(0);
    expect(await query(pg, otherOwner, 'select 1 from public.membership_events where shop_id = $1', [shop])).toEqual([]);
    expect(await errorCode(query(pg, owner, "insert into public.membership_events (shop_id, member_id, action) values ($1, $1, 'removed')", [shop]))).toBe('42501');
    expect(await errorCode(query(pg, owner, 'delete from public.membership_events'))).toBe('42501');
  });
});
