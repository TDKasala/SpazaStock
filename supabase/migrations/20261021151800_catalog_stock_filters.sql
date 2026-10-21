-- Category and stock-level filters for the shared catalogue and the shop catalogue page.
-- Stock level uses the same rules as the stock page: sellable units exclude expired batches.

create function private.shop_product_stock_state(p_shop_id uuid, p_product_id uuid, p_today date)
returns table (sellable integer, expiring boolean)
language sql
stable
set search_path = ''
as $$
  select
    coalesce(sum(b.quantity) filter (
      where b.expiry_date is null or b.expiry_date >= p_today
    ), 0)::integer,
    coalesce(bool_or(
      b.expiry_date is not null and b.expiry_date <= p_today + 7
    ), false)
  from public.stock_batches b
  where p_product_id is not null
    and b.shop_id = p_shop_id
    and b.product_id = p_product_id
    and b.quantity > 0;
$$;

create function private.matches_stock_level(
  p_level text,
  p_sellable integer,
  p_min_stock integer,
  p_expiring boolean
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_level
    when 'in' then p_sellable > 0
    when 'out' then p_sellable <= 0
    when 'low' then p_min_stock is not null and p_sellable <= p_min_stock
    when 'expiring' then p_expiring
    else true
  end;
$$;

revoke all on function private.shop_product_stock_state(uuid, uuid, date) from public, anon, authenticated;
revoke all on function private.matches_stock_level(text, integer, integer, boolean) from public, anon, authenticated;

drop function public.search_catalog(uuid, text, integer, integer, boolean);

create function public.search_catalog(
  p_shop_id uuid,
  p_query text default '',
  p_limit integer default 20,
  p_offset integer default 0,
  p_in_shop boolean default null,
  p_category text default null,
  p_stock text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_term text := left(btrim(coalesce(p_query, '')), 80);
  v_pattern text;
  v_category text := nullif(btrim(coalesce(p_category, '')), '');
  v_stock text := nullif(btrim(coalesce(p_stock, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_today date := private.shop_today(p_shop_id);
  v_total integer;
  v_items jsonb;
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.shop_members m
    where m.shop_id = p_shop_id and m.user_id = (select auth.uid()) and m.status = 'active'
  ) then
    raise exception 'You do not have access to this shop.' using errcode = '42501';
  end if;
  if v_category is not null and v_category not in (
    'groceries', 'beverages', 'snacks', 'bakery', 'dairy',
    'personal_care', 'household', 'airtime', 'other'
  ) then
    raise exception 'Choose a known category.' using errcode = '22023';
  end if;
  if v_stock is not null and v_stock not in ('in', 'out', 'low', 'expiring') then
    raise exception 'Choose a known stock level.' using errcode = '22023';
  end if;

  v_pattern := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  select count(*)::int into v_total
  from public.catalog_products c
  left join lateral (
    select p.id, p.min_stock_units
    from public.products p
    where p.shop_id = p_shop_id
      and p.catalog_product_id = c.id
      and p.archived_at is null
    limit 1
  ) shop on true
  left join lateral private.shop_product_stock_state(p_shop_id, shop.id, v_today) st on true
  where (
      v_term = ''
      or c.name ilike v_pattern escape '\'
      or c.brand ilike v_pattern escape '\'
      or exists (
        select 1 from public.catalog_barcodes b
        where b.catalog_product_id = c.id and b.barcode ilike v_pattern escape '\'
      )
    )
    and (v_category is null or c.category = v_category)
    and (
      p_in_shop is null
      or (p_in_shop is true and shop.id is not null)
      or (p_in_shop is false and shop.id is null)
    )
    and (
      v_stock is null
      or private.matches_stock_level(v_stock, coalesce(st.sellable, 0), shop.min_stock_units, coalesce(st.expiring, false))
    );

  select coalesce(jsonb_agg(row_to_json(hit)::jsonb), '[]'::jsonb) into v_items
  from (
    select
      c.id,
      c.name,
      c.brand,
      c.category,
      c.package_size,
      c.package_quantity,
      c.package_unit,
      c.image_url,
      c.image_path,
      c.verification_status,
      shop.id as shop_product_id,
      shop.listed as shop_listed,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'barcode', b.barcode,
          'kind', b.kind,
          'units_per_package', b.units_per_package
        ) order by b.kind, b.barcode)
        from public.catalog_barcodes b
        where b.catalog_product_id = c.id
      ), '[]'::jsonb) as barcodes
    from public.catalog_products c
    left join lateral (
      select p.id, p.listed, p.min_stock_units
      from public.products p
      where p.shop_id = p_shop_id
        and p.catalog_product_id = c.id
        and p.archived_at is null
      limit 1
    ) shop on true
    left join lateral private.shop_product_stock_state(p_shop_id, shop.id, v_today) st on true
    where (
        v_term = ''
        or c.name ilike v_pattern escape '\'
        or c.brand ilike v_pattern escape '\'
        or exists (
          select 1 from public.catalog_barcodes b
          where b.catalog_product_id = c.id and b.barcode ilike v_pattern escape '\'
        )
      )
      and (v_category is null or c.category = v_category)
      and (
        p_in_shop is null
        or (p_in_shop is true and shop.id is not null)
        or (p_in_shop is false and shop.id is null)
      )
      and (
        v_stock is null
        or private.matches_stock_level(v_stock, coalesce(st.sellable, 0), shop.min_stock_units, coalesce(st.expiring, false))
      )
    order by c.name, c.id
    limit v_limit
    offset v_offset
  ) hit;

  return jsonb_build_object('items', v_items, 'total', v_total);
end;
$$;

