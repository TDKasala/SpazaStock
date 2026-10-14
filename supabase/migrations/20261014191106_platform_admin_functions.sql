-- Platform administration functions (called by the /admin screens).
--
-- Every function is security definer and checks the caller's platform permission on each call.
-- All return jsonb: { "ok": true, ... } on success, or { "ok": false, "code": "forbidden" } when the
-- caller lacks the permission (that refusal is recorded in platform_audit_log, which is why it is
-- returned rather than raised). Invalid input raises 22023 and changes nothing.
--
-- Metrics come straight from the tables; nothing is estimated. Revenue is reported as unavailable
-- because no payment provider records payments yet. Date buckets use Africa/Johannesburg.

-- Shared helpers ----------------------------------------------------------------------------------

create function private.check_range(p_from timestamptz, p_to timestamptz)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception 'Choose a start date before the end date.' using errcode = '22023';
  end if;
  if p_to - p_from > interval '366 days' then
    raise exception 'Date ranges are limited to 366 days.' using errcode = '22023';
  end if;
end;
$$;

create function private.page_limit(p_limit integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select least(greatest(coalesce(p_limit, 25), 1), 100);
$$;

create function private.page_offset(p_offset integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select least(greatest(coalesce(p_offset, 0), 0), 1000000);
$$;

create function private.find_confirmed_user(p_email text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user uuid;
begin
  select u.id into v_user from auth.users u
  where lower(u.email) = v_email and u.email_confirmed_at is not null;
  if v_user is null then
    raise exception 'No account with a confirmed email address matches %.', v_email using errcode = '22023';
  end if;
  return v_user;
end;
$$;

-- Failed scheduler runs in a window, or null where pg_cron is not installed or readable.
create function private.cron_failures(p_from timestamptz, p_to timestamptz)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if to_regclass('cron.job_run_details') is null then
    return null;
  end if;
  execute $q$
    select count(*)::integer
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where j.jobname like 'expiry-alerts-%' and d.status = 'failed'
      and d.start_time >= $1 and d.start_time < $2
  $q$ into v_count using p_from, p_to;
  return v_count;
exception
  when others then
    return null;
end;
$$;

create function private.cron_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_jobs jsonb;
begin
  if to_regclass('cron.job_run_details') is null then
    return jsonb_build_object('available', false);
  end if;
  execute $q$
    select coalesce(jsonb_agg(jsonb_build_object(
      'job', j.jobname,
      'schedule', j.schedule,
      'active', j.active,
      'last_run_at', lr.start_time,
      'last_status', lr.status,
      'last_duration_ms', round(extract(epoch from (lr.end_time - lr.start_time)) * 1000),
      'last_success_at', ls.start_time,
      'runs_24h', st.runs,
      'failures_24h', st.failures,
      'last_failure_at', lf.start_time,
      'last_failure_message', left(lf.return_message, 300)
    ) order by j.jobname), '[]'::jsonb)
    from cron.job j
    left join lateral (
      select d.start_time, d.end_time, d.status from cron.job_run_details d
      where d.jobid = j.jobid order by d.start_time desc limit 1
    ) lr on true
    left join lateral (
      select d.start_time from cron.job_run_details d
      where d.jobid = j.jobid and d.status = 'succeeded' order by d.start_time desc limit 1
    ) ls on true
    left join lateral (
      select count(*) as runs, count(*) filter (where d.status = 'failed') as failures
      from cron.job_run_details d
      where d.jobid = j.jobid and d.start_time > now() - interval '24 hours'
    ) st on true
    left join lateral (
      select d.start_time, d.return_message from cron.job_run_details d
      where d.jobid = j.jobid and d.status = 'failed' order by d.start_time desc limit 1
    ) lf on true
    where j.jobname like 'expiry-alerts-%'
  $q$ into v_jobs;
  return jsonb_build_object('available', true, 'jobs', v_jobs);
exception
  when others then
    return jsonb_build_object('available', false);
end;
$$;

-- Tenant search shared by the list and the export.
create function private.tenant_search(p_search text, p_status text, p_plan text)
returns table (
  id uuid,
  name text,
  status text,
  created_at timestamptz,
  owner_id uuid,
  owner_email text,
  owner_name text,
  plan text,
  subscription_status text,
  member_count integer,
  product_count integer,
  last_activity_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_search text := btrim(coalesce(p_search, ''));
  v_pattern text;
  v_uuid uuid;
begin
  if char_length(v_search) > 100 then
    raise exception 'Search text is limited to 100 characters.' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('active', 'suspended') then
    raise exception 'Unknown shop status.' using errcode = '22023';
  end if;
  v_pattern := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  if v_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_uuid := v_search::uuid;
  end if;

  return query
  select
    s.id, s.name, s.status, s.created_at, s.owner_id,
    lower(u.email)::text, p.display_name, sub.plan, sub.status,
    (select count(*)::integer from public.shop_members m
      where m.shop_id = s.id and m.user_id is not null and m.status = 'active'),
    (select count(*)::integer from public.products pr where pr.shop_id = s.id and pr.archived_at is null),
    (select max(mv.created_at) from public.stock_movements mv where mv.shop_id = s.id)
  from public.shops s
  left join auth.users u on u.id = s.owner_id
  left join public.profiles p on p.id = s.owner_id
  left join public.subscriptions sub on sub.shop_id = s.id
  where (v_search = '' or s.name ilike v_pattern or u.email ilike v_pattern or s.id = v_uuid)
    and (p_status is null or s.status = p_status)
    and (p_plan is null or sub.plan = p_plan);
end;
$$;

create function private.assert_not_last_superadmin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from private.platform_admins where role = 'superadmin' and status = 'active' for update;
  if exists (
    select 1 from private.platform_admins
    where user_id = p_user_id and role = 'superadmin' and status = 'active'
  ) and not exists (
    select 1 from private.platform_admins
    where role = 'superadmin' and status = 'active' and user_id <> p_user_id
  ) then
    raise exception 'The last superadmin cannot be removed or demoted.' using errcode = '22023';
  end if;
end;
$$;

-- Who am I ----------------------------------------------------------------------------------------
-- Called by the shop app for every signed-in user, so a non-administrator is not a refusal.

create function public.admin_whoami()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text := private.platform_role();
begin
  return jsonb_build_object(
    'ok', true,
    'role', v_role,
    'email', case when v_role is not null then private.user_email((select auth.uid())) end,
    'permissions', coalesce((
      select jsonb_agg(rp.permission order by rp.permission)
      from private.platform_role_permissions rp where rp.role = v_role
    ), '[]'::jsonb)
  );
end;
$$;

-- Overview ----------------------------------------------------------------------------------------

create function public.admin_platform_overview(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.platform_role() is null then
    return private.platform_denied('overview.view');
  end if;
  perform private.check_range(p_from, p_to);

  return jsonb_build_object(
    'ok', true,
    'from', p_from,
    'to', p_to,
    'generated_at', now(),
    'shops', (
      select jsonb_build_object(
        'total', count(*),
        'active', count(*) filter (where s.status = 'active'),
        'suspended', count(*) filter (where s.status = 'suspended'),
        'new', count(*) filter (where s.created_at >= p_from and s.created_at < p_to)
      ) from public.shops s
    ),
    'users', (
      select jsonb_build_object(
        'registered', count(*),
        'confirmed', count(*) filter (where u.email_confirmed_at is not null),
        'new', count(*) filter (where u.created_at >= p_from and u.created_at < p_to)
      ) from auth.users u
    ),
    'subscriptions', jsonb_build_object(
      'by_status', (
        select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb)
        from (select s.status, count(*) as n from public.subscriptions s group by s.status) x
      ),
      'by_plan', (
        select coalesce(jsonb_object_agg(x.plan, x.n), '{}'::jsonb)
        from (select s.plan, count(*) as n from public.subscriptions s group by s.plan) x
      ),
      'active', (select count(*) from public.subscriptions s where s.status = 'active'),
      'trials_active', (
        select count(*) from public.subscriptions s
        where s.status = 'trialing' and (s.trial_ends_at is null or s.trial_ends_at > now())
      ),
      'cancellations', (
        select count(*) from public.subscription_events e
        where e.new_status = 'canceled' and e.old_status is distinct from 'canceled'
          and e.occurred_at >= p_from and e.occurred_at < p_to
      )
    ),
    'stock', (
      select jsonb_build_object(
        'movements', count(*),
        'units_in', coalesce(sum(m.quantity_delta) filter (where m.quantity_delta > 0), 0),
        'units_out', coalesce(-sum(m.quantity_delta) filter (where m.quantity_delta < 0), 0),
        'active_shops', count(distinct m.shop_id)
      )
      from public.stock_movements m
      where m.created_at >= p_from and m.created_at < p_to
    ),
    'stock_by_reason', (
      select coalesce(jsonb_object_agg(x.reason, x.n), '{}'::jsonb)
      from (
        select m.reason, count(*) as n from public.stock_movements m
        where m.created_at >= p_from and m.created_at < p_to group by m.reason
      ) x
    ),
    'sales', (select count(*) from public.sales s where s.created_at >= p_from and s.created_at < p_to),
    'expiry', jsonb_build_object(
      'created', (
        select count(*) from public.expiry_alerts a where a.created_at >= p_from and a.created_at < p_to
      ),
      'by_kind', (
        select coalesce(jsonb_object_agg(x.kind, x.n), '{}'::jsonb)
        from (
          select a.kind, count(*) as n from public.expiry_alerts a
          where a.created_at >= p_from and a.created_at < p_to group by a.kind
        ) x
      ),
      'resolved', (
        select count(*) from public.expiry_alerts a where a.resolved_at >= p_from and a.resolved_at < p_to
      ),
      'by_resolution', (
        select coalesce(jsonb_object_agg(x.resolution, x.n), '{}'::jsonb)
        from (
          select a.resolution, count(*) as n from public.expiry_alerts a
          where a.resolved_at >= p_from and a.resolved_at < p_to group by a.resolution
        ) x
      ),
      'open', (select count(*) from public.expiry_alerts a where a.resolved_at is null)
    ),
    'errors', jsonb_build_object(
      'push_failed', (
        select count(*) from public.notifications n
        where n.push_status = 'failed' and n.updated_at >= p_from and n.updated_at < p_to
      ),
      'sync_failures', (
        select coalesce(sum(r.occurrences), 0) from public.sync_failure_reports r
        where r.last_seen >= p_from and r.first_seen < p_to
      ),
      'cron_failures', private.cron_failures(p_from, p_to)
    ),
    'revenue', jsonb_build_object('available', false, 'reason', 'no_payment_provider')
  );
end;
$$;

-- p_metric: shops | users | stock_movements | sales | expiry_alerts | active_shops
-- p_bucket: day | week | month
create function public.admin_growth_series(p_metric text, p_from timestamptz, p_to timestamptz, p_bucket text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz constant text := 'Africa/Johannesburg';
  v_series jsonb;
begin
  if private.platform_role() is null then
    return private.platform_denied('analytics.series');
  end if;
  perform private.check_range(p_from, p_to);
  if p_bucket is null or p_bucket not in ('day', 'week', 'month') then
    raise exception 'Bucket must be day, week or month.' using errcode = '22023';
  end if;
  if p_metric is null or p_metric not in ('shops', 'users', 'stock_movements', 'sales', 'expiry_alerts', 'active_shops') then
    raise exception 'Unknown metric.' using errcode = '22023';
  end if;

  with buckets as (
    select generate_series(
      date_trunc(p_bucket, p_from at time zone v_tz),
      (p_to at time zone v_tz) - interval '1 microsecond',
      ('1 ' || p_bucket)::interval
    ) as bucket
  ),
  events as (
    select date_trunc(p_bucket, s.created_at at time zone v_tz) as bucket, null::uuid as shop_id
    from public.shops s
    where p_metric = 'shops' and s.created_at >= p_from and s.created_at < p_to
    union all
    select date_trunc(p_bucket, u.created_at at time zone v_tz), null
    from auth.users u
    where p_metric = 'users' and u.created_at >= p_from and u.created_at < p_to
    union all
    select date_trunc(p_bucket, m.created_at at time zone v_tz), m.shop_id
    from public.stock_movements m
    where p_metric in ('stock_movements', 'active_shops') and m.created_at >= p_from and m.created_at < p_to
    union all
    select date_trunc(p_bucket, s.created_at at time zone v_tz), null
    from public.sales s
    where p_metric = 'sales' and s.created_at >= p_from and s.created_at < p_to
    union all
    select date_trunc(p_bucket, a.created_at at time zone v_tz), null
    from public.expiry_alerts a
    where p_metric = 'expiry_alerts' and a.created_at >= p_from and a.created_at < p_to
  ),
  counted as (
    select e.bucket,
           case when p_metric = 'active_shops' then count(distinct e.shop_id) else count(*) end as n
    from events e group by e.bucket
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'bucket', to_char(b.bucket, 'YYYY-MM-DD'),
    'value', coalesce(c.n, 0)
  ) order by b.bucket), '[]'::jsonb)
  into v_series
  from buckets b left join counted c on c.bucket = b.bucket;

  return jsonb_build_object('ok', true, 'metric', p_metric, 'bucket', p_bucket, 'timezone', v_tz, 'series', v_series);
end;
$$;

-- Analytics ---------------------------------------------------------------------------------------

create function public.admin_analytics(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz constant text := 'Africa/Johannesburg';
  v_first_month timestamp;
  v_retention jsonb;
begin
  if not private.has_platform_permission('analytics.view') then
    return private.platform_denied('analytics.view');
  end if;
  perform private.check_range(p_from, p_to);

  -- Six monthly cohorts ending with the month of p_to: shops created in each month, and how many
  -- of them recorded a stock movement in that month and each month after.
  v_first_month := date_trunc('month', p_to at time zone v_tz) - interval '5 months';
  with months as (
    select generate_series(v_first_month, date_trunc('month', p_to at time zone v_tz), interval '1 month') as month_start
  ),
  cohort as (
    select s.id, date_trunc('month', s.created_at at time zone v_tz) as month_start
    from public.shops s
    where s.created_at >= (v_first_month at time zone v_tz) and s.created_at < p_to
  ),
  activity as (
    select distinct m.shop_id, date_trunc('month', m.created_at at time zone v_tz) as month_start
    from public.stock_movements m
    where m.created_at >= (v_first_month at time zone v_tz) and m.created_at < p_to
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'cohort', to_char(mo.month_start, 'YYYY-MM'),
    'size', (select count(*) from cohort c where c.month_start = mo.month_start),
    'active', (
      select coalesce(jsonb_agg((
        select count(distinct c.id) from cohort c
        join activity a on a.shop_id = c.id and a.month_start = later.month_start
        where c.month_start = mo.month_start
      ) order by later.month_start), '[]'::jsonb)
      from months later where later.month_start >= mo.month_start
    )
  ) order by mo.month_start), '[]'::jsonb)
  into v_retention
  from months mo;

  return jsonb_build_object(
    'ok', true,
    'from', p_from,
    'to', p_to,
    'timezone', v_tz,
    'tenants', (
      select jsonb_build_object(
        'at_start', count(*) filter (where s.created_at < p_from),
        'at_end', count(*) filter (where s.created_at < p_to),
        'new', count(*) filter (where s.created_at >= p_from and s.created_at < p_to)
      ) from public.shops s
    ),
    'usage', (
      select jsonb_build_object(
        'active_shops', count(distinct m.shop_id),
        'active_users', count(distinct m.actor_id)
      )
      from public.stock_movements m
      where m.created_at >= p_from and m.created_at < p_to
    ),
    'retention', v_retention,
    'conversion', (
      select jsonb_build_object(
        'trials_started', count(*) filter (where e.new_status = 'trialing' and e.old_status is distinct from 'trialing'),
        'trials_converted', count(*) filter (where e.old_status = 'trialing' and e.new_status = 'active'),
        'trials_lapsed', count(*) filter (where e.old_status = 'trialing' and e.new_status in ('past_due', 'canceled'))
      )
      from public.subscription_events e
      where e.occurred_at >= p_from and e.occurred_at < p_to
    ),
    'plan_distribution', jsonb_build_object(
      'subscribed', (
        select coalesce(jsonb_object_agg(x.plan, x.n), '{}'::jsonb)
        from (select s.plan, count(*) as n from public.subscriptions s group by s.plan) x
      ),
      'effective', (
        select coalesce(jsonb_object_agg(x.plan, x.n), '{}'::jsonb)
        from (
          select private.effective_plan(s.id) as plan, count(*) as n from public.shops s group by 1
        ) x
      )
    ),
    'feature_adoption', jsonb_build_object(
      'shops', (select count(*) from public.shops),
      'push_enabled', (
        select count(distinct m.shop_id) from public.shop_members m
        where m.status = 'active' and m.user_id in (select ps.user_id from public.push_subscriptions ps)
      ),
      'teams', (
        select count(*) from (
          select m.shop_id from public.shop_members m
          where m.user_id is not null and m.status = 'active'
          group by m.shop_id having count(*) > 1
        ) t
      ),
      'expiry_tracking', (
        select count(distinct b.shop_id) from public.stock_batches b where b.expiry_date is not null
      )
    ),
    'stock_volumes', (
      select coalesce(jsonb_object_agg(x.reason, jsonb_build_object('movements', x.n, 'units', x.units)), '{}'::jsonb)
      from (
        select m.reason, count(*) as n, sum(abs(m.quantity_delta)) as units
        from public.stock_movements m
        where m.created_at >= p_from and m.created_at < p_to
        group by m.reason
      ) x
    ),
    'expiry', jsonb_build_object(
      'created_by_kind', (
        select coalesce(jsonb_object_agg(x.kind, x.n), '{}'::jsonb)
        from (
          select a.kind, count(*) as n from public.expiry_alerts a
          where a.created_at >= p_from and a.created_at < p_to group by a.kind
        ) x
      ),
      'resolved_by_resolution', (
        select coalesce(jsonb_object_agg(x.resolution, x.n), '{}'::jsonb)
        from (
          select a.resolution, count(*) as n from public.expiry_alerts a
          where a.resolved_at >= p_from and a.resolved_at < p_to group by a.resolution
        ) x
      ),
      'open', (select count(*) from public.expiry_alerts a where a.resolved_at is null)
    )
  );
end;
$$;

-- Tenants -----------------------------------------------------------------------------------------

-- p_sort: created_desc (default) | created_asc | name_asc | activity_desc
create function public.admin_list_tenants(
  p_search text default null,
  p_status text default null,
  p_plan text default null,
  p_sort text default 'created_desc',
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sort text := coalesce(p_sort, 'created_desc');
  v_limit integer := private.page_limit(p_limit);
  v_offset integer := private.page_offset(p_offset);
  v_total integer;
  v_rows jsonb;
begin
  if not private.has_platform_permission('tenants.view') then
    return private.platform_denied('tenant.list');
  end if;
  if v_sort not in ('created_desc', 'created_asc', 'name_asc', 'activity_desc') then
    raise exception 'Unknown sort order.' using errcode = '22023';
  end if;

  select count(*) into v_total from private.tenant_search(p_search, p_status, p_plan);

  select coalesce(jsonb_agg(to_jsonb(t) order by t.ord), '[]'::jsonb)
  into v_rows
  from (
    select r.*, row_number() over (
      order by
        case when v_sort = 'name_asc' then lower(r.name) end asc,
        case when v_sort = 'created_asc' then r.created_at end asc,
        case when v_sort = 'created_desc' then r.created_at end desc,
        case when v_sort = 'activity_desc' then r.last_activity_at end desc nulls last,
        r.id
    ) as ord
    from private.tenant_search(p_search, p_status, p_plan) r
    order by ord
    limit v_limit offset v_offset
  ) t;

  return jsonb_build_object('ok', true, 'total', v_total, 'limit', v_limit, 'offset', v_offset, 'rows', v_rows);
end;
$$;

create function public.admin_get_tenant(p_shop_id uuid)
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
      'created_at', v_shop.created_at
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

create function public.admin_set_shop_status(p_shop_id uuid, p_status text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_shop public.shops;
begin
  if not private.has_platform_permission('tenants.manage') then
    return private.platform_denied('tenant.status', 'shop', p_shop_id::text, p_shop_id);
  end if;
  v_reason := private.require_reason(p_reason);
  if p_status is null or p_status not in ('active', 'suspended') then
    raise exception 'Status must be active or suspended.' using errcode = '22023';
  end if;

  select * into v_shop from public.shops where id = p_shop_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_shop.status = p_status then
    return jsonb_build_object('ok', true, 'unchanged', true, 'status', p_status);
  end if;

  update public.shops
  set status = p_status,
      suspended_at = case when p_status = 'suspended' then now() end,
      suspended_by = case when p_status = 'suspended' then (select auth.uid()) end,
      suspension_reason = case when p_status = 'suspended' then v_reason end
  where id = p_shop_id;

  perform private.audit(
    case when p_status = 'suspended' then 'tenant.suspended' else 'tenant.reactivated' end,
    'success', 'shop', p_shop_id::text, p_shop_id, v_reason,
    jsonb_build_object('before', v_shop.status, 'after', p_status, 'shop_name', v_shop.name)
  );

  insert into public.notifications (shop_id, user_id, type, title, body, data)
  select
    p_shop_id, m.user_id, 'system',
    case when p_status = 'suspended' then 'Shop suspended' else 'Shop reactivated' end,
    case
      when p_status = 'suspended'
        then format('%s is suspended. You can still view your data; changes stay on your phone until it is reactivated. Contact SpazaStock support.', v_shop.name)
      else format('%s is active again. Waiting changes will now sync.', v_shop.name)
    end,
    jsonb_build_object('kind', 'shop_status', 'status', p_status)
  from public.shop_members m
  where m.shop_id = p_shop_id and m.user_id is not null and m.status = 'active'
    and m.role in ('owner', 'manager');

  return jsonb_build_object('ok', true, 'unchanged', false, 'status', p_status);
end;
$$;

-- Creates a shop for an existing account with a confirmed email; that account becomes its owner.
create function public.admin_create_shop(p_owner_email text, p_name text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_owner uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_shop public.shops;
begin
  if not private.has_platform_permission('tenants.manage') then
    return private.platform_denied('tenant.create');
  end if;
  v_reason := private.require_reason(p_reason);
  if char_length(v_name) not between 1 and 120 then
    raise exception 'Shop name is required (up to 120 characters).' using errcode = '22023';
  end if;
  v_owner := private.find_confirmed_user(p_owner_email);

  insert into public.shops (owner_id, name) values (v_owner, v_name) returning * into v_shop;

  perform private.audit(
    'tenant.created', 'success', 'shop', v_shop.id::text, v_shop.id, v_reason,
    jsonb_build_object('name', v_name, 'owner_email', private.user_email(v_owner))
  );
  return jsonb_build_object('ok', true, 'shop_id', v_shop.id);
end;
$$;

-- At most 5000 rows; the caller builds the file. Recorded with the filters used.
create function public.admin_export_tenants(p_search text, p_status text, p_plan text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_total integer;
  v_rows jsonb;
begin
  if not private.has_platform_permission('tenants.export') then
    return private.platform_denied('tenant.export');
  end if;
  v_reason := private.require_reason(p_reason);

  select count(*) into v_total from private.tenant_search(p_search, p_status, p_plan);
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc, t.id), '[]'::jsonb)
  into v_rows
  from (
    select * from private.tenant_search(p_search, p_status, p_plan) r
    order by r.created_at desc, r.id
    limit 5000
  ) t;

  perform private.audit(
    'tenant.exported', 'success', 'platform', null, null, v_reason,
    jsonb_build_object(
      'search', p_search, 'status', p_status, 'plan', p_plan,
      'rows', least(v_total, 5000), 'total', v_total
    )
  );
  return jsonb_build_object('ok', true, 'total', v_total, 'truncated', v_total > 5000, 'rows', v_rows);
end;
$$;

-- Administrators ----------------------------------------------------------------------------------

create function public.admin_list_admins()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_platform_permission('admins.manage') then
    return private.platform_denied('admin.list');
  end if;
  return jsonb_build_object('ok', true, 'rows', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', a.user_id,
      'email', lower(u.email),
      'display_name', p.display_name,
      'role', a.role,
      'status', a.status,
      'granted_at', a.granted_at,
      'granted_by_email', private.user_email(a.granted_by),
      'revoked_at', a.revoked_at,
      'revoked_by_email', private.user_email(a.revoked_by),
      'last_sign_in_at', u.last_sign_in_at,
      'is_you', a.user_id = (select auth.uid())
    ) order by a.status, a.role, lower(u.email)), '[]'::jsonb)
    from private.platform_admins a
    join auth.users u on u.id = a.user_id
    left join public.profiles p on p.id = a.user_id
  ));
