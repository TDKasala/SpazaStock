-- Team management: invite links, deactivation, a permission matrix and a membership audit trail.
--
-- Invites stay pending shop_members rows (user_id null). The inviting owner receives a random
-- token once; only its SHA-256 hash is stored. Someone joins by presenting the token while signed
-- in with the invited, confirmed email address, and the token is cleared on use. Deactivated
-- members keep their row (for the audit trail and reactivation) but lose all access, because the
-- membership helpers that every policy and function relies on only count active rows.

-- Membership columns ------------------------------------------------------------------------------

alter table public.shop_members
  add column status text not null default 'active' check (status in ('active', 'deactivated')),
  add column deactivated_at timestamptz,
  add column deactivated_by uuid references auth.users (id) on delete set null,
  add column invite_token_hash text,
  add column invite_expires_at timestamptz,
  add column invite_sent_at timestamptz,
  add constraint shop_members_token_only_pending check (invite_token_hash is null or user_id is null),
  add constraint shop_members_deactivate_joined_only check (status = 'active' or user_id is not null);

create unique index shop_members_invite_token_key
  on public.shop_members (invite_token_hash) where invite_token_hash is not null;
create index shop_members_deactivated_by_idx on public.shop_members (deactivated_by);

-- The token hash never leaves the database, and only owners see the whole team (names and
-- emails); everyone else sees just their own membership.
revoke select on table public.shop_members from authenticated;
grant select (
  id, shop_id, user_id, invited_email, role, invited_by, joined_at, created_at, updated_at,
  status, deactivated_at, deactivated_by, invite_expires_at, invite_sent_at
) on public.shop_members to authenticated;

drop policy "Members can view their shop's members" on public.shop_members;
create policy "Members see their own membership and owners see the team"
  on public.shop_members for select to authenticated
  using (user_id = (select auth.uid()) or shop_id in (select private.my_shop_ids(array['owner'])));

-- Membership helpers count active members only ---------------------------------------------------

create or replace function private.my_shop_ids(p_roles text[] default array['owner', 'manager', 'staff'])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.shop_id
  from public.shop_members m
  where m.user_id = (select auth.uid()) and m.status = 'active' and m.role = any (p_roles);
$$;

create or replace function private.has_shop_role(p_shop_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.shop_members m
    where m.shop_id = p_shop_id and m.user_id = (select auth.uid()) and m.status = 'active'
      and m.role = any (p_roles)
  );
$$;

create or replace function private.my_co_member_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.user_id
  from public.shop_members m
  where m.user_id is not null and m.status = 'active'
    and m.shop_id in (select private.my_shop_ids());
$$;

create or replace function private.assert_owner_change_allowed(p_member public.shop_members)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account_owner uuid;
  v_other_owners integer;
begin
  select owner_id into v_account_owner from public.shops where id = p_member.shop_id for update;
  if p_member.user_id is not null and p_member.user_id = v_account_owner then
    raise exception 'The account owner cannot be removed, demoted or deactivated.' using errcode = '22023';
  end if;
  if p_member.role = 'owner' and p_member.user_id is not null then
    select count(*) into v_other_owners
    from public.shop_members
    where shop_id = p_member.shop_id and role = 'owner' and user_id is not null and status = 'active'
      and id <> p_member.id;
    if v_other_owners = 0 then
      raise exception 'A shop must keep at least one owner.' using errcode = '22023';
    end if;
  end if;
end;
$$;

-- Permission matrix -------------------------------------------------------------------------------
-- Edit permissions here (in a migration) and mirror them in src/lib/permissions.ts; a test keeps the
-- two in step.

create table private.role_permissions (
  role text not null check (role in ('owner', 'manager', 'staff')),
  permission text not null check (permission ~ '^[a-z]+\.[a-z_]+$'),
  primary key (role, permission)
);

revoke all on table private.role_permissions from public, anon, authenticated;

insert into private.role_permissions (role, permission) values
  ('owner', 'team.manage'),
  ('owner', 'shop.settings'),
  ('owner', 'billing.view'),
  ('owner', 'products.edit'),
  ('manager', 'products.edit'),
  ('owner', 'stock.adjust'),
  ('manager', 'stock.adjust'),
  ('owner', 'expiry.manage'),
  ('manager', 'expiry.manage'),
  ('owner', 'stock.receive'),
  ('manager', 'stock.receive'),
  ('staff', 'stock.receive'),
  ('owner', 'sales.record'),
  ('manager', 'sales.record'),
  ('staff', 'sales.record'),
  ('owner', 'inventory.view'),
  ('manager', 'inventory.view'),
  ('staff', 'inventory.view');

