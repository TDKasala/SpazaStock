-- Optional GPS point captured when a shop is created. Both coordinates are stored, or neither.
alter table public.shops
  add column latitude double precision,
  add column longitude double precision,
  add constraint shops_location_pair check (
    (latitude is null and longitude is null) or (latitude is not null and longitude is not null)
  ),
  add constraint shops_latitude_range check (latitude is null or latitude between -90 and 90),
  add constraint shops_longitude_range check (longitude is null or longitude between -180 and 180);

comment on column public.shops.latitude is 'GPS latitude in decimal degrees, captured from the phone when the shop is created.';
comment on column public.shops.longitude is 'GPS longitude in decimal degrees, captured from the phone when the shop is created.';

grant select (latitude, longitude) on public.shops to authenticated;

create function private.shop_location(p_latitude double precision, p_longitude double precision)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_latitude is null and p_longitude is null then
    return jsonb_build_object('latitude', null, 'longitude', null);
  end if;
  if p_latitude is null or p_longitude is null then
    raise exception 'Latitude and longitude must be given together.' using errcode = '22023';
  end if;
  if p_latitude < -90 or p_latitude > 90 or p_longitude < -180 or p_longitude > 180 then
    raise exception 'Location is outside the valid range.' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'latitude', round(p_latitude::numeric, 6),
    'longitude', round(p_longitude::numeric, 6)
  );
end;
$$;

revoke all on function private.shop_location(double precision, double precision) from public, anon, authenticated;

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
    'province', s.province,
    'latitude', s.latitude,
    'longitude', s.longitude
  ) order by s.created_at, s.id), '[]'::jsonb)
  from public.shop_members m
  join public.shops s on s.id = m.shop_id
  where m.user_id = (select auth.uid()) and m.status = 'active';
$$;

drop function public.create_shop(text, text, text, text, text);

create function public.create_shop(
  p_name text,
  p_phone text default null,
  p_address text default null,
  p_city text default null,
  p_province text default null,
  p_latitude double precision default null,
  p_longitude double precision default null
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
  v_location jsonb;
  v_shop public.shops;
begin
  if v_uid is null then
    raise exception 'Sign in to create a shop.' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 120 then
    raise exception 'Shop name is required (up to 120 characters).' using errcode = '22023';
  end if;
  v_contact := private.shop_contact(p_phone, p_address, p_city, p_province);
  v_location := private.shop_location(p_latitude, p_longitude);

  insert into public.shops (owner_id, name, phone, address, city, province, latitude, longitude)
  values (
    v_uid,
    v_name,
    v_contact ->> 'phone',
    v_contact ->> 'address',
    v_contact ->> 'city',
    v_contact ->> 'province',
    (v_location ->> 'latitude')::double precision,
    (v_location ->> 'longitude')::double precision
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
    'province', v_shop.province,
    'latitude', v_shop.latitude,
    'longitude', v_shop.longitude
  );
end;
$$;

revoke all on function public.create_shop(text, text, text, text, text, double precision, double precision) from public, anon;
grant execute on function public.create_shop(text, text, text, text, text, double precision, double precision) to authenticated;

drop function public.admin_create_shop(text, text, text, text, text, text, text);

create function public.admin_create_shop(
  p_owner_email text,
  p_name text,
  p_reason text,
  p_phone text default null,
  p_address text default null,
  p_city text default null,
  p_province text default null,
  p_latitude double precision default null,
  p_longitude double precision default null
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
  v_location jsonb;
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
  v_location := private.shop_location(p_latitude, p_longitude);
  v_owner := private.find_confirmed_user(p_owner_email);

  insert into public.shops (owner_id, name, phone, address, city, province, latitude, longitude)
  values (
    v_owner,
    v_name,
    v_contact ->> 'phone',
    v_contact ->> 'address',
    v_contact ->> 'city',
    v_contact ->> 'province',
    (v_location ->> 'latitude')::double precision,
    (v_location ->> 'longitude')::double precision
  )
  returning * into v_shop;

  perform private.audit(
    'tenant.created', 'success', 'shop', v_shop.id::text, v_shop.id, v_reason,
    jsonb_build_object('name', v_name, 'owner_email', private.user_email(v_owner))
  );
  return jsonb_build_object('ok', true, 'shop_id', v_shop.id);
end;
$$;

revoke all on function public.admin_create_shop(text, text, text, text, text, text, text, double precision, double precision) from public, anon;
grant execute on function public.admin_create_shop(text, text, text, text, text, text, text, double precision, double precision) to authenticated;

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
      'province', v_shop.province,
      'latitude', v_shop.latitude,
      'longitude', v_shop.longitude
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
