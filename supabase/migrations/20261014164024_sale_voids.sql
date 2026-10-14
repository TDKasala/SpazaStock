-- Sale voids: undo a mis-scan or reduce a sold line, returning the units to the batches they came
-- from. Sale lines keep their original quantity and line_total (gross); voided units are counted
-- in sale_items.voided_quantity, so net = (quantity - voided_quantity) * unit_price.

alter table public.sale_items
  add column voided_quantity integer not null default 0,
  add constraint sale_items_voided_quantity_check check (voided_quantity >= 0 and voided_quantity <= quantity);

comment on column public.sale_items.voided_quantity is
  'Units of this line that were voided (undone). line_total stays the gross amount.';

-- One row per void, for audit and idempotency --------------------------------------------

create table public.sale_item_voids (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  sale_id uuid not null,
  sale_item_id uuid not null references public.sale_items (id) on delete cascade,
  quantity integer not null check (quantity > 0),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  voided_by uuid default auth.uid() references auth.users (id) on delete set null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint sale_item_voids_sale_fkey foreign key (shop_id, sale_id)
    references public.sales (shop_id, id) on delete cascade,
  constraint sale_item_voids_shop_idempotency_key unique (shop_id, idempotency_key)
);

comment on column public.sale_item_voids.occurred_at is 'Device time the void happened.';

create index sale_item_voids_sale_item_id_idx on public.sale_item_voids (sale_item_id);
create index sale_item_voids_shop_sale_idx on public.sale_item_voids (shop_id, sale_id);
create index sale_item_voids_voided_by_idx on public.sale_item_voids (voided_by);
create index sale_item_voids_shop_created_idx on public.sale_item_voids (shop_id, created_at);

alter table public.sale_item_voids enable row level security;
revoke all on table public.sale_item_voids from anon, authenticated;
grant select on table public.sale_item_voids to authenticated;

create policy "Members can view shop sale voids"
  on public.sale_item_voids for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

-- void_sale_item -------------------------------------------------------------------------
-- Owners and managers may void any line. Staff may void only lines they sold, within 15 minutes
-- of the sale (device time), and not with a future timestamp beyond normal clock skew.
--
-- Returned units follow a fixed rule determined by allocations and voided_quantity alone:
--   1. units that were never taken from a batch (an oversell shortfall) are voided first;
--   2. the rest go back to the batches they came from, last allocation first.
-- Each batch credited gets a 'return' movement keyed 'void:{key}:{batch_id}'.

create function private.void_result(p_sale_item_id uuid, p_duplicate boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'sale', to_jsonb(s),
    'item', to_jsonb(i),
    'stock_total', private.product_stock(i.shop_id, i.product_id),
    'duplicate', p_duplicate
  )
  from public.sale_items i
  join public.sales s on s.id = i.sale_id
  where i.id = p_sale_item_id;
$$;

revoke all on function private.void_result(uuid, boolean) from public, anon, authenticated;

