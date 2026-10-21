-- A delivery against a wholesale order. Rows are append-only: a later delivery is a new receipt.
-- Inventory changes only through record_stock_in, once per batch in this receipt.

create table public.wholesale_order_receipts (
  id uuid primary key,
  shop_id uuid not null,
  order_id uuid not null,
  received_at timestamptz not null default now(),
  received_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wholesale_order_receipts_order_fkey foreign key (shop_id, order_id)
    references public.wholesale_orders (shop_id, id) on delete cascade
);

create unique index wholesale_order_receipts_shop_id_key on public.wholesale_order_receipts (shop_id, id);
create index wholesale_order_receipts_shop_updated_idx on public.wholesale_order_receipts (shop_id, updated_at);

create trigger wholesale_order_receipts_set_updated_at before update on public.wholesale_order_receipts
  for each row execute function public.set_updated_at();

alter table public.wholesale_order_receipts enable row level security;
revoke all on table public.wholesale_order_receipts from public, anon, authenticated;
grant select on table public.wholesale_order_receipts to authenticated;

create policy "Members can view shop wholesale receipts"
  on public.wholesale_order_receipts for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

create table public.wholesale_order_receipt_lines (
  id uuid primary key,
  shop_id uuid not null,
  receipt_id uuid not null,
  order_item_id uuid not null,
  batch_id uuid not null unique,
  quantity integer not null check (quantity >= 1 and quantity <= 1000000),
  expiry_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wholesale_order_receipt_lines_receipt_fkey foreign key (shop_id, receipt_id)
    references public.wholesale_order_receipts (shop_id, id) on delete cascade,
  constraint wholesale_order_receipt_lines_item_fkey foreign key (order_item_id)
    references public.wholesale_order_items (id)
);

create index wholesale_order_receipt_lines_shop_updated_idx
  on public.wholesale_order_receipt_lines (shop_id, updated_at);
create index wholesale_order_receipt_lines_item_idx
  on public.wholesale_order_receipt_lines (order_item_id);

create trigger wholesale_order_receipt_lines_set_updated_at before update on public.wholesale_order_receipt_lines
  for each row execute function public.set_updated_at();

alter table public.wholesale_order_receipt_lines enable row level security;
revoke all on table public.wholesale_order_receipt_lines from public, anon, authenticated;
grant select on table public.wholesale_order_receipt_lines to authenticated;

create policy "Members can view shop wholesale receipt lines"
  on public.wholesale_order_receipt_lines for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

comment on table public.wholesale_order_receipts is
  'One recorded delivery against a wholesale order. Replaying the id does not receive stock again.';
comment on table public.wholesale_order_receipt_lines is
  'Units actually received, and the batch record_stock_in created for them.';

