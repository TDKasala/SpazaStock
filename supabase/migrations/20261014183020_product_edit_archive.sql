-- Editing and archiving products.
--
-- Products are never deleted: sales, batches, movements and alerts reference them with
-- `on delete cascade`, so a delete would erase history. Archiving hides a product from the
-- catalogue instead. Sales and stock-in for an archived product are still accepted, because a
-- phone that was offline may have sold it before it learned of the archive.
--
-- Owners and managers (permission products.edit) change products only through these functions;
-- the direct column grant is revoked so every edit is validated the same way.
--
-- Error codes the client relies on:
--   22023 invalid_parameter_value -> permanent validation failure
--   23505 unique_violation        -> another product in the shop already uses the barcode
--   42501 insufficient_privilege  -> caller lacks products.edit in this shop
--   P0002 no_data_found           -> product is not in this shop

alter table public.products add column archived_at timestamptz;

comment on column public.products.archived_at is
  'Set when the product is archived (hidden from lists, scans and alerts); history is kept.';

revoke update on public.products from authenticated;
drop policy "Owners and managers can edit shop products" on public.products;

-- Expiry alerts for an archived product are closed with this resolution.
alter table public.expiry_alerts drop constraint expiry_alerts_resolution_check;
alter table public.expiry_alerts add constraint expiry_alerts_resolution_check check (
  resolution is null
  or resolution in (
    'sold_out', 'discarded', 'returned_to_supplier', 'expiry_corrected', 'superseded', 'product_archived'
  )
);

-- update_product ---------------------------------------------------------------------------------

create function public.update_product(
  p_shop_id uuid,
  p_product_id uuid,
  p_barcode text,
  p_name text,
  p_category text,
  p_buying_price numeric,
  p_selling_price numeric
)
returns public.products
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products;
  v_barcode text := regexp_replace(coalesce(p_barcode, ''), '\s', '', 'g');
  v_name text := btrim(coalesce(p_name, ''));
begin
  perform private.assert_permission(p_shop_id, 'products.edit');
  if p_product_id is null then
    raise exception 'Product id is required.' using errcode = '22023';
  end if;
  if v_barcode = '' or char_length(v_barcode) > 64 then
    raise exception 'Barcode is required (up to 64 characters).' using errcode = '22023';
  end if;
  if v_name = '' or char_length(v_name) > 200 then
    raise exception 'Product name is required (up to 200 characters).' using errcode = '22023';
  end if;
  if p_category is null or p_category not in (
    'groceries', 'beverages', 'snacks', 'bakery', 'dairy', 'personal_care', 'household', 'airtime', 'other'
  ) then
    raise exception 'Unknown product category.' using errcode = '22023';
  end if;
  if p_buying_price < 0 or p_selling_price < 0 then
    raise exception 'Prices cannot be negative.' using errcode = '22023';
  end if;

  perform 1 from public.products where id = p_product_id and shop_id = p_shop_id for update;
  if not found then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.products
    where shop_id = p_shop_id and barcode = v_barcode and id <> p_product_id
  ) then
    raise exception 'Another product in this shop already uses barcode %.', v_barcode using errcode = '23505';
  end if;

  update public.products
  set barcode = v_barcode,
      name = v_name,
      category = p_category,
      buying_price = p_buying_price,
      selling_price = p_selling_price
  where id = p_product_id and shop_id = p_shop_id
  returning * into v_product;

  return v_product;
exception
  when unique_violation then
    raise exception 'Another product in this shop already uses barcode %.', v_barcode using errcode = '23505';
end;
$$;

-- set_product_archived ---------------------------------------------------------------------------

create function public.set_product_archived(p_shop_id uuid, p_product_id uuid, p_archived boolean)
returns public.products
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products;
begin
  perform private.assert_permission(p_shop_id, 'products.edit');
  if p_product_id is null or p_archived is null then
    raise exception 'Product id and archived flag are required.' using errcode = '22023';
  end if;

  select * into v_product
  from public.products
  where id = p_product_id and shop_id = p_shop_id
  for update;
  if not found then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;

  -- Idempotent: archiving twice keeps the first archive time.
  if p_archived and v_product.archived_at is null then
    update public.products set archived_at = now()
    where id = p_product_id
    returning * into v_product;

    update public.expiry_alerts
    set resolved_at = now(), resolution = 'product_archived'
    where shop_id = p_shop_id and product_id = p_product_id and resolved_at is null;
  elsif not p_archived and v_product.archived_at is not null then
    update public.products set archived_at = null
    where id = p_product_id
    returning * into v_product;
  end if;

  return v_product;
end;
$$;

revoke all on function public.update_product(uuid, uuid, text, text, text, numeric, numeric)
  from public, anon;
revoke all on function public.set_product_archived(uuid, uuid, boolean) from public, anon;
grant execute on function public.update_product(uuid, uuid, text, text, text, numeric, numeric)
  to authenticated;
grant execute on function public.set_product_archived(uuid, uuid, boolean) to authenticated;

-- Alert generator: same as before, but archived products get no new alerts. ----------------------

create or replace function private.generate_expiry_alerts(p_now timestamptz default now())
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

  -- Close alerts whose product has been archived.
  update public.expiry_alerts a
  set resolved_at = v_now, resolution = 'product_archived'
  from public.products p
  where p.id = a.product_id and a.resolved_at is null and p.archived_at is not null;

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
    join public.products pr on pr.id = b.product_id and pr.archived_at is null
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

revoke all on function private.generate_expiry_alerts(timestamptz) from public, anon, authenticated;
