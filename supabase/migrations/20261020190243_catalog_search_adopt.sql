-- Shops can find a shared catalogue product and keep one of their own.
-- Search only reads identity. Adopt writes a shop product, its prices, and that shop's
-- barcode aliases. It does not copy stock, expiry, or another shop's prices.

-- Corrections: a shop sees proposals for products it stocks or submitted.
-- Authorship columns stay off the client API so one shop cannot read another's shop or user id.

drop policy "Active members can view catalog corrections" on public.catalog_corrections;

create policy "Members see corrections for their shops"
  on public.catalog_corrections for select to authenticated
  using (
    shop_id in (select private.my_shop_ids())
    or exists (
      select 1 from public.products p
      where p.catalog_product_id = catalog_corrections.catalog_product_id
        and p.shop_id in (select private.my_shop_ids())
    )
  );

revoke select on table public.catalog_corrections from authenticated;
grant select (
  id, catalog_product_id, proposed_name, proposed_brand, proposed_category,
  proposed_package_size, proposed_package_quantity, proposed_package_unit,
  proposed_ingredients, proposed_image_url, reason, status, created_at, updated_at
) on table public.catalog_corrections to authenticated;

-- Copies catalogue barcodes onto one shop product. The unit code already on products.barcode
-- is left there. Packs become shop packagings with no selling price. Existing rows are kept.
create function private.copy_catalog_barcodes(p_shop_id uuid, p_product_id uuid, p_catalog_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code record;
  v_product_barcode text;
  v_packaging_id uuid;
  v_link_id uuid;
  v_owner uuid;
begin
  select barcode into v_product_barcode from public.products where id = p_product_id and shop_id = p_shop_id;
  v_owner := (select auth.uid());

  for v_code in
    select barcode, kind, units_per_package
    from public.catalog_barcodes
    where catalog_product_id = p_catalog_id
    order by kind, barcode
  loop
    if v_code.kind in ('unit', 'alternate') then
      if v_code.barcode = v_product_barcode then
        continue;
      end if;
      perform private.lock_barcode(p_shop_id, v_code.barcode);
      if exists (
        select 1 from public.products
        where shop_id = p_shop_id and barcode = v_code.barcode and id <> p_product_id
      ) then
        raise exception 'Barcode % is already used in this shop.', v_code.barcode using errcode = '23505';
      end if;
      select id into v_link_id
      from public.product_barcodes
      where shop_id = p_shop_id and barcode = v_code.barcode and unlinked_at is null;
      if found then
        if not exists (
          select 1 from public.product_barcodes
          where id = v_link_id and product_id = p_product_id and packaging_id is null
        ) then
          raise exception 'Barcode % is already used in this shop.', v_code.barcode using errcode = '23505';
        end if;
      else
        insert into public.product_barcodes (id, shop_id, product_id, packaging_id, barcode, created_by)
        values (gen_random_uuid(), p_shop_id, p_product_id, null, v_code.barcode, v_owner);
      end if;
    elsif v_code.kind = 'pack' then
      select id into v_packaging_id
      from public.product_packagings
      where shop_id = p_shop_id
        and product_id = p_product_id
        and units_per_package = v_code.units_per_package
        and retired_at is null
      order by created_at
      limit 1;
      if v_packaging_id is null then
        insert into public.product_packagings (
          id, shop_id, product_id, name, units_per_package, created_by
        )
        values (
          gen_random_uuid(), p_shop_id, p_product_id,
          'Pack of ' || v_code.units_per_package::text,
          v_code.units_per_package, v_owner
        )
        returning id into v_packaging_id;
      end if;

      perform private.lock_barcode(p_shop_id, v_code.barcode);
      if exists (
        select 1 from public.products where shop_id = p_shop_id and barcode = v_code.barcode
      ) then
        raise exception 'Barcode % is already used in this shop.', v_code.barcode using errcode = '23505';
      end if;
      select id into v_link_id
      from public.product_barcodes
      where shop_id = p_shop_id and barcode = v_code.barcode and unlinked_at is null;
      if found then
        if not exists (
          select 1 from public.product_barcodes
          where id = v_link_id and product_id = p_product_id and packaging_id = v_packaging_id
        ) then
          raise exception 'Barcode % is already used in this shop.', v_code.barcode using errcode = '23505';
        end if;
      else
        insert into public.product_barcodes (
          id, shop_id, product_id, packaging_id, barcode, created_by
        )
        values (
          gen_random_uuid(), p_shop_id, p_product_id, v_packaging_id, v_code.barcode, v_owner
        );
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'packagings', coalesce((
      select jsonb_agg(to_jsonb(g) order by g.created_at)
      from public.product_packagings g
      where g.shop_id = p_shop_id and g.product_id = p_product_id and g.retired_at is null
        and exists (
          select 1 from public.catalog_barcodes b
          where b.catalog_product_id = p_catalog_id
            and b.kind = 'pack'
            and b.units_per_package = g.units_per_package
        )
    ), '[]'::jsonb),
    'barcodes', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.created_at)
      from public.product_barcodes a
      where a.shop_id = p_shop_id and a.product_id = p_product_id and a.unlinked_at is null
        and exists (
          select 1 from public.catalog_barcodes b
          where b.catalog_product_id = p_catalog_id and b.barcode = a.barcode
        )
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function private.copy_catalog_barcodes(uuid, uuid, uuid) from public, anon, authenticated;