create function public.receive_wholesale_order(
  p_shop_id uuid,
  p_receipt_id uuid,
  p_order_id uuid,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.wholesale_orders;
  v_receipt public.wholesale_order_receipts;
  v_line jsonb;
  v_line_ids uuid[] := '{}';
  v_item_ids uuid[] := '{}';
  v_batch_ids uuid[] := '{}';
  v_qtys integer[] := '{}';
  v_expiries date[] := '{}';
  v_products uuid[] := '{}';
  v_costs numeric[] := '{}';
  v_keys text[] := '{}';
  v_line_id uuid;
  v_item_id uuid;
  v_batch_id uuid;
  v_qty integer;
  v_expiry date;
  v_expiry_text text;
  v_product_id uuid;
  v_cost numeric;
  v_ordered integer;
  v_already integer;
  v_asked integer;
  v_supplier text;
  v_received_at timestamptz := now();
  v_outstanding integer;
  v_status text;
  v_lines jsonb;
  v_batches jsonb;
  v_movements jsonb;
  i integer;
begin
  perform private.assert_permission(p_shop_id, 'stock.receive');
  if p_receipt_id is null or p_order_id is null then
    raise exception 'Choose an order.' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1
     or jsonb_array_length(p_lines) > 160 then
    raise exception 'Record at least one product.' using errcode = '22023';
  end if;

  select * into v_order
  from public.wholesale_orders
  where id = p_order_id and shop_id = p_shop_id
  for update;
  if not found then
    raise exception 'Order not found in this shop.' using errcode = 'P0002';
  end if;

  select * into v_receipt from public.wholesale_order_receipts where id = p_receipt_id;
  if found then
    if v_receipt.shop_id <> p_shop_id or v_receipt.order_id <> p_order_id then
      raise exception 'This receipt belongs to another order.' using errcode = '22023';
    end if;
    select * into v_order from public.wholesale_orders where id = v_receipt.order_id and shop_id = p_shop_id;
    select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at), '[]'::jsonb) into v_lines
    from public.wholesale_order_receipt_lines l
    where l.receipt_id = v_receipt.id;
    select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) into v_batches
    from public.stock_batches b
    where b.id in (select l.batch_id from public.wholesale_order_receipt_lines l where l.receipt_id = v_receipt.id);
    select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) into v_movements
    from public.stock_movements m
    where m.shop_id = p_shop_id
      and m.batch_id in (select l.batch_id from public.wholesale_order_receipt_lines l where l.receipt_id = v_receipt.id)
      and m.reason = 'stock_in';
    return jsonb_build_object(
      'order', to_jsonb(v_order),
      'receipt', to_jsonb(v_receipt),
      'lines', v_lines,
      'batches', v_batches,
      'movements', v_movements
    );
  end if;

  if v_order.status not in ('ordered', 'partially_received') then
    raise exception 'Only an ordered delivery can be received.' using errcode = '22023';
  end if;

  select w.name into v_supplier
  from public.wholesalers w
  where w.id = v_order.wholesaler_id and w.shop_id = p_shop_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    begin
      v_line_id := (v_line ->> 'id')::uuid;
      v_item_id := (v_line ->> 'order_item_id')::uuid;
      v_batch_id := (v_line ->> 'batch_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Each delivery line needs an id.' using errcode = '22023';
    end;
    if v_line_id is null or v_item_id is null or v_batch_id is null then
      raise exception 'Each delivery line needs an id.' using errcode = '22023';
    end if;
    if v_line_id = any(v_line_ids) or v_batch_id = any(v_batch_ids) then
      raise exception 'The same delivery line was sent twice.' using errcode = '22023';
    end if;
    if coalesce(v_line ->> 'quantity', '') !~ '^[0-9]+$' then
      raise exception 'Quantity must be a whole number from 1 to 1,000,000.' using errcode = '22023';
    end if;
    v_qty := (v_line ->> 'quantity')::integer;
    if v_qty < 1 or v_qty > 1000000 then
      raise exception 'Quantity must be a whole number from 1 to 1,000,000.' using errcode = '22023';
    end if;
    v_expiry_text := nullif(btrim(coalesce(v_line ->> 'expiry_date', '')), '');
    v_expiry := null;
    if v_expiry_text is not null then
      begin
        v_expiry := v_expiry_text::date;
      exception when invalid_datetime_format or datetime_field_overflow then
        raise exception 'Expiry date must be a real date.' using errcode = '22023';
      end;
    end if;

    select i.product_id, i.quantity, i.estimated_unit_cost into v_product_id, v_ordered, v_cost
    from public.wholesale_order_items i
    where i.id = v_item_id and i.shop_id = p_shop_id and i.order_id = p_order_id and i.removed_at is null;
    if not found then
      raise exception 'Order line not found in this shop.' using errcode = 'P0002';
    end if;
    if exists (select 1 from public.stock_batches where id = v_batch_id) then
      raise exception 'This delivery was already recorded.' using errcode = '22023';
    end if;

    v_line_ids := array_append(v_line_ids, v_line_id);
    v_item_ids := array_append(v_item_ids, v_item_id);
    v_batch_ids := array_append(v_batch_ids, v_batch_id);
    v_qtys := array_append(v_qtys, v_qty);
    v_expiries := array_append(v_expiries, v_expiry);
    v_products := array_append(v_products, v_product_id);
    v_costs := array_append(v_costs, v_cost);
  end loop;

  for v_item_id in select distinct unnest(v_item_ids) loop
    select i.quantity into v_ordered
    from public.wholesale_order_items i
    where i.id = v_item_id;
    select coalesce(sum(l.quantity), 0)::integer into v_already
    from public.wholesale_order_receipt_lines l
    where l.order_item_id = v_item_id;
    select coalesce(sum(q), 0)::integer into v_asked
    from unnest(v_item_ids, v_qtys) as t(item_id, q)
    where t.item_id = v_item_id;
    if v_asked > v_ordered - v_already then
      raise exception 'That is more than is still outstanding.' using errcode = '22023';
    end if;
  end loop;

  insert into public.wholesale_order_receipts (id, shop_id, order_id, received_at, received_by)
  values (p_receipt_id, p_shop_id, p_order_id, v_received_at, (select auth.uid()))
  returning * into v_receipt;

  for i in 1..array_length(v_line_ids, 1) loop
    v_keys := v_keys || ('wholesale:' || p_receipt_id::text || ':' || v_line_ids[i]::text);
    perform public.record_stock_in(
      v_batch_ids[i],
      p_shop_id,
      v_products[i],
      v_qtys[i],
      v_expiries[i],
      v_costs[i],
      v_received_at,
      'wholesale:' || p_receipt_id::text || ':' || v_line_ids[i]::text,
      null::uuid,
      null::integer,
      null::uuid,
      null::text,
      v_supplier
    );
    insert into public.wholesale_order_receipt_lines (
      id, shop_id, receipt_id, order_item_id, batch_id, quantity, expiry_date
    )
    values (
      v_line_ids[i], p_shop_id, p_receipt_id, v_item_ids[i], v_batch_ids[i], v_qtys[i], v_expiries[i]
    );
  end loop;

  v_outstanding := 0;
  for v_item_id, v_ordered in
    select i.id, i.quantity
    from public.wholesale_order_items i
    where i.shop_id = p_shop_id and i.order_id = p_order_id and i.removed_at is null
  loop
    select coalesce(sum(l.quantity), 0)::integer into v_already
    from public.wholesale_order_receipt_lines l
    where l.order_item_id = v_item_id;
    v_outstanding := v_outstanding + greatest(v_ordered - v_already, 0);
  end loop;
  v_status := case when v_outstanding = 0 then 'received' else 'partially_received' end;

  update public.wholesale_orders
  set status = v_status
  where id = p_order_id and shop_id = p_shop_id
  returning * into v_order;

  select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at), '[]'::jsonb) into v_lines
  from public.wholesale_order_receipt_lines l
  where l.receipt_id = p_receipt_id;
  select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) into v_batches
  from public.stock_batches b
  where b.id = any(v_batch_ids);
  select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) into v_movements
  from public.stock_movements m
  where m.shop_id = p_shop_id and m.idempotency_key = any(
    select 'stock_in:' || k from unnest(v_keys) as k
  );

  return jsonb_build_object(
    'order', to_jsonb(v_order),
    'receipt', to_jsonb(v_receipt),
    'lines', v_lines,
    'batches', v_batches,
    'movements', v_movements
  );
