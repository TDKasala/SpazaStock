-- Adds units onto a batch that is already saved. Expiry, lot, supplier, and cost stay as they are.
-- A new delivery with its own expiry still uses record_stock_in, which always inserts a new batch.

create function public.add_stock_to_batch(
  p_shop_id uuid,
  p_batch_id uuid,
  p_quantity integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := 'stock_add:' || coalesce(nullif(btrim(p_idempotency_key), ''), '');
  v_batch public.stock_batches;
  v_product_id uuid;
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
  if v_key = 'stock_add:' or char_length(v_key) > 300 then
    raise exception 'Idempotency key is required.' using errcode = '22023';
  end if;

  select product_id into v_product_id
  from public.stock_batches
  where id = p_batch_id and shop_id = p_shop_id;
  if not found then
    raise exception 'Batch not found in this shop.' using errcode = 'P0002';
  end if;

  -- Product first, then the batch, matching a sale so the two cannot deadlock.
  perform 1 from public.products
  where id = v_product_id and shop_id = p_shop_id
  for update;

  select * into v_batch
  from public.stock_batches
  where id = p_batch_id and shop_id = p_shop_id
  for update;
  if not found then
    raise exception 'Batch not found in this shop.' using errcode = 'P0002';
  end if;

  select batch_id into v_existing_batch
  from public.stock_movements
  where shop_id = p_shop_id and idempotency_key = v_key;
  if found then
    select * into v_batch from public.stock_batches where id = v_existing_batch;
    return jsonb_build_object(
      'batch', to_jsonb(v_batch), 'duplicate', true,
      'total_quantity', private.product_stock(p_shop_id, v_batch.product_id)
    );
  end if;

  if v_batch.quantity::bigint + p_quantity > 1000000 then
    raise exception 'A batch can hold at most 1,000,000 units.' using errcode = '22023';
  end if;

  update public.stock_batches
  set quantity = quantity + p_quantity,
      initial_quantity = initial_quantity + p_quantity
  where id = p_batch_id
  returning * into v_batch;

  v_total := private.product_stock(p_shop_id, v_batch.product_id);

  insert into public.stock_movements (
    id, shop_id, product_id, batch_id, reason, quantity_delta,
    resulting_total_quantity, idempotency_key, occurred_at
  )
  values (
    gen_random_uuid(), p_shop_id, v_batch.product_id, v_batch.id, 'stock_in', p_quantity,
    v_total, v_key, now()
  );

  return jsonb_build_object(
    'batch', to_jsonb(v_batch), 'duplicate', false, 'total_quantity', v_total
  );
exception
  when unique_violation then
    select * into v_batch
    from public.stock_batches
    where id = (
      select batch_id from public.stock_movements
      where shop_id = p_shop_id and idempotency_key = v_key
    );
    return jsonb_build_object(
      'batch', to_jsonb(v_batch), 'duplicate', true,
      'total_quantity', private.product_stock(p_shop_id, v_batch.product_id)
    );
end;
$$;

revoke all on function public.add_stock_to_batch(uuid, uuid, integer, text) from public, anon;
grant execute on function public.add_stock_to_batch(uuid, uuid, integer, text) to authenticated;
