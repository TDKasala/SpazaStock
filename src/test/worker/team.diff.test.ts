// @vitest-environment node
/** The ported shop and team functions (worker/d1/team.ts) must match Postgres. See d1diff.ts. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createD1Pair, type D1Pair } from './d1diff';
import { createShop, createUser, addMember, invite, type User } from '../db/harness';

let p: D1Pair;
let owner: User;
let manager: User;
let staff: User;
let outsider: User;
let joiner: User;
let shopId: string;

beforeAll(async () => {
  p = await createD1Pair();
  owner = await createUser(p.pg, 'owner@example.com', { displayName: 'Owner' });
  manager = await createUser(p.pg, 'manager@example.com');
  staff = await createUser(p.pg, 'staff@example.com');
  outsider = await createUser(p.pg, 'outsider@example.com');
  joiner = await createUser(p.pg, 'joiner@example.com');
  shopId = await createShop(p.pg, owner, 'Team shop');
  await addMember(p.pg, owner, shopId, manager, 'manager');
  await addMember(p.pg, owner, shopId, staff, 'staff');
}, 60_000);

afterAll(async () => {
  await p?.close();
});

async function same(user: User | null, fn: string, args: Record<string, unknown> = {}) {
  const r = await p.call(user, fn, args);
  expect(r.d1, `${fn} ${JSON.stringify(args)}`).toEqual(r.pg);
  for (const table of Object.keys(r.tables.pg)) expect(r.tables.d1[table], `${fn}: ${table}`).toEqual(r.tables.pg[table]);
  return r;
}

describe('shops', () => {
  it('creates shops and lists them the same way', async () => {
    await same(outsider, 'create_shop', { p_name: ' Corner Shop ', p_phone: '082 123 4567', p_address: ' 12  Main   Rd ', p_city: 'Soweto', p_province: 'gp', p_latitude: -26.2678912345, p_longitude: 27.858 });
    await same(outsider, 'create_shop', { p_name: '' });
    await same(outsider, 'create_shop', { p_name: 'X', p_phone: '123' });
    await same(outsider, 'create_shop', { p_name: 'X', p_province: 'ZZ' });
    await same(outsider, 'create_shop', { p_name: 'X', p_latitude: 1 });
    await same(owner, 'my_shops');
    await same(staff, 'my_shops');
  });

  it('updates alert settings the same way', async () => {
    await same(manager, 'update_shop_alert_settings', { p_shop_id: shopId, p_reminder_days: [7, 30, 7, 1], p_timezone: 'Africa/Johannesburg' });
    await same(manager, 'update_shop_alert_settings', { p_shop_id: shopId, p_reminder_days: [0], p_timezone: 'Africa/Johannesburg' });
    await same(manager, 'update_shop_alert_settings', { p_shop_id: shopId, p_reminder_days: [1, 2, 3, 4, 5, 6], p_timezone: 'Africa/Johannesburg' });
    await same(manager, 'update_shop_alert_settings', { p_shop_id: shopId, p_reminder_days: [3], p_timezone: 'Mars/Olympus' });
    await same(staff, 'update_shop_alert_settings', { p_shop_id: shopId, p_reminder_days: [3], p_timezone: 'Africa/Johannesburg' });
  });
});

describe('team', () => {
  it('invites, previews, accepts, resends and lists the same way', async () => {
    await same(owner, 'list_shop_team', { p_shop_id: shopId });
    await same(staff, 'list_shop_team', { p_shop_id: shopId });
    await same(owner, 'invite_shop_member', { p_shop_id: shopId, p_email: ' Joiner@Example.com ', p_role: 'staff' });
    await same(owner, 'invite_shop_member', { p_shop_id: shopId, p_email: 'staff@example.com', p_role: 'staff' });
    await same(owner, 'invite_shop_member', { p_shop_id: shopId, p_email: 'nope', p_role: 'staff' });
    await same(owner, 'invite_shop_member', { p_shop_id: shopId, p_email: 'x@example.com', p_role: 'owner' });
    await same(staff, 'invite_shop_member', { p_shop_id: shopId, p_email: 'y@example.com', p_role: 'staff' });

    // An invite made on the Postgres side is mirrored before each call, so its token works on both.
    const inv = await invite(p.pg, owner, shopId, 'joiner@example.com', 'manager');
    await same(null, 'preview_shop_invite', { p_token: inv.token });
    await same(null, 'preview_shop_invite', { p_token: 'short' });
    await same(outsider, 'accept_shop_invite', { p_token: inv.token });
    await same(joiner, 'accept_shop_invite', { p_token: 'x'.repeat(40) });
    await same(owner, 'resend_shop_invite', { p_member_id: inv.member_id });
    await same(joiner, 'accept_shop_invite', { p_token: inv.token });
    await same(owner, 'list_shop_team', { p_shop_id: shopId });
  });

  it('changes roles, deactivates and removes members the same way', async () => {
    const { rows } = await p.pg.query<{ id: string; user_id: string }>('select id, user_id from public.shop_members where shop_id = $1', [shopId]);
    const memberOf = (u: User) => rows.find((r) => r.user_id === u.id)!.id;
    await same(owner, 'update_member_role', { p_member_id: memberOf(staff), p_role: 'manager' });
    await same(owner, 'update_member_role', { p_member_id: memberOf(owner), p_role: 'staff' });
    await same(owner, 'update_member_role', { p_member_id: memberOf(manager), p_role: 'king' });
    await same(staff, 'update_member_role', { p_member_id: memberOf(manager), p_role: 'staff' });
    await same(owner, 'set_member_status', { p_member_id: memberOf(manager), p_status: 'deactivated' });
    await same(owner, 'set_member_status', { p_member_id: memberOf(manager), p_status: 'deactivated' });
    await same(owner, 'set_member_status', { p_member_id: memberOf(owner), p_status: 'deactivated' });
    await same(owner, 'remove_shop_member', { p_member_id: memberOf(owner) });
    await same(staff, 'remove_shop_member', { p_member_id: memberOf(staff) });
    await same(owner, 'remove_shop_member', { p_member_id: '00000000-0000-4000-8000-000000000000' });
  });
});
