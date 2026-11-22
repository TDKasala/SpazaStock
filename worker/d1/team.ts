/**
 * Shops, membership and invites in D1, ported from the Postgres functions of the same names.
 * The triggers that wrote history (log_membership_event, log_subscription_event, handle_new_shop)
 * become rows written in the same D1 batch as the change they describe.
 */
import { all, batch, first, type D1Like } from '../db/d1';
import { DbError, conflict, forbidden, invalid, planLimit } from '../db/errors';
import { toApiRow, type ApiRow } from '../db/rows';
import { sha256Hex } from './hash';
import {
  addDays,
  assertPermission,
  assertShopRole,
  entitlementLimit,
  isValidTimeZone,
  membership,
  shopEntitlements,
  shopIsActive,
  userEmail,
  uuidArg,
  type D1Ctx,
  type Stmt,
} from './common';

type Args = Record<string, unknown>;
type MemberRow = {
  id: string;
  shop_id: string;
  user_id: string | null;
  invited_email: string | null;
  role: string;
  status: string;
  invite_token_hash: string | null;
};

const PROVINCES = ['EC', 'FS', 'GP', 'KZN', 'LP', 'MP', 'NC', 'NW', 'WC'];

/** private.shop_contact: phone numbers normalised to +27…, blank fields cleared. */
export function shopContact(phone: unknown, address: unknown, city: unknown, province: unknown) {
  let p: string | null = String(phone ?? '').replace(/[\s().-]/g, '');
  const squash = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim() || null;
  const addr = squash(address);
  const town = squash(city);
  const prov = String(province ?? '').trim().toUpperCase() || null;
  if (p === '') p = null;
  else if (/^0[0-9]{9}$/.test(p)) p = `+27${p.slice(1)}`;
  else if (/^27[0-9]{9}$/.test(p)) p = `+${p}`;
  else if (/^00[1-9][0-9]{7,14}$/.test(p)) p = `+${p.slice(2)}`;
  if (p !== null && !/^\+[1-9][0-9]{7,14}$/.test(p)) {
    throw invalid('Enter a valid phone number, for example 082 123 4567 or +27 82 123 4567.');
  }
  if (addr && [...addr].length > 200) throw invalid('Address is too long (up to 200 characters).');
  if (town && [...town].length > 100) throw invalid('Town or city is too long (up to 100 characters).');
  if (prov !== null && !PROVINCES.includes(prov)) throw invalid('Unknown province.');
  return { phone: p, address: addr, city: town, province: prov };
}

/** private.shop_location: rounded to six decimals (about 10 cm). */
export function shopLocation(lat: unknown, lng: unknown): { latitude: number | null; longitude: number | null } {
  if (lat == null && lng == null) return { latitude: null, longitude: null };
  if (lat == null || lng == null) throw invalid('Latitude and longitude must be given together.');
  const la = Number(lat);
  const lo = Number(lng);
  if (!(la >= -90 && la <= 90 && lo >= -180 && lo <= 180)) throw invalid('Location is outside the valid range.');
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return { latitude: round(la), longitude: round(lo) };
}

async function shopSummary(db: D1Ctx & { db: D1Like }, shopId: string, role: string, userId: string): Promise<ApiRow> {
  const s = toApiRow('shops', await first(db.db, 'SELECT * FROM shops WHERE id = ?', shopId))!;
  return {
    id: s.id,
    name: s.name,
    timezone: s.timezone,
    expiry_reminder_days: s.expiry_reminder_days,
    role,
    is_account_owner: s.owner_id === userId,
    status: s.status,
    entitlements: await shopEntitlements(db.db, shopId, db.now),
    phone: s.phone,
    address: s.address,
    city: s.city,
    province: s.province,
    latitude: s.latitude,
    longitude: s.longitude,
    catalog_prompt_pending: s.catalog_prompt_pending,
  };
}

