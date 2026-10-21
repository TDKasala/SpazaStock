-- Target stock sits beside the existing minimum. Wholesalers and wholesale orders are shop lists.
-- Saving or moving an order never changes stock batches, quantities, or expiry dates.

alter table public.products
  add column target_stock_units integer check (target_stock_units >= 0);

comment on column public.products.target_stock_units is
  'Sellable units to hold after a wholesale order. Null means no target. When both are set, the target is at least the minimum.';

create function public.set_product_target_stock(p_shop_id uuid, p_product_id uuid, p_target integer)
returns public.products
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products;
begin
  perform private.assert_permission(p_shop_id, 'products.edit');
  if p_product_id is null then
    raise exception 'Product id is required.' using errcode = '22023';
  end if;
  if p_target is not null and p_target < 0 then
    raise exception 'Target stock cannot be negative.' using errcode = '22023';
  end if;

  update public.products
  set target_stock_units = p_target
  where id = p_product_id and shop_id = p_shop_id
  returning * into v_product;

  if not found then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;
  if v_product.min_stock_units is not null
     and v_product.target_stock_units is not null
     and v_product.target_stock_units < v_product.min_stock_units then
    raise exception 'Target stock must be at least the minimum.' using errcode = '22023';
  end if;
  return v_product;
end;
$$;

revoke all on function public.set_product_target_stock(uuid, uuid, integer) from public, anon;
grant execute on function public.set_product_target_stock(uuid, uuid, integer) to authenticated;

insert into private.role_permissions (role, permission) values
  ('owner', 'orders.manage'),
  ('manager', 'orders.manage');

create table public.wholesalers (
  id uuid primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  name text not null,
  phone text,
  note text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wholesalers_name_len check (char_length(btrim(name)) between 1 and 80),
  constraint wholesalers_phone_len check (phone is null or char_length(phone) between 1 and 40),
  constraint wholesalers_note_len check (note is null or char_length(note) <= 280)
);

create unique index wholesalers_shop_id_key on public.wholesalers (shop_id, id);
create unique index wholesalers_active_name_idx
  on public.wholesalers (shop_id, lower(name))
  where archived_at is null;
create index wholesalers_shop_updated_idx on public.wholesalers (shop_id, updated_at);

create trigger wholesalers_set_updated_at before update on public.wholesalers
  for each row execute function public.set_updated_at();

alter table public.wholesalers enable row level security;
revoke all on table public.wholesalers from public, anon, authenticated;
grant select on table public.wholesalers to authenticated;

create policy "Members can view shop wholesalers"
  on public.wholesalers for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

create table public.wholesale_orders (
  id uuid primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  wholesaler_id uuid,
  status text not null default 'draft' check (status in (
    'draft', 'approved', 'ordered', 'partially_received', 'received', 'cancelled'
  )),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wholesale_orders_wholesaler_fkey foreign key (shop_id, wholesaler_id)
    references public.wholesalers (shop_id, id),
  constraint wholesale_orders_note_len check (note is null or char_length(note) <= 280)
);

create unique index wholesale_orders_shop_id_key on public.wholesale_orders (shop_id, id);
create index wholesale_orders_shop_updated_idx on public.wholesale_orders (shop_id, updated_at);

create trigger wholesale_orders_set_updated_at before update on public.wholesale_orders
  for each row execute function public.set_updated_at();

alter table public.wholesale_orders enable row level security;
revoke all on table public.wholesale_orders from public, anon, authenticated;
grant select on table public.wholesale_orders to authenticated;

create policy "Members can view shop wholesale orders"
  on public.wholesale_orders for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

create table public.wholesale_order_items (
  id uuid primary key,
  shop_id uuid not null,
  order_id uuid not null,
  product_id uuid not null,
  quantity integer not null check (quantity >= 1 and quantity <= 1000000),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wholesale_order_items_order_fkey foreign key (shop_id, order_id)
    references public.wholesale_orders (shop_id, id) on delete cascade,
  constraint wholesale_order_items_product_fkey foreign key (shop_id, product_id)
    references public.products (shop_id, id)
);

