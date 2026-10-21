-- A shop reviews common catalogue products over time.
-- Sell and hide are stored only on that shop's product row. The shared catalogue is not changed.

create function public.list_shop_catalog_review(
  p_shop_id uuid,
  p_query text default '',
  p_status text default null,
  p_category text default null,
  p_limit integer default 20,
  p_offset integer default 0
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
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
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
    select p.id, p.listed
    from public.products p
    where p.shop_id = p_shop_id
      and p.catalog_product_id = c.id
      and p.archived_at is null
    limit 1
  ) shop on true
  where c.common
    and (v_category is null or c.category = v_category)
    and (
      v_status is null
      or (v_status = 'open' and shop.id is null)
      or (v_status = 'selling' and shop.listed)
      or (v_status = 'hidden' and shop.id is not null and not shop.listed)
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
      select p.id, p.listed
      from public.products p
      where p.shop_id = p_shop_id
        and p.catalog_product_id = c.id
        and p.archived_at is null
      limit 1
    ) shop on true
    where c.common
      and (v_category is null or c.category = v_category)
      and (
        v_status is null
        or (v_status = 'open' and shop.id is null)
        or (v_status = 'selling' and shop.listed)
        or (v_status = 'hidden' and shop.id is not null and not shop.listed)
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

create function public.review_shop_catalog(p_shop_id uuid, p_decisions jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_catalog_id uuid;
  v_decision text;
  v_listed boolean;
  v_buying numeric;
  v_selling numeric;
  v_catalog public.catalog_products;
  v_product public.products;
  v_primary text;
  v_created boolean;
  v_links jsonb;
  v_results jsonb := '[]'::jsonb;
  v_seen uuid[] := '{}';
begin
  perform private.assert_permission(p_shop_id, 'products.edit');
  if p_decisions is null or jsonb_typeof(p_decisions) <> 'array' or jsonb_array_length(p_decisions) = 0 then
    raise exception 'Choose at least one catalogue product.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_decisions) > 50 then
    raise exception 'Review up to 50 products at a time.' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_decisions)
  loop
    begin
      v_catalog_id := nullif(v_item ->> 'catalog_product_id', '')::uuid;
    exception
      when invalid_text_representation then
        raise exception 'Catalog product id is required.' using errcode = '22023';
    end;
    if v_catalog_id is null then
      raise exception 'Catalog product id is required.' using errcode = '22023';
    end if;
    if v_catalog_id = any (v_seen) then
      continue;
    end if;
    v_seen := array_append(v_seen, v_catalog_id);

    v_decision := v_item ->> 'decision';
    if v_decision not in ('sell', 'hide') then
      raise exception 'Choose sell or hide.' using errcode = '22023';
    end if;
    v_listed := v_decision = 'sell';

    v_buying := null;
    v_selling := null;
    if v_listed then
      if nullif(v_item ->> 'buying_price', '') is not null then
        v_buying := (v_item ->> 'buying_price')::numeric;
      end if;
      if nullif(v_item ->> 'selling_price', '') is not null then
        v_selling := (v_item ->> 'selling_price')::numeric;
      end if;
      if v_buying < 0 or v_selling < 0 then
        raise exception 'Prices cannot be negative.' using errcode = '22023';
      end if;
    end if;

    select * into v_catalog from public.catalog_products where id = v_catalog_id;
    if not found then
      raise exception 'Catalog product not found.' using errcode = 'P0002';
    end if;
    if not v_catalog.common then
      raise exception 'Only a common catalogue product can be reviewed for this shop.' using errcode = '22023';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_shop_id::text || '|' || v_catalog_id::text, 0)
    );

    select * into v_product
    from public.products
    where shop_id = p_shop_id and catalog_product_id = v_catalog_id and archived_at is null
    for update;

    v_created := false;
    v_links := jsonb_build_object('packagings', '[]'::jsonb, 'barcodes', '[]'::jsonb);

    if found then
      if v_product.listed is distinct from v_listed then
        update public.products
        set listed = v_listed
        where id = v_product.id and shop_id = p_shop_id
        returning * into v_product;
      end if;
    else
      select b.barcode into v_primary
      from public.catalog_barcodes b
      where b.catalog_product_id = v_catalog_id and b.kind in ('unit', 'alternate')
      order by case b.kind when 'unit' then 0 else 1 end, b.created_at, b.barcode
      limit 1;
      if v_primary is null then
        raise exception 'This catalog product has no single-item barcode.' using errcode = '22023';
      end if;

      select * into v_product
      from public.products
      where shop_id = p_shop_id and barcode = v_primary
      for update;

      if found and v_product.archived_at is null and v_product.catalog_product_id is null then
        v_product := private.attach_catalog_link(v_product, v_catalog_id);
        if v_product.listed is distinct from v_listed then
          update public.products
          set listed = v_listed
          where id = v_product.id and shop_id = p_shop_id
          returning * into v_product;
        end if;
      elsif found and (
        v_product.archived_at is not null
        or v_product.catalog_product_id is distinct from v_catalog_id
      ) then
        if v_product.archived_at is null then
          raise exception 'Barcode % is already used in this shop.', v_primary using errcode = '23505';
        end if;
      elsif not found then
        begin
          insert into public.products (
            id, shop_id, barcode, name, category, buying_price, selling_price,
            created_at, brand, size, catalog_product_id, listed
          )
          values (
            gen_random_uuid(), p_shop_id, v_primary, v_catalog.name, v_catalog.category,
            v_buying, v_selling, now(), v_catalog.brand, v_catalog.package_size, v_catalog_id, v_listed
          )
          returning * into v_product;
          v_created := true;
          v_links := private.copy_catalog_barcodes(p_shop_id, v_product.id, v_catalog_id);
        exception
          when unique_violation then
            select * into v_product
            from public.products
            where shop_id = p_shop_id and catalog_product_id = v_catalog_id and archived_at is null;
            if not found then
              raise;
            end if;
            if v_product.listed is distinct from v_listed then
              update public.products
              set listed = v_listed
              where id = v_product.id and shop_id = p_shop_id
              returning * into v_product;
            end if;
        end;
      end if;
    end if;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'created', v_created,
      'product', to_jsonb(v_product),
      'packagings', v_links -> 'packagings',
      'barcodes', v_links -> 'barcodes'
    ));
  end loop;

  return jsonb_build_object('ok', true, 'products', v_results);
end;
$$;

revoke all on function public.list_shop_catalog_review(uuid, text, text, text, integer, integer) from public, anon;
revoke all on function public.review_shop_catalog(uuid, jsonb) from public, anon;

grant execute on function public.list_shop_catalog_review(uuid, text, text, text, integer, integer) to authenticated;
grant execute on function public.review_shop_catalog(uuid, jsonb) to authenticated;
