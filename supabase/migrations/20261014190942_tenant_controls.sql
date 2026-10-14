-- Tenant controls: shop suspension, plans with server-enforced entitlements, subscription history
-- and offline sync failure reports.
--
-- Error codes the client relies on:
--   SP001 the shop is suspended; the change stays queued on the phone until it is reactivated
--   SP002 the shop's plan does not allow this (for example the team member limit)

-- Shop suspension ---------------------------------------------------------------------------------

alter table public.shops
  add column status text not null default 'active' check (status in ('active', 'suspended')),
  add column suspended_at timestamptz,
  add column suspended_by uuid references auth.users (id) on delete set null,
  add column suspension_reason text check (suspension_reason is null or char_length(suspension_reason) <= 500),
  add constraint shops_suspension_consistent check ((status = 'suspended') = (suspended_at is not null));

create index shops_status_created_idx on public.shops (status, created_at desc);
create index shops_created_at_idx on public.shops (created_at desc);
create index shops_suspended_by_idx on public.shops (suspended_by);

-- Members may see whether their shop is suspended, but not who suspended it or the internal reason.
revoke select on table public.shops from authenticated;
grant select (id, owner_id, name, timezone, expiry_reminder_days, status, suspended_at, created_at, updated_at)
  on public.shops to authenticated;

create function private.shop_is_active(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.status = 'active' from public.shops s where s.id = p_shop_id), true);
$$;

-- Every shop function checks access through one of these two helpers, so suspension is enforced in
-- one place. Membership is checked first, so outsiders never learn whether a shop is suspended.
create or replace function private.assert_shop_role(p_shop_id uuid, p_roles text[])
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
  if not private.shop_is_active(p_shop_id) then
    raise exception 'This shop is suspended. Changes stay on this phone until it is reactivated.'
      using errcode = 'SP001';
  end if;
end;
$$;

create or replace function private.assert_permission(p_shop_id uuid, p_permission text)
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
  if not private.shop_is_active(p_shop_id) then
    raise exception 'This shop is suspended. Changes stay on this phone until it is reactivated.'
      using errcode = 'SP001';
  end if;
end;
$$;

