-- A new shop product may point at the shared catalogue picture. The file stays one object.
-- Existing shop pictures are left as they are. Nothing here backfills rows or marks products common.

alter table public.products drop constraint if exists products_image_path_check;

do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  where c.conrelid = 'public.products'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%image_path%';
  if v_name is not null then
    execute format('alter table public.products drop constraint %I', v_name);
  end if;
end
$$;

alter table public.products
  add constraint products_image_path_check check (
    image_path is null
    or image_path ~ ('^' || shop_id::text || '/[0-9a-f]{32}\.(webp|jpg)$')
    or image_path ~ '^catalog/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg)$'
  );

comment on column public.products.image_path is
  'A shop file, or the shared catalog/<id>.webp|jpg path. A catalogue path is stored only on a new row and is never a second copy.';

-- adopt_catalog_product, review_shop_catalog and confirm_shop_catalog insert the shop row
-- without a picture. This copies the catalogue path onto that new row only.
create function private.copy_catalog_image()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.image_path is null and new.catalog_product_id is not null then
    select c.image_path into new.image_path
    from public.catalog_products c
    where c.id = new.catalog_product_id;
  end if;
  return new;
end;
$$;

create trigger products_copy_catalog_image
  before insert on public.products
  for each row execute function private.copy_catalog_image();

-- Replacing a shop picture must not ask the phone to delete the shared catalogue file.
create or replace function public.set_product_image(p_shop_id uuid, p_product_id uuid, p_image_path text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text := nullif(btrim(coalesce(p_image_path, '')), '');
  v_product public.products;
  v_previous text;
begin
  perform private.assert_shop_role(p_shop_id, array['owner', 'manager', 'staff']);
  if p_product_id is null then
    raise exception 'Product id is required.' using errcode = '22023';
  end if;
  if v_path is not null and private.product_image_shop(v_path) is distinct from p_shop_id then
    raise exception 'This picture does not belong to this shop.' using errcode = '22023';
  end if;

  select * into v_product
  from public.products
  where id = p_product_id and shop_id = p_shop_id
  for update;
  if not found then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;

  v_previous := v_product.image_path;
  if v_previous is not distinct from v_path then
    return jsonb_build_object('product', to_jsonb(v_product), 'previous_path', null);
  end if;

  if not private.has_permission(p_shop_id, 'products.edit')
     and not (v_previous is null and v_path is not null) then
    raise exception 'Only an owner or manager can change a product picture.' using errcode = '42501';
  end if;

  if v_path is not null and not exists (
    select 1 from storage.objects where bucket_id = 'product-images' and name = v_path
  ) then
    raise exception 'The picture has not been uploaded.' using errcode = '22023';
  end if;

  update public.products set image_path = v_path
  where id = p_product_id
  returning * into v_product;

  return jsonb_build_object(
    'product', to_jsonb(v_product),
    'previous_path', case
      when v_previous is null then null
      when v_previous ~ '^catalog/' then null
      when exists (select 1 from public.catalog_products c where c.image_path = v_previous) then null
      when exists (select 1 from public.products where image_path = v_previous) then null
      else v_previous
    end
  );
end;
$$;

-- p_in_shop null keeps every match. false is products this shop does not have. true is products it has.
drop function if exists public.search_catalog(uuid, text, integer, integer);

create function public.search_catalog(
  p_shop_id uuid,
  p_query text default '',
  p_limit integer default 20,
  p_offset integer default 0,
  p_in_shop boolean default null
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
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total integer;
  v_items jsonb;
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.shop_members m
    where m.shop_id = p_shop_id and m.user_id = (select auth.uid()) and m.status = 'active'
  ) then
    raise exception 'You do not have access to this shop.' using errcode = '42501';
  end if;

  v_pattern := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  select count(*)::int into v_total
  from public.catalog_products c
  where (
      v_term = ''
      or c.name ilike v_pattern escape '\'
      or c.brand ilike v_pattern escape '\'
      or exists (
        select 1 from public.catalog_barcodes b
        where b.catalog_product_id = c.id and b.barcode ilike v_pattern escape '\'
      )
    )
    and (
      p_in_shop is null
      or (p_in_shop is true and exists (
        select 1 from public.products p
        where p.shop_id = p_shop_id
          and p.catalog_product_id = c.id
          and p.archived_at is null
      ))
      or (p_in_shop is false and not exists (
        select 1 from public.products p
        where p.shop_id = p_shop_id
          and p.catalog_product_id = c.id
          and p.archived_at is null
      ))
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
      (
        select p.id from public.products p
        where p.shop_id = p_shop_id
          and p.catalog_product_id = c.id
          and p.archived_at is null
        limit 1
      ) as shop_product_id,
      (
        select p.listed from public.products p
        where p.shop_id = p_shop_id
          and p.catalog_product_id = c.id
          and p.archived_at is null
        limit 1
      ) as shop_listed,
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
    where (
        v_term = ''
        or c.name ilike v_pattern escape '\'
        or c.brand ilike v_pattern escape '\'
        or exists (
          select 1 from public.catalog_barcodes b
          where b.catalog_product_id = c.id and b.barcode ilike v_pattern escape '\'
        )
      )
      and (
        p_in_shop is null
        or (p_in_shop is true and exists (
          select 1 from public.products p
          where p.shop_id = p_shop_id
            and p.catalog_product_id = c.id
            and p.archived_at is null
        ))
        or (p_in_shop is false and not exists (
          select 1 from public.products p
          where p.shop_id = p_shop_id
            and p.catalog_product_id = c.id
            and p.archived_at is null
        ))
      )
    order by c.name, c.id
    limit v_limit
    offset v_offset
  ) hit;

  return jsonb_build_object('items', v_items, 'total', v_total);
end;
$$;

create or replace function public.list_shop_catalog_review(
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

revoke all on function public.search_catalog(uuid, text, integer, integer, boolean) from public, anon;
revoke all on function public.list_shop_catalog_review(uuid, text, text, text, integer, integer) from public, anon;
revoke all on function public.set_product_image(uuid, uuid, text) from public, anon;

grant execute on function public.search_catalog(uuid, text, integer, integer, boolean) to authenticated;
grant execute on function public.list_shop_catalog_review(uuid, text, text, text, integer, integer) to authenticated;
grant execute on function public.set_product_image(uuid, uuid, text) to authenticated;
