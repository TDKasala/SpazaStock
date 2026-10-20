-- Platform-admin access to the shared catalogue.
-- Shop prices, quantities and expiry stay on the shop product and its batches.
-- These functions never update public.products, public.stock_batches, public.product_barcodes
-- or public.product_packagings. Shop submit and adopt are unchanged.

-- True only for a superadmin and a shared-catalogue picture path.
create function private.can_manage_catalog_image(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_platform_permission('catalog.verify')
    and p_name ~ '^catalog/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg)$';
$$;

revoke all on function private.can_manage_catalog_image(text) from public, anon;
grant execute on function private.can_manage_catalog_image(text) to authenticated;

create policy "Platform admins can view catalog images"
  on storage.objects for select to authenticated
  using (bucket_id = 'product-images' and private.can_manage_catalog_image(name));

create policy "Platform admins can upload catalog images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and private.can_manage_catalog_image(name));

create policy "Platform admins can replace catalog images"
  on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and private.can_manage_catalog_image(name))
  with check (bucket_id = 'product-images' and private.can_manage_catalog_image(name));

create function public.admin_search_catalog(
  p_query text default '',
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_term text := left(btrim(coalesce(p_query, '')), 80);
  v_pattern text;
  v_limit integer := private.page_limit(p_limit);
  v_offset integer := private.page_offset(p_offset);
  v_total integer;
  v_rows jsonb;
begin
  if not private.has_platform_permission('catalog.verify') then
    return private.platform_denied('catalog.search', 'catalog');
  end if;

  v_pattern := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  select count(*)::int into v_total
  from public.catalog_products c
  where v_term = ''
     or c.name ilike v_pattern escape '\'
     or c.brand ilike v_pattern escape '\'
     or exists (
       select 1 from public.catalog_barcodes b
       where b.catalog_product_id = c.id and b.barcode ilike v_pattern escape '\'
     );

  select coalesce(jsonb_agg((to_jsonb(hit) - 'ord') order by hit.ord), '[]'::jsonb) into v_rows
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
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'barcode', b.barcode,
          'kind', b.kind,
          'units_per_package', b.units_per_package
        ) order by b.kind, b.barcode)
        from public.catalog_barcodes b
        where b.catalog_product_id = c.id
      ), '[]'::jsonb) as barcodes,
      row_number() over (order by c.name, c.id) as ord
    from public.catalog_products c
    where v_term = ''
       or c.name ilike v_pattern escape '\'
       or c.brand ilike v_pattern escape '\'
       or exists (
         select 1 from public.catalog_barcodes b
         where b.catalog_product_id = c.id and b.barcode ilike v_pattern escape '\'
       )
    order by c.name, c.id
    limit v_limit
    offset v_offset
  ) hit;

  perform private.audit(
    'catalog.search', 'success', 'catalog', null, null, null,
    jsonb_build_object('query', v_term, 'total', v_total)
  );

  return jsonb_build_object('ok', true, 'total', v_total, 'limit', v_limit, 'offset', v_offset, 'rows', v_rows);
end;
$$;

create function public.admin_get_catalog_product(p_id uuid)
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
      'source', v_product.source
    ),
    'barcodes', v_barcodes
  );
end;
$$;