create function public.void_sale_item(
  p_shop_id uuid,
  p_sale_item_id uuid,
  p_quantity integer,
  p_occurred_at timestamptz,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_uid uuid := (select auth.uid());
  v_occurred_at timestamptz := coalesce(p_occurred_at, now());
  v_product_id uuid;
  v_item public.sale_items;
  v_sale public.sales;
  v_existing public.sale_item_voids;
  v_allocated integer;
  v_shortfall integer;
  v_skip integer;
  v_remaining integer;
  v_available integer;
  v_skipped integer;
  v_take integer;
  v_total integer;
  v_alloc record;
begin
  perform private.assert_shop_role(p_shop_id, array['owner', 'manager', 'staff']);
  if p_sale_item_id is null then
    raise exception 'Sale item id is required.' using errcode = '22023';
  end if;
  if v_key = '' or char_length(v_key) > 200 then
    raise exception 'Idempotency key is required (up to 200 characters).' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000000 then
    raise exception 'Quantity must be a whole number from 1 to 1,000,000.' using errcode = '22023';
  end if;

  select product_id into v_product_id
  from public.sale_items
  where id = p_sale_item_id and shop_id = p_shop_id;
  if not found then
    raise exception 'Sale item not found in this shop.' using errcode = 'P0002';
  end if;

  -- Same lock order as record_sale: product first, then the rows that depend on it.
  perform 1 from public.products where id = v_product_id for update;
  select * into v_item from public.sale_items where id = p_sale_item_id for update;
  select * into v_sale from public.sales where id = v_item.sale_id;

  select * into v_existing
  from public.sale_item_voids
  where shop_id = p_shop_id and idempotency_key = v_key;
  if found then
    return private.void_result(v_existing.sale_item_id, true);
  end if;

  if not private.has_shop_role(p_shop_id, array['owner', 'manager']) then
    if v_sale.sold_by is distinct from v_uid
       or v_occurred_at < v_sale.sold_at
       or v_occurred_at > v_sale.sold_at + interval '15 minutes'
       or v_occurred_at > now() + interval '5 minutes' then
      raise exception 'Staff can only undo their own sales within 15 minutes.' using errcode = '42501';
    end if;
  end if;

  if p_quantity > v_item.quantity - v_item.voided_quantity then
    raise exception 'Only % units of this sale can still be voided.', v_item.quantity - v_item.voided_quantity
      using errcode = '22023';
  end if;

  select coalesce(sum((a.value ->> 'quantityDeducted')::integer), 0) into v_allocated
  from jsonb_array_elements(v_item.allocations) a(value);
  v_shortfall := greatest(v_item.quantity - v_allocated, 0);

  -- Units already returned to batches by earlier voids, and units this void returns to batches.
  v_skip := v_item.voided_quantity - least(v_item.voided_quantity, v_shortfall);
  v_remaining := p_quantity - least(p_quantity, v_shortfall - least(v_item.voided_quantity, v_shortfall));
  v_total := private.product_stock(p_shop_id, v_item.product_id);

  for v_alloc in
    select (a.value ->> 'batchId')::uuid as batch_id, (a.value ->> 'quantityDeducted')::integer as quantity
    from jsonb_array_elements(v_item.allocations) with ordinality a(value, ord)
    order by a.ord desc
  loop
    exit when v_remaining <= 0;
    v_available := v_alloc.quantity;
    v_skipped := least(v_skip, v_available);
    v_skip := v_skip - v_skipped;
    v_available := v_available - v_skipped;
    continue when v_available <= 0;

    v_take := least(v_available, v_remaining);
    v_remaining := v_remaining - v_take;
    v_total := v_total + v_take;

    update public.stock_batches
    set quantity = quantity + v_take
    where id = v_alloc.batch_id and shop_id = p_shop_id;
    if not found then
      raise exception 'Batch not found in this shop.' using errcode = 'P0002';
    end if;

    insert into public.stock_movements (
      id, shop_id, product_id, batch_id, sale_id, sale_item_id, reason, quantity_delta,
      resulting_total_quantity, idempotency_key, actor_id, occurred_at
    )
    values (
      gen_random_uuid(), p_shop_id, v_item.product_id, v_alloc.batch_id, v_item.sale_id, v_item.id,
      'return', v_take, v_total, 'void:' || v_key || ':' || v_alloc.batch_id, v_uid, v_occurred_at
    );
  end loop;

  update public.sale_items
  set voided_quantity = voided_quantity + p_quantity
  where id = v_item.id;

  insert into public.sale_item_voids (
    shop_id, sale_id, sale_item_id, quantity, idempotency_key, voided_by, occurred_at
  )
  values (p_shop_id, v_item.sale_id, v_item.id, p_quantity, v_key, v_uid, v_occurred_at);

  return private.void_result(v_item.id, false);
end;
$$;

revoke all on function public.void_sale_item(uuid, uuid, integer, timestamptz, text) from public, anon;
grant execute on function public.void_sale_item(uuid, uuid, integer, timestamptz, text) to authenticated;
