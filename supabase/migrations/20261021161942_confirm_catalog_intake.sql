-- One transaction links catalogue products into this shop and inserts their opening batches.
-- adopt_catalog_product and record_stock_in keep their own arguments and are called from here.
-- A repeat with the same batch ids does not add the quantity again. A product that already has
-- some other batch is left untouched.

create function public.confirm_catalog_intake(p_shop_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_item jsonb;
  v_batch jsonb;
  v_seen uuid[] := '{}';
  v_product_ids uuid[] := '{}';
  v_batch_ids uuid[] := '{}';
  v_catalog_id uuid;
  v_product_key uuid;
  v_batch_id uuid;
  v_qty integer;
  v_expiry_text text;
  v_expiry date;
  v_buying numeric;
  v_selling numeric;
  v_adopt jsonb;
  v_product_id uuid;
  v_created boolean;
  v_existing uuid[];
  v_requested uuid[];
  v_known boolean;
  v_other boolean;
  v_stock jsonb;
  v_batches jsonb;
  v_any_new boolean;
  v_any_duplicate boolean;
  v_status text;
  v_results jsonb := '[]'::jsonb;
begin
  perform private.assert_shop_role(p_shop_id, array['owner', 'manager', 'staff']);
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 40 then
    raise exception 'Choose between 1 and 40 products.' using errcode = '22023';
  end if;
  v_today := private.shop_today(p_shop_id);

  for v_item in select value from jsonb_array_elements(p_items) loop
    begin
      v_catalog_id := (v_item ->> 'catalog_product_id')::uuid;
      v_product_key := (v_item ->> 'product_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Each product needs a catalogue id and a product id.' using errcode = '22023';
    end;
    if v_catalog_id is null or v_product_key is null then
      raise exception 'Each product needs a catalogue id and a product id.' using errcode = '22023';
    end if;
    if v_catalog_id = any(v_seen) or v_product_key = any(v_product_ids) then
      raise exception 'The same product was sent twice.' using errcode = '22023';
    end if;
    v_seen := v_seen || v_catalog_id;
    v_product_ids := v_product_ids || v_product_key;

    if v_item -> 'buying_price' is not null and jsonb_typeof(v_item -> 'buying_price') <> 'null' then
      v_buying := (v_item ->> 'buying_price')::numeric;
      if v_buying < 0 then
        raise exception 'Prices cannot be negative.' using errcode = '22023';
      end if;
    end if;
    if v_item -> 'selling_price' is not null and jsonb_typeof(v_item -> 'selling_price') <> 'null' then
      v_selling := (v_item ->> 'selling_price')::numeric;
      if v_selling < 0 then
        raise exception 'Prices cannot be negative.' using errcode = '22023';
      end if;
    end if;

    if v_item -> 'batches' is null or jsonb_typeof(v_item -> 'batches') <> 'array'
       or jsonb_array_length(v_item -> 'batches') < 1 or jsonb_array_length(v_item -> 'batches') > 8 then
      raise exception 'Each product needs between 1 and 8 batches.' using errcode = '22023';
    end if;
    for v_batch in select value from jsonb_array_elements(v_item -> 'batches') loop
      begin
        v_batch_id := (v_batch ->> 'id')::uuid;
      exception when invalid_text_representation then
        raise exception 'Each batch needs an id.' using errcode = '22023';
      end;
      if v_batch_id is null or v_batch_id = any(v_batch_ids) then
        raise exception 'Each batch needs its own id.' using errcode = '22023';
      end if;
      v_batch_ids := v_batch_ids || v_batch_id;
      if coalesce(v_batch ->> 'quantity', '') !~ '^[0-9]+$' then
        raise exception 'Quantity must be a whole number from 1 to 1,000,000.' using errcode = '22023';
      end if;
      v_qty := (v_batch ->> 'quantity')::integer;
      if v_qty < 1 or v_qty > 1000000 then
        raise exception 'Quantity must be a whole number from 1 to 1,000,000.' using errcode = '22023';
      end if;
      v_expiry_text := nullif(v_batch ->> 'expiry_date', '');
      if v_expiry_text is not null then
        if v_expiry_text !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception 'Expiry date must be a calendar date.' using errcode = '22023';
        end if;
        v_expiry := v_expiry_text::date;
        if v_expiry < v_today then
          raise exception 'Expiry date is already past.' using errcode = '22023';
        end if;
      end if;
    end loop;
  end loop;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_catalog_id := (v_item ->> 'catalog_product_id')::uuid;
    v_product_key := (v_item ->> 'product_id')::uuid;
    v_buying := case
      when v_item -> 'buying_price' is null or jsonb_typeof(v_item -> 'buying_price') = 'null' then null
      else round((v_item ->> 'buying_price')::numeric, 2)
    end;
    v_selling := case
      when v_item -> 'selling_price' is null or jsonb_typeof(v_item -> 'selling_price') = 'null' then null
      else round((v_item ->> 'selling_price')::numeric, 2)
    end;

    v_adopt := public.adopt_catalog_product(
      p_id => v_product_key,
      p_shop_id => p_shop_id,
      p_catalog_product_id => v_catalog_id,
      p_buying_price => v_buying,
      p_selling_price => v_selling,
      p_created_at => now()
    );
    v_product_id := (v_adopt -> 'product' ->> 'id')::uuid;
    v_created := coalesce((v_adopt ->> 'created')::boolean, false);
    if (v_adopt -> 'product' ->> 'archived_at') is not null then
      raise exception 'This product is archived in this shop.' using errcode = '22023';
    end if;

    select coalesce(array_agg(b.id), '{}') into v_requested
    from jsonb_array_elements(v_item -> 'batches') batch
    cross join lateral (select (batch ->> 'id')::uuid as id) b;

    select coalesce(array_agg(s.id), '{}') into v_existing
    from public.stock_batches s
    where s.shop_id = p_shop_id and s.product_id = v_product_id;

    v_known := v_existing && v_requested;
    v_other := exists (select 1 from unnest(v_existing) existing_id where not existing_id = any(v_requested));
    v_batches := '[]'::jsonb;
    v_any_new := false;
    v_any_duplicate := false;

    if v_other and not v_known then
      v_status := 'already_in_shop';
    else
      for v_batch in select value from jsonb_array_elements(v_item -> 'batches') loop
        v_batch_id := (v_batch ->> 'id')::uuid;
        v_qty := (v_batch ->> 'quantity')::integer;
        v_expiry_text := nullif(v_batch ->> 'expiry_date', '');
        v_expiry := case when v_expiry_text is null then null else v_expiry_text::date end;
        v_stock := public.record_stock_in(
          p_batch_id => v_batch_id,
          p_shop_id => p_shop_id,
          p_product_id => v_product_id,
          p_quantity => v_qty,
          p_expiry_date => v_expiry,
          p_cost_price_per_unit => v_buying,
          p_received_at => now(),
          p_idempotency_key => v_batch_id::text
        );
        v_batches := v_batches || jsonb_build_array(v_stock);
        if coalesce((v_stock ->> 'duplicate')::boolean, false) then
          v_any_duplicate := true;
        else
          v_any_new := true;
        end if;
      end loop;
      v_status := case
        when v_any_duplicate and not v_any_new then 'duplicate'
        when v_created then 'created'
        else 'stocked'
      end;
    end if;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'catalog_product_id', v_catalog_id,
      'status', v_status,
      'created', v_created,
      'product', v_adopt -> 'product',
      'packagings', coalesce(v_adopt -> 'packagings', '[]'::jsonb),
      'barcodes', coalesce(v_adopt -> 'barcodes', '[]'::jsonb),
      'batches', v_batches
    ));
  end loop;

  return jsonb_build_object('items', v_results);
end;
$$;

revoke all on function public.confirm_catalog_intake(uuid, jsonb) from public, anon;
grant execute on function public.confirm_catalog_intake(uuid, jsonb) to authenticated;
