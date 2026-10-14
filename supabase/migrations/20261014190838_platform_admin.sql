-- Platform administration: administrator roles, their permission matrix and an append-only audit
-- log.
--
-- Platform administrators are a separate population from shop members. A platform role grants
-- nothing through shop policies or shop functions, and a shop role grants nothing here. Every
-- administrative action is a security-definer function that re-checks the caller's active
-- platform role on each call, so revoking an administrator takes effect immediately.
--
-- Nobody is an administrator after this migration. The database owner grants the first
-- superadmin once with private.bootstrap_superadmin (see the README runbook); superadmins grant
-- everyone else from the admin screens.

-- Administrators ----------------------------------------------------------------------------------

create table private.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('superadmin', 'support', 'billing', 'analyst')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint platform_admins_revoked_consistent check ((status = 'revoked') = (revoked_at is not null))
);

create index platform_admins_granted_by_idx on private.platform_admins (granted_by);
create index platform_admins_revoked_by_idx on private.platform_admins (revoked_by);

create trigger platform_admins_set_updated_at before update on private.platform_admins
  for each row execute function public.set_updated_at();

revoke all on table private.platform_admins from public, anon, authenticated;

-- Platform permission matrix -----------------------------------------------------------------------
-- Edit permissions here (in a migration) and mirror them in src/admin/permissions.ts; a test keeps
-- the two in step.

create table private.platform_role_permissions (
  role text not null check (role in ('superadmin', 'support', 'billing', 'analyst')),
  permission text not null check (permission ~ '^[a-z]+\.[a-z_]+$'),
  primary key (role, permission)
);

revoke all on table private.platform_role_permissions from public, anon, authenticated;

insert into private.platform_role_permissions (role, permission) values
  ('superadmin', 'admins.manage'),
  ('superadmin', 'tenants.view'),
  ('superadmin', 'tenants.manage'),
  ('superadmin', 'tenants.export'),
  ('superadmin', 'billing.view'),
  ('superadmin', 'billing.manage'),
  ('superadmin', 'plans.manage'),
  ('superadmin', 'analytics.view'),
  ('superadmin', 'operations.view'),
  ('superadmin', 'audit.view'),
  ('support', 'tenants.view'),
  ('support', 'operations.view'),
  ('billing', 'tenants.view'),
  ('billing', 'billing.view'),
  ('billing', 'billing.manage'),
  ('analyst', 'analytics.view');

-- Audit log ---------------------------------------------------------------------------------------
-- No foreign keys, so the record outlives deleted shops and accounts. Clients have no access; the
-- admin screens read it through admin_list_audit. Rows can never be changed or removed.

create table public.platform_audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id uuid,
  actor_email text check (actor_email is null or char_length(actor_email) <= 320),
  actor_role text check (actor_role is null or char_length(actor_role) <= 40),
  action text not null check (action ~ '^[a-z]+\.[a-z_]+$'),
  target_type text check (target_type is null or target_type in ('shop', 'user', 'admin', 'plan', 'feature', 'subscription', 'platform')),
  target_id text check (target_id is null or char_length(target_id) <= 200),
  shop_id uuid,
  reason text check (reason is null or char_length(reason) <= 500),
  outcome text not null check (outcome in ('success', 'denied')),
  details jsonb not null default '{}'::jsonb
);

comment on table public.platform_audit_log is
  'Append-only record of platform administration: who did what, to which target, why, and the outcome.';

create index platform_audit_log_occurred_idx on public.platform_audit_log (occurred_at desc);
create index platform_audit_log_actor_idx on public.platform_audit_log (actor_id, occurred_at desc);
create index platform_audit_log_target_idx on public.platform_audit_log (target_id);
create index platform_audit_log_shop_idx on public.platform_audit_log (shop_id, occurred_at desc);
create index platform_audit_log_action_idx on public.platform_audit_log (action, occurred_at desc);

alter table public.platform_audit_log enable row level security;
revoke all on table public.platform_audit_log from public, anon, authenticated;

-- Shared by every append-only table.
create function private.reject_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only.', tg_table_name using errcode = '42501';
end;
$$;

create trigger platform_audit_log_append_only
  before update or delete on public.platform_audit_log
  for each row execute function private.reject_change();