create function private.has_permission(p_shop_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.shop_members m
    join private.role_permissions rp on rp.role = m.role
    where m.shop_id = p_shop_id and m.user_id = (select auth.uid()) and m.status = 'active'
      and rp.permission = p_permission
  );
$$;

-- Raises 42501 unless the caller is an active member whose role grants p_permission.
create function private.assert_permission(p_shop_id uuid, p_permission text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not private.has_permission(p_shop_id, p_permission) then
    raise exception 'You do not have access to this shop.' using errcode = '42501';
  end if;
end;
$$;

-- Audit trail -------------------------------------------------------------------------------------
-- No foreign keys, so the history outlives deleted shops, members and accounts.

create table public.membership_events (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  member_id uuid not null,
  actor_id uuid,
  target_user_id uuid,
  target_email text,
  action text not null check (action in (
    'invited', 'invite_resent', 'invite_revoked', 'joined', 'role_changed',
    'deactivated', 'reactivated', 'removed'
  )),
  old_role text,
  new_role text,
  created_at timestamptz not null default now()
);

create index membership_events_shop_created_idx on public.membership_events (shop_id, created_at desc);

alter table public.membership_events enable row level security;
revoke all on table public.membership_events from anon, authenticated;
grant select on table public.membership_events to authenticated;

create policy "Owners can view their shop's membership history"
  on public.membership_events for select to authenticated
  using (shop_id in (select private.my_shop_ids(array['owner'])));

create function private.user_email(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(u.email) from auth.users u where u.id = p_user_id;
$$;

create function private.log_membership_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    insert into public.membership_events (shop_id, member_id, actor_id, target_user_id, target_email, action, new_role)
    values (
      new.shop_id, new.id, v_actor, new.user_id,
      coalesce(private.user_email(new.user_id), new.invited_email),
      case when new.user_id is null then 'invited' else 'joined' end,
      new.role
    );
    return new;
  end if;

  if tg_op = 'DELETE' then
    insert into public.membership_events (shop_id, member_id, actor_id, target_user_id, target_email, action, old_role)
    values (
      old.shop_id, old.id, v_actor, old.user_id,
      coalesce(private.user_email(old.user_id), old.invited_email),
      case when old.user_id is null then 'invite_revoked' else 'removed' end,
      old.role
    );
    return old;
  end if;

  if old.user_id is null and new.user_id is not null then
    insert into public.membership_events (shop_id, member_id, actor_id, target_user_id, target_email, action, new_role)
    values (new.shop_id, new.id, v_actor, new.user_id, coalesce(private.user_email(new.user_id), new.invited_email), 'joined', new.role);
  elsif new.user_id is null and new.invite_token_hash is not null
    and new.invite_token_hash is distinct from old.invite_token_hash then
    insert into public.membership_events (shop_id, member_id, actor_id, target_email, action, old_role, new_role)
    values (new.shop_id, new.id, v_actor, new.invited_email, 'invite_resent', old.role, new.role);
  elsif new.role <> old.role then
    insert into public.membership_events (shop_id, member_id, actor_id, target_user_id, target_email, action, old_role, new_role)
    values (new.shop_id, new.id, v_actor, new.user_id, coalesce(private.user_email(new.user_id), new.invited_email), 'role_changed', old.role, new.role);
  end if;

  if new.status <> old.status then
    insert into public.membership_events (shop_id, member_id, actor_id, target_user_id, target_email, action, old_role, new_role)
    values (
      new.shop_id, new.id, v_actor, new.user_id, private.user_email(new.user_id),
      case when new.status = 'deactivated' then 'deactivated' else 'reactivated' end,
      old.role, new.role
    );
  end if;
  return new;
end;
$$;

create trigger shop_members_log_events
  after insert or update or delete on public.shop_members
  for each row execute function private.log_membership_event();

-- Notifications only reach active members ---------------------------------------------------------
-- Covers every producer (expiry generator, sale shortfalls) without redefining them.

create function private.skip_inactive_recipient()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.shop_members m
    where m.shop_id = new.shop_id and m.user_id = new.user_id and m.status = 'active'
  ) then
    return null;
  end if;
  return new;
end;
$$;

create trigger notifications_skip_inactive_recipient
  before insert on public.notifications
  for each row execute function private.skip_inactive_recipient();

-- Invite tokens -----------------------------------------------------------------------------------
-- 64 hex characters from two v4 UUIDs (244 random bits); built in, so no pgcrypto is needed.

create function private.new_invite_token()
returns text
language sql
volatile
set search_path = ''
as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
$$;

create function private.invite_token_hash(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
$$;

-- Membership API ----------------------------------------------------------------------------------

drop function public.accept_pending_invites();
drop function public.invite_shop_member(uuid, text, text);
drop function public.update_member_role(uuid, text);

-- Owner invites a manager or worker by email and receives the invite token exactly once.
-- Inviting a pending email again issues a new token, so older links stop working.
create function public.invite_shop_member(p_shop_id uuid, p_email text, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_token text := private.new_invite_token();
  v_expires timestamptz := now() + interval '7 days';
  v_member public.shop_members;
begin
  perform private.assert_permission(p_shop_id, 'team.manage');
  if char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'A valid email address is required.' using errcode = '22023';
  end if;
  if p_role is null or p_role not in ('manager', 'staff') then
    raise exception 'Invite people as a manager or a worker.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.shop_members m join auth.users u on u.id = m.user_id
    where m.shop_id = p_shop_id and lower(u.email) = v_email
  ) then
    raise exception 'This person is already in the team.' using errcode = '23505';
  end if;
  if (
    select count(*) from public.shop_members
    where shop_id = p_shop_id and user_id is null and invited_email <> v_email
  ) >= 50 then
    raise exception 'Too many pending invites. Revoke some before inviting more.' using errcode = '54000';
  end if;

  insert into public.shop_members (
    shop_id, invited_email, role, invited_by, invite_token_hash, invite_expires_at, invite_sent_at
  )
  values (p_shop_id, v_email, p_role, (select auth.uid()), private.invite_token_hash(v_token), v_expires, now())
  on conflict (shop_id, invited_email) where user_id is null
  do update set
    role = excluded.role,
    invited_by = excluded.invited_by,
    invite_token_hash = excluded.invite_token_hash,
    invite_expires_at = excluded.invite_expires_at,
    invite_sent_at = excluded.invite_sent_at
  returning * into v_member;

  return jsonb_build_object(
    'member_id', v_member.id, 'email', v_member.invited_email, 'role', v_member.role,
    'token', v_token, 'expires_at', v_member.invite_expires_at
  );
end;
$$;

-- Issues a fresh token and expiry for a pending invite; the previous link stops working.
create function public.resend_shop_invite(p_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := private.new_invite_token();
  v_member public.shop_members;
begin
  select * into v_member from public.shop_members where id = p_member_id for update;
  if not found then
    raise exception 'You do not have access to this shop.' using errcode = '42501';
  end if;
  perform private.assert_permission(v_member.shop_id, 'team.manage');
  if v_member.user_id is not null then
    raise exception 'Only pending invites can be sent again.' using errcode = '22023';
  end if;

  update public.shop_members
  set invite_token_hash = private.invite_token_hash(v_token),
      invite_expires_at = now() + interval '7 days',
      invite_sent_at = now(),
      invited_by = (select auth.uid())
  where id = p_member_id
  returning * into v_member;

  return jsonb_build_object(
    'member_id', v_member.id, 'email', v_member.invited_email, 'role', v_member.role,
    'token', v_token, 'expires_at', v_member.invite_expires_at
  );
end;
$$;

-- What an invite link is for, so the invitee can sign up with the right email. Callable before
-- signing in; unknown or used tokens return null.
create function public.preview_shop_invite(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'shop_name', s.name,
    'role', m.role,
    'email', m.invited_email,
    'invited_by', p.display_name,
    'expires_at', m.invite_expires_at,
    'expired', m.invite_expires_at is null or m.invite_expires_at <= now()
  )
  from public.shop_members m
  join public.shops s on s.id = m.shop_id
  left join public.profiles p on p.id = m.invited_by
  where char_length(coalesce(p_token, '')) between 32 and 128
    and m.user_id is null
    and m.invite_token_hash = private.invite_token_hash(p_token);
$$;

-- Joins the shop with an invite token. The caller's account email must match the invite and be
-- confirmed, so a link alone cannot be used by someone else.
create function public.accept_shop_invite(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text;
  v_confirmed_at timestamptz;
  v_member public.shop_members;
begin
  if v_uid is null then
    raise exception 'Sign in to accept the invite.' using errcode = '42501';
  end if;
  if char_length(coalesce(p_token, '')) not between 32 and 128 then
    raise exception 'This invite link is not valid or has already been used.' using errcode = 'SS001';
  end if;

  select * into v_member
  from public.shop_members
  where user_id is null and invite_token_hash = private.invite_token_hash(p_token)
  for update;
  if not found then
    raise exception 'This invite link is not valid or has already been used.' using errcode = 'SS001';
  end if;
  if v_member.invite_expires_at is null or v_member.invite_expires_at <= now() then
    raise exception 'This invite has expired. Ask the shop owner to send a new one.' using errcode = 'SS002';
  end if;

  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed_at
  from auth.users u where u.id = v_uid;
  if v_email is distinct from v_member.invited_email then
    raise exception 'This invite is for a different email address.' using errcode = 'SS003';
  end if;
  if v_confirmed_at is null then
    raise exception 'Confirm your email address before joining.' using errcode = 'SS004';
  end if;
  if exists (select 1 from public.shop_members where shop_id = v_member.shop_id and user_id = v_uid) then
    raise exception 'You are already a member of this shop.' using errcode = 'SS005';
  end if;

  update public.shop_members
  set user_id = v_uid, joined_at = now(), status = 'active',
      invite_token_hash = null, invite_expires_at = null
  where id = v_member.id
  returning * into v_member;

  return jsonb_build_object('shop_id', v_member.shop_id, 'member_id', v_member.id, 'role', v_member.role);
end;
$$;

-- Owners change a member's role. Nobody changes their own role, and only joined members can be
-- made owners.
create function public.update_member_role(p_member_id uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.shop_members;
begin
  if p_role is null or p_role not in ('owner', 'manager', 'staff') then
    raise exception 'Role must be owner, manager or staff.' using errcode = '22023';
  end if;
  select * into v_member from public.shop_members where id = p_member_id for update;
  if not found then
    raise exception 'You do not have access to this shop.' using errcode = '42501';
  end if;
  perform private.assert_permission(v_member.shop_id, 'team.manage');

  if v_member.user_id = (select auth.uid()) then
    raise exception 'You cannot change your own role.' using errcode = '22023';
  end if;
  if v_member.status <> 'active' then
    raise exception 'Reactivate this member before changing their role.' using errcode = '22023';
  end if;
  if v_member.user_id is null and p_role = 'owner' then
    raise exception 'Invite people as a manager or a worker.' using errcode = '22023';
  end if;

  if v_member.role <> p_role then
    if v_member.role = 'owner' then
      perform private.assert_owner_change_allowed(v_member);
    end if;
    update public.shop_members set role = p_role where id = p_member_id returning * into v_member;
  end if;

  return to_jsonb(v_member) - 'invite_token_hash';
end;
$$;

-- Owners deactivate or reactivate a joined member. Deactivation removes all access at once and
-- cancels pushes still queued for that person.
create function public.set_member_status(p_member_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_member public.shop_members;
begin
  if p_status is null or p_status not in ('active', 'deactivated') then
    raise exception 'Status must be active or deactivated.' using errcode = '22023';
  end if;
  select * into v_member from public.shop_members where id = p_member_id for update;
  if not found then
    raise exception 'You do not have access to this shop.' using errcode = '42501';
  end if;
  perform private.assert_permission(v_member.shop_id, 'team.manage');

  if v_member.user_id is null then
    raise exception 'Pending invites cannot be deactivated; revoke them instead.' using errcode = '22023';
  end if;
  if v_member.user_id = v_uid then
    raise exception 'You cannot change your own access.' using errcode = '22023';
  end if;
  if v_member.status = p_status then
    return to_jsonb(v_member) - 'invite_token_hash';
  end if;
  if p_status = 'deactivated' then
    perform private.assert_owner_change_allowed(v_member);
  end if;

  update public.shop_members
  set status = p_status,
      deactivated_at = case when p_status = 'deactivated' then now() end,
      deactivated_by = case when p_status = 'deactivated' then v_uid end
  where id = p_member_id
  returning * into v_member;

  if p_status = 'deactivated' then
    update public.notifications
    set push_status = 'skipped', push_next_at = null
    where shop_id = v_member.shop_id and user_id = v_member.user_id and push_status in ('pending', 'sending');
  end if;

  return to_jsonb(v_member) - 'invite_token_hash';
end;
$$;

-- The team screen: everyone in the shop with their email, name, role and status.
create function public.list_shop_team(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_permission(p_shop_id, 'team.manage');
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'member_id', m.id,
      'user_id', m.user_id,
      'email', coalesce(lower(u.email), m.invited_email),
      'display_name', p.display_name,
      'role', m.role,
      'status', case
        when m.user_id is not null then m.status
        when m.invite_expires_at > now() then 'invited'
        else 'expired'
      end,
      'is_account_owner', coalesce(m.user_id = s.owner_id, false),
      'is_you', coalesce(m.user_id = (select auth.uid()), false),
      'joined_at', m.joined_at,
      'invited_at', m.created_at,
      'invite_sent_at', m.invite_sent_at,
      'invite_expires_at', m.invite_expires_at,
      'deactivated_at', m.deactivated_at
    ) order by m.user_id is null, m.role <> 'owner', coalesce(p.display_name, u.email, m.invited_email)), '[]'::jsonb)
    from public.shop_members m
    join public.shops s on s.id = m.shop_id
    left join auth.users u on u.id = m.user_id
    left join public.profiles p on p.id = m.user_id
    where m.shop_id = p_shop_id
  );
end;
$$;

-- Every shop the caller can currently work in, with their role.
create function public.my_shops()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'name', s.name,
    'timezone', s.timezone,
    'expiry_reminder_days', s.expiry_reminder_days,
    'role', m.role,
    'is_account_owner', s.owner_id = m.user_id
  ) order by s.created_at, s.id), '[]'::jsonb)
  from public.shop_members m
  join public.shops s on s.id = m.shop_id
  where m.user_id = (select auth.uid()) and m.status = 'active';
