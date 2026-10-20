-- Shop-only visibility for a catalogue selection.
-- The shared catalogue already holds identity, barcode aliases and verification status.
-- Prices, quantities, expiry and this flag stay on the shop product. Existing rows stay listed
-- through the constant default; this migration does not update or delete any product or batch.

alter table public.products
  add column listed boolean not null default true;

comment on column public.products.listed is
  'Whether this shop shows the product for sale. Not stored on the shared catalogue. Archive remains archived_at.';

create index products_catalog_shop_idx
  on public.products (catalog_product_id, shop_id)
  where catalog_product_id is not null;

grant select (listed) on public.products to authenticated;

create function public.set_product_listed(p_shop_id uuid, p_product_id uuid, p_listed boolean)
returns public.products
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products;
begin
  perform private.assert_permission(p_shop_id, 'products.edit');
  if p_product_id is null or p_listed is null then
    raise exception 'Product id and visibility are required.' using errcode = '22023';
  end if;

  update public.products
  set listed = p_listed
  where id = p_product_id and shop_id = p_shop_id
  returning * into v_product;

  if not found then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;
  return v_product;
end;
$$;

revoke all on function public.set_product_listed(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_product_listed(uuid, uuid, boolean) to authenticated;

-- Same arguments as before. shop_listed is null when this shop has no active selection.
create or replace function public.search_catalog(
  p_shop_id uuid,
  p_query text default '',
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
  where v_term = ''
     or c.name ilike v_pattern escape '\'
     or c.brand ilike v_pattern escape '\'
     or exists (
       select 1 from public.catalog_barcodes b
       where b.catalog_product_id = c.id and b.barcode ilike v_pattern escape '\'
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

  return jsonb_build_object('items', v_items, 'total', v_total);
end;
$$;
