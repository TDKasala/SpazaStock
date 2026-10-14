-- Stock write API v2, used by the device sync engine.
--
-- These functions are the only way stock changes. They run as SECURITY DEFINER because clients
-- have no write privileges on the ledger tables, so each one first checks the caller's shop role
-- (42501), validates input (22023), then locks the affected product rows in id order so
-- concurrent writers for the same product serialise and never deadlock.
--
-- Invariants:
--   * stock_batches.quantity never goes below 0.
--   * For every product, sum(stock_batches.quantity) = sum(stock_movements.quantity_delta).
--   * Each operation is idempotent on its client-generated ids and idempotency key: replaying
--     it returns the original result with duplicate = true and changes nothing.
--
-- Error codes the client relies on:
--   22023 invalid_parameter_value -> permanent validation failure
--   42501 insufficient_privilege  -> caller is not a member with the required role
--   P0002 no_data_found           -> product or batch is not in this shop

drop function public.upsert_product(uuid, uuid, text, text, text, numeric, numeric, timestamptz);
drop function public.record_stock_in(uuid, uuid, uuid, uuid, integer, date, numeric, timestamptz, text);
drop function public.record_sale(uuid, uuid, uuid, uuid, integer, numeric, text, timestamptz);

-- Sum of the product's batches. Callers hold the product row lock.
create function private.product_stock(p_shop_id uuid, p_product_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(quantity), 0)::integer
  from public.stock_batches
  where shop_id = p_shop_id and product_id = p_product_id;
$$;

revoke all on function private.product_stock(uuid, uuid) from public, anon, authenticated;

-- upsert_product -------------------------------------------------------------------
-- Returns the canonical product row. If another device already registered the same barcode in
-- this shop, that existing row is returned and the client remaps its local ID to it.