create function public.search_catalog(
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

create function public.adopt_catalog_product(
  p_id uuid,
  p_shop_id uuid,
  p_catalog_product_id uuid,
  p_buying_price numeric default null,
  p_selling_price numeric default null,
  p_created_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_catalog public.catalog_products;
  v_product public.products;
  v_primary text;
  v_created boolean := false;
  v_links jsonb;
begin
  perform private.assert_shop_role(p_shop_id, array['owner', 'manager', 'staff']);
  if p_id is null then
    raise exception 'Product id is required.' using errcode = '22023';
  end if;
  if p_catalog_product_id is null then
    raise exception 'Catalog product id is required.' using errcode = '22023';
  end if;
  if p_buying_price < 0 or p_selling_price < 0 then
    raise exception 'Prices cannot be negative.' using errcode = '22023';
  end if;

  select * into v_catalog from public.catalog_products where id = p_catalog_product_id;
  if not found then
    raise exception 'Catalog product not found.' using errcode = 'P0002';
  end if;

  select b.barcode into v_primary
  from public.catalog_barcodes b
  where b.catalog_product_id = p_catalog_product_id and b.kind in ('unit', 'alternate')
  order by case b.kind when 'unit' then 0 else 1 end, b.created_at, b.barcode
  limit 1;
  if v_primary is null then
    raise exception 'This catalog product has no single-item barcode.' using errcode = '22023';
  end if;

  select * into v_product
  from public.products
  where shop_id = p_shop_id and catalog_product_id = p_catalog_product_id and archived_at is null
  for update;

  if not found then
    select * into v_product
    from public.products
    where shop_id = p_shop_id and barcode = v_primary
    for update;
  end if;

  if not found then
    insert into public.products (
      id, shop_id, barcode, name, category, buying_price, selling_price,
      created_at, brand, size, catalog_product_id
    )
    values (
      p_id, p_shop_id, v_primary, v_catalog.name, v_catalog.category,
      p_buying_price, p_selling_price, coalesce(p_created_at, now()),
      v_catalog.brand, v_catalog.package_size, p_catalog_product_id
    )
    returning * into v_product;
    v_created := true;
    v_links := private.copy_catalog_barcodes(p_shop_id, v_product.id, p_catalog_product_id);
  elsif v_product.archived_at is not null then
    v_links := jsonb_build_object('packagings', '[]'::jsonb, 'barcodes', '[]'::jsonb);
  else
    if v_product.catalog_product_id is not null and v_product.catalog_product_id <> p_catalog_product_id then
      raise exception 'Barcode % is already used in this shop.', v_primary using errcode = '23505';
    end if;
    if v_product.catalog_product_id is null then
      v_product := private.attach_catalog_link(v_product, p_catalog_product_id);
    end if;
    if v_product.catalog_product_id is distinct from p_catalog_product_id then
      raise exception 'Barcode % is already used in this shop.', v_primary using errcode = '23505';
    end if;
    v_links := private.copy_catalog_barcodes(p_shop_id, v_product.id, p_catalog_product_id);
  end if;

  return jsonb_build_object(
    'created', v_created,
    'product', to_jsonb(v_product),
    'packagings', v_links -> 'packagings',
    'barcodes', v_links -> 'barcodes'
  );
end;
$$;

revoke all on function public.search_catalog(uuid, text, integer, integer) from public, anon;
revoke all on function public.adopt_catalog_product(uuid, uuid, uuid, numeric, numeric, timestamptz) from public, anon;

grant execute on function public.search_catalog(uuid, text, integer, integer) to authenticated;
grant execute on function public.adopt_catalog_product(uuid, uuid, uuid, numeric, numeric, timestamptz) to authenticated;