-- The team screen is a read, so it stays available while the shop is suspended.
create or replace function public.list_shop_team(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not private.has_permission(p_shop_id, 'team.manage') then
    raise exception 'You do not have access to this shop.' using errcode = '42501';
  end if;
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

-- Direct client writes (product registration, discrepancy resolution, renaming) raise the same
-- error instead of silently matching no rows, so the phone keeps the change queued. Writes made by
-- other triggers or foreign-key actions (an account being deleted) are side effects, not requests,
-- and pass.
create function private.reject_write_to_suspended_shop()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_trigger_depth() = 1 and not private.shop_is_active(new.shop_id) then
    raise exception 'This shop is suspended. Changes stay on this phone until it is reactivated.'
      using errcode = 'SP001';
  end if;
  return new;
end;
$$;

create trigger products_reject_suspended
  before insert or update on public.products
  for each row execute function private.reject_write_to_suspended_shop();
create trigger stock_discrepancies_reject_suspended
  before insert or update on public.stock_discrepancies
  for each row execute function private.reject_write_to_suspended_shop();

-- Suspending and reactivating change status; anything else while suspended is refused.
create function private.reject_suspended_shop_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_trigger_depth() = 1 and old.status = 'suspended' and new.status = 'suspended' then
    raise exception 'This shop is suspended. Changes stay on this phone until it is reactivated.'
      using errcode = 'SP001';
  end if;
  return new;
end;
$$;

create trigger shops_reject_suspended_update
  before update on public.shops
  for each row execute function private.reject_suspended_shop_update();

-- Plans and entitlements --------------------------------------------------------------------------

create table public.plans (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,31}$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  price_cents integer check (price_cents is null or price_cents between 0 and 100000000),
  currency text not null default 'ZAR' check (currency ~ '^[A-Z]{3}$'),
  billing_interval text not null default 'month' check (billing_interval in ('month', 'year')),
  trial_days integer not null default 0 check (trial_days between 0 and 365),
  grace_days integer not null default 7 check (grace_days between 0 and 90),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.plans.price_cents is 'List price in cents; null until an administrator sets it.';

create trigger plans_set_updated_at before update on public.plans
  for each row execute function public.set_updated_at();

alter table public.plans enable row level security;
revoke all on table public.plans from anon, authenticated;
grant select on table public.plans to authenticated;
create policy "Signed-in users can view plans" on public.plans for select to authenticated using (true);

-- What can be switched per plan. 'boolean' keys are on or off; 'limit' keys carry a number, where
-- null means unlimited.
create table private.entitlement_catalog (
  key text primary key check (key ~ '^[a-z][a-z_.]{1,63}$'),
  kind text not null check (kind in ('boolean', 'limit')),
  description text not null
);

revoke all on table private.entitlement_catalog from public, anon, authenticated;

insert into private.entitlement_catalog (key, kind, description) values
  ('expiry_push', 'boolean', 'Expiry alerts delivered as push notifications'),
  ('team.max_members', 'limit', 'Team members, joined or invited, including owners');

create table public.plan_entitlements (
  plan_code text not null references public.plans (code) on update cascade on delete cascade,
  key text not null references private.entitlement_catalog (key),
  enabled boolean not null default true,
  limit_value integer check (limit_value is null or limit_value between 0 and 1000000),
  updated_at timestamptz not null default now(),
  primary key (plan_code, key)
);

create index plan_entitlements_key_idx on public.plan_entitlements (key);

create trigger plan_entitlements_set_updated_at before update on public.plan_entitlements
  for each row execute function public.set_updated_at();

alter table public.plan_entitlements enable row level security;
revoke all on table public.plan_entitlements from public, anon, authenticated;

-- Global switches for boolean features; off overrides every plan.
create table public.platform_features (
  key text primary key references private.entitlement_catalog (key),
  enabled boolean not null default true,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create index platform_features_updated_by_idx on public.platform_features (updated_by);

create trigger platform_features_set_updated_at before update on public.platform_features
  for each row execute function public.set_updated_at();

alter table public.platform_features enable row level security;
revoke all on table public.platform_features from public, anon, authenticated;

-- Everything starts enabled and unlimited, so no existing shop loses anything.
insert into public.plans (code, name, price_cents, trial_days, grace_days) values
  ('free', 'Free', 0, 0, 0),
  ('pro', 'Pro', null, 14, 7);
insert into public.plan_entitlements (plan_code, key, enabled, limit_value)
select p.code, c.key, true, null from public.plans p cross join private.entitlement_catalog c;
insert into public.platform_features (key, enabled)
select key, true from private.entitlement_catalog where kind = 'boolean';

-- Subscriptions -----------------------------------------------------------------------------------

alter table public.subscriptions drop constraint subscriptions_plan_check;
alter table public.subscriptions
  add constraint subscriptions_plan_fkey foreign key (plan) references public.plans (code) on update cascade,
  add column trial_ends_at timestamptz;

create index subscriptions_plan_idx on public.subscriptions (plan);
create index subscriptions_status_idx on public.subscriptions (status);

-- One row per change, written by a trigger, so cancellations and conversions are counted from what
-- actually happened rather than inferred from the current state.
create table public.subscription_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  shop_id uuid not null,
  subscription_id uuid not null,
  actor_id uuid,
  event text not null check (event in ('created', 'plan_changed', 'status_changed', 'updated')),
  old_plan text,
  new_plan text,
  old_status text,
  new_status text,
  details jsonb not null default '{}'::jsonb
);

create index subscription_events_occurred_idx on public.subscription_events (occurred_at);
create index subscription_events_shop_idx on public.subscription_events (shop_id, occurred_at desc);
create index subscription_events_status_idx on public.subscription_events (new_status, occurred_at);

alter table public.subscription_events enable row level security;
revoke all on table public.subscription_events from public, anon, authenticated;

create trigger subscription_events_append_only
  before update or delete on public.subscription_events
  for each row execute function private.reject_change();

create function private.log_subscription_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.subscription_events (shop_id, subscription_id, actor_id, event, new_plan, new_status, details)
    values (
      new.shop_id, new.id, (select auth.uid()), 'created', new.plan, new.status,
      jsonb_build_object('trial_ends_at', new.trial_ends_at, 'current_period_end', new.current_period_end)
    );
    return new;
  end if;

  if new.plan is not distinct from old.plan and new.status is not distinct from old.status
     and new.trial_ends_at is not distinct from old.trial_ends_at
     and new.current_period_end is not distinct from old.current_period_end then
    return new;
  end if;

  insert into public.subscription_events (
    shop_id, subscription_id, actor_id, event, old_plan, new_plan, old_status, new_status, details
  )
  values (
    new.shop_id, new.id, (select auth.uid()),
    case
      when new.status is distinct from old.status then 'status_changed'
      when new.plan is distinct from old.plan then 'plan_changed'
      else 'updated'
    end,
    old.plan, new.plan, old.status, new.status,
    jsonb_build_object(
      'old_trial_ends_at', old.trial_ends_at, 'trial_ends_at', new.trial_ends_at,
      'old_current_period_end', old.current_period_end, 'current_period_end', new.current_period_end
    )
  );
  return new;
end;
$$;

create trigger subscriptions_log_events
  after insert or update on public.subscriptions
  for each row execute function private.log_subscription_event();

insert into public.subscription_events (occurred_at, shop_id, subscription_id, event, new_plan, new_status)
select s.created_at, s.shop_id, s.id, 'created', s.plan, s.status from public.subscriptions s;

-- The plan a shop is entitled to right now:
--   active                                   -> the subscribed plan
--   trialing, before trial_ends_at (or open) -> the subscribed plan
--   past_due, within the plan's grace days   -> the subscribed plan
--   anything else                            -> free
create function private.effective_plan(p_shop_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select s.plan
    from public.subscriptions s
    join public.plans p on p.code = s.plan
    where s.shop_id = p_shop_id
      and (
        s.status = 'active'
        or (s.status = 'trialing' and (s.trial_ends_at is null or s.trial_ends_at > now()))
        or (
          s.status = 'past_due' and s.current_period_end is not null
          and s.current_period_end + make_interval(days => p.grace_days) > now()
        )
      )
  ), 'free');