create function public.admin_save_catalog_product(
  p_id uuid,
  p_name text,
  p_brand text,
  p_category text,
  p_package_size text,
  p_package_quantity numeric,
  p_package_unit text,
  p_verification_status text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_name text := btrim(coalesce(p_name, ''));
  v_brand text;
  v_size text;
  v_unit text;
  v_status text := btrim(coalesce(p_verification_status, ''));
  v_product public.catalog_products;
  v_created boolean := false;
begin
  if not private.has_platform_permission('catalog.verify') then
    return private.platform_denied('catalog.save', 'catalog', p_id::text);
  end if;
  v_reason := private.require_reason(p_reason);
  if v_name = '' or char_length(v_name) > 200 then
    raise exception 'Product name is required (up to 200 characters).' using errcode = '22023';
  end if;
  if p_category is null or p_category not in (
    'groceries', 'beverages', 'snacks', 'bakery', 'dairy', 'personal_care', 'household', 'airtime', 'other'
  ) then
    raise exception 'Unknown product category.' using errcode = '22023';
  end if;
  if v_status not in ('external', 'user_submitted', 'verified') then
    raise exception 'Unknown verification status.' using errcode = '22023';
  end if;
  if p_package_quantity is not null and p_package_quantity <= 0 then
    raise exception 'Package quantity must be greater than zero.' using errcode = '22023';
  end if;
  v_brand := private.optional_text(p_brand, null, 80, 'Brand');
  v_size := private.optional_text(p_package_size, null, 40, 'Size');
  v_unit := private.optional_text(p_package_unit, null, 16, 'Unit');

  if p_id is null then
    insert into public.catalog_products (
      name, brand, category, package_size, package_quantity, package_unit,
      source, verification_status, created_by
    )
    values (
      v_name, v_brand, p_category, v_size, p_package_quantity, v_unit,
      'user', 'verified', (select auth.uid())
    )
    returning * into v_product;
    v_created := true;
  else
    update public.catalog_products
    set name = v_name,
        brand = v_brand,
        category = p_category,
        package_size = v_size,
        package_quantity = p_package_quantity,
        package_unit = v_unit,
        verification_status = v_status
    where id = p_id
    returning * into v_product;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'not_found');
    end if;
  end if;

  perform private.audit(
    'catalog.save', 'success', 'catalog', v_product.id::text, null, v_reason,
    jsonb_build_object('created', v_created)
  );

  return jsonb_build_object('ok', true, 'created', v_created, 'id', v_product.id);
end;
$$;

