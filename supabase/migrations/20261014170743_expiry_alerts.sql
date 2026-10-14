-- Automated expiry alerts.
--
-- A scheduled job (see *_expiry_schedule.sql) calls private.generate_expiry_alerts() so reminders
-- appear even when nobody has the app open. Every date decision uses the shop's own time zone.
--
-- Rules, decided from the shop's local "today":
--   * Reminder: a batch with stock, d = expiry_date - today >= 0, fires only the smallest reminder
--     threshold T >= d. A batch first seen 5 days out gets the 7-day reminder only; larger
--     thresholds never fire later because d only shrinks.
--   * Overdue: expiry_date < today fires one separate 'expired' alert.
--   * Each (batch, expiry date, kind, threshold) fires at most once (a unique constraint), so
--     re-runs, retries and overlapping runs never duplicate an alert or its notifications.
--   * Expired batches are not sellable: record_sale skips them. Removing or correcting them goes
--     through resolve_expired_batch, which keeps an expiry_resolutions record.

-- Shop settings ---------------------------------------------------------------------------

create function private.is_valid_timezone(p_timezone text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_timezone is not null
     and exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone);
$$;

create function private.is_valid_reminder_days(p_days smallint[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_days is not null
     and cardinality(p_days) between 1 and 5
     and array_position(p_days, null) is null
     and 1 <= all (p_days)
     and 180 >= all (p_days)
     and (select count(distinct d) from unnest(p_days) d) = cardinality(p_days);
$$;

alter table public.shops
  add column timezone text not null default 'Africa/Johannesburg',
  add column expiry_reminder_days smallint[] not null default '{21,14,7}',
  add constraint shops_expiry_reminder_days_check check (private.is_valid_reminder_days(expiry_reminder_days));

comment on column public.shops.timezone is 'IANA time zone used for every calendar-date decision (expiry, alerts).';
comment on column public.shops.expiry_reminder_days is 'Days before expiry at which a reminder fires (owners and managers edit).';

create function private.check_shop_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not private.is_valid_timezone(new.timezone) then
    raise exception 'Unknown time zone: %', new.timezone using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger shops_check_timezone
  before insert or update of timezone on public.shops
  for each row execute function private.check_shop_timezone();

-- The shop's calendar date at a given instant.
create function private.shop_today(p_shop_id uuid, p_at timestamptz default now())
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (coalesce(p_at, now()) at time zone s.timezone)::date from public.shops s where s.id = p_shop_id;
$$;

-- Units the shop may sell: batches without an expiry date or not yet past it.
create function private.sellable_stock(p_shop_id uuid, p_product_id uuid, p_at timestamptz default now())
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(b.quantity), 0)::integer
  from public.stock_batches b
  where b.shop_id = p_shop_id and b.product_id = p_product_id and b.quantity > 0
    and (b.expiry_date is null or b.expiry_date >= private.shop_today(p_shop_id, p_at));
$$;

create function public.update_shop_alert_settings(p_shop_id uuid, p_reminder_days integer[], p_timezone text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_days smallint[];
  v_shop public.shops;
begin
  perform private.assert_shop_role(p_shop_id, array['owner', 'manager']);
  if p_reminder_days is null or array_position(p_reminder_days, null) is not null
     or exists (select 1 from unnest(p_reminder_days) d where d < 1 or d > 180) then
    raise exception 'Reminder days must be whole numbers from 1 to 180.' using errcode = '22023';
  end if;
  select coalesce(array_agg(d order by d desc), '{}') into v_days
  from (select distinct d::smallint as d from unnest(p_reminder_days) d) x;
  if cardinality(v_days) not between 1 and 5 then
    raise exception 'Choose 1 to 5 reminder days.' using errcode = '22023';
  end if;
  if not private.is_valid_timezone(p_timezone) then
    raise exception 'Unknown time zone.' using errcode = '22023';
  end if;

  update public.shops
  set expiry_reminder_days = v_days, timezone = p_timezone
  where id = p_shop_id
  returning * into v_shop;

  return jsonb_build_object('timezone', v_shop.timezone, 'expiry_reminder_days', to_jsonb(v_shop.expiry_reminder_days));
end;
$$;

-- Expiry alerts -----------------------------------------------------------------------------

create table public.expiry_alerts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  batch_id uuid not null references public.stock_batches (id) on delete cascade,
  product_id uuid not null,
  kind text not null check (kind in ('reminder', 'expired')),
  threshold_days smallint check (threshold_days is null or threshold_days between 1 and 180),
  expiry_date date not null,
  quantity integer not null check (quantity >= 0),
  alert_date date not null,
  resolved_at timestamptz,
  resolution text check (
    resolution is null
    or resolution in ('sold_out', 'discarded', 'returned_to_supplier', 'expiry_corrected', 'superseded')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expiry_alerts_threshold_check check ((kind = 'reminder') = (threshold_days is not null)),
  constraint expiry_alerts_resolved_check check ((resolved_at is null) = (resolution is null)),
  constraint expiry_alerts_product_fkey foreign key (shop_id, product_id)
    references public.products (shop_id, id) on delete cascade,
  constraint expiry_alerts_dedup_key unique nulls not distinct (batch_id, expiry_date, kind, threshold_days)
);

comment on column public.expiry_alerts.quantity is 'Units in the batch when the alert fired.';
comment on column public.expiry_alerts.alert_date is 'Shop-local date the alert fired.';

create index expiry_alerts_shop_updated_idx on public.expiry_alerts (shop_id, updated_at);
create index expiry_alerts_shop_product_idx on public.expiry_alerts (shop_id, product_id);
create index expiry_alerts_open_idx on public.expiry_alerts (shop_id) where resolved_at is null;
create index stock_batches_expiry_idx on public.stock_batches (expiry_date)
  where quantity > 0 and expiry_date is not null;

create trigger expiry_alerts_set_updated_at before update on public.expiry_alerts
  for each row execute function public.set_updated_at();

alter table public.expiry_alerts enable row level security;
revoke all on table public.expiry_alerts from anon, authenticated;
grant select on table public.expiry_alerts to authenticated;

create policy "Members can view shop expiry alerts"
  on public.expiry_alerts for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

-- Push delivery state on notifications -------------------------------------------------------
-- Only expiry notifications are pushed; older rows default to 'skipped'.

alter table public.notifications
  add column push_status text not null default 'skipped'
    check (push_status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  add column push_attempts smallint not null default 0 check (push_attempts >= 0),
  add column push_next_at timestamptz,
  add column pushed_at timestamptz,
  add column push_error text check (push_error is null or char_length(push_error) <= 500);

create index notifications_push_due_idx on public.notifications (push_next_at)
  where push_status in ('pending', 'sending');

-- Push subscriptions (one per browser endpoint) ----------------------------------------------

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null unique check (char_length(endpoint) between 12 and 1000 and endpoint like 'https://%'),
  p256dh text not null check (char_length(p256dh) between 20 and 200),
  auth text not null check (char_length(auth) between 8 and 100),
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  failure_count integer not null default 0 check (failure_count >= 0),
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

create trigger push_subscriptions_set_updated_at before update on public.push_subscriptions
  for each row execute function public.set_updated_at();

alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from anon, authenticated;
grant select on table public.push_subscriptions to authenticated;

create policy "Users can view their push subscriptions"
  on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

-- A browser endpoint belongs to whoever signed in on it most recently.
create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Sign in to turn on notifications.' using errcode = '42501';
  end if;
  if p_endpoint is null or p_endpoint not like 'https://%' or char_length(p_endpoint) not between 12 and 1000
     or char_length(coalesce(p_p256dh, '')) not between 20 and 200
     or char_length(coalesce(p_auth, '')) not between 8 and 100 then
    raise exception 'Invalid push subscription.' using errcode = '22023';
  end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (v_uid, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, failure_count = 0
  returning id into v_id;
  return v_id;
end;
$$;

create function public.delete_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Sign in to turn off notifications.' using errcode = '42501';
  end if;
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = (select auth.uid());
end;
$$;

-- Vault-backed push configuration ------------------------------------------------------------
-- Secrets live only in Supabase Vault. Where Vault is absent (local tests) these return null.

create function private.vault_secret(p_name text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_value text;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    return null;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
    into v_value using p_name;
  return v_value;
end;
$$;

-- The public VAPID key is not secret; browsers need it to subscribe.
create function public.get_push_public_key()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Sign in to turn on notifications.' using errcode = '42501';
  end if;
  return private.vault_secret('vapid_public_key');
end;
$$;

-- Service role only: the Edge Function reads its signing keys and the cron secret here.
create function public.push_config()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'vapid_public_key', private.vault_secret('vapid_public_key'),
    'vapid_private_key', private.vault_secret('vapid_private_key'),
    'vapid_subject', private.vault_secret('vapid_subject'),
    'cron_secret', private.vault_secret('expiry_push_secret')
  );
$$;

-- Claims due pushes. A claimed row stays 'sending' with push_next_at 10 minutes ahead, so a run
-- that crashes mid-way is reclaimed by a later run. Rows whose recipient has no subscription, or
-- has left the shop, are skipped.
create function public.claim_push_batch(p_limit integer default 50, p_now timestamptz default now())
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

-- Backoff after the nth failed attempt: 5 min, 30 min, 2 h, 6 h; the 5th failure is final.
create function private.push_backoff(p_attempts integer)
returns interval
language sql
immutable
set search_path = ''
as $$
  select case
    when p_attempts <= 1 then interval '5 minutes'
    when p_attempts = 2 then interval '30 minutes'
    when p_attempts = 3 then interval '2 hours'
    else interval '6 hours'
  end;
$$;

-- p_results: [{ "notification_id": uuid, "outcome": "sent" | "retry" | "fail", "error": text,
--               "ok_subscription_ids": [uuid], "gone_subscription_ids": [uuid] }]
-- Only rows still 'sending' are updated, so a late or repeated report changes nothing.
create function public.complete_push(p_results jsonb, p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_result jsonb;
  v_outcome text;
  v_updated integer := 0;
  v_rows integer;
begin
  if p_results is null or jsonb_typeof(p_results) <> 'array' then
    raise exception 'Results must be an array.' using errcode = '22023';
  end if;

  for v_result in select value from jsonb_array_elements(p_results) loop
    v_outcome := v_result ->> 'outcome';
    if v_outcome is null or v_outcome not in ('sent', 'retry', 'fail') then
      raise exception 'Unknown push outcome.' using errcode = '22023';
    end if;

    delete from public.push_subscriptions
    where id in (
      select (x.value #>> '{}')::uuid
      from jsonb_array_elements(coalesce(v_result -> 'gone_subscription_ids', '[]'::jsonb)) x(value)
    );

    update public.push_subscriptions
    set last_success_at = v_now, failure_count = 0
    where id in (
      select (x.value #>> '{}')::uuid
      from jsonb_array_elements(coalesce(v_result -> 'ok_subscription_ids', '[]'::jsonb)) x(value)
    );

    update public.notifications n
    set push_status = case
          when v_outcome = 'sent' then 'sent'
          when v_outcome = 'fail' or n.push_attempts >= 5 then 'failed'
          else 'pending'
        end,
        pushed_at = case when v_outcome = 'sent' then v_now else n.pushed_at end,
        push_next_at = case
          when v_outcome = 'retry' and n.push_attempts < 5 then v_now + private.push_backoff(n.push_attempts)
          else null
        end,
        push_error = case when v_outcome = 'sent' then null else left(v_result ->> 'error', 500) end
    where n.id = (v_result ->> 'notification_id')::uuid and n.push_status = 'sending';
    get diagnostics v_rows = row_count;
    v_updated := v_updated + v_rows;
  end loop;

  return v_updated;
end;
$$;

-- Generator ---------------------------------------------------------------------------------
-- Safe to run at any time, repeatedly or concurrently: inserts rely on the dedup constraint and
-- notifications are created only for alerts this run actually inserted.

create function private.generate_expiry_alerts(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_inserted integer;
begin
  -- Close alerts whose batch has sold out or whose expiry date has since changed.
  update public.expiry_alerts a
  set resolved_at = v_now,
      resolution = case when b.quantity <= 0 then 'sold_out' else 'expiry_corrected' end
  from public.stock_batches b
  where b.id = a.batch_id and a.resolved_at is null
    and (b.quantity <= 0 or b.expiry_date is distinct from a.expiry_date);

  with shop_day as (
    select s.id as shop_id, s.timezone, s.expiry_reminder_days as days, (v_now at time zone s.timezone)::date as today
    from public.shops s
  ),
  due as (
    select b.id as batch_id, b.shop_id, b.product_id, b.quantity, b.expiry_date, b.received_at,
           d.today, d.timezone,
           case when b.expiry_date < d.today then 'expired' else 'reminder' end as kind,
           case when b.expiry_date < d.today then null
                else (select min(t) from unnest(d.days) t where t >= b.expiry_date - d.today)
           end as threshold_days
    from public.stock_batches b
    join shop_day d on d.shop_id = b.shop_id
    where b.quantity > 0 and b.expiry_date is not null
  ),
  inserted as (
    insert into public.expiry_alerts (
      shop_id, batch_id, product_id, kind, threshold_days, expiry_date, quantity, alert_date
    )
    select shop_id, batch_id, product_id, kind, threshold_days, expiry_date, quantity, today
    from due
    where kind = 'expired' or threshold_days is not null
    on conflict on constraint expiry_alerts_dedup_key do nothing
    returning *
  ),
  superseded as (
    update public.expiry_alerts a
    set resolved_at = v_now, resolution = 'superseded'
    from inserted i
    where a.batch_id = i.batch_id and a.id <> i.id and a.resolved_at is null
    returning a.id
  ),
  notified as (
    insert into public.notifications (
      shop_id, user_id, type, title, body, data, push_status, push_next_at
    )
    select
      i.shop_id, m.user_id, 'expiry',
      left(case
        when i.kind = 'expired' then format('Expired: %s', p.name)
        when i.expiry_date = i.alert_date then format('Expires today: %s', p.name)
        when i.expiry_date - i.alert_date = 1 then format('Expires tomorrow: %s', p.name)
        else format('Expires in %s days: %s', i.expiry_date - i.alert_date, p.name)
      end, 200),
      format(
        '%s units, expiry %s, batch %s (received %s).',
        i.quantity, to_char(i.expiry_date, 'YYYY-MM-DD'), upper(left(i.batch_id::text, 6)),
        to_char(due.received_at at time zone due.timezone, 'YYYY-MM-DD')
      ),
      jsonb_build_object(
        'alert_id', i.id, 'kind', i.kind, 'threshold_days', i.threshold_days,
        'days_left', i.expiry_date - i.alert_date, 'batch_id', i.batch_id,
        'batch_code', upper(left(i.batch_id::text, 6)),
        'received_date', to_char(due.received_at at time zone due.timezone, 'YYYY-MM-DD'),
        'product_id', i.product_id, 'product_name', p.name, 'quantity', i.quantity,
        'expiry_date', i.expiry_date
      ),
      'pending',
      -- Not before 07:00 shop time, so nobody is woken at night.
      greatest(v_now, (i.alert_date + time '07:00') at time zone due.timezone)
    from inserted i
    join due on due.batch_id = i.batch_id
    join public.products p on p.id = i.product_id
    join public.shop_members m
      on m.shop_id = i.shop_id and m.user_id is not null and m.role in ('owner', 'manager')
    returning 1
  )
  select count(*) into v_inserted from inserted;

  return v_inserted;
end;
$$;

-- Resolving expired stock --------------------------------------------------------------------

alter table public.stock_movements drop constraint stock_movements_reason_check;
alter table public.stock_movements add constraint stock_movements_reason_check check (
  reason in (
    'stock_in', 'sale', 'adjustment', 'write_off_expired', 'write_off_damaged',
    'count_correction', 'return', 'supplier_return'
  )
);

create table public.expiry_resolutions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  batch_id uuid not null references public.stock_batches (id) on delete cascade,
  product_id uuid not null,
  action text not null check (action in ('discarded', 'returned_to_supplier', 'expiry_corrected')),
  quantity integer not null check (quantity >= 0),
  previous_expiry_date date,
  new_expiry_date date,
  note text check (note is null or char_length(note) <= 500),
  movement_id uuid references public.stock_movements (id) on delete set null,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  resolved_by uuid default auth.uid() references auth.users (id) on delete set null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint expiry_resolutions_product_fkey foreign key (shop_id, product_id)
    references public.products (shop_id, id) on delete cascade,
  constraint expiry_resolutions_shop_idempotency_key unique (shop_id, idempotency_key)
);

comment on table public.expiry_resolutions is 'Permanent record of expired stock being removed or its date corrected.';

create index expiry_resolutions_batch_id_idx on public.expiry_resolutions (batch_id);
create index expiry_resolutions_shop_product_idx on public.expiry_resolutions (shop_id, product_id);
create index expiry_resolutions_movement_id_idx on public.expiry_resolutions (movement_id);
create index expiry_resolutions_resolved_by_idx on public.expiry_resolutions (resolved_by);
create index expiry_resolutions_shop_created_idx on public.expiry_resolutions (shop_id, created_at);

alter table public.expiry_resolutions enable row level security;
revoke all on table public.expiry_resolutions from anon, authenticated;
grant select on table public.expiry_resolutions to authenticated;

create policy "Members can view shop expiry resolutions"
  on public.expiry_resolutions for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

-- discarded / returned_to_supplier: removes every unit left in the batch with a movement.
-- expiry_corrected: changes the batch's expiry date (a wrongly captured date); no stock moves.
-- Either way the batch's open alerts close and an expiry_resolutions row is kept.
create function public.resolve_expired_batch(
  p_shop_id uuid,
  p_batch_id uuid,
  p_action text,
  p_new_expiry_date date,
  p_note text,
  p_occurred_at timestamptz,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_uid uuid := (select auth.uid());
  v_occurred_at timestamptz := coalesce(p_occurred_at, now());
  v_batch public.stock_batches;
  v_existing public.expiry_resolutions;
  v_resolution public.expiry_resolutions;
  v_movement_id uuid;
  v_quantity integer := 0;
  v_previous date;
  v_total integer;
begin
  perform private.assert_shop_role(p_shop_id, array['owner', 'manager']);
  if v_key = '' or char_length(v_key) > 200 then
    raise exception 'Idempotency key is required (up to 200 characters).' using errcode = '22023';
  end if;
  if p_action is null or p_action not in ('discarded', 'returned_to_supplier', 'expiry_corrected') then
    raise exception 'Unknown action.' using errcode = '22023';
  end if;
  if p_action = 'expiry_corrected' and p_new_expiry_date is null then
    raise exception 'A corrected expiry date is required.' using errcode = '22023';
  end if;
  if p_note is not null and char_length(p_note) > 500 then
    raise exception 'Note is too long (500 characters).' using errcode = '22023';
  end if;

  select * into v_batch from public.stock_batches where id = p_batch_id and shop_id = p_shop_id;
  if not found then
    raise exception 'Batch not found in this shop.' using errcode = 'P0002';
  end if;

  perform 1 from public.products where id = v_batch.product_id for update;
  select * into v_batch from public.stock_batches where id = p_batch_id for update;

  select * into v_existing
  from public.expiry_resolutions
  where shop_id = p_shop_id and idempotency_key = v_key;
  if found then
    return jsonb_build_object(
      'resolution', to_jsonb(v_existing), 'batch', to_jsonb(v_batch), 'duplicate', true,
      'total_quantity', private.product_stock(p_shop_id, v_batch.product_id)
    );
  end if;

  v_previous := v_batch.expiry_date;

  if p_action = 'expiry_corrected' then
    update public.stock_batches set expiry_date = p_new_expiry_date where id = p_batch_id
    returning * into v_batch;
  else
    if v_batch.quantity <= 0 then
      raise exception 'This batch has no units left.' using errcode = '22023';
    end if;
    v_quantity := v_batch.quantity;
    update public.stock_batches set quantity = 0 where id = p_batch_id returning * into v_batch;

    v_total := private.product_stock(p_shop_id, v_batch.product_id);
    v_movement_id := gen_random_uuid();
    insert into public.stock_movements (
      id, shop_id, product_id, batch_id, reason, quantity_delta, resulting_total_quantity,
      idempotency_key, actor_id, occurred_at
    )
    values (
      v_movement_id, p_shop_id, v_batch.product_id, p_batch_id,
      case when p_action = 'discarded' then 'write_off_expired' else 'supplier_return' end,
      -v_quantity, v_total, 'expiry:' || v_key, v_uid, v_occurred_at
    );
  end if;

  update public.expiry_alerts
  set resolved_at = now(), resolution = p_action
  where batch_id = p_batch_id and resolved_at is null;

  insert into public.expiry_resolutions (
    shop_id, batch_id, product_id, action, quantity, previous_expiry_date, new_expiry_date, note,
    movement_id, idempotency_key, resolved_by, occurred_at
  )
  values (
    p_shop_id, p_batch_id, v_batch.product_id, p_action, v_quantity, v_previous,
    case when p_action = 'expiry_corrected' then p_new_expiry_date else v_previous end,
    nullif(btrim(p_note), ''), v_movement_id, v_key, v_uid, v_occurred_at
  )
  returning * into v_resolution;

  return jsonb_build_object(
    'resolution', to_jsonb(v_resolution), 'batch', to_jsonb(v_batch), 'duplicate', false,
    'total_quantity', private.product_stock(p_shop_id, v_batch.product_id)
  );
end;
$$;

-- record_sale: expired batches are no longer sellable ----------------------------------------
-- Same contract as before, except allocation skips batches past their expiry date on the shop's
-- calendar at the time of sale (sold_at, so an offline sale before midnight still counts).
-- Units that only expired stock could have covered fall into the shortfall/discrepancy path.

create or replace function private.sale_result(p_sale public.sales, p_duplicate boolean, p_shortfall integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'sale', to_jsonb(p_sale),
    'items', coalesce(
      (select jsonb_agg(to_jsonb(i) order by i.created_at, i.id)
       from public.sale_items i where i.sale_id = p_sale.id),
      '[]'::jsonb
    ),
    'stock_totals', coalesce(
      (select jsonb_object_agg(t.product_id::text, private.product_stock(p_sale.shop_id, t.product_id))
       from (select distinct product_id from public.sale_items where sale_id = p_sale.id) t),
      '{}'::jsonb
    ),
    'sellable_totals', coalesce(
      (select jsonb_object_agg(t.product_id::text, private.sellable_stock(p_sale.shop_id, t.product_id))
       from (select distinct product_id from public.sale_items where sale_id = p_sale.id) t),
      '{}'::jsonb
    ),
    'duplicate', p_duplicate,
    'shortfall', p_shortfall
  );
$$;

create or replace function public.record_sale(
  p_sale_id uuid,
  p_shop_id uuid,
  p_idempotency_key text,
  p_sold_at timestamptz,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_sold_at timestamptz := coalesce(p_sold_at, now());
  v_uid uuid := (select auth.uid());
  v_sale public.sales;
  v_item record;
  v_batch record;
  v_remaining integer;
  v_take integer;
  v_total integer;
  v_allocations jsonb;
  v_shortfall integer := 0;
  v_locked integer := 0;
  v_product_id uuid;
  v_product_name text;
  v_today date;
begin
  perform private.assert_shop_role(p_shop_id, array['owner', 'manager', 'staff']);
  if p_sale_id is null then
    raise exception 'Sale id is required.' using errcode = '22023';
  end if;
  if v_key = '' or char_length(v_key) > 200 then
    raise exception 'Idempotency key is required (up to 200 characters).' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 100 then
    raise exception 'A sale needs 1 to 100 items.' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_items) e(value) where jsonb_typeof(e.value) <> 'object'
  ) or exists (
    select 1 from private.sale_lines(p_items) l
    where l.id is null or l.product_id is null or l.quantity is null
       or l.quantity <= 0 or l.quantity > 1000000 or l.unit_price < 0
  ) then
    raise exception 'Each item needs an id, a product, a quantity from 1 to 1,000,000 and a non-negative price.'
      using errcode = '22023';
  end if;
  if (select count(distinct l.id) from private.sale_lines(p_items) l) <> jsonb_array_length(p_items) then
    raise exception 'Item ids must be unique.' using errcode = '22023';
  end if;

  -- Lock every product in the sale, in id order, before reading or changing stock.
  for v_product_id in
    select p.id from public.products p
    where p.shop_id = p_shop_id and p.id in (select l.product_id from private.sale_lines(p_items) l)
    order by p.id
    for update
  loop
    v_locked := v_locked + 1;
  end loop;
  if v_locked <> (select count(distinct l.product_id) from private.sale_lines(p_items) l) then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;

  select * into v_sale
  from public.sales
  where shop_id = p_shop_id and (id = p_sale_id or idempotency_key = v_key)
  limit 1;
  if found then
    return private.sale_result(v_sale, true, 0);
  end if;

  v_today := private.shop_today(p_shop_id, v_sold_at);

  insert into public.sales (id, shop_id, idempotency_key, total_amount, item_count, sold_by, sold_at)
  select p_sale_id, p_shop_id, v_key, sum(round(l.unit_price * l.quantity, 2)), count(*), v_uid, v_sold_at
  from private.sale_lines(p_items) l
  returning * into v_sale;

  for v_item in select * from private.sale_lines(p_items) l order by l.ord loop
    insert into public.sale_items (id, shop_id, sale_id, product_id, quantity, unit_price, line_total)
    values (
      v_item.id, p_shop_id, p_sale_id, v_item.product_id, v_item.quantity, v_item.unit_price,
      round(v_item.unit_price * v_item.quantity, 2)
    );

    v_remaining := v_item.quantity;
    v_allocations := '[]'::jsonb;
    v_total := private.product_stock(p_shop_id, v_item.product_id);

    for v_batch in
      select id, quantity, expiry_date
      from public.stock_batches
      where shop_id = p_shop_id and product_id = v_item.product_id and quantity > 0
        and (expiry_date is null or expiry_date >= v_today)
      order by expiry_date asc nulls last, received_at asc, id asc
      for update
    loop
      exit when v_remaining <= 0;
      v_take := least(v_batch.quantity, v_remaining);
      v_remaining := v_remaining - v_take;
      v_total := v_total - v_take;

      update public.stock_batches set quantity = quantity - v_take where id = v_batch.id;

      insert into public.stock_movements (
        id, shop_id, product_id, batch_id, sale_id, sale_item_id, reason, quantity_delta,
        resulting_total_quantity, idempotency_key, actor_id, occurred_at
      )
      values (
        gen_random_uuid(), p_shop_id, v_item.product_id, v_batch.id, p_sale_id, v_item.id, 'sale',
        -v_take, v_total, 'sale:' || v_key || ':' || v_item.id || ':' || v_batch.id, v_uid, v_sold_at
      );

      v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
        'batchId', v_batch.id,
        'quantityDeducted', v_take,
        'batchExpiryDate', v_batch.expiry_date
      ));
    end loop;

    update public.sale_items set allocations = v_allocations where id = v_item.id;

    if v_remaining > 0 then
      v_shortfall := v_shortfall + v_remaining;

      insert into public.stock_discrepancies (shop_id, product_id, sale_id, sale_item_id, shortfall)
      values (p_shop_id, v_item.product_id, p_sale_id, v_item.id, v_remaining);

      select name into v_product_name from public.products where id = v_item.product_id;
      insert into public.notifications (shop_id, user_id, type, title, body, data)
      select p_shop_id, m.user_id, 'stock_discrepancy', 'Stock needs a recount',
             format('%s units of %s were sold without recorded stock.', v_remaining, v_product_name),
             jsonb_build_object(
               'product_id', v_item.product_id, 'sale_id', p_sale_id,
               'sale_item_id', v_item.id, 'shortfall', v_remaining
             )
      from public.shop_members m
      where m.shop_id = p_shop_id and m.user_id is not null and m.role in ('owner', 'manager');
    end if;
  end loop;

  return private.sale_result(v_sale, false, v_shortfall);
end;
$$;

-- Privileges ---------------------------------------------------------------------------------

revoke all on function private.is_valid_timezone(text) from public, anon, authenticated;
revoke all on function private.is_valid_reminder_days(smallint[]) from public, anon, authenticated;
revoke all on function private.check_shop_timezone() from public, anon, authenticated;
revoke all on function private.shop_today(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.sellable_stock(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.vault_secret(text) from public, anon, authenticated;
revoke all on function private.push_backoff(integer) from public, anon, authenticated;
revoke all on function private.generate_expiry_alerts(timestamptz) from public, anon, authenticated;
-- Evaluated by the shops check constraint and trigger, which run as the writing user.
grant execute on function private.is_valid_timezone(text) to authenticated, service_role;
grant execute on function private.is_valid_reminder_days(smallint[]) to authenticated, service_role;

revoke all on function public.update_shop_alert_settings(uuid, integer[], text) from public, anon;
revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.delete_push_subscription(text) from public, anon;
revoke all on function public.get_push_public_key() from public, anon;
revoke all on function public.resolve_expired_batch(uuid, uuid, text, date, text, timestamptz, text) from public, anon;
grant execute on function public.update_shop_alert_settings(uuid, integer[], text) to authenticated;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.delete_push_subscription(text) to authenticated;
grant execute on function public.get_push_public_key() to authenticated;
grant execute on function public.resolve_expired_batch(uuid, uuid, text, date, text, timestamptz, text) to authenticated;

revoke all on function public.push_config() from public, anon, authenticated;
revoke all on function public.claim_push_batch(integer, timestamptz) from public, anon, authenticated;
revoke all on function public.complete_push(jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.push_config() to service_role;
grant execute on function public.claim_push_batch(integer, timestamptz) to service_role;
grant execute on function public.complete_push(jsonb, timestamptz) to service_role;