create function public.upsert_product(
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
security definer
set search_path = ''
as $$
declare
  v_product public.products;
  v_barcode text := regexp_replace(coalesce(p_barcode, ''), '\s', '', 'g');
begin
  perform private.assert_shop_role(p_shop_id, array['owner', 'manager', 'staff']);
  if p_id is null then
    raise exception 'Product id is required.' using errcode = '22023';
  end if;
  if v_barcode = '' or char_length(v_barcode) > 64 then
    raise exception 'Barcode is required (up to 64 characters).' using errcode = '22023';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Product name is required.' using errcode = '22023';
  end if;
  if p_buying_price < 0 or p_selling_price < 0 then
    raise exception 'Prices cannot be negative.' using errcode = '22023';
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
    raise exception 'This product id is already used elsewhere.' using errcode = '23505';
  end if;

  return v_product;
end;
$$;

-- record_stock_in ------------------------------------------------------------------

create function public.record_stock_in(
  p_batch_id uuid,
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
security definer
set search_path = ''
as $$
declare
  v_key text := 'stock_in:' || coalesce(nullif(btrim(p_idempotency_key), ''), p_batch_id::text);
  v_batch public.stock_batches;
  v_existing_batch uuid;
  v_total integer;
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

  insert into public.stock_batches (
    id, shop_id, product_id, quantity, initial_quantity, expiry_date, cost_price_per_unit,
    received_at, received_by
  )
  values (
    p_batch_id, p_shop_id, p_product_id, p_quantity, p_quantity, p_expiry_date,
    p_cost_price_per_unit, coalesce(p_received_at, now()), (select auth.uid())
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

-- record_sale ----------------------------------------------------------------------
-- p_items: [{ "id": uuid, "product_id": uuid, "quantity": int, "unit_price": numeric }, ...]
-- Deducts stock First-Expired-First-Out. A shortfall never rejects the sale (the goods already
-- left the shop): batches stop at 0, the shortfall is recorded in stock_discrepancies and owners
-- and managers are notified. Any invalid line rolls back the whole sale.

create function private.sale_result(p_sale public.sales, p_duplicate boolean, p_shortfall integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'sale', to_jsonb(p_sale),
    'items', coalesce(
      (select jsonb_agg(to_jsonb(i) order by i.created_at, i.id)
       from public.sale_items i where i.sale_id = p_sale.id),
      '[]'::jsonb
    ),
    'stock_totals', coalesce(
      (select jsonb_object_agg(t.product_id::text, private.product_stock(p_sale.shop_id, t.product_id))
       from (select distinct product_id from public.sale_items where sale_id = p_sale.id) t),
      '{}'::jsonb
    ),
    'duplicate', p_duplicate,
    'shortfall', p_shortfall
  );
$$;

revoke all on function private.sale_result(public.sales, boolean, integer) from public, anon, authenticated;

-- Sale lines from the p_items JSON array, in the order given. Bad values raise 22P02.
create function private.sale_lines(p_items jsonb)
returns table (ord integer, id uuid, product_id uuid, quantity integer, unit_price numeric(12, 2))
language sql
immutable
set search_path = ''
as $$
  select e.ord::integer,
         (e.value ->> 'id')::uuid,
         (e.value ->> 'product_id')::uuid,
         (e.value ->> 'quantity')::integer,
         coalesce((e.value ->> 'unit_price')::numeric, 0)::numeric(12, 2)
  from jsonb_array_elements(p_items) with ordinality as e(value, ord);
$$;

revoke all on function private.sale_lines(jsonb) from public, anon, authenticated;

create function public.record_sale(
  p_sale_id uuid,
  p_shop_id uuid,
  p_idempotency_key text,
  p_sold_at timestamptz,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_sold_at timestamptz := coalesce(p_sold_at, now());
  v_uid uuid := (select auth.uid());
  v_sale public.sales;
  v_item record;
  v_batch record;
  v_remaining integer;
  v_take integer;
  v_total integer;
  v_allocations jsonb;
  v_shortfall integer := 0;
  v_locked integer := 0;
  v_product_id uuid;
  v_product_name text;
begin
  perform private.assert_shop_role(p_shop_id, array['owner', 'manager', 'staff']);
  if p_sale_id is null then
    raise exception 'Sale id is required.' using errcode = '22023';
  end if;
  if v_key = '' or char_length(v_key) > 200 then
    raise exception 'Idempotency key is required (up to 200 characters).' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 100 then
    raise exception 'A sale needs 1 to 100 items.' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_items) e(value) where jsonb_typeof(e.value) <> 'object'
  ) or exists (
    select 1 from private.sale_lines(p_items) l
    where l.id is null or l.product_id is null or l.quantity is null
       or l.quantity <= 0 or l.quantity > 1000000 or l.unit_price < 0
  ) then
    raise exception 'Each item needs an id, a product, a quantity from 1 to 1,000,000 and a non-negative price.'
      using errcode = '22023';
  end if;
  if (select count(distinct l.id) from private.sale_lines(p_items) l) <> jsonb_array_length(p_items) then
    raise exception 'Item ids must be unique.' using errcode = '22023';
  end if;

  -- Lock every product in the sale, in id order, before reading or changing stock.
  for v_product_id in
    select p.id from public.products p
    where p.shop_id = p_shop_id and p.id in (select l.product_id from private.sale_lines(p_items) l)
    order by p.id
    for update
  loop
    v_locked := v_locked + 1;
  end loop;
  if v_locked <> (select count(distinct l.product_id) from private.sale_lines(p_items) l) then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;

  select * into v_sale
  from public.sales
  where shop_id = p_shop_id and (id = p_sale_id or idempotency_key = v_key)
  limit 1;
  if found then
    return private.sale_result(v_sale, true, 0);
  end if;

  insert into public.sales (id, shop_id, idempotency_key, total_amount, item_count, sold_by, sold_at)
  select p_sale_id, p_shop_id, v_key, sum(round(l.unit_price * l.quantity, 2)), count(*), v_uid, v_sold_at
  from private.sale_lines(p_items) l
  returning * into v_sale;

  for v_item in select * from private.sale_lines(p_items) l order by l.ord loop
    insert into public.sale_items (id, shop_id, sale_id, product_id, quantity, unit_price, line_total)
    values (
      v_item.id, p_shop_id, p_sale_id, v_item.product_id, v_item.quantity, v_item.unit_price,
      round(v_item.unit_price * v_item.quantity, 2)
    );

    v_remaining := v_item.quantity;
    v_allocations := '[]'::jsonb;
    v_total := private.product_stock(p_shop_id, v_item.product_id);

    for v_batch in
      select id, quantity, expiry_date
      from public.stock_batches
      where shop_id = p_shop_id and product_id = v_item.product_id and quantity > 0
      order by expiry_date asc nulls last, received_at asc, id asc
      for update
    loop
      exit when v_remaining <= 0;
      v_take := least(v_batch.quantity, v_remaining);
      v_remaining := v_remaining - v_take;
      v_total := v_total - v_take;

      update public.stock_batches set quantity = quantity - v_take where id = v_batch.id;

      insert into public.stock_movements (
        id, shop_id, product_id, batch_id, sale_id, sale_item_id, reason, quantity_delta,
        resulting_total_quantity, idempotency_key, actor_id, occurred_at
      )
      values (
        gen_random_uuid(), p_shop_id, v_item.product_id, v_batch.id, p_sale_id, v_item.id, 'sale',
        -v_take, v_total, 'sale:' || v_key || ':' || v_item.id || ':' || v_batch.id, v_uid, v_sold_at
      );

      v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
        'batchId', v_batch.id,
        'quantityDeducted', v_take,
        'batchExpiryDate', v_batch.expiry_date
      ));
    end loop;

    update public.sale_items set allocations = v_allocations where id = v_item.id;

    if v_remaining > 0 then
      v_shortfall := v_shortfall + v_remaining;

      insert into public.stock_discrepancies (shop_id, product_id, sale_id, sale_item_id, shortfall)
      values (p_shop_id, v_item.product_id, p_sale_id, v_item.id, v_remaining);

      select name into v_product_name from public.products where id = v_item.product_id;
      insert into public.notifications (shop_id, user_id, type, title, body, data)
      select p_shop_id, m.user_id, 'stock_discrepancy', 'Stock needs a recount',
             format('%s units of %s were sold without recorded stock.', v_remaining, v_product_name),
             jsonb_build_object(
               'product_id', v_item.product_id, 'sale_id', p_sale_id,
               'sale_item_id', v_item.id, 'shortfall', v_remaining
             )
      from public.shop_members m
      where m.shop_id = p_shop_id and m.user_id is not null and m.role in ('owner', 'manager');
    end if;
  end loop;

  return private.sale_result(v_sale, false, v_shortfall);