/** The membership_events row a change to shop_members writes (private.log_membership_event). */
async function memberEvents(db: D1Like, ctx: D1Ctx, before: MemberRow | null, after: MemberRow | null): Promise<Stmt[]> {
  const out: Stmt[] = [];
  const ev = (row: Record<string, string | null>): Stmt => {
    const cols = Object.keys(row);
    return [`INSERT INTO membership_events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c])];
  };
  const base = (m: MemberRow) => ({ id: crypto.randomUUID(), shop_id: m.shop_id, member_id: m.id, actor_id: ctx.userId, created_at: ctx.now });
  if (!before && after) {
    out.push(ev({ ...base(after), target_user_id: after.user_id, target_email: (await userEmail(db, after.user_id)) ?? after.invited_email, action: after.user_id ? 'joined' : 'invited', new_role: after.role }));
    return out;
  }
  if (before && !after) {
    out.push(ev({ ...base(before), target_user_id: before.user_id, target_email: (await userEmail(db, before.user_id)) ?? before.invited_email, action: before.user_id ? 'removed' : 'invite_revoked', old_role: before.role }));
    return out;
  }
  if (!before || !after) return out;
  if (before.user_id === null && after.user_id !== null) {
    out.push(ev({ ...base(after), target_user_id: after.user_id, target_email: (await userEmail(db, after.user_id)) ?? after.invited_email, action: 'joined', new_role: after.role }));
  } else if (after.user_id === null && after.invite_token_hash !== null && after.invite_token_hash !== before.invite_token_hash) {
    out.push(ev({ ...base(after), target_email: after.invited_email, action: 'invite_resent', old_role: before.role, new_role: after.role }));
  } else if (after.role !== before.role) {
    out.push(ev({ ...base(after), target_user_id: after.user_id, target_email: (await userEmail(db, after.user_id)) ?? after.invited_email, action: 'role_changed', old_role: before.role, new_role: after.role }));
  }
  if (after.status !== before.status) {
    out.push(ev({ ...base(after), target_user_id: after.user_id, target_email: await userEmail(db, after.user_id), action: after.status === 'deactivated' ? 'deactivated' : 'reactivated', old_role: before.role, new_role: after.role }));
  }
  return out;
}

/** public.create_shop: the caller becomes its owner; a free subscription is opened. */
export async function createShop(db: D1Like, ctx: D1Ctx, a: Args): Promise<ApiRow> {
  if (!ctx.userId) throw forbidden('Sign in to create a shop.');
  const name = String(a.p_name ?? '').trim();
  if ([...name].length < 1 || [...name].length > 120) throw invalid('Shop name is required (up to 120 characters).');
  const contact = shopContact(a.p_phone, a.p_address, a.p_city, a.p_province);
  const location = shopLocation(a.p_latitude, a.p_longitude);
  const shopId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const subscriptionId = crypto.randomUUID();
  const member: MemberRow = { id: memberId, shop_id: shopId, user_id: ctx.userId, invited_email: null, role: 'owner', status: 'active', invite_token_hash: null };
  await batch(db, [
    [
      `INSERT INTO shops (id, owner_id, name, phone, address, city, province, latitude, longitude, catalog_prompt_pending, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      shopId, ctx.userId, name, contact.phone, contact.address, contact.city, contact.province, location.latitude, location.longitude, ctx.now, ctx.now,
    ],
    ['INSERT INTO shop_members (id, shop_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', memberId, shopId, ctx.userId, 'owner', ctx.now, ctx.now, ctx.now],
    ...(await memberEvents(db, ctx, null, member)),
    ['INSERT INTO subscriptions (id, shop_id, created_at, updated_at) VALUES (?, ?, ?, ?)', subscriptionId, shopId, ctx.now, ctx.now],
    [
      `INSERT INTO subscription_events (shop_id, subscription_id, actor_id, event, new_plan, new_status, details, occurred_at)
       VALUES (?, ?, ?, 'created', 'free', 'active', ?, ?)`,
      shopId, subscriptionId, ctx.userId, JSON.stringify({ trial_ends_at: null, current_period_end: null }), ctx.now,
    ],
  ]);
  return shopSummary({ ...ctx, db }, shopId, 'owner', ctx.userId);
}

