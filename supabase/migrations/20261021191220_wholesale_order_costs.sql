-- Optional estimated unit cost and a purchased tick on a wholesale line.
-- Neither column changes stock batches or expiry dates.

alter table public.wholesale_order_items
  add column estimated_unit_cost numeric(12, 2),
  add column purchased_at timestamptz,
  add constraint wholesale_order_items_cost_check
    check (estimated_unit_cost is null or estimated_unit_cost >= 0);

comment on column public.wholesale_order_items.estimated_unit_cost is
  'Optional estimated cost per sellable unit. Null means the line has no estimate.';
comment on column public.wholesale_order_items.purchased_at is
  'Set when the merchant marks the line as bought. It does not receive stock.';

create or replace function public.save_wholesale_order(
  p_shop_id uuid,
  p_order_id uuid,
  p_wholesaler_id uuid,
  p_note text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_order public.wholesale_orders;
  v_item jsonb;
  v_ids uuid[] := '{}';
  v_products uuid[] := '{}';
  v_item_id uuid;
  v_product_id uuid;
  v_qty integer;
  v_cost_text text;
  v_cost numeric;
  v_items jsonb;
begin
  perform private.assert_permission(p_shop_id, 'orders.manage');
  if p_order_id is null then
    raise exception 'Order id is required.' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 280 then
    raise exception 'Note is too long.' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 80 then
    raise exception 'An order can hold up to 80 products.' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    begin
      v_item_id := (v_item ->> 'id')::uuid;
      v_product_id := (v_item ->> 'product_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Each line needs an id and a product.' using errcode = '22023';
    end;
    if v_item_id is null or v_product_id is null then
      raise exception 'Each line needs an id and a product.' using errcode = '22023';
    end if;
    if v_item_id = any(v_ids) or v_product_id = any(v_products) then
      raise exception 'The same product was sent twice.' using errcode = '22023';
    end if;
    if coalesce(v_item ->> 'quantity', '') !~ '^[0-9]+$' then
      raise exception 'Quantity must be a whole number from 1 to 1,000,000.' using errcode = '22023';
    end if;
    v_qty := (v_item ->> 'quantity')::integer;
    if v_qty < 1 or v_qty > 1000000 then
      raise exception 'Quantity must be a whole number from 1 to 1,000,000.' using errcode = '22023';
    end if;
    v_cost_text := nullif(btrim(coalesce(v_item ->> 'estimated_unit_cost', '')), '');
    if v_cost_text is not null then
      begin
        v_cost := round(v_cost_text::numeric, 2);
      exception when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'Estimated cost must be a number.' using errcode = '22023';
      end;
      if v_cost < 0 then
        raise exception 'Estimated cost cannot be negative.' using errcode = '22023';
      end if;
    end if;
    if not exists (
      select 1 from public.products where id = v_product_id and shop_id = p_shop_id
    ) then
      raise exception 'Product not found in this shop.' using errcode = 'P0002';
    end if;
    v_ids := v_ids || v_item_id;
    v_products := v_products || v_product_id;
  end loop;

  if p_wholesaler_id is not null and not exists (
    select 1 from public.wholesalers
    where id = p_wholesaler_id and shop_id = p_shop_id and archived_at is null
  ) then
    raise exception 'Choose a wholesaler from this shop.' using errcode = '22023';
  end if;

  select * into v_order from public.wholesale_orders where id = p_order_id;
  if found and v_order.shop_id <> p_shop_id then
    raise exception 'This order belongs to another shop.' using errcode = '22023';
  end if;
  if found and v_order.status <> 'draft' then
    raise exception 'Only a draft can be changed.' using errcode = '22023';
  end if;

  if not found then
    insert into public.wholesale_orders (id, shop_id, wholesaler_id, status, note)
    values (p_order_id, p_shop_id, p_wholesaler_id, 'draft', v_note)
    returning * into v_order;
  else
    update public.wholesale_orders
    set wholesaler_id = p_wholesaler_id, note = v_note
    where id = p_order_id and shop_id = p_shop_id
    returning * into v_order;
  end if;

  update public.wholesale_order_items
  set removed_at = now()
  where shop_id = p_shop_id and order_id = p_order_id and removed_at is null
    and not (id = any(v_ids));

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_item_id := (v_item ->> 'id')::uuid;
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_qty := (v_item ->> 'quantity')::integer;
    v_cost_text := nullif(btrim(coalesce(v_item ->> 'estimated_unit_cost', '')), '');
    v_cost := case when v_cost_text is null then null else round(v_cost_text::numeric, 2) end;
    update public.wholesale_order_items
    set product_id = v_product_id,
        quantity = v_qty,
        estimated_unit_cost = v_cost,
        removed_at = null
    where id = v_item_id and shop_id = p_shop_id and order_id = p_order_id;
    if not found then
      insert into public.wholesale_order_items (
        id, shop_id, order_id, product_id, quantity, estimated_unit_cost
      )
      values (v_item_id, p_shop_id, p_order_id, v_product_id, v_qty, v_cost);
    end if;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at), '[]'::jsonb) into v_items
  from public.wholesale_order_items i
  where i.shop_id = p_shop_id and i.order_id = p_order_id and i.removed_at is null;

  return jsonb_build_object('order', to_jsonb(v_order), 'items', v_items);
end;
$$;

create function public.set_wholesale_item_purchased(p_shop_id uuid, p_item_id uuid, p_purchased boolean)
returns public.wholesale_order_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.wholesale_order_items;
  v_status text;
begin
  perform private.assert_permission(p_shop_id, 'orders.manage');
  if p_item_id is null or p_purchased is null then
    raise exception 'Choose a line.' using errcode = '22023';
  end if;

  select i.* into v_item
  from public.wholesale_order_items i
  where i.id = p_item_id and i.shop_id = p_shop_id and i.removed_at is null;
  if not found then
    raise exception 'Order line not found in this shop.' using errcode = 'P0002';
  end if;

  select o.status into v_status
  from public.wholesale_orders o
  where o.id = v_item.order_id and o.shop_id = p_shop_id;
  if v_status = 'cancelled' then
    raise exception 'A cancelled order cannot be changed.' using errcode = '22023';
  end if;

  if (p_purchased and v_item.purchased_at is not null)
     or (not p_purchased and v_item.purchased_at is null) then
    return v_item;
  end if;

  update public.wholesale_order_items
  set purchased_at = case when p_purchased then now() else null end
  where id = p_item_id and shop_id = p_shop_id
  returning * into v_item;
  return v_item;
end;
$$;

revoke all on function public.set_wholesale_item_purchased(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_wholesale_item_purchased(uuid, uuid, boolean) to authenticated;
