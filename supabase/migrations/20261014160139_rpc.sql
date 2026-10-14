-- Write API used by the device sync engine.
-- Every function is idempotent on the client-generated IDs, so a retried outbox item never
-- double-counts stock. Functions run as the caller (security invoker), so RLS still applies.
--
-- Error codes the client relies on:
--   22023 invalid_parameter_value -> permanent validation failure
--   P0002 no_data_found          -> product/shop not visible to the caller

-- upsert_product -------------------------------------------------------------
-- Returns the canonical product row. If another device already registered the same barcode in
-- this shop, that existing row is returned and the client remaps its local ID to it.

create or replace function public.upsert_product(
  p_id uuid,
  p_shop_id uuid,
  p_barcode text,
  p_name text,
  p_category text,
  p_buying_price numeric,
  p_selling_price numeric,
  p_created_at timestamptz
)
returns public.products
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_product public.products;
  v_barcode text := regexp_replace(coalesce(p_barcode, ''), '\s', '', 'g');
begin
  if v_barcode = '' then
    raise exception 'Barcode is required.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Product name is required.' using errcode = '22023';
  end if;

  insert into public.products (
    id, shop_id, barcode, name, category, buying_price, selling_price, created_at
  )
  values (
    p_id, p_shop_id, v_barcode, btrim(p_name), coalesce(p_category, 'other'),
    p_buying_price, p_selling_price, coalesce(p_created_at, now())
  )
  on conflict do nothing
  returning * into v_product;

  if v_product.id is null then
    select * into v_product from public.products where id = p_id and shop_id = p_shop_id;
  end if;

  if v_product.id is null then
    select * into v_product
    from public.products
    where shop_id = p_shop_id and barcode = v_barcode;
  end if;

  if v_product.id is null then
    raise exception 'Shop not found or not accessible.' using errcode = 'P0002';
  end if;

  return v_product;
end;
$$;

-- record_stock_in ------------------------------------------------------------