end;
$$;

revoke all on function public.receive_wholesale_order(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.receive_wholesale_order(uuid, uuid, uuid, jsonb) to authenticated;

-- Partly received and received now come only from a receipt, so a status change cannot skip the stock.
create or replace function public.set_wholesale_order_status(p_shop_id uuid, p_order_id uuid, p_status text)
returns public.wholesale_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.wholesale_orders;
  v_allowed boolean;
begin
  perform private.assert_permission(p_shop_id, 'orders.manage');
  if p_status not in ('draft', 'approved', 'ordered', 'partially_received', 'received', 'cancelled') then
    raise exception 'That status is not used.' using errcode = '22023';
  end if;

  select * into v_order from public.wholesale_orders where id = p_order_id and shop_id = p_shop_id;
  if not found then
    raise exception 'Order not found in this shop.' using errcode = 'P0002';
  end if;
  if v_order.status = p_status then
    return v_order;
  end if;

  v_allowed := case v_order.status
    when 'draft' then p_status in ('approved', 'cancelled')
    when 'approved' then p_status in ('ordered', 'draft', 'cancelled')
    when 'ordered' then p_status = 'cancelled'
    when 'partially_received' then p_status = 'cancelled'
    else false
  end;
  if not v_allowed then
    raise exception 'That status change is not allowed.' using errcode = '22023';
  end if;

  if p_status not in ('draft', 'cancelled') then
    if v_order.wholesaler_id is null or not exists (
      select 1 from public.wholesale_order_items
      where shop_id = p_shop_id and order_id = p_order_id and removed_at is null
    ) then
      raise exception 'Choose a wholesaler and at least one product first.' using errcode = '22023';
    end if;
  end if;

  update public.wholesale_orders
  set status = p_status
  where id = p_order_id and shop_id = p_shop_id
  returning * into v_order;
  return v_order;
end;
$$;
