-- Tenancy: user profiles and shop membership (owner, manager, staff).
-- A shop's data is reachable only by its members. shops.owner_id is the account owner who created
-- the shop; that person is always an owner member and cannot be removed or demoted.

-- Private helpers ---------------------------------------------------------------
-- The private schema is not exposed through the Data API. Its security-definer helpers let RLS
-- policies read shop_members without recursing into shop_members' own policies.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- Profiles ----------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(btrim(display_name)) between 1 and 80),
  phone text check (phone is null or phone ~ '^\+?[0-9 ]{7,20}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
revoke all on table public.profiles from anon;

create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created_create_profile
  after insert on auth.users
  for each row execute function private.handle_new_user();

insert into public.profiles (id) select id from auth.users on conflict (id) do nothing;

-- Shop members ------------------------------------------------------------------
-- A row with user_id null is a pending invite, claimed by accept_pending_invites() once a user
-- with that (verified) email signs in.

create table public.shop_members (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  invited_email text check (
    invited_email is null
    or (invited_email = lower(btrim(invited_email)) and invited_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
  ),
  role text not null check (role in ('owner', 'manager', 'staff')),
  invited_by uuid references auth.users (id) on delete set null,
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shop_members_user_or_invite check (user_id is not null or invited_email is not null),
  constraint shop_members_shop_user_key unique (shop_id, user_id)
);

create unique index shop_members_pending_email_key
  on public.shop_members (shop_id, invited_email) where user_id is null;
create index shop_members_user_id_idx on public.shop_members (user_id);
create index shop_members_pending_email_idx on public.shop_members (invited_email) where user_id is null;
create index shop_members_invited_by_idx on public.shop_members (invited_by);
create index shop_members_shop_updated_idx on public.shop_members (shop_id, updated_at);

create trigger shop_members_set_updated_at before update on public.shop_members
  for each row execute function public.set_updated_at();

alter table public.shop_members enable row level security;
revoke all on table public.shop_members from anon;

-- Membership checks used by policies and functions --------------------------------

create function private.my_shop_ids(p_roles text[] default array['owner', 'manager', 'staff'])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.shop_id
  from public.shop_members m
  where m.user_id = (select auth.uid()) and m.role = any (p_roles);
$$;

create function private.has_shop_role(p_shop_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.shop_members m
    where m.shop_id = p_shop_id and m.user_id = (select auth.uid()) and m.role = any (p_roles)
  );
$$;

create function private.is_shop_member(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_shop_role(p_shop_id, array['owner', 'manager', 'staff']);
$$;

create function private.my_co_member_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.user_id
  from public.shop_members m
  where m.user_id is not null
    and m.shop_id in (select private.my_shop_ids());
$$;

-- Raises 42501 unless the caller holds one of p_roles in the shop.
create function private.assert_shop_role(p_shop_id uuid, p_roles text[])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not private.has_shop_role(p_shop_id, p_roles) then
    raise exception 'You do not have access to this shop.' using errcode = '42501';
  end if;
end;
$$;

-- New shops: the creator becomes an owner member --------------------------------

create function private.handle_new_shop()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.shop_members (shop_id, user_id, role, joined_at)
  values (new.id, new.owner_id, 'owner', now())
  on conflict (shop_id, user_id) do update set role = 'owner';
  return new;
end;
$$;

create trigger shops_add_owner_member
  after insert on public.shops
  for each row execute function private.handle_new_shop();

insert into public.shop_members (shop_id, user_id, role, joined_at)
select s.id, s.owner_id, 'owner', s.created_at from public.shops s
on conflict (shop_id, user_id) do nothing;

-- Membership API ----------------------------------------------------------------

-- Owner invites someone by email. Re-inviting the same pending email updates the role.
create function public.invite_shop_member(p_shop_id uuid, p_email text, p_role text)
returns public.shop_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_member public.shop_members;
begin
  perform private.assert_shop_role(p_shop_id, array['owner']);
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'A valid email address is required.' using errcode = '22023';
  end if;
  if p_role is null or p_role not in ('owner', 'manager', 'staff') then
    raise exception 'Role must be owner, manager or staff.' using errcode = '22023';
  end if;

  insert into public.shop_members (shop_id, invited_email, role, invited_by)
  values (p_shop_id, v_email, p_role, (select auth.uid()))
  on conflict (shop_id, invited_email) where user_id is null
  do update set role = excluded.role, invited_by = excluded.invited_by
  returning * into v_member;

  return v_member;
end;
$$;

-- Claims every pending invite addressed to the caller's verified email. Returns the number claimed.
create function public.accept_pending_invites()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text := lower(btrim(coalesce((select auth.jwt()) ->> 'email', '')));
  v_invite public.shop_members;
  v_claimed integer := 0;
begin
  if v_uid is null then
    raise exception 'Sign in to accept invites.' using errcode = '42501';
  end if;
  if v_email = '' then
    return 0;
  end if;

  for v_invite in
    select * from public.shop_members
    where user_id is null and invited_email = v_email
    for update
  loop
    if exists (
      select 1 from public.shop_members m where m.shop_id = v_invite.shop_id and m.user_id = v_uid
    ) then
      delete from public.shop_members where id = v_invite.id;
    else
      update public.shop_members
      set user_id = v_uid, joined_at = now()
      where id = v_invite.id;
      v_claimed := v_claimed + 1;
    end if;
  end loop;

  return v_claimed;
end;
$$;

-- Locks the shop's owner rows and fails if the change would leave the shop without an owner,
-- or would remove or demote the account owner.
create function private.assert_owner_change_allowed(p_member public.shop_members)
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
    raise exception 'The account owner cannot be removed or demoted.' using errcode = '22023';
  end if;
  if p_member.role = 'owner' and p_member.user_id is not null then
    select count(*) into v_other_owners
    from public.shop_members
    where shop_id = p_member.shop_id and role = 'owner' and user_id is not null and id <> p_member.id;
    if v_other_owners = 0 then
      raise exception 'A shop must keep at least one owner.' using errcode = '22023';
    end if;
  end if;
end;
$$;

create function public.update_member_role(p_member_id uuid, p_role text)
returns public.shop_members
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
  perform private.assert_shop_role(v_member.shop_id, array['owner']);

  if v_member.role = p_role then
    return v_member;
  end if;
  if v_member.role = 'owner' then
    perform private.assert_owner_change_allowed(v_member);
  end if;

  update public.shop_members set role = p_role where id = p_member_id returning * into v_member;
  return v_member;
end;
$$;

-- Owners can remove anyone; any member can remove themselves (leave the shop).
create function public.remove_shop_member(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.shop_members;
begin
  select * into v_member from public.shop_members where id = p_member_id for update;
  if not found then
    raise exception 'You do not have access to this shop.' using errcode = '42501';
  end if;
  if v_member.user_id is distinct from (select auth.uid()) then
    perform private.assert_shop_role(v_member.shop_id, array['owner']);
  end if;
  perform private.assert_owner_change_allowed(v_member);

  delete from public.shop_members where id = p_member_id;
end;
$$;

-- Privileges ----------------------------------------------------------------------
-- RLS policies run as the caller, so they need the read-only membership helpers. The assert_*
-- helpers are only called from security-definer functions and stay private.

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.my_shop_ids(text[]) to authenticated;
grant execute on function private.has_shop_role(uuid, text[]) to authenticated;
grant execute on function private.is_shop_member(uuid) to authenticated;
grant execute on function private.my_co_member_ids() to authenticated;

revoke all on function public.invite_shop_member(uuid, text, text) from public, anon;
revoke all on function public.accept_pending_invites() from public, anon;
revoke all on function public.update_member_role(uuid, text) from public, anon;
revoke all on function public.remove_shop_member(uuid) from public, anon;
grant execute on function public.invite_shop_member(uuid, text, text) to authenticated;
grant execute on function public.accept_pending_invites() to authenticated;
grant execute on function public.update_member_role(uuid, text) to authenticated;
grant execute on function public.remove_shop_member(uuid) to authenticated;
