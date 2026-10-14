-- Shop contact details: phone number, street address, town or city, and province.
--
-- All four are optional, so existing shops keep working and nobody is blocked from starting. They
-- are set when a shop is created (create_shop, admin_create_shop) and validated on the server.
-- Phone numbers are stored in international form: a South African number typed as 082 123 4567
-- becomes +27821234567; other countries must be entered with their + code.
--
-- Error codes the client relies on:
--   22023 invalid_parameter_value -> a detail is too long, the phone number or province is invalid

alter table public.shops
  add column phone text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  add column address text check (address is null or char_length(address) between 1 and 200),
  add column city text check (city is null or char_length(city) between 1 and 100),
  add column province text check (
    province is null or province in ('EC', 'FS', 'GP', 'KZN', 'LP', 'MP', 'NC', 'NW', 'WC')
  );

comment on column public.shops.phone is 'Shop phone number in international form, e.g. +27821234567.';
comment on column public.shops.address is 'Street address or stand number and area (suburb, township or village).';
comment on column public.shops.city is 'Town or city.';
comment on column public.shops.province is 'South African province code: EC, FS, GP, KZN, LP, MP, NC, NW or WC.';

-- Members read them like the other shop columns; changes go through the functions only.
grant select (phone, address, city, province) on public.shops to authenticated;

-- Validates and cleans the details. Blank values become null.
create function private.shop_contact(p_phone text, p_address text, p_city text, p_province text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[[:space:]().-]', '', 'g');
  v_address text := nullif(btrim(regexp_replace(coalesce(p_address, ''), '[[:space:]]+', ' ', 'g')), '');
  v_city text := nullif(btrim(regexp_replace(coalesce(p_city, ''), '[[:space:]]+', ' ', 'g')), '');
  v_province text := nullif(upper(btrim(coalesce(p_province, ''))), '');
begin
  if v_phone = '' then
    v_phone := null;
  elsif v_phone ~ '^0[0-9]{9}$' then
    v_phone := '+27' || substr(v_phone, 2);
  elsif v_phone ~ '^27[0-9]{9}$' then
    v_phone := '+' || v_phone;
  elsif v_phone ~ '^00[1-9][0-9]{7,14}$' then
    v_phone := '+' || substr(v_phone, 3);
  end if;
  if v_phone is not null and v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Enter a valid phone number, for example 082 123 4567 or +27 82 123 4567.'
      using errcode = '22023';
  end if;
  if char_length(v_address) > 200 then
    raise exception 'Address is too long (up to 200 characters).' using errcode = '22023';
  end if;
  if char_length(v_city) > 100 then
    raise exception 'Town or city is too long (up to 100 characters).' using errcode = '22023';
  end if;
  if v_province is not null and v_province not in ('EC', 'FS', 'GP', 'KZN', 'LP', 'MP', 'NC', 'NW', 'WC') then
    raise exception 'Unknown province.' using errcode = '22023';
  end if;
  return jsonb_build_object('phone', v_phone, 'address', v_address, 'city', v_city, 'province', v_province);
end;
$$;

revoke all on function private.shop_contact(text, text, text, text) from public, anon, authenticated;

-- Shop list and creation carry the details ----------------------------------------------------------

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
    'entitlements', private.shop_entitlements(s.id),
    'phone', s.phone,
    'address', s.address,
    'city', s.city,
    'province', s.province
  ) order by s.created_at, s.id), '[]'::jsonb)
  from public.shop_members m
  join public.shops s on s.id = m.shop_id
  where m.user_id = (select auth.uid()) and m.status = 'active';
$$;

drop function public.create_shop(text);