create function public.admin_link_catalog_barcode(
  p_catalog_product_id uuid,
  p_barcode text,
  p_kind text,
  p_units_per_package integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_barcode text := private.clean_barcode(p_barcode);
  v_link public.catalog_barcodes;
begin
  if not private.has_platform_permission('catalog.verify') then
    return private.platform_denied('catalog.barcode', 'catalog', p_catalog_product_id::text);
  end if;
  v_reason := private.require_reason(p_reason);
  if p_catalog_product_id is null then
    raise exception 'Catalog product id is required.' using errcode = '22023';
  end if;
  if v_barcode = '' or char_length(v_barcode) > 64 then
    raise exception 'Barcode is required (up to 64 characters).' using errcode = '22023';
  end if;
  if p_kind not in ('unit', 'alternate', 'pack') then
    raise exception 'Choose a unit, alternate or pack barcode.' using errcode = '22023';
  end if;
  if p_kind = 'pack' and (p_units_per_package is null or p_units_per_package < 2 or p_units_per_package > 10000) then
    raise exception 'A pack holds 2 to 10,000 units.' using errcode = '22023';
  end if;
  if p_kind <> 'pack' and p_units_per_package is not null then
    raise exception 'Only a pack barcode has a unit count.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.catalog_products where id = p_catalog_product_id) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  perform private.lock_catalog_barcode(v_barcode);
  select * into v_link from public.catalog_barcodes where barcode = v_barcode;
  if found and v_link.catalog_product_id <> p_catalog_product_id then
    perform private.audit(
      'catalog.barcode', 'denied', 'catalog', p_catalog_product_id::text, null, v_reason,
      jsonb_build_object('code', 'conflict', 'barcode', v_barcode)
    );
    return jsonb_build_object('ok', false, 'code', 'conflict');
  end if;
  if found then
    perform private.audit(
      'catalog.barcode', 'success', 'catalog', p_catalog_product_id::text, null, v_reason,
      jsonb_build_object('barcode', v_barcode, 'unchanged', true)
    );
    return jsonb_build_object('ok', true, 'barcode', to_jsonb(v_link), 'unchanged', true);
  end if;

  begin
    insert into public.catalog_barcodes (
      barcode, catalog_product_id, kind, units_per_package, source, created_by
    )
    values (
      v_barcode, p_catalog_product_id, p_kind,
      case when p_kind = 'pack' then p_units_per_package else null end,
      'user', (select auth.uid())
    )
    returning * into v_link;
  exception
    when unique_violation then
      perform private.audit(
        'catalog.barcode', 'denied', 'catalog', p_catalog_product_id::text, null, v_reason,
        jsonb_build_object('code', 'conflict', 'barcode', v_barcode)
      );
      return jsonb_build_object('ok', false, 'code', 'conflict');
  end;

  perform private.audit(
    'catalog.barcode', 'success', 'catalog', p_catalog_product_id::text, null, v_reason,
    jsonb_build_object('barcode', v_barcode, 'kind', p_kind)
  );
  return jsonb_build_object('ok', true, 'barcode', to_jsonb(v_link), 'unchanged', false);
end;
$$;

create function public.admin_unlink_catalog_barcode(p_barcode text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_barcode text := private.clean_barcode(p_barcode);
  v_link public.catalog_barcodes;
begin
  if not private.has_platform_permission('catalog.verify') then
    return private.platform_denied('catalog.barcode_remove', 'catalog', null);
  end if;
  v_reason := private.require_reason(p_reason);
  if v_barcode = '' then
    raise exception 'Barcode is required.' using errcode = '22023';
  end if;

  delete from public.catalog_barcodes
  where barcode = v_barcode
  returning * into v_link;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  perform private.audit(
    'catalog.barcode_remove', 'success', 'catalog', v_link.catalog_product_id::text, null, v_reason,
    jsonb_build_object('barcode', v_barcode)
  );
  return jsonb_build_object('ok', true);
end;
$$;

create function public.admin_set_catalog_image(
  p_id uuid,
  p_image_path text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_path text := nullif(btrim(coalesce(p_image_path, '')), '');
  v_stored text;
begin
  if not private.has_platform_permission('catalog.verify') then
    return private.platform_denied('catalog.image', 'catalog', p_id::text);
  end if;
  v_reason := private.require_reason(p_reason);
  if p_id is null then
    raise exception 'Catalog product id is required.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.catalog_products where id = p_id) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if v_path is not null then
    if private.catalog_image_id(v_path) is distinct from p_id then
      raise exception 'This picture does not belong to that catalog product.' using errcode = '22023';
    end if;
    if not exists (
      select 1 from storage.objects where bucket_id = 'product-images' and name = v_path
    ) then
      raise exception 'The picture has not been uploaded.' using errcode = '22023';
    end if;
  end if;

  update public.catalog_products
  set image_path = v_path
  where id = p_id
  returning image_path into v_stored;

  perform private.audit(
    'catalog.image', 'success', 'catalog', p_id::text, null, v_reason,
    jsonb_build_object('image_path', v_stored)
  );
  return jsonb_build_object('ok', true, 'image_path', v_stored);
end;
$$;

revoke all on function public.admin_search_catalog(text, integer, integer) from public, anon;
revoke all on function public.admin_get_catalog_product(uuid) from public, anon;
revoke all on function public.admin_save_catalog_product(uuid, text, text, text, text, numeric, text, text, text) from public, anon;
revoke all on function public.admin_link_catalog_barcode(uuid, text, text, integer, text) from public, anon;
revoke all on function public.admin_unlink_catalog_barcode(text, text) from public, anon;
revoke all on function public.admin_set_catalog_image(uuid, text, text) from public, anon;

grant execute on function public.admin_search_catalog(text, integer, integer) to authenticated;
grant execute on function public.admin_get_catalog_product(uuid) to authenticated;
grant execute on function public.admin_save_catalog_product(uuid, text, text, text, text, numeric, text, text, text) to authenticated;
grant execute on function public.admin_link_catalog_barcode(uuid, text, text, integer, text) to authenticated;
grant execute on function public.admin_unlink_catalog_barcode(text, text) to authenticated;
grant execute on function public.admin_set_catalog_image(uuid, text, text) to authenticated;
