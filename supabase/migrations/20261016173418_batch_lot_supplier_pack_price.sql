-- Lot and supplier stay on the delivery they arrived with. A later delivery is a new batch.
alter table public.stock_batches
  add column lot_number text,
  add column supplier_name text;

alter table public.stock_batches
  add constraint stock_batches_lot_length check (lot_number is null or char_length(btrim(lot_number)) between 1 and 40),
  add constraint stock_batches_supplier_length check (supplier_name is null or char_length(btrim(supplier_name)) between 1 and 80);

comment on column public.stock_batches.lot_number is
  'Optional lot or batch code printed on this delivery. Never copied onto another delivery.';
comment on column public.stock_batches.supplier_name is
  'Optional supplier of this delivery. A later delivery can name a different supplier.';

-- Price of one pack, not of one unit. The conversion trigger still forbids changing the name or the unit count.
alter table public.product_packagings
  add column selling_price numeric(12, 2);

alter table public.product_packagings
  add constraint product_packagings_selling_price_nonneg check (selling_price is null or selling_price >= 0);

comment on column public.product_packagings.selling_price is
  'Optional price for one whole pack. Null means every unit is sold at the product price.';

-- record_stock_in: lot and supplier are trailing optional arguments so older queued calls still apply.
drop function public.record_stock_in(uuid, uuid, uuid, integer, date, numeric, timestamptz, text, uuid, integer, uuid);

create function public.record_stock_in(
  p_batch_id uuid,
  p_shop_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_expiry_date date,
  p_cost_price_per_unit numeric,
  p_received_at timestamptz,
  p_idempotency_key text,
  p_packaging_id uuid default null,
  p_package_quantity integer default null,
  p_barcode_id uuid default null,
  p_lot_number text default null,
  p_supplier_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := 'stock_in:' || coalesce(nullif(btrim(p_idempotency_key), ''), p_batch_id::text);
  v_batch public.stock_batches;
  v_existing_batch uuid;
  v_total integer;
  v_units integer;
  v_barcode_id uuid;
  v_lot text := nullif(btrim(coalesce(p_lot_number, '')), '');
  v_supplier text := nullif(btrim(coalesce(p_supplier_name, '')), '');
begin
  perform private.assert_shop_role(p_shop_id, array['owner', 'manager', 'staff']);
  if p_batch_id is null then
    raise exception 'Batch id is required.' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000000 then
    raise exception 'Quantity must be a whole number from 1 to 1,000,000.' using errcode = '22023';
  end if;
  if p_cost_price_per_unit < 0 then
    raise exception 'Purchase cost cannot be negative.' using errcode = '22023';
  end if;
  if char_length(v_key) > 300 then
    raise exception 'Idempotency key is too long.' using errcode = '22023';
  end if;
  if (p_packaging_id is null) <> (p_package_quantity is null) then
    raise exception 'A packaging needs a number of packages, and the other way round.' using errcode = '22023';
  end if;
  if v_lot is not null and char_length(v_lot) > 40 then
    raise exception 'Lot number can be at most 40 characters.' using errcode = '22023';
  end if;
  if v_supplier is not null and char_length(v_supplier) > 80 then
    raise exception 'Supplier name can be at most 80 characters.' using errcode = '22023';
  end if;

  perform 1 from public.products
  where id = p_product_id and shop_id = p_shop_id
  for update;
  if not found then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;

  select batch_id into v_existing_batch
  from public.stock_movements
  where shop_id = p_shop_id and idempotency_key = v_key;
  if found then
    select * into v_batch from public.stock_batches where id = v_existing_batch;
    return jsonb_build_object(
      'batch', to_jsonb(v_batch), 'duplicate', true,
      'total_quantity', private.product_stock(p_shop_id, p_product_id)
    );
  end if;

  select * into v_batch from public.stock_batches where id = p_batch_id;
  if found then
    if v_batch.shop_id <> p_shop_id or v_batch.product_id <> p_product_id then
      raise exception 'This batch id is already used elsewhere.' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'batch', to_jsonb(v_batch), 'duplicate', true,
      'total_quantity', private.product_stock(p_shop_id, p_product_id)
    );
  end if;

  if p_packaging_id is not null then
    select units_per_package into v_units
    from public.product_packagings
    where id = p_packaging_id and shop_id = p_shop_id and product_id = p_product_id;
    if not found then
      raise exception 'Packaging not found for this product.' using errcode = 'P0002';
    end if;
    if p_package_quantity <= 0 or p_package_quantity::bigint * v_units <> p_quantity then
      raise exception 'Quantity must be % packages × % units.', p_package_quantity, v_units using errcode = '22023';
    end if;
  end if;

  select id into v_barcode_id
  from public.product_barcodes
  where id = p_barcode_id and shop_id = p_shop_id and product_id = p_product_id;

  insert into public.stock_batches (
    id, shop_id, product_id, quantity, initial_quantity, expiry_date, cost_price_per_unit,
    received_at, received_by, packaging_id, package_quantity, units_per_package, received_barcode_id,
    lot_number, supplier_name
  )
  values (
    p_batch_id, p_shop_id, p_product_id, p_quantity, p_quantity, p_expiry_date,
    p_cost_price_per_unit, coalesce(p_received_at, now()), (select auth.uid()),
    p_packaging_id, p_package_quantity, v_units, v_barcode_id,
    v_lot, v_supplier
  )
  returning * into v_batch;

  v_total := private.product_stock(p_shop_id, p_product_id);

  insert into public.stock_movements (
    id, shop_id, product_id, batch_id, reason, quantity_delta, resulting_total_quantity,
    idempotency_key, actor_id, occurred_at
  )
  values (
    gen_random_uuid(), p_shop_id, p_product_id, p_batch_id, 'stock_in', p_quantity, v_total,
    v_key, (select auth.uid()), coalesce(p_received_at, now())
  );

  return jsonb_build_object('batch', to_jsonb(v_batch), 'duplicate', false, 'total_quantity', v_total);