$$;

-- On unless the global switch or the shop's plan turns it off. A plan without a row for a key keeps
-- the default (on, unlimited).
create function private.entitled(p_shop_id uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select f.enabled from public.platform_features f where f.key = p_key), true)
     and coalesce((
       select e.enabled from public.plan_entitlements e
       where e.plan_code = private.effective_plan(p_shop_id) and e.key = p_key
     ), true);
$$;

-- The shop's limit for a 'limit' key: null is unlimited, a disabled entitlement is 0.
create function private.entitlement_limit(p_shop_id uuid, p_key text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case when e.enabled is false then 0 else e.limit_value end
  from (select private.effective_plan(p_shop_id) as plan) ep
  left join public.plan_entitlements e on e.plan_code = ep.plan and e.key = p_key;
$$;

create function private.shop_entitlements(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'plan', private.effective_plan(p_shop_id),
    'expiry_push', private.entitled(p_shop_id, 'expiry_push'),
    'team_max_members', private.entitlement_limit(p_shop_id, 'team.max_members')
  );
$$;

-- Joined (active) members plus pending invites that have not expired.
create function private.team_size(p_shop_id uuid, p_exclude_member uuid default null)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.shop_members m
  where m.shop_id = p_shop_id
    and m.id is distinct from p_exclude_member
    and (
      (m.user_id is not null and m.status = 'active')
      or (m.user_id is null and m.invite_expires_at > now())
    );
$$;

create function private.assert_team_capacity(p_shop_id uuid, p_exclude_member uuid default null)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := private.entitlement_limit(p_shop_id, 'team.max_members');
begin
  if v_limit is not null and private.team_size(p_shop_id, p_exclude_member) >= v_limit then
    raise exception 'This shop''s plan allows % team members.', v_limit using errcode = 'SP002';
  end if;
end;
$$;

-- Team functions with the member limit ------------------------------------------------------------

create or replace function public.invite_shop_member(p_shop_id uuid, p_email text, p_role text)
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
  v_existing uuid;
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

  -- Re-inviting a pending email replaces its invite, so it does not count twice.
  select id into v_existing from public.shop_members
  where shop_id = p_shop_id and user_id is null and invited_email = v_email;
  perform private.assert_team_capacity(p_shop_id, v_existing);

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

create or replace function public.accept_shop_invite(p_token text)
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
  if not private.shop_is_active(v_member.shop_id) then
    raise exception 'This shop is suspended. Try again once it is reactivated.' using errcode = 'SP001';
  end if;
  -- The limit may have been lowered since the invite was sent.
  perform private.assert_team_capacity(v_member.shop_id, v_member.id);

  update public.shop_members
  set user_id = v_uid, joined_at = now(), status = 'active',
      invite_token_hash = null, invite_expires_at = null
  where id = v_member.id
  returning * into v_member;

  return jsonb_build_object('shop_id', v_member.shop_id, 'member_id', v_member.id, 'role', v_member.role);
end;
$$;

-- Push delivery honours the plan and suspension ---------------------------------------------------

create or replace function public.claim_push_batch(p_limit integer default 50, p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_claimed jsonb;
begin
  update public.notifications n
  set push_status = 'skipped', push_next_at = null
  where n.push_status in ('pending', 'sending') and n.push_next_at <= v_now
    and (
      not exists (select 1 from public.push_subscriptions s where s.user_id = n.user_id)
      or not exists (
        select 1 from public.shop_members m where m.shop_id = n.shop_id and m.user_id = n.user_id
      )
      or not private.shop_is_active(n.shop_id)
      or not private.entitled(n.shop_id, 'expiry_push')
    );

  with due as (
    select n.id
    from public.notifications n
    where n.push_status in ('pending', 'sending') and n.push_next_at <= v_now
    order by n.push_next_at, n.id
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update skip locked
  ),
  claimed as (
    update public.notifications n
    set push_status = 'sending', push_attempts = n.push_attempts + 1, push_next_at = v_now + interval '10 minutes'
    from due
    where n.id = due.id
    returning n.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'notification_id', c.id,
    'title', c.title,
    'body', c.body,
    'data', c.data,
    'attempts', c.push_attempts,
    'subscriptions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth
      ) order by s.created_at), '[]'::jsonb)
      from public.push_subscriptions s where s.user_id = c.user_id
    )
  ) order by c.push_next_at, c.id), '[]'::jsonb)
  into v_claimed
  from claimed c;

  return v_claimed;