create or replace function public.record_stock_in(
  p_batch_id uuid,
  p_movement_id uuid,
  p_shop_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_expiry_date date,
  p_cost_price_per_unit numeric,
  p_received_at timestamptz,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_batch public.stock_batches;
  v_total integer;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be a positive whole number.' using errcode = '22023';
  end if;

  -- Serialise all stock changes for this product.
  perform 1 from public.products
  where id = p_product_id and shop_id = p_shop_id
  for update;
  if not found then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;

  select * into v_batch from public.stock_batches where id = p_batch_id;
  if found then
    select coalesce(sum(quantity), 0) into v_total
    from public.stock_batches
    where shop_id = p_shop_id and product_id = p_product_id;
    return jsonb_build_object('batch', to_jsonb(v_batch), 'duplicate', true, 'total_quantity', v_total);
  end if;

  insert into public.stock_batches (
    id, shop_id, product_id, quantity, initial_quantity, expiry_date, cost_price_per_unit, received_at
  )
  values (
    p_batch_id, p_shop_id, p_product_id, p_quantity, p_quantity, p_expiry_date,
    p_cost_price_per_unit, coalesce(p_received_at, now())
  )
  returning * into v_batch;

  select coalesce(sum(quantity), 0) into v_total
  from public.stock_batches
  where shop_id = p_shop_id and product_id = p_product_id;

  insert into public.stock_movements (
    id, shop_id, product_id, batch_id, type, quantity_delta, resulting_total_quantity,
    idempotency_key, created_at
  )
  values (
    p_movement_id, p_shop_id, p_product_id, p_batch_id, 'stock_in', p_quantity, v_total,
    p_idempotency_key, coalesce(p_received_at, now())
  )
  on conflict (id) do nothing;

  return jsonb_build_object('batch', to_jsonb(v_batch), 'duplicate', false, 'total_quantity', v_total);
end;
$$;

-- record_sale ----------------------------------------------------------------
-- Deducts stock First-Expired-First-Out under a row lock. A shortfall never rejects the sale
-- (the goods already left the shop); it is recorded in stock_discrepancies instead.

create or replace function public.record_sale(
  p_sale_id uuid,
  p_movement_id uuid,
  p_shop_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_unit_price numeric,
  p_idempotency_key text,
  p_sold_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_sale public.sales;
  v_batch record;
  v_remaining integer := p_quantity;
  v_take integer;
  v_allocations jsonb := '[]'::jsonb;
  v_first_batch uuid;
  v_total integer;
  v_unit_price numeric(12, 2) := coalesce(p_unit_price, 0);
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be a positive whole number.' using errcode = '22023';
  end if;
  if v_unit_price < 0 then
    raise exception 'Unit price cannot be negative.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_idempotency_key), '') = '' then
    raise exception 'Idempotency key is required.' using errcode = '22023';
  end if;

  perform 1 from public.products
  where id = p_product_id and shop_id = p_shop_id
  for update;
  if not found then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;

  -- Checked after taking the product lock so concurrent retries of the same sale serialise here.
  select * into v_sale
  from public.sales
  where id = p_sale_id or (shop_id = p_shop_id and idempotency_key = p_idempotency_key)
  limit 1;
  if found then
    select coalesce(sum(quantity), 0) into v_total
    from public.stock_batches
    where shop_id = p_shop_id and product_id = p_product_id;
    return jsonb_build_object(
      'sale', to_jsonb(v_sale), 'duplicate', true, 'shortfall', 0, 'total_quantity', v_total
    );
  end if;

  for v_batch in
    select id, quantity, expiry_date
    from public.stock_batches
    where shop_id = p_shop_id and product_id = p_product_id and quantity > 0
    order by expiry_date asc nulls last, received_at asc
    for update
  loop
    exit when v_remaining <= 0;
    v_take := least(v_batch.quantity, v_remaining);

    update public.stock_batches set quantity = quantity - v_take where id = v_batch.id;

    v_remaining := v_remaining - v_take;
    v_first_batch := coalesce(v_first_batch, v_batch.id);
    v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
      'batchId', v_batch.id,
      'quantityDeducted', v_take,
      'batchExpiryDate', v_batch.expiry_date
    ));
  end loop;

  insert into public.sales (
    id, shop_id, product_id, quantity, unit_price, total_amount, allocations, idempotency_key, sold_at
  )
  values (
    p_sale_id, p_shop_id, p_product_id, p_quantity, v_unit_price,
    round(v_unit_price * p_quantity, 2), v_allocations, p_idempotency_key, coalesce(p_sold_at, now())
  )
  returning * into v_sale;

  select coalesce(sum(quantity), 0) into v_total
  from public.stock_batches
  where shop_id = p_shop_id and product_id = p_product_id;

  insert into public.stock_movements (
    id, shop_id, product_id, batch_id, sale_id, type, quantity_delta, resulting_total_quantity,
    idempotency_key, created_at
  )
  values (
    coalesce(p_movement_id, gen_random_uuid()), p_shop_id, p_product_id, v_first_batch, p_sale_id,
    'sale', -p_quantity, v_total, p_idempotency_key, coalesce(p_sold_at, now())
  )
  on conflict (id) do nothing;

  if v_remaining > 0 then
    insert into public.stock_discrepancies (shop_id, product_id, sale_id, shortfall)
    values (p_shop_id, p_product_id, p_sale_id, v_remaining);
  end if;

  return jsonb_build_object(
    'sale', to_jsonb(v_sale), 'duplicate', false, 'shortfall', v_remaining, 'total_quantity', v_total
  );
end;
$$;

-- Only signed-in users may call the write API -------------------------------

revoke execute on function public.upsert_product(uuid, uuid, text, text, text, numeric, numeric, timestamptz) from public, anon;
revoke execute on function public.record_stock_in(uuid, uuid, uuid, uuid, integer, date, numeric, timestamptz, text) from public, anon;
revoke execute on function public.record_sale(uuid, uuid, uuid, uuid, integer, numeric, text, timestamptz) from public, anon;

grant execute on function public.upsert_product(uuid, uuid, text, text, text, numeric, numeric, timestamptz) to authenticated;
grant execute on function public.record_stock_in(uuid, uuid, uuid, uuid, integer, date, numeric, timestamptz, text) to authenticated;
grant execute on function public.record_sale(uuid, uuid, uuid, uuid, integer, numeric, text, timestamptz) to authenticated;