end;
$$;

-- record_stock_adjustment ------------------------------------------------------------
-- Deliberate corrections by an owner or manager. Strict: a change that would take the batch
-- below 0 is rejected. Write-offs must reduce stock; returns must add it.

create function public.record_stock_adjustment(
  p_shop_id uuid,
  p_batch_id uuid,
  p_quantity_delta integer,
  p_reason text,
  p_occurred_at timestamptz,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := 'adjustment:' || btrim(coalesce(p_idempotency_key, ''));
  v_batch public.stock_batches;
  v_movement public.stock_movements;
  v_total integer;
begin
  perform private.assert_shop_role(p_shop_id, array['owner', 'manager']);
  if btrim(coalesce(p_idempotency_key, '')) = '' or char_length(v_key) > 300 then
    raise exception 'Idempotency key is required (up to 288 characters).' using errcode = '22023';
  end if;
  if p_quantity_delta is null or p_quantity_delta = 0 or abs(p_quantity_delta) > 1000000 then
    raise exception 'Quantity change must be a non-zero whole number up to 1,000,000.' using errcode = '22023';
  end if;
  if p_reason is null
     or p_reason not in ('adjustment', 'write_off_expired', 'write_off_damaged', 'count_correction', 'return') then
    raise exception 'Unknown adjustment reason.' using errcode = '22023';
  end if;
  if p_reason in ('write_off_expired', 'write_off_damaged') and p_quantity_delta > 0 then
    raise exception 'A write-off must reduce stock.' using errcode = '22023';
  end if;
  if p_reason = 'return' and p_quantity_delta < 0 then
    raise exception 'A return must add stock.' using errcode = '22023';
  end if;

  select * into v_batch from public.stock_batches where id = p_batch_id and shop_id = p_shop_id;
  if not found then
    raise exception 'Batch not found in this shop.' using errcode = 'P0002';
  end if;

  perform 1 from public.products where id = v_batch.product_id for update;
  select * into v_batch from public.stock_batches where id = p_batch_id for update;

  select * into v_movement
  from public.stock_movements
  where shop_id = p_shop_id and idempotency_key = v_key;
  if found then
    return jsonb_build_object(
      'batch', to_jsonb(v_batch), 'movement', to_jsonb(v_movement), 'duplicate', true,
      'total_quantity', private.product_stock(p_shop_id, v_batch.product_id)
    );
  end if;

  if v_batch.quantity + p_quantity_delta < 0 then
    raise exception 'Only % units are left in this batch.', v_batch.quantity using errcode = '22023';
  end if;

  update public.stock_batches
  set quantity = quantity + p_quantity_delta
  where id = p_batch_id
  returning * into v_batch;

  v_total := private.product_stock(p_shop_id, v_batch.product_id);

  insert into public.stock_movements (
    id, shop_id, product_id, batch_id, reason, quantity_delta, resulting_total_quantity,
    idempotency_key, actor_id, occurred_at
  )
  values (
    gen_random_uuid(), p_shop_id, v_batch.product_id, p_batch_id, p_reason, p_quantity_delta, v_total,
    v_key, (select auth.uid()), coalesce(p_occurred_at, now())
  )
  returning * into v_movement;

  return jsonb_build_object(
    'batch', to_jsonb(v_batch), 'movement', to_jsonb(v_movement), 'duplicate', false,
    'total_quantity', v_total
  );
end;
$$;

-- Only signed-in users may call the write API -----------------------------------------

revoke all on function public.upsert_product(uuid, uuid, text, text, text, numeric, numeric, timestamptz) from public, anon;
revoke all on function public.record_stock_in(uuid, uuid, uuid, integer, date, numeric, timestamptz, text) from public, anon;
revoke all on function public.record_sale(uuid, uuid, text, timestamptz, jsonb) from public, anon;
revoke all on function public.record_stock_adjustment(uuid, uuid, integer, text, timestamptz, text) from public, anon;

grant execute on function public.upsert_product(uuid, uuid, text, text, text, numeric, numeric, timestamptz) to authenticated;
grant execute on function public.record_stock_in(uuid, uuid, uuid, integer, date, numeric, timestamptz, text) to authenticated;
grant execute on function public.record_sale(uuid, uuid, text, timestamptz, jsonb) to authenticated;
grant execute on function public.record_stock_adjustment(uuid, uuid, integer, text, timestamptz, text) to authenticated;