end;
$$;

-- Offline sync failure reports --------------------------------------------------------------------
-- Phones report changes the server refused for good: only the kind of change and the error code,
-- never the data or the message, aggregated per user and day.

create table public.sync_failure_reports (
  shop_id uuid not null references public.shops (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  op_type text not null check (op_type ~ '^[a-z_]{1,40}$'),
  error_code text not null check (error_code ~ '^[A-Za-z0-9_]{1,16}$'),
  occurrences integer not null default 1 check (occurrences between 1 and 1000000),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (shop_id, user_id, day, op_type, error_code)
);

create index sync_failure_reports_day_idx on public.sync_failure_reports (day);
create index sync_failure_reports_user_idx on public.sync_failure_reports (user_id);

alter table public.sync_failure_reports enable row level security;
revoke all on table public.sync_failure_reports from public, anon, authenticated;

-- p_reports: [{ "op_type": "sale", "error_code": "23505", "count": 2 }], at most 50 entries.
create function public.report_sync_failures(p_shop_id uuid, p_reports jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_report jsonb;
  v_op text;
  v_code text;
  v_count integer;
  v_recorded integer := 0;
begin
  -- Suspended shops may still report, so this checks membership only.
  if v_uid is null or not private.has_shop_role(p_shop_id, array['owner', 'manager', 'staff']) then
    raise exception 'You do not have access to this shop.' using errcode = '42501';
  end if;
  if p_reports is null or jsonb_typeof(p_reports) <> 'array' or jsonb_array_length(p_reports) > 50 then
    raise exception 'Reports must be an array of at most 50 entries.' using errcode = '22023';
  end if;

  for v_report in select value from jsonb_array_elements(p_reports) loop
    v_op := v_report ->> 'op_type';
    v_code := coalesce(nullif(v_report ->> 'error_code', ''), 'unknown');
    v_count := least(greatest(coalesce((v_report ->> 'count')::integer, 1), 1), 1000);
    if v_op is null or v_op !~ '^[a-z_]{1,40}$' or v_code !~ '^[A-Za-z0-9_]{1,16}$' then
      raise exception 'Invalid sync failure report.' using errcode = '22023';
    end if;

    insert into public.sync_failure_reports (shop_id, user_id, day, op_type, error_code, occurrences)
    values (p_shop_id, v_uid, (now() at time zone 'utc')::date, v_op, v_code, v_count)
    on conflict (shop_id, user_id, day, op_type, error_code) do update
      set occurrences = least(public.sync_failure_reports.occurrences + excluded.occurrences, 1000000),
          last_seen = now();
    v_recorded := v_recorded + 1;
  end loop;

  return v_recorded;
end;
$$;

-- Shop list carries status and entitlements -------------------------------------------------------

create or replace function public.my_shops()
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
    'is_account_owner', s.owner_id = m.user_id,
    'status', s.status,
    'entitlements', private.shop_entitlements(s.id)
  ) order by s.created_at, s.id), '[]'::jsonb)
  from public.shop_members m
  join public.shops s on s.id = m.shop_id
  where m.user_id = (select auth.uid()) and m.status = 'active';
