-- Per-product minimum stock and a shared dismissal so a low-stock alert does not chime on every phone.
-- Sellable quantity is still the batches that are not past their expiry date; this table does not
-- store a second stock figure. Null min_stock_units means the product is not watched.

alter table public.products
  add column min_stock_units integer check (min_stock_units >= 0);

comment on column public.products.min_stock_units is
  'Sellable base units at or below which the product is low. Null means no low-stock alert.';

create table public.low_stock_dismissals (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  product_id uuid not null,
  dismissed_at timestamptz not null default now(),
  dismissed_by uuid default auth.uid() references auth.users (id) on delete set null,
  -- Set once sellable stock rises above the minimum, so the next drop can alert again.
  cleared_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint low_stock_dismissals_product_fkey foreign key (shop_id, product_id)
    references public.products (shop_id, id) on delete cascade,
  constraint low_stock_dismissals_shop_product_key unique (shop_id, product_id)
);

comment on table public.low_stock_dismissals is
  'One row per product. An open row (cleared_at null) quiets the alert while stock stays at or below the minimum.';

create index low_stock_dismissals_shop_updated_idx on public.low_stock_dismissals (shop_id, updated_at);

create trigger low_stock_dismissals_set_updated_at before update on public.low_stock_dismissals
  for each row execute function public.set_updated_at();

alter table public.low_stock_dismissals enable row level security;
revoke all on table public.low_stock_dismissals from anon, authenticated;
grant select on table public.low_stock_dismissals to authenticated;

create policy "Members can view shop low stock dismissals"
  on public.low_stock_dismissals for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

-- Minimum stock: owners and managers only. A name or price edit does not pass through here. -----

create function public.set_product_min_stock(p_shop_id uuid, p_product_id uuid, p_min_stock integer)
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
  if p_min_stock is not null and p_min_stock < 0 then
    raise exception 'Minimum stock cannot be negative.' using errcode = '22023';
  end if;

  update public.products
  set min_stock_units = p_min_stock
  where id = p_product_id and shop_id = p_shop_id
  returning * into v_product;

  if not found then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;
  return v_product;
end;
$$;

-- Dismissal: anyone who can see inventory. Repeating it while it is still open changes nothing. --

create function public.dismiss_low_stock(p_shop_id uuid, p_product_id uuid)
returns public.low_stock_dismissals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.low_stock_dismissals;
begin
  perform private.assert_permission(p_shop_id, 'inventory.view');
  if p_product_id is null then
    raise exception 'Product id is required.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.products where id = p_product_id and shop_id = p_shop_id
  ) then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;

  insert into public.low_stock_dismissals (shop_id, product_id, dismissed_at, dismissed_by)
  values (p_shop_id, p_product_id, now(), (select auth.uid()))
  on conflict (shop_id, product_id) do update
    set dismissed_at = now(),
        dismissed_by = (select auth.uid()),
        cleared_at = null
    where public.low_stock_dismissals.cleared_at is not null
  returning * into v_row;

  if not found then
    select * into v_row
    from public.low_stock_dismissals
    where shop_id = p_shop_id and product_id = p_product_id;
  end if;
  return v_row;
end;
$$;

-- Called when sellable stock is back above the minimum. Missing or already cleared is a no-op. --

create function public.clear_low_stock_dismissal(p_shop_id uuid, p_product_id uuid)
returns public.low_stock_dismissals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.low_stock_dismissals;
begin
  perform private.assert_permission(p_shop_id, 'inventory.view');
  if p_product_id is null then
    raise exception 'Product id is required.' using errcode = '22023';
  end if;

  update public.low_stock_dismissals
  set cleared_at = now()
  where shop_id = p_shop_id and product_id = p_product_id and cleared_at is null
  returning * into v_row;

  if found then
    return v_row;
  end if;

  select * into v_row
  from public.low_stock_dismissals
  where shop_id = p_shop_id and product_id = p_product_id;
  if not found then
    return null;
  end if;
  return v_row;
end;
$$;

revoke all on function public.set_product_min_stock(uuid, uuid, integer) from public, anon;
revoke all on function public.dismiss_low_stock(uuid, uuid) from public, anon;
revoke all on function public.clear_low_stock_dismissal(uuid, uuid) from public, anon;
grant execute on function public.set_product_min_stock(uuid, uuid, integer) to authenticated;
grant execute on function public.dismiss_low_stock(uuid, uuid) to authenticated;
grant execute on function public.clear_low_stock_dismissal(uuid, uuid) to authenticated;