/** public.my_shops */
export async function myShops(db: D1Like, ctx: D1Ctx): Promise<ApiRow[]> {
  if (!ctx.userId) return [];
  const rows = await all<{ shop_id: string; role: string }>(
    db,
    `SELECT m.shop_id, m.role FROM shop_members m JOIN shops s ON s.id = m.shop_id
      WHERE m.user_id = ? AND m.status = 'active' ORDER BY s.created_at, s.id`,
    ctx.userId
  );
  const out: ApiRow[] = [];
  for (const r of rows) out.push(await shopSummary({ ...ctx, db }, r.shop_id, r.role, ctx.userId));
  return out;
}

/** public.update_shop_alert_settings */
export async function updateShopAlertSettings(db: D1Like, ctx: D1Ctx, a: Args): Promise<ApiRow> {
  const shopId = uuidArg(a.p_shop_id);
  if (!shopId) throw forbidden();
  await assertShopRole(db, ctx, shopId, ['owner', 'manager']);
  const raw = a.p_reminder_days;
  if (!Array.isArray(raw) || raw.some((d) => d === null || !Number.isInteger(Number(d)) || Number(d) < 1 || Number(d) > 180)) {
    throw invalid('Reminder days must be whole numbers from 1 to 180.');
  }
  const days = [...new Set(raw.map(Number))].sort((x, y) => y - x);
  if (days.length < 1 || days.length > 5) throw invalid('Choose 1 to 5 reminder days.');
  if (!isValidTimeZone(a.p_timezone)) throw invalid('Unknown time zone.');
  await batch(db, [['UPDATE shops SET expiry_reminder_days = ?, timezone = ? WHERE id = ?', JSON.stringify(days), a.p_timezone, shopId]]);
  return { timezone: a.p_timezone, expiry_reminder_days: days };
}

/** private.team_size: active members plus unexpired invites. */
async function teamSize(db: D1Like, shopId: string, now: string, exclude: string | null): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM shop_members
      WHERE shop_id = ? AND id IS NOT ?
        AND ((user_id IS NOT NULL AND status = 'active') OR (user_id IS NULL AND invite_expires_at > ?))`,
    shopId,
    exclude,
    now
  );
  return Number(row?.n ?? 0);
}

/** private.assert_team_capacity */
async function assertTeamCapacity(db: D1Like, shopId: string, now: string, exclude: string | null): Promise<void> {
  const limit = await entitlementLimit(db, shopId, 'team.max_members', now);
  if (limit !== null && (await teamSize(db, shopId, now, exclude)) >= limit) {
    throw planLimit(`This shop's plan allows ${limit} team members.`);
  }
}

const newInviteToken = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');