create function public.create_shop(
  p_name text,
  p_phone text default null,
  p_address text default null,
  p_city text default null,
  p_province text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := btrim(coalesce(p_name, ''));
  v_contact jsonb;
  v_shop public.shops;
begin
  if v_uid is null then
    raise exception 'Sign in to create a shop.' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 120 then
    raise exception 'Shop name is required (up to 120 characters).' using errcode = '22023';
  end if;
  v_contact := private.shop_contact(p_phone, p_address, p_city, p_province);

  insert into public.shops (owner_id, name, phone, address, city, province)
  values (
    v_uid, v_name, v_contact ->> 'phone', v_contact ->> 'address', v_contact ->> 'city', v_contact ->> 'province'
  )
  returning * into v_shop;

  return jsonb_build_object(
    'id', v_shop.id,
    'name', v_shop.name,
    'timezone', v_shop.timezone,
    'expiry_reminder_days', v_shop.expiry_reminder_days,
    'role', 'owner',
    'is_account_owner', true,
    'status', v_shop.status,
    'entitlements', private.shop_entitlements(v_shop.id),
    'phone', v_shop.phone,
    'address', v_shop.address,
    'city', v_shop.city,
    'province', v_shop.province
  );
end;
$$;

revoke all on function public.create_shop(text, text, text, text, text) from public, anon;
grant execute on function public.create_shop(text, text, text, text, text) to authenticated;

-- Platform administration ----------------------------------------------------------------------------

drop function public.admin_create_shop(text, text, text);

-- Creates a shop for an existing account with a confirmed email; that account becomes its owner.
create function public.admin_create_shop(
  p_owner_email text,
  p_name text,
  p_reason text,
  p_phone text default null,
  p_address text default null,
  p_city text default null,
  p_province text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_owner uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_contact jsonb;
  v_shop public.shops;
begin
  if not private.has_platform_permission('tenants.manage') then
    return private.platform_denied('tenant.create');
  end if;
  v_reason := private.require_reason(p_reason);
  if char_length(v_name) not between 1 and 120 then
    raise exception 'Shop name is required (up to 120 characters).' using errcode = '22023';
  end if;
  v_contact := private.shop_contact(p_phone, p_address, p_city, p_province);
  v_owner := private.find_confirmed_user(p_owner_email);

  insert into public.shops (owner_id, name, phone, address, city, province)
  values (
    v_owner, v_name, v_contact ->> 'phone', v_contact ->> 'address', v_contact ->> 'city', v_contact ->> 'province'
  )
  returning * into v_shop;

  perform private.audit(
    'tenant.created', 'success', 'shop', v_shop.id::text, v_shop.id, v_reason,
    jsonb_build_object('name', v_name, 'owner_email', private.user_email(v_owner))
  );
  return jsonb_build_object('ok', true, 'shop_id', v_shop.id);
end;
$$;

revoke all on function public.admin_create_shop(text, text, text, text, text, text, text) from public, anon;
grant execute on function public.admin_create_shop(text, text, text, text, text, text, text) to authenticated;

-- Tenant detail shows the contact details with the profile.
create or replace function public.admin_get_tenant(p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop public.shops;
  v_result jsonb;
begin
  if not private.has_platform_permission('tenants.view') then
    return private.platform_denied('tenant.view', 'shop', p_shop_id::text, p_shop_id);
  end if;
  select * into v_shop from public.shops where id = p_shop_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  v_result := jsonb_build_object(
    'ok', true,
    'shop', jsonb_build_object(
      'id', v_shop.id,
      'name', v_shop.name,
      'status', v_shop.status,
      'suspended_at', v_shop.suspended_at,
      'suspension_reason', v_shop.suspension_reason,
      'suspended_by_email', private.user_email(v_shop.suspended_by),
      'timezone', v_shop.timezone,
      'expiry_reminder_days', to_jsonb(v_shop.expiry_reminder_days),
      'created_at', v_shop.created_at,
      'phone', v_shop.phone,
      'address', v_shop.address,
      'city', v_shop.city,
      'province', v_shop.province
    ),
    'owner', (
      select jsonb_build_object(
        'id', u.id, 'email', lower(u.email), 'display_name', p.display_name,
        'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at,
        'email_confirmed', u.email_confirmed_at is not null
      )
      from auth.users u left join public.profiles p on p.id = u.id
      where u.id = v_shop.owner_id
    ),
    'members', (
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
        'joined_at', m.joined_at,
        'last_sign_in_at', u.last_sign_in_at
      ) order by m.user_id is null, m.role <> 'owner', m.created_at), '[]'::jsonb)
      from public.shop_members m
      left join auth.users u on u.id = m.user_id
      left join public.profiles p on p.id = m.user_id
      where m.shop_id = p_shop_id
    ),
    'outlets', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'status', s.status, 'created_at', s.created_at
      ) order by s.created_at), '[]'::jsonb)
      from public.shops s
      where s.owner_id = v_shop.owner_id and s.id <> v_shop.id
    ),
    'inventory', (
      select jsonb_build_object(
        'products', count(*),
        'active_products', count(*) filter (where pr.archived_at is null),
        'archived_products', count(*) filter (where pr.archived_at is not null)
      )
      from public.products pr where pr.shop_id = p_shop_id
    ) || (
      select jsonb_build_object(
        'batches_in_stock', count(*),
        'units_in_stock', coalesce(sum(b.quantity), 0),
        'stock_value_at_cost', coalesce(sum(b.quantity * b.cost_price_per_unit), 0),
        'batches_without_cost', count(*) filter (where b.cost_price_per_unit is null)
      )
      from public.stock_batches b where b.shop_id = p_shop_id and b.quantity > 0
    ),
    'activity', (
      select jsonb_build_object(
        'last_movement_at', max(m.created_at),
        'movements_30d', count(*) filter (where m.created_at > now() - interval '30 days')
      )
      from public.stock_movements m where m.shop_id = p_shop_id
    ) || jsonb_build_object(
      'sales_30d', (
        select count(*) from public.sales s where s.shop_id = p_shop_id and s.created_at > now() - interval '30 days'
      ),
      'open_expiry_alerts', (
        select count(*) from public.expiry_alerts a where a.shop_id = p_shop_id and a.resolved_at is null
      ),
      'sync_failures_7d', (
        select coalesce(sum(r.occurrences), 0) from public.sync_failure_reports r
        where r.shop_id = p_shop_id and r.last_seen > now() - interval '7 days'
      )
    ),
    'subscription', (
      select jsonb_build_object(
        'plan', s.plan, 'status', s.status, 'trial_ends_at', s.trial_ends_at,
        'current_period_end', s.current_period_end, 'provider', s.provider,
        'created_at', s.created_at, 'updated_at', s.updated_at
      )
      from public.subscriptions s where s.shop_id = p_shop_id
    ),
    'entitlements', private.shop_entitlements(p_shop_id),
    'usage', jsonb_build_object(
      'team_members', private.team_size(p_shop_id),
      'team_limit', private.entitlement_limit(p_shop_id, 'team.max_members')
    ),
    'history', jsonb_build_object(
      'membership', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'occurred_at', e.created_at, 'action', e.action, 'target_email', e.target_email,
          'actor_email', private.user_email(e.actor_id), 'old_role', e.old_role, 'new_role', e.new_role
        ) order by e.created_at desc), '[]'::jsonb)
        from (
          select * from public.membership_events me where me.shop_id = p_shop_id
          order by me.created_at desc limit 50
        ) e
      ),
      'subscription', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'occurred_at', e.occurred_at, 'event', e.event, 'actor_email', private.user_email(e.actor_id),
          'old_plan', e.old_plan, 'new_plan', e.new_plan, 'old_status', e.old_status, 'new_status', e.new_status
        ) order by e.occurred_at desc), '[]'::jsonb)
        from (
          select * from public.subscription_events se where se.shop_id = p_shop_id
          order by se.occurred_at desc limit 50
        ) e
      ),
      'admin', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'occurred_at', l.occurred_at, 'action', l.action, 'actor_email', l.actor_email,
          'reason', l.reason, 'outcome', l.outcome
        ) order by l.occurred_at desc), '[]'::jsonb)
        from (
          select * from public.platform_audit_log al where al.shop_id = p_shop_id
          order by al.occurred_at desc limit 50
        ) l
      )
    )
  );

  perform private.audit('tenant.viewed', 'success', 'shop', p_shop_id::text, p_shop_id);
  return v_result;
end;
$$;