$$;

-- Shops are created only here: the caller always becomes the account owner.
create function public.create_shop(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := btrim(coalesce(p_name, ''));
  v_shop public.shops;
begin
  if v_uid is null then
    raise exception 'Sign in to create a shop.' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 120 then
    raise exception 'Shop name is required (up to 120 characters).' using errcode = '22023';
  end if;
  insert into public.shops (owner_id, name) values (v_uid, v_name) returning * into v_shop;

  return jsonb_build_object(
    'id', v_shop.id,
    'name', v_shop.name,
    'timezone', v_shop.timezone,
    'expiry_reminder_days', v_shop.expiry_reminder_days,
    'role', 'owner',
    'is_account_owner', true
  );
end;
$$;

drop policy "Users can create a shop they own" on public.shops;
revoke insert on table public.shops from authenticated;

-- Profiles take the name given at registration ----------------------------------------------------

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    nullif(btrim(left(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 80)), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Privileges --------------------------------------------------------------------------------------

revoke all on function private.has_permission(uuid, text) from public, anon, authenticated;
revoke all on function private.assert_permission(uuid, text) from public, anon, authenticated;
revoke all on function private.user_email(uuid) from public, anon, authenticated;
revoke all on function private.log_membership_event() from public, anon, authenticated;
revoke all on function private.skip_inactive_recipient() from public, anon, authenticated;
revoke all on function private.new_invite_token() from public, anon, authenticated;
revoke all on function private.invite_token_hash(text) from public, anon, authenticated;

revoke all on function public.invite_shop_member(uuid, text, text) from public, anon;
revoke all on function public.resend_shop_invite(uuid) from public, anon;
revoke all on function public.preview_shop_invite(text) from public;
revoke all on function public.accept_shop_invite(text) from public, anon;
revoke all on function public.update_member_role(uuid, text) from public, anon;
revoke all on function public.set_member_status(uuid, text) from public, anon;
revoke all on function public.list_shop_team(uuid) from public, anon;
revoke all on function public.my_shops() from public, anon;
revoke all on function public.create_shop(text) from public, anon;

grant execute on function public.invite_shop_member(uuid, text, text) to authenticated;
grant execute on function public.resend_shop_invite(uuid) to authenticated;
grant execute on function public.preview_shop_invite(text) to anon, authenticated;
grant execute on function public.accept_shop_invite(text) to authenticated;
grant execute on function public.update_member_role(uuid, text) to authenticated;
grant execute on function public.set_member_status(uuid, text) to authenticated;
grant execute on function public.list_shop_team(uuid) to authenticated;
grant execute on function public.my_shops() to authenticated;
grant execute on function public.create_shop(text) to authenticated;