end;
$$;

create function public.admin_grant_admin(p_email text, p_role text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_user uuid;
  v_existing private.platform_admins;
begin
  if not private.has_platform_permission('admins.manage') then
    return private.platform_denied('admin.grant', 'admin');
  end if;
  v_reason := private.require_reason(p_reason);
  if p_role is null or p_role not in ('superadmin', 'support', 'billing', 'analyst') then
    raise exception 'Unknown administrator role.' using errcode = '22023';
  end if;
  v_user := private.find_confirmed_user(p_email);
  if v_user = (select auth.uid()) then
    raise exception 'You cannot change your own role.' using errcode = '22023';
  end if;

  select * into v_existing from private.platform_admins where user_id = v_user for update;
  if found and v_existing.status = 'active' and v_existing.role = p_role then
    return jsonb_build_object('ok', true, 'unchanged', true, 'user_id', v_user);
  end if;
  if found and v_existing.status = 'active' and p_role <> 'superadmin' then
    perform private.assert_not_last_superadmin(v_user);
  end if;

  insert into private.platform_admins (user_id, role, status, granted_by, granted_at)
  values (v_user, p_role, 'active', (select auth.uid()), now())
  on conflict (user_id) do update
    set role = excluded.role, status = 'active', granted_by = excluded.granted_by,
        granted_at = excluded.granted_at, revoked_by = null, revoked_at = null;

  perform private.audit(
    'admin.granted', 'success', 'admin', v_user::text, null, v_reason,
    jsonb_build_object(
      'email', private.user_email(v_user), 'role', p_role,
      'previous_role', v_existing.role, 'previous_status', v_existing.status
    )
  );
  return jsonb_build_object('ok', true, 'unchanged', false, 'user_id', v_user);
end;
$$;

create function public.admin_set_admin_role(p_user_id uuid, p_role text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_existing private.platform_admins;
begin
  if not private.has_platform_permission('admins.manage') then
    return private.platform_denied('admin.role', 'admin', p_user_id::text);
  end if;
  v_reason := private.require_reason(p_reason);
  if p_role is null or p_role not in ('superadmin', 'support', 'billing', 'analyst') then
    raise exception 'Unknown administrator role.' using errcode = '22023';
  end if;
  if p_user_id = (select auth.uid()) then
    raise exception 'You cannot change your own role.' using errcode = '22023';
  end if;

  select * into v_existing from private.platform_admins
  where user_id = p_user_id and status = 'active' for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_existing.role = p_role then
    return jsonb_build_object('ok', true, 'unchanged', true);
  end if;
  if p_role <> 'superadmin' then
    perform private.assert_not_last_superadmin(p_user_id);
  end if;

  update private.platform_admins set role = p_role where user_id = p_user_id;
  perform private.audit(
    'admin.role_changed', 'success', 'admin', p_user_id::text, null, v_reason,
    jsonb_build_object('email', private.user_email(p_user_id), 'before', v_existing.role, 'after', p_role)
  );
  return jsonb_build_object('ok', true, 'unchanged', false);
end;
$$;

create function public.admin_revoke_admin(p_user_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_existing private.platform_admins;
begin
  if not private.has_platform_permission('admins.manage') then
    return private.platform_denied('admin.revoke', 'admin', p_user_id::text);
  end if;
  v_reason := private.require_reason(p_reason);
  if p_user_id = (select auth.uid()) then
    raise exception 'You cannot revoke your own access.' using errcode = '22023';
  end if;

  select * into v_existing from private.platform_admins
  where user_id = p_user_id and status = 'active' for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  perform private.assert_not_last_superadmin(p_user_id);

  update private.platform_admins
  set status = 'revoked', revoked_by = (select auth.uid()), revoked_at = now()
  where user_id = p_user_id;
  perform private.audit(
    'admin.revoked', 'success', 'admin', p_user_id::text, null, v_reason,
    jsonb_build_object('email', private.user_email(p_user_id), 'role', v_existing.role)
  );
  return jsonb_build_object('ok', true);
end;
$$;

-- Plans, subscriptions and features ---------------------------------------------------------------

create function public.admin_list_plans()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (private.has_platform_permission('billing.view') or private.has_platform_permission('plans.manage')) then
    return private.platform_denied('plan.list');
  end if;
  return jsonb_build_object(
    'ok', true,
    'plans', (
      select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object(
        'subscriptions', (select count(*) from public.subscriptions s where s.plan = p.code),
        'entitlements', (
          select coalesce(jsonb_object_agg(e.key, jsonb_build_object('enabled', e.enabled, 'limit', e.limit_value)), '{}'::jsonb)
          from public.plan_entitlements e where e.plan_code = p.code
        )
      ) order by p.price_cents nulls last, p.code), '[]'::jsonb)
      from public.plans p
    ),
    'catalog', (
      select coalesce(jsonb_agg(jsonb_build_object('key', c.key, 'kind', c.kind, 'description', c.description) order by c.key), '[]'::jsonb)
      from private.entitlement_catalog c
    ),
    'features', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'key', f.key, 'enabled', f.enabled, 'updated_at', f.updated_at,
        'updated_by_email', private.user_email(f.updated_by)
      ) order by f.key), '[]'::jsonb)
      from public.platform_features f
    ),
    'payments', jsonb_build_object('provider_connected', false)
  );