create unique index wholesale_order_items_active_product_idx
  on public.wholesale_order_items (order_id, product_id)
  where removed_at is null;
create index wholesale_order_items_shop_updated_idx on public.wholesale_order_items (shop_id, updated_at);

create trigger wholesale_order_items_set_updated_at before update on public.wholesale_order_items
  for each row execute function public.set_updated_at();

alter table public.wholesale_order_items enable row level security;
revoke all on table public.wholesale_order_items from public, anon, authenticated;
grant select on table public.wholesale_order_items to authenticated;

create policy "Members can view shop wholesale order items"
  on public.wholesale_order_items for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

create function public.upsert_wholesaler(
  p_id uuid,
  p_shop_id uuid,
  p_name text,
  p_phone text default null,
  p_note text default null
)
returns public.wholesalers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_row public.wholesalers;
begin
  perform private.assert_permission(p_shop_id, 'orders.manage');
  if p_id is null then
    raise exception 'Wholesaler id is required.' using errcode = '22023';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'Enter a wholesaler name.' using errcode = '22023';
  end if;
  if v_phone is not null and char_length(v_phone) > 40 then
    raise exception 'Phone is too long.' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 280 then
    raise exception 'Note is too long.' using errcode = '22023';
  end if;

  select * into v_row from public.wholesalers where id = p_id;
  if found and v_row.shop_id <> p_shop_id then
    raise exception 'This wholesaler belongs to another shop.' using errcode = '22023';
  end if;
  if found and v_row.archived_at is not null then
    raise exception 'This wholesaler is archived.' using errcode = '22023';
  end if;

  if not found then
    insert into public.wholesalers (id, shop_id, name, phone, note)
    values (p_id, p_shop_id, v_name, v_phone, v_note)
    returning * into v_row;
  else
    update public.wholesalers
    set name = v_name, phone = v_phone, note = v_note
    where id = p_id and shop_id = p_shop_id
    returning * into v_row;
  end if;
  return v_row;
exception
  when unique_violation then
    raise exception 'A wholesaler with this name is already in the shop.' using errcode = '22023';
end;
$$;

create function public.archive_wholesaler(p_shop_id uuid, p_id uuid)
returns public.wholesalers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.wholesalers;
begin
  perform private.assert_permission(p_shop_id, 'orders.manage');
  update public.wholesalers
  set archived_at = coalesce(archived_at, now())
  where id = p_id and shop_id = p_shop_id
  returning * into v_row;
  if not found then
    raise exception 'Wholesaler not found in this shop.' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

create function public.save_wholesale_order(
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
    update public.wholesale_order_items
    set product_id = v_product_id, quantity = v_qty, removed_at = null
    where id = v_item_id and shop_id = p_shop_id and order_id = p_order_id;
    if not found then
      insert into public.wholesale_order_items (id, shop_id, order_id, product_id, quantity)
      values (v_item_id, p_shop_id, p_order_id, v_product_id, v_qty);
    end if;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at), '[]'::jsonb) into v_items
  from public.wholesale_order_items i
  where i.shop_id = p_shop_id and i.order_id = p_order_id and i.removed_at is null;

  return jsonb_build_object('order', to_jsonb(v_order), 'items', v_items);
end;
$$;

create function public.set_wholesale_order_status(p_shop_id uuid, p_order_id uuid, p_status text)
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
    when 'ordered' then p_status in ('partially_received', 'received', 'cancelled')
    when 'partially_received' then p_status in ('received', 'cancelled')
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

revoke all on function public.upsert_wholesaler(uuid, uuid, text, text, text) from public, anon;
revoke all on function public.archive_wholesaler(uuid, uuid) from public, anon;
revoke all on function public.save_wholesale_order(uuid, uuid, uuid, text, jsonb) from public, anon;
revoke all on function public.set_wholesale_order_status(uuid, uuid, text) from public, anon;
grant execute on function public.upsert_wholesaler(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.archive_wholesaler(uuid, uuid) to authenticated;
grant execute on function public.save_wholesale_order(uuid, uuid, uuid, text, jsonb) to authenticated;
grant execute on function public.set_wholesale_order_status(uuid, uuid, text) to authenticated;