end;
$$;

-- Pack price can be set when the packaging is created. A replay of the same id keeps the conversion
-- and only fills a price that was missing.
drop function public.create_product_packaging(uuid, uuid, uuid, text, integer, timestamptz);

create function public.create_product_packaging(
  p_id uuid,
  p_shop_id uuid,
  p_product_id uuid,
  p_name text,
  p_units_per_package integer,
  p_created_at timestamptz default null,
  p_selling_price numeric default null
)
returns public.product_packagings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_price numeric(12, 2) := case when p_selling_price is null then null else round(p_selling_price, 2) end;
  v_packaging public.product_packagings;
begin
  perform private.assert_permission(p_shop_id, 'products.edit');
  if p_id is null then
    raise exception 'Packaging id is required.' using errcode = '22023';
  end if;
  if v_name = '' or char_length(v_name) > 40 then
    raise exception 'Packaging name is required (up to 40 characters).' using errcode = '22023';
  end if;
  if p_units_per_package is null or p_units_per_package < 2 or p_units_per_package > 10000 then
    raise exception 'A packaging holds 2 to 10,000 units.' using errcode = '22023';
  end if;
  if v_price is not null and (v_price < 0 or v_price > 9999999999.99) then
    raise exception 'Pack price cannot be negative.' using errcode = '22023';
  end if;

  perform 1 from public.products where id = p_product_id and shop_id = p_shop_id for update;
  if not found then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;

  select * into v_packaging from public.product_packagings where id = p_id;
  if found then
    if v_packaging.shop_id = p_shop_id and v_packaging.product_id = p_product_id
       and v_packaging.name = v_name and v_packaging.units_per_package = p_units_per_package then
      if v_price is not null and v_packaging.selling_price is distinct from v_price then
        update public.product_packagings
        set selling_price = v_price, updated_at = now()
        where id = p_id
        returning * into v_packaging;
      end if;
      return v_packaging;
    end if;
    raise exception 'This packaging id is already used elsewhere.' using errcode = '23505';
  end if;

  insert into public.product_packagings (
    id, shop_id, product_id, name, units_per_package, selling_price, created_at
  )
  values (
    p_id, p_shop_id, p_product_id, v_name, p_units_per_package, v_price, coalesce(p_created_at, now())
  )
  returning * into v_packaging;

  return v_packaging;
end;
$$;

-- Later price changes. Null clears the pack price so every unit uses the product price again.
create function public.set_packaging_price(
  p_shop_id uuid,
  p_packaging_id uuid,
  p_selling_price numeric
)
returns public.product_packagings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_price numeric(12, 2) := case when p_selling_price is null then null else round(p_selling_price, 2) end;
  v_packaging public.product_packagings;
begin
  perform private.assert_permission(p_shop_id, 'products.edit');
  if v_price is not null and (v_price < 0 or v_price > 9999999999.99) then
    raise exception 'Pack price cannot be negative.' using errcode = '22023';
  end if;

  update public.product_packagings
  set selling_price = v_price, updated_at = now()
  where id = p_packaging_id and shop_id = p_shop_id
  returning * into v_packaging;
  if not found then
    raise exception 'Packaging not found in this shop.' using errcode = 'P0002';
  end if;
  return v_packaging;
end;
$$;

revoke all on function public.record_stock_in(
  uuid, uuid, uuid, integer, date, numeric, timestamptz, text, uuid, integer, uuid, text, text
) from public, anon;
revoke all on function public.create_product_packaging(uuid, uuid, uuid, text, integer, timestamptz, numeric)
  from public, anon;
revoke all on function public.set_packaging_price(uuid, uuid, numeric) from public, anon;

grant execute on function public.record_stock_in(
  uuid, uuid, uuid, integer, date, numeric, timestamptz, text, uuid, integer, uuid, text, text
) to authenticated;
grant execute on function public.create_product_packaging(uuid, uuid, uuid, text, integer, timestamptz, numeric)
  to authenticated;
grant execute on function public.set_packaging_price(uuid, uuid, numeric) to authenticated;