end;
$$;

create function public.admin_update_subscription(
  p_shop_id uuid,
  p_plan text,
  p_status text,
  p_trial_ends_at timestamptz,
  p_current_period_end timestamptz,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_before public.subscriptions;
  v_after public.subscriptions;
  v_plan public.plans;
  v_trial_ends timestamptz := p_trial_ends_at;
begin
  if not private.has_platform_permission('billing.manage') then
    return private.platform_denied('billing.subscription', 'subscription', p_shop_id::text, p_shop_id);
  end if;
  v_reason := private.require_reason(p_reason);
  if p_status is null or p_status not in ('trialing', 'active', 'past_due', 'canceled') then
    raise exception 'Unknown subscription status.' using errcode = '22023';
  end if;
  select * into v_plan from public.plans where code = p_plan;
  if not found then
    raise exception 'Unknown plan.' using errcode = '22023';
  end if;

  select * into v_before from public.subscriptions where shop_id = p_shop_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not v_plan.is_active and v_plan.code <> v_before.plan then
    raise exception 'This plan is not available for new subscriptions.' using errcode = '22023';
  end if;
  if p_status = 'trialing' and v_trial_ends is null then
    if v_plan.trial_days = 0 then
      raise exception 'Set a trial end date; this plan has no default trial.' using errcode = '22023';
    end if;
    v_trial_ends := now() + make_interval(days => v_plan.trial_days);
  end if;
  if p_status = 'past_due' and p_current_period_end is null then
    raise exception 'Past-due subscriptions need the end of the paid period.' using errcode = '22023';
  end if;

  update public.subscriptions
  set plan = p_plan, status = p_status, trial_ends_at = v_trial_ends, current_period_end = p_current_period_end
  where shop_id = p_shop_id
  returning * into v_after;

  perform private.audit(
    'billing.subscription_changed', 'success', 'subscription', v_after.id::text, p_shop_id, v_reason,
    jsonb_build_object(
      'before', jsonb_build_object(
        'plan', v_before.plan, 'status', v_before.status,
        'trial_ends_at', v_before.trial_ends_at, 'current_period_end', v_before.current_period_end
      ),
      'after', jsonb_build_object(
        'plan', v_after.plan, 'status', v_after.status,
        'trial_ends_at', v_after.trial_ends_at, 'current_period_end', v_after.current_period_end
      )
    )
  );
  return jsonb_build_object('ok', true, 'effective_plan', private.effective_plan(p_shop_id));
end;
$$;

create function public.admin_upsert_plan(
  p_code text,
  p_name text,
  p_price_cents integer,
  p_currency text,
  p_billing_interval text,
  p_trial_days integer,
  p_grace_days integer,
  p_is_active boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_code text := lower(btrim(coalesce(p_code, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_before public.plans;
  v_after public.plans;
  v_created boolean;
begin
  if not private.has_platform_permission('plans.manage') then
    return private.platform_denied('plan.upsert', 'plan', p_code);
  end if;
  v_reason := private.require_reason(p_reason);
  if v_code !~ '^[a-z][a-z0-9_]{1,31}$' then
    raise exception 'Plan codes are 2 to 32 lowercase letters, digits or underscores.' using errcode = '22023';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Plan name is required (up to 80 characters).' using errcode = '22023';
  end if;
  if p_price_cents is not null and p_price_cents not between 0 and 100000000 then
    raise exception 'Price must be between 0 and 1,000,000.00.' using errcode = '22023';
  end if;
  if coalesce(p_currency, '') !~ '^[A-Z]{3}$' then
    raise exception 'Currency must be a three-letter code such as ZAR.' using errcode = '22023';
  end if;
  if p_billing_interval is null or p_billing_interval not in ('month', 'year') then
    raise exception 'Billing interval must be month or year.' using errcode = '22023';
  end if;
  if p_trial_days is null or p_trial_days not between 0 and 365 then
    raise exception 'Trial days must be between 0 and 365.' using errcode = '22023';
  end if;
  if p_grace_days is null or p_grace_days not between 0 and 90 then
    raise exception 'Grace days must be between 0 and 90.' using errcode = '22023';
  end if;
  if v_code = 'free' and p_is_active is not true then
    raise exception 'The free plan is the fallback for every shop and cannot be deactivated.' using errcode = '22023';
  end if;

  select * into v_before from public.plans where code = v_code for update;
  v_created := not found;

  insert into public.plans (code, name, price_cents, currency, billing_interval, trial_days, grace_days, is_active)
  values (v_code, v_name, p_price_cents, p_currency, p_billing_interval, p_trial_days, p_grace_days, coalesce(p_is_active, true))
  on conflict (code) do update
    set name = excluded.name, price_cents = excluded.price_cents, currency = excluded.currency,
        billing_interval = excluded.billing_interval, trial_days = excluded.trial_days,
        grace_days = excluded.grace_days, is_active = excluded.is_active
  returning * into v_after;

  if v_created then
    insert into public.plan_entitlements (plan_code, key, enabled, limit_value)
    select v_code, c.key, true, null from private.entitlement_catalog c
    on conflict do nothing;
  end if;

  perform private.audit(
    case when v_created then 'plan.created' else 'plan.updated' end,
    'success', 'plan', v_code, null, v_reason,
    jsonb_build_object(
      'before', case when v_created then null else to_jsonb(v_before) - 'created_at' - 'updated_at' end,
      'after', to_jsonb(v_after) - 'created_at' - 'updated_at'
    )
  );
  return jsonb_build_object('ok', true, 'created', v_created);
end;
$$;

create function public.admin_set_entitlement(
  p_plan text,
  p_key text,
  p_enabled boolean,
  p_limit integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_kind text;
  v_before public.plan_entitlements;
begin
  if not private.has_platform_permission('plans.manage') then
    return private.platform_denied('plan.entitlement', 'plan', p_plan);
  end if;
  v_reason := private.require_reason(p_reason);
  if not exists (select 1 from public.plans where code = p_plan) then
    raise exception 'Unknown plan.' using errcode = '22023';
  end if;
  select kind into v_kind from private.entitlement_catalog where key = p_key;
  if v_kind is null then
    raise exception 'Unknown entitlement.' using errcode = '22023';
  end if;
  if p_enabled is null then
    raise exception 'Choose whether the entitlement is on.' using errcode = '22023';
  end if;
  if v_kind = 'boolean' and p_limit is not null then
    raise exception 'This entitlement is on or off and takes no limit.' using errcode = '22023';
  end if;
  if p_limit is not null and p_limit not between 0 and 1000000 then
    raise exception 'Limits must be between 0 and 1,000,000.' using errcode = '22023';
  end if;

  select * into v_before from public.plan_entitlements where plan_code = p_plan and key = p_key for update;

  insert into public.plan_entitlements (plan_code, key, enabled, limit_value)
  values (p_plan, p_key, p_enabled, p_limit)
  on conflict (plan_code, key) do update set enabled = excluded.enabled, limit_value = excluded.limit_value;

  perform private.audit(
    'plan.entitlement_changed', 'success', 'plan', p_plan, null, v_reason,
    jsonb_build_object(
      'key', p_key,
      'before', case when v_before.key is null then null
                     else jsonb_build_object('enabled', v_before.enabled, 'limit', v_before.limit_value) end,
      'after', jsonb_build_object('enabled', p_enabled, 'limit', p_limit)
    )
  );
  return jsonb_build_object('ok', true);
end;
$$;

create function public.admin_set_feature(p_key text, p_enabled boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_before boolean;
begin
  if not private.has_platform_permission('plans.manage') then
    return private.platform_denied('feature.change', 'feature', p_key);
  end if;
  v_reason := private.require_reason(p_reason);
  if not exists (select 1 from private.entitlement_catalog where key = p_key and kind = 'boolean') then
    raise exception 'Unknown feature.' using errcode = '22023';
  end if;
  if p_enabled is null then
    raise exception 'Choose whether the feature is on.' using errcode = '22023';
  end if;

  select enabled into v_before from public.platform_features where key = p_key for update;

  insert into public.platform_features (key, enabled, updated_by)
  values (p_key, p_enabled, (select auth.uid()))
  on conflict (key) do update set enabled = excluded.enabled, updated_by = excluded.updated_by;

  perform private.audit(
    'feature.changed', 'success', 'feature', p_key, null, v_reason,
    jsonb_build_object('before', v_before, 'after', p_enabled)
  );
  return jsonb_build_object('ok', true);
end;
$$;

-- Operations --------------------------------------------------------------------------------------

create function public.admin_operations_health()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_platform_permission('operations.view') then
    return private.platform_denied('operations.view');
  end if;
  return jsonb_build_object(
    'ok', true,
    'generated_at', now(),
    'scheduler', private.cron_health(),
    'push', jsonb_build_object(
      'by_status_7d', (
        select coalesce(jsonb_object_agg(x.push_status, x.n), '{}'::jsonb)
        from (
          select n.push_status, count(*) as n from public.notifications n
          where n.created_at > now() - interval '7 days' and n.type = 'expiry'
          group by n.push_status
        ) x
      ),
      'due_now', (
        select count(*) from public.notifications n
        where n.push_status in ('pending', 'sending') and n.push_next_at <= now()
      ),
      'oldest_due_at', (
        select min(n.push_next_at) from public.notifications n
        where n.push_status in ('pending', 'sending') and n.push_next_at <= now()
      ),
      'failed_24h', (
        select count(*) from public.notifications n
        where n.push_status = 'failed' and n.updated_at > now() - interval '24 hours'
      ),
      'last_sent_at', (select max(n.pushed_at) from public.notifications n where n.push_status = 'sent')
    ),
    'sync', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'op_type', x.op_type, 'error_code', x.error_code, 'occurrences', x.occurrences,
        'shops', x.shops, 'users', x.users, 'last_seen', x.last_seen
      ) order by x.occurrences desc), '[]'::jsonb)
      from (
        select r.op_type, r.error_code, sum(r.occurrences) as occurrences,
               count(distinct r.shop_id) as shops, count(distinct r.user_id) as users, max(r.last_seen) as last_seen
        from public.sync_failure_reports r
        where r.last_seen > now() - interval '7 days'
        group by r.op_type, r.error_code
        order by sum(r.occurrences) desc
        limit 20
      ) x
    ),
    -- Whether each secret is set; values never leave Vault.
    'integrations', jsonb_build_object(
      'push_keys', private.vault_secret('vapid_public_key') is not null and private.vault_secret('vapid_private_key') is not null,
      'push_subject', private.vault_secret('vapid_subject') is not null,
      'scheduler_secret', private.vault_secret('expiry_push_secret') is not null,
      'project_url', private.vault_secret('project_url') is not null,
      'payment_provider', false
    )
  );
end;
$$;

create function public.admin_list_audit(
  p_action text default null,
  p_actor_email text default null,
  p_shop_id uuid default null,
  p_outcome text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text := nullif(lower(btrim(coalesce(p_action, ''))), '');
  v_actor text := nullif(lower(btrim(coalesce(p_actor_email, ''))), '');
  v_limit integer := private.page_limit(p_limit);
  v_offset integer := private.page_offset(p_offset);
  v_total integer;
  v_rows jsonb;
begin
  if not private.has_platform_permission('audit.view') then
    return private.platform_denied('audit.view');
  end if;
  if v_action is not null and v_action !~ '^[a-z._]{1,60}$' then
    raise exception 'Unknown action filter.' using errcode = '22023';
  end if;
  if v_actor is not null and char_length(v_actor) > 320 then
    raise exception 'Email filter is too long.' using errcode = '22023';
  end if;
  if p_outcome is not null and p_outcome not in ('success', 'denied') then
    raise exception 'Outcome must be success or denied.' using errcode = '22023';
  end if;
  if p_from is not null and p_to is not null and p_from >= p_to then
    raise exception 'Choose a start date before the end date.' using errcode = '22023';
  end if;

  select count(*) into v_total
  from public.platform_audit_log l
  where (v_action is null or l.action like v_action || '%')
    and (v_actor is null or l.actor_email = v_actor)
    and (p_shop_id is null or l.shop_id = p_shop_id)
    and (p_outcome is null or l.outcome = p_outcome)
    and (p_from is null or l.occurred_at >= p_from)
    and (p_to is null or l.occurred_at < p_to);

  select coalesce(jsonb_agg(to_jsonb(t) order by t.occurred_at desc, t.id desc), '[]'::jsonb)
  into v_rows
  from (
    select l.id, l.occurred_at, l.actor_id, l.actor_email, l.actor_role, l.action, l.target_type,
           l.target_id, l.shop_id, l.reason, l.outcome, l.details
    from public.platform_audit_log l
    where (v_action is null or l.action like v_action || '%')
      and (v_actor is null or l.actor_email = v_actor)
      and (p_shop_id is null or l.shop_id = p_shop_id)
      and (p_outcome is null or l.outcome = p_outcome)
      and (p_from is null or l.occurred_at >= p_from)
      and (p_to is null or l.occurred_at < p_to)
    order by l.occurred_at desc, l.id desc
    limit v_limit offset v_offset
  ) t;

  return jsonb_build_object('ok', true, 'total', v_total, 'limit', v_limit, 'offset', v_offset, 'rows', v_rows);
end;
$$;

-- Privileges --------------------------------------------------------------------------------------

revoke all on function private.check_range(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function private.page_limit(integer) from public, anon, authenticated;
revoke all on function private.page_offset(integer) from public, anon, authenticated;
revoke all on function private.find_confirmed_user(text) from public, anon, authenticated;
revoke all on function private.cron_failures(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function private.cron_health() from public, anon, authenticated;
revoke all on function private.tenant_search(text, text, text) from public, anon, authenticated;
revoke all on function private.assert_not_last_superadmin(uuid) from public, anon, authenticated;

revoke all on function public.admin_whoami() from public, anon;
revoke all on function public.admin_platform_overview(timestamptz, timestamptz) from public, anon;
revoke all on function public.admin_growth_series(text, timestamptz, timestamptz, text) from public, anon;
revoke all on function public.admin_analytics(timestamptz, timestamptz) from public, anon;
revoke all on function public.admin_list_tenants(text, text, text, text, integer, integer) from public, anon;
revoke all on function public.admin_get_tenant(uuid) from public, anon;
revoke all on function public.admin_set_shop_status(uuid, text, text) from public, anon;
revoke all on function public.admin_create_shop(text, text, text) from public, anon;
revoke all on function public.admin_export_tenants(text, text, text, text) from public, anon;
revoke all on function public.admin_list_admins() from public, anon;
revoke all on function public.admin_grant_admin(text, text, text) from public, anon;
revoke all on function public.admin_set_admin_role(uuid, text, text) from public, anon;
revoke all on function public.admin_revoke_admin(uuid, text) from public, anon;
revoke all on function public.admin_list_plans() from public, anon;
revoke all on function public.admin_update_subscription(uuid, text, text, timestamptz, timestamptz, text) from public, anon;
revoke all on function public.admin_upsert_plan(text, text, integer, text, text, integer, integer, boolean, text) from public, anon;
revoke all on function public.admin_set_entitlement(text, text, boolean, integer, text) from public, anon;
revoke all on function public.admin_set_feature(text, boolean, text) from public, anon;
revoke all on function public.admin_operations_health() from public, anon;
revoke all on function public.admin_list_audit(text, text, uuid, text, timestamptz, timestamptz, integer, integer) from public, anon;

grant execute on function public.admin_whoami() to authenticated;
grant execute on function public.admin_platform_overview(timestamptz, timestamptz) to authenticated;
grant execute on function public.admin_growth_series(text, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.admin_analytics(timestamptz, timestamptz) to authenticated;
grant execute on function public.admin_list_tenants(text, text, text, text, integer, integer) to authenticated;
grant execute on function public.admin_get_tenant(uuid) to authenticated;
grant execute on function public.admin_set_shop_status(uuid, text, text) to authenticated;
grant execute on function public.admin_create_shop(text, text, text) to authenticated;
grant execute on function public.admin_export_tenants(text, text, text, text) to authenticated;
grant execute on function public.admin_list_admins() to authenticated;
grant execute on function public.admin_grant_admin(text, text, text) to authenticated;
grant execute on function public.admin_set_admin_role(uuid, text, text) to authenticated;
grant execute on function public.admin_revoke_admin(uuid, text) to authenticated;
grant execute on function public.admin_list_plans() to authenticated;
grant execute on function public.admin_update_subscription(uuid, text, text, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.admin_upsert_plan(text, text, integer, text, text, integer, integer, boolean, text) to authenticated;
grant execute on function public.admin_set_entitlement(text, text, boolean, integer, text) to authenticated;
grant execute on function public.admin_set_feature(text, boolean, text) to authenticated;
grant execute on function public.admin_operations_health() to authenticated;
grant execute on function public.admin_list_audit(text, text, uuid, text, timestamptz, timestamptz, integer, integer) to authenticated;
