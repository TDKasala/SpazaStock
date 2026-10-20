-- A new shop can see common catalogue products without copying them into inventory.
-- A shop product row is created only when the owner confirms a choice.
-- Existing shops stay catalog_prompt_pending = false through the constant default.

alter table public.catalog_products
  add column common boolean not null default false;

comment on column public.catalog_products.common is
  'Shown to a new shop as a choice. Not copied into that shop until the owner confirms it.';

alter table public.shops
  add column catalog_prompt_pending boolean not null default false;

comment on column public.shops.catalog_prompt_pending is
  'True only for a shop that has not yet confirmed or skipped the common catalogue. Existing shops stay false.';

grant select (catalog_prompt_pending) on public.shops to authenticated;
grant select (common) on public.catalog_products to authenticated;

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
    'longitude', s.longitude,
    'catalog_prompt_pending', s.catalog_prompt_pending
  ) order by s.created_at, s.id), '[]'::jsonb)
  from public.shop_members m
  join public.shops s on s.id = m.shop_id
  where m.user_id = (select auth.uid()) and m.status = 'active';
$$;

create or replace function public.create_shop(
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

  insert into public.shops (
    owner_id, name, phone, address, city, province, latitude, longitude, catalog_prompt_pending
  )
  values (
    v_uid,
    v_name,
    v_contact ->> 'phone',
    v_contact ->> 'address',
    v_contact ->> 'city',
    v_contact ->> 'province',
    (v_location ->> 'latitude')::double precision,
    (v_location ->> 'longitude')::double precision,
    true
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
    'longitude', v_shop.longitude,
    'catalog_prompt_pending', v_shop.catalog_prompt_pending
  );
end;
$$;

create or replace function public.admin_create_shop(
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

  insert into public.shops (
    owner_id, name, phone, address, city, province, latitude, longitude, catalog_prompt_pending
  )
  values (
    v_owner,
    v_name,
    v_contact ->> 'phone',
    v_contact ->> 'address',
    v_contact ->> 'city',
    v_contact ->> 'province',
    (v_location ->> 'latitude')::double precision,
    (v_location ->> 'longitude')::double precision,
    true
  )
  returning * into v_shop;

  perform private.audit(
    'tenant.created', 'success', 'shop', v_shop.id::text, v_shop.id, v_reason,
    jsonb_build_object('name', v_name, 'owner_email', private.user_email(v_owner))
  );
  return jsonb_build_object('ok', true, 'shop_id', v_shop.id);
end;
$$;

create function public.admin_set_catalog_common(p_id uuid, p_common boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
begin
  if not private.has_platform_permission('catalog.verify') then
    return private.platform_denied('catalog.common', 'catalog', p_id::text);
  end if;
  v_reason := private.require_reason(p_reason);
  if p_id is null or p_common is null then
    raise exception 'Catalog product and common flag are required.' using errcode = '22023';
  end if;

  update public.catalog_products
  set common = p_common
  where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  perform private.audit(
    'catalog.common', 'success', 'catalog', p_id::text, null, v_reason,
    jsonb_build_object('common', p_common)
  );
  return jsonb_build_object('ok', true, 'common', p_common);
end;
$$;

create or replace function public.admin_get_catalog_product(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.catalog_products;
  v_barcodes jsonb;
begin
  if not private.has_platform_permission('catalog.verify') then
    return private.platform_denied('catalog.view', 'catalog', p_id::text);
  end if;
  if p_id is null then
    raise exception 'Catalog product id is required.' using errcode = '22023';
  end if;

  select * into v_product from public.catalog_products where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'barcode', b.barcode,
    'kind', b.kind,
    'units_per_package', b.units_per_package
  ) order by b.kind, b.barcode), '[]'::jsonb)
  into v_barcodes
  from public.catalog_barcodes b
  where b.catalog_product_id = p_id;

  perform private.audit('catalog.view', 'success', 'catalog', p_id::text);

  return jsonb_build_object(
    'ok', true,
    'product', jsonb_build_object(
      'id', v_product.id,
      'name', v_product.name,
      'brand', v_product.brand,
      'category', v_product.category,
      'package_size', v_product.package_size,
      'package_quantity', v_product.package_quantity,
      'package_unit', v_product.package_unit,
      'image_url', v_product.image_url,
      'image_path', v_product.image_path,
      'verification_status', v_product.verification_status,
      'source', v_product.source,
      'common', v_product.common
    ),
    'barcodes', v_barcodes
  );
end;
$$;

create function public.list_common_catalog(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.shop_members m
    where m.shop_id = p_shop_id and m.user_id = (select auth.uid()) and m.status = 'active'
  ) then
    raise exception 'You do not have access to this shop.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'brand', c.brand,
    'category', c.category,
    'package_size', c.package_size,
    'barcodes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'barcode', b.barcode,
        'kind', b.kind,
        'units_per_package', b.units_per_package
      ) order by b.kind, b.barcode)
      from public.catalog_barcodes b
      where b.catalog_product_id = c.id
    ), '[]'::jsonb),
    'shop_product_id', (
      select p.id from public.products p
      where p.shop_id = p_shop_id
        and p.catalog_product_id = c.id
        and p.archived_at is null
      limit 1
    )
  ) order by c.name, c.id), '[]'::jsonb)
  into v_items
  from public.catalog_products c
  where c.common;

  return jsonb_build_object('items', v_items);
end;
$$;

create function public.confirm_shop_catalog(p_shop_id uuid, p_selections jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_catalog_id uuid;
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
  if p_selections is null or jsonb_typeof(p_selections) <> 'array' then
    raise exception 'Choose catalogue products as a list.' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_selections)
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

    v_buying := null;
    v_selling := null;
    if nullif(v_item ->> 'buying_price', '') is not null then
      v_buying := (v_item ->> 'buying_price')::numeric;
    end if;
    if nullif(v_item ->> 'selling_price', '') is not null then
      v_selling := (v_item ->> 'selling_price')::numeric;
    end if;
    if v_buying < 0 or v_selling < 0 then
      raise exception 'Prices cannot be negative.' using errcode = '22023';
    end if;

    select * into v_catalog from public.catalog_products where id = v_catalog_id;
    if not found then
      raise exception 'Catalog product not found.' using errcode = 'P0002';
    end if;
    if not v_catalog.common then
      raise exception 'Only a common catalogue product can be added while setting up a shop.' using errcode = '22023';
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

    if not found then
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
            created_at, brand, size, catalog_product_id
          )
          values (
            gen_random_uuid(), p_shop_id, v_primary, v_catalog.name, v_catalog.category,
            v_buying, v_selling, now(), v_catalog.brand, v_catalog.package_size, v_catalog_id
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

  update public.shops
  set catalog_prompt_pending = false
  where id = p_shop_id;

  return jsonb_build_object('ok', true, 'products', v_results);
end;
$$;

revoke all on function public.admin_set_catalog_common(uuid, boolean, text) from public, anon;
revoke all on function public.list_common_catalog(uuid) from public, anon;
revoke all on function public.confirm_shop_catalog(uuid, jsonb) from public, anon;

grant execute on function public.admin_set_catalog_common(uuid, boolean, text) to authenticated;
grant execute on function public.list_common_catalog(uuid) to authenticated;
grant execute on function public.confirm_shop_catalog(uuid, jsonb) to authenticated;