drop function public.list_shop_catalog_review(uuid, text, text, text, integer, integer);

create function public.list_shop_catalog_review(
  p_shop_id uuid,
  p_query text default '',
  p_status text default null,
  p_category text default null,
  p_limit integer default 20,
  p_offset integer default 0,
  p_stock text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_term text := left(btrim(coalesce(p_query, '')), 80);
  v_pattern text;
  v_status text := nullif(btrim(coalesce(p_status, '')), '');
  v_category text := nullif(btrim(coalesce(p_category, '')), '');
  v_stock text := nullif(btrim(coalesce(p_stock, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_today date := private.shop_today(p_shop_id);
  v_filtered integer;
  v_total integer;
  v_selling integer;
  v_hidden integer;
  v_open integer;
  v_items jsonb;
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.shop_members m
    where m.shop_id = p_shop_id and m.user_id = (select auth.uid()) and m.status = 'active'
  ) then
    raise exception 'You do not have access to this shop.' using errcode = '42501';
  end if;
  if v_status is not null and v_status not in ('open', 'selling', 'hidden') then
    raise exception 'Choose open, selling, or hidden.' using errcode = '22023';
  end if;
  if v_category is not null and v_category not in (
    'groceries', 'beverages', 'snacks', 'bakery', 'dairy',
    'personal_care', 'household', 'airtime', 'other'
  ) then
    raise exception 'Choose a known category.' using errcode = '22023';
  end if;
  if v_stock is not null and v_stock not in ('in', 'out', 'low', 'expiring') then
    raise exception 'Choose a known stock level.' using errcode = '22023';
  end if;

  v_pattern := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  select
    count(*)::int,
    count(*) filter (where shop.listed)::int,
    count(*) filter (where shop.id is not null and not shop.listed)::int,
    count(*) filter (where shop.id is null)::int
  into v_total, v_selling, v_hidden, v_open
  from public.catalog_products c
  left join lateral (
    select p.id, p.listed
    from public.products p
    where p.shop_id = p_shop_id
      and p.catalog_product_id = c.id
      and p.archived_at is null
    limit 1
  ) shop on true
  where c.common;

  select count(*)::int into v_filtered
  from public.catalog_products c
  left join lateral (
    select p.id, p.listed, p.min_stock_units
    from public.products p
    where p.shop_id = p_shop_id
      and p.catalog_product_id = c.id
      and p.archived_at is null
    limit 1
  ) shop on true
  left join lateral private.shop_product_stock_state(p_shop_id, shop.id, v_today) st on true
  where c.common
    and (v_category is null or c.category = v_category)
    and (
      v_status is null
      or (v_status = 'open' and shop.id is null)
      or (v_status = 'selling' and shop.listed)
      or (v_status = 'hidden' and shop.id is not null and not shop.listed)
    )
    and (
      v_stock is null
      or private.matches_stock_level(v_stock, coalesce(st.sellable, 0), shop.min_stock_units, coalesce(st.expiring, false))
    )
    and (
      v_term = ''
      or c.name ilike v_pattern escape '\'
      or c.brand ilike v_pattern escape '\'
      or exists (
        select 1 from public.catalog_barcodes b
        where b.catalog_product_id = c.id and b.barcode ilike v_pattern escape '\'
      )
    );

  select coalesce(jsonb_agg(row_to_json(hit)::jsonb), '[]'::jsonb) into v_items
  from (
    select
      c.id,
      c.name,
      c.brand,
      c.category,
      c.package_size,
      c.image_url,
      c.image_path,
      shop.id as shop_product_id,
      shop.listed,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'barcode', b.barcode,
          'kind', b.kind,
          'units_per_package', b.units_per_package
        ) order by b.kind, b.barcode)
        from public.catalog_barcodes b
        where b.catalog_product_id = c.id
      ), '[]'::jsonb) as barcodes
    from public.catalog_products c
    left join lateral (
      select p.id, p.listed, p.min_stock_units
      from public.products p
      where p.shop_id = p_shop_id
        and p.catalog_product_id = c.id
        and p.archived_at is null
      limit 1
    ) shop on true
    left join lateral private.shop_product_stock_state(p_shop_id, shop.id, v_today) st on true
    where c.common
      and (v_category is null or c.category = v_category)
      and (
        v_status is null
        or (v_status = 'open' and shop.id is null)
        or (v_status = 'selling' and shop.listed)
        or (v_status = 'hidden' and shop.id is not null and not shop.listed)
      )
      and (
        v_stock is null
        or private.matches_stock_level(v_stock, coalesce(st.sellable, 0), shop.min_stock_units, coalesce(st.expiring, false))
      )
      and (
        v_term = ''
        or c.name ilike v_pattern escape '\'
        or c.brand ilike v_pattern escape '\'
        or exists (
          select 1 from public.catalog_barcodes b
          where b.catalog_product_id = c.id and b.barcode ilike v_pattern escape '\'
        )
      )
    order by c.name, c.id
    limit v_limit
    offset v_offset
  ) hit;

  return jsonb_build_object(
    'items', v_items,
    'total', v_filtered,
    'progress', jsonb_build_object(
      'total', v_total,
      'selling', v_selling,
      'hidden', v_hidden,
      'open', v_open
    )
  );
end;
$$;

revoke all on function public.search_catalog(uuid, text, integer, integer, boolean, text, text) from public, anon;
revoke all on function public.list_shop_catalog_review(uuid, text, text, text, integer, integer, text) from public, anon;

grant execute on function public.search_catalog(uuid, text, integer, integer, boolean, text, text) to authenticated;
grant execute on function public.list_shop_catalog_review(uuid, text, text, text, integer, integer, text) to authenticated;