/** public.invite_shop_member */
export async function inviteShopMember(db: D1Like, ctx: D1Ctx, a: Args): Promise<ApiRow> {
  const shopId = uuidArg(a.p_shop_id);
  if (!shopId) throw forbidden();
  await assertPermission(db, ctx, shopId, 'team.manage');
  const email = String(a.p_email ?? '').trim().toLowerCase();
  if ([...email].length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid('A valid email address is required.');
  if (a.p_role !== 'manager' && a.p_role !== 'staff') throw invalid('Invite people as a manager or a worker.');
  const already = await first(
    db,
    'SELECT 1 AS x FROM shop_members m JOIN users u ON u.id = m.user_id WHERE m.shop_id = ? AND lower(u.email) = ?',
    shopId,
    email
  );
  if (already) throw conflict('This person is already in the team.');
  const pending = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM shop_members WHERE shop_id = ? AND user_id IS NULL AND invited_email <> ?',
    shopId,
    email
  );
  if (Number(pending?.n ?? 0) >= 50) throw new DbError('54000', 'Too many pending invites. Revoke some before inviting more.');
  const existing = await first<MemberRow>(db, 'SELECT * FROM shop_members WHERE shop_id = ? AND user_id IS NULL AND invited_email = ?', shopId, email);
  await assertTeamCapacity(db, shopId, ctx.now, existing?.id ?? null);

  const token = newInviteToken();
  const hash = await sha256Hex(token);
  const expires = addDays(ctx.now, 7);
  let memberId: string;
  let stmts: Stmt[];
  if (existing) {
    memberId = existing.id;
    stmts = [
      [
        `UPDATE shop_members SET role = ?, invited_by = ?, invite_token_hash = ?, invite_expires_at = ?, invite_sent_at = ? WHERE id = ?`,
        a.p_role, ctx.userId, hash, expires, ctx.now, memberId,
      ],
      ...(await memberEvents(db, ctx, existing, { ...existing, role: a.p_role as string, invite_token_hash: hash })),
    ];
  } else {
    memberId = crypto.randomUUID();
    const row: MemberRow = { id: memberId, shop_id: shopId, user_id: null, invited_email: email, role: a.p_role as string, status: 'active', invite_token_hash: hash };
    stmts = [
      [
        `INSERT INTO shop_members (id, shop_id, invited_email, role, invited_by, invite_token_hash, invite_expires_at, invite_sent_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        memberId, shopId, email, a.p_role, ctx.userId, hash, expires, ctx.now, ctx.now, ctx.now,
      ],
      ...(await memberEvents(db, ctx, null, row)),
    ];
  }
  await batch(db, stmts);
  return { member_id: memberId, email, role: a.p_role, token, expires_at: expires };
}

/** public.preview_shop_invite: what an invite link is for, before signing in. */
export async function previewShopInvite(db: D1Like, ctx: D1Ctx, a: Args): Promise<ApiRow | null> {
  const token = String(a.p_token ?? '');
  if (token.length < 32 || token.length > 128) return null;
  const row = await first<{ shop_name: string; role: string; email: string; invited_by: string | null; expires_at: string | null }>(
    db,
    `SELECT s.name AS shop_name, m.role, m.invited_email AS email, p.display_name AS invited_by, m.invite_expires_at AS expires_at
       FROM shop_members m JOIN shops s ON s.id = m.shop_id LEFT JOIN profiles p ON p.id = m.invited_by
      WHERE m.user_id IS NULL AND m.invite_token_hash = ?`,
    await sha256Hex(token)
  );
  if (!row) return null;
  return { ...row, expired: row.expires_at === null || Date.parse(row.expires_at) <= Date.parse(ctx.now) };
}

/** public.accept_shop_invite */
export async function acceptShopInvite(db: D1Like, ctx: D1Ctx, a: Args): Promise<ApiRow> {
  if (!ctx.userId) throw forbidden('Sign in to accept the invite.');
  const token = String(a.p_token ?? '');
  const unusable = new DbError('SS001', 'This invite link is not valid or has already been used.');
  if (token.length < 32 || token.length > 128) throw unusable;
  const member = await first<MemberRow & { invite_expires_at: string | null }>(
    db,
    'SELECT * FROM shop_members WHERE user_id IS NULL AND invite_token_hash = ?',
    await sha256Hex(token)
  );
  if (!member) throw unusable;
  if (!member.invite_expires_at || Date.parse(member.invite_expires_at) <= Date.parse(ctx.now)) {
    throw new DbError('SS002', 'This invite has expired. Ask the shop owner to send a new one.');
  }
  const user = await first<{ email: string; email_confirmed_at: string | null }>(db, 'SELECT lower(email) AS email, email_confirmed_at FROM users WHERE id = ?', ctx.userId);
  if (user?.email !== member.invited_email) throw new DbError('SS003', 'This invite is for a different email address.');
  if (!user.email_confirmed_at) throw new DbError('SS004', 'Confirm your email address before joining.');
  if (await first(db, 'SELECT 1 AS x FROM shop_members WHERE shop_id = ? AND user_id = ?', member.shop_id, ctx.userId)) {
    throw new DbError('SS005', 'You are already a member of this shop.');
  }
  if (!(await shopIsActive(db, member.shop_id))) throw new DbError('SP001', 'This shop is suspended. Try again once it is reactivated.');
  await assertTeamCapacity(db, member.shop_id, ctx.now, member.id);
  await batch(db, [
    [
      `UPDATE shop_members SET user_id = ?, joined_at = ?, status = 'active', invite_token_hash = NULL, invite_expires_at = NULL
        WHERE id = ? AND user_id IS NULL`,
      ctx.userId, ctx.now, member.id,
    ],
    ...(await memberEvents(db, ctx, member, { ...member, user_id: ctx.userId, status: 'active', invite_token_hash: null })),
  ]);
  return { shop_id: member.shop_id, member_id: member.id, role: member.role };
}

async function memberById(db: D1Like, id: unknown): Promise<MemberRow | null> {
  const memberId = uuidArg(id);
  return memberId ? first<MemberRow>(db, 'SELECT * FROM shop_members WHERE id = ?', memberId) : null;
}

/** public.resend_shop_invite: a new link; the old one stops working. */
export async function resendShopInvite(db: D1Like, ctx: D1Ctx, a: Args): Promise<ApiRow> {
  const member = await memberById(db, a.p_member_id);
  if (!member) throw forbidden();
  await assertPermission(db, ctx, member.shop_id, 'team.manage');
  if (member.user_id !== null) throw invalid('Only pending invites can be sent again.');
  const token = newInviteToken();
  const hash = await sha256Hex(token);
  const expires = addDays(ctx.now, 7);
  await batch(db, [
    ['UPDATE shop_members SET invite_token_hash = ?, invite_expires_at = ?, invite_sent_at = ?, invited_by = ? WHERE id = ?', hash, expires, ctx.now, ctx.userId, member.id],
    ...(await memberEvents(db, ctx, member, { ...member, invite_token_hash: hash })),
  ]);
  return { member_id: member.id, email: member.invited_email, role: member.role, token, expires_at: expires };
}

/** private.assert_owner_change_allowed */
async function assertOwnerChangeAllowed(db: D1Like, member: MemberRow): Promise<void> {
  const shop = await first<{ owner_id: string }>(db, 'SELECT owner_id FROM shops WHERE id = ?', member.shop_id);
  if (member.user_id !== null && member.user_id === shop?.owner_id) {
    throw invalid('The account owner cannot be removed, demoted or deactivated.');
  }
  if (member.role === 'owner' && member.user_id !== null) {
    const others = await first<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM shop_members WHERE shop_id = ? AND role = 'owner' AND user_id IS NOT NULL AND status = 'active' AND id <> ?`,
      member.shop_id,
      member.id
    );
    if (Number(others?.n ?? 0) === 0) throw invalid('A shop must keep at least one owner.');
  }
}

/** public.remove_shop_member: owners remove anyone; anyone may leave. */
export async function removeShopMember(db: D1Like, ctx: D1Ctx, a: Args): Promise<null> {
  const member = await memberById(db, a.p_member_id);
  if (!member) throw forbidden();
  if (member.user_id !== ctx.userId) await assertShopRole(db, ctx, member.shop_id, ['owner']);
  await assertOwnerChangeAllowed(db, member);
  await batch(db, [['DELETE FROM shop_members WHERE id = ?', member.id], ...(await memberEvents(db, ctx, member, null))]);
  return null;
}

const memberApi = async (db: D1Like, id: string) => {
  const row = toApiRow('shop_members', await first(db, 'SELECT * FROM shop_members WHERE id = ?', id))!;
  delete row.invite_token_hash;
  return row;
};

/** public.set_member_status: deactivating stops that member's pending pushes. */
export async function setMemberStatus(db: D1Like, ctx: D1Ctx, a: Args): Promise<ApiRow> {
  const status = a.p_status;
  if (status !== 'active' && status !== 'deactivated') throw invalid('Status must be active or deactivated.');
  const member = await memberById(db, a.p_member_id);
  if (!member) throw forbidden();
  await assertPermission(db, ctx, member.shop_id, 'team.manage');
  if (member.user_id === null) throw invalid('Pending invites cannot be deactivated; revoke them instead.');
  if (member.user_id === ctx.userId) throw invalid('You cannot change your own access.');
  if (member.status === status) return memberApi(db, member.id);
  if (status === 'deactivated') await assertOwnerChangeAllowed(db, member);
  const off = status === 'deactivated';
  await batch(db, [
    ['UPDATE shop_members SET status = ?, deactivated_at = ?, deactivated_by = ? WHERE id = ?', status, off ? ctx.now : null, off ? ctx.userId : null, member.id],
    ...(await memberEvents(db, ctx, member, { ...member, status })),
    ...(off
      ? ([
          [
            `UPDATE notifications SET push_status = 'skipped', push_next_at = NULL
              WHERE shop_id = ? AND user_id = ? AND push_status IN ('pending', 'sending')`,
            member.shop_id,
            member.user_id,
          ],
        ] as Stmt[])
      : []),
  ]);
  return memberApi(db, member.id);
}

/** public.update_member_role */
export async function updateMemberRole(db: D1Like, ctx: D1Ctx, a: Args): Promise<ApiRow> {
  const role = a.p_role;
  if (role !== 'owner' && role !== 'manager' && role !== 'staff') throw invalid('Role must be owner, manager or staff.');
  const member = await memberById(db, a.p_member_id);
  if (!member) throw forbidden();
  await assertPermission(db, ctx, member.shop_id, 'team.manage');
  if (member.user_id === ctx.userId) throw invalid('You cannot change your own role.');
  if (member.status !== 'active') throw invalid('Reactivate this member before changing their role.');
  if (member.user_id === null && role === 'owner') throw invalid('Invite people as a manager or a worker.');
  if (member.role !== role) {
    if (member.role === 'owner') await assertOwnerChangeAllowed(db, member);
    await batch(db, [['UPDATE shop_members SET role = ? WHERE id = ?', role, member.id], ...(await memberEvents(db, ctx, member, { ...member, role }))]);
  }
  return memberApi(db, member.id);
}

/** public.list_shop_team */
export async function listShopTeam(db: D1Like, ctx: D1Ctx, a: Args): Promise<ApiRow[]> {
  const shopId = uuidArg(a.p_shop_id);
  const m = shopId ? await membership(db, shopId, ctx.userId) : null;
  if (!m || !m.permissions.includes('team.manage')) throw forbidden();
  const rows = await all<Record<string, string | null>>(
    db,
    `SELECT m.id AS member_id, m.user_id, coalesce(lower(u.email), m.invited_email) AS email, p.display_name, m.role,
            m.status, m.invite_expires_at, m.joined_at, m.created_at AS invited_at, m.invite_sent_at, m.deactivated_at,
            s.owner_id, u.email AS user_email, m.invited_email
       FROM shop_members m JOIN shops s ON s.id = m.shop_id
       LEFT JOIN users u ON u.id = m.user_id LEFT JOIN profiles p ON p.id = m.user_id
      WHERE m.shop_id = ?`,
    shopId
  );
  const now = Date.parse(ctx.now);
  const sortKey = (r: Record<string, string | null>) => r.display_name ?? r.user_email ?? r.invited_email ?? '';
  rows.sort(
    (x, y) =>
      Number(x.user_id === null) - Number(y.user_id === null) ||
      Number(x.role !== 'owner') - Number(y.role !== 'owner') ||
      (sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0)
  );
  return rows.map((r) => ({
    member_id: r.member_id,
    user_id: r.user_id,
    email: r.email,
    display_name: r.display_name,
    role: r.role,
    status: r.user_id !== null ? r.status : r.invite_expires_at && Date.parse(r.invite_expires_at) > now ? 'invited' : 'expired',
    is_account_owner: r.user_id !== null && r.user_id === r.owner_id,
    is_you: r.user_id !== null && r.user_id === ctx.userId,
    joined_at: r.joined_at,
    invited_at: r.invited_at,
    invite_sent_at: r.invite_sent_at,
    invite_expires_at: r.invite_expires_at,
    deactivated_at: r.deactivated_at,
  }));
}