$$;

create or replace function public.create_shop(p_name text)
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
    'is_account_owner', true,
    'status', v_shop.status,
    'entitlements', private.shop_entitlements(v_shop.id)
  );
end;
$$;

-- Indexes for platform-wide date ranges -----------------------------------------------------------

create index stock_movements_created_at_idx on public.stock_movements (created_at);
create index sales_created_at_idx on public.sales (created_at);
create index expiry_alerts_created_at_idx on public.expiry_alerts (created_at);
create index notifications_push_failed_idx on public.notifications (updated_at) where push_status = 'failed';

-- Privileges --------------------------------------------------------------------------------------

revoke all on function private.shop_is_active(uuid) from public, anon, authenticated;
revoke all on function private.reject_write_to_suspended_shop() from public, anon, authenticated;
revoke all on function private.reject_suspended_shop_update() from public, anon, authenticated;
revoke all on function private.log_subscription_event() from public, anon, authenticated;
revoke all on function private.effective_plan(uuid) from public, anon, authenticated;
revoke all on function private.entitled(uuid, text) from public, anon, authenticated;
revoke all on function private.entitlement_limit(uuid, text) from public, anon, authenticated;
revoke all on function private.shop_entitlements(uuid) from public, anon, authenticated;
revoke all on function private.team_size(uuid, uuid) from public, anon, authenticated;
revoke all on function private.assert_team_capacity(uuid, uuid) from public, anon, authenticated;

revoke all on function public.report_sync_failures(uuid, jsonb) from public, anon;
grant execute on function public.report_sync_failures(uuid, jsonb) to authenticated;