create trigger platform_audit_log_no_truncate
  before truncate on public.platform_audit_log
  for each statement execute function private.reject_change();

-- Helpers -----------------------------------------------------------------------------------------

-- The caller's active platform role, or null.
create function private.platform_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select a.role from private.platform_admins a
  where a.user_id = (select auth.uid()) and a.status = 'active';
$$;

create function private.has_platform_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.platform_admins a
    join private.platform_role_permissions rp on rp.role = a.role
    where a.user_id = (select auth.uid()) and a.status = 'active' and rp.permission = p_permission
  );
$$;

create function private.audit(
  p_action text,
  p_outcome text,
  p_target_type text default null,
  p_target_id text default null,
  p_shop_id uuid default null,
  p_reason text default null,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  insert into public.platform_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, shop_id, reason, outcome, details
  )
  values (
    v_uid,
    coalesce(private.user_email(v_uid), case when v_uid is null then 'db:' || current_user end),
    private.platform_role(),
    p_action, p_target_type, p_target_id, p_shop_id,
    nullif(btrim(coalesce(p_reason, '')), ''),
    p_outcome,
    coalesce(p_details, '{}'::jsonb)
  );
end;
$$;

-- Records a refused administrative call and returns the refusal. Callers return this instead of
-- raising, because raising would roll back the audit row. A burst of identical refusals from one
-- caller is recorded once per 10 seconds so the log cannot be flooded.
create function private.platform_denied(
  p_action text,
  p_target_type text default null,
  p_target_id text default null,
  p_shop_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.platform_audit_log l
    where l.actor_id is not distinct from (select auth.uid()) and l.action = p_action
      and l.outcome = 'denied' and l.occurred_at > now() - interval '10 seconds'
  ) then
    perform private.audit(p_action, 'denied', p_target_type, p_target_id, p_shop_id);
  end if;
  return jsonb_build_object('ok', false, 'code', 'forbidden');
end;
$$;

-- Sensitive actions carry a reason of 10 to 500 characters.
create function private.require_reason(p_reason text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if char_length(v_reason) not between 10 and 500 then
    raise exception 'A reason of 10 to 500 characters is required.' using errcode = '22023';
  end if;
  return v_reason;
end;
$$;

-- Bootstrap ---------------------------------------------------------------------------------------
-- Run once by the database owner from the SQL editor:
--   select private.bootstrap_superadmin('you@example.com', 'First platform administrator');
-- Refused once any active superadmin exists; from then on superadmins grant roles in the app.

create function private.bootstrap_superadmin(p_email text, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_reason text := private.require_reason(p_reason);
  v_user uuid;
begin
  lock table private.platform_admins in share row exclusive mode;
  if exists (select 1 from private.platform_admins where role = 'superadmin' and status = 'active') then
    raise exception 'A superadmin already exists. Grant further roles from the admin screens.'
      using errcode = '55000';
  end if;

  select u.id into v_user
  from auth.users u
  where lower(u.email) = v_email and u.email_confirmed_at is not null;
  if v_user is null then
    raise exception 'No account with a confirmed email address matches %.', v_email using errcode = '22023';
  end if;

  insert into private.platform_admins (user_id, role, status, granted_by, granted_at)
  values (v_user, 'superadmin', 'active', null, now())
  on conflict (user_id) do update
    set role = 'superadmin', status = 'active', granted_by = null, granted_at = now(),
        revoked_by = null, revoked_at = null;

  perform private.audit(
    'admin.bootstrap', 'success', 'admin', v_user::text, null, v_reason,
    jsonb_build_object('role', 'superadmin', 'email', v_email)
  );
  return v_user;
end;
$$;

-- Privileges --------------------------------------------------------------------------------------

revoke all on function private.reject_change() from public, anon, authenticated;
revoke all on function private.platform_role() from public, anon, authenticated;
revoke all on function private.has_platform_permission(text) from public, anon, authenticated;
revoke all on function private.audit(text, text, text, text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function private.platform_denied(text, text, text, uuid) from public, anon, authenticated;
revoke all on function private.require_reason(text) from public, anon, authenticated;
revoke all on function private.bootstrap_superadmin(text, text) from public, anon, authenticated, service_role;
