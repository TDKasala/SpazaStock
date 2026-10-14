-- Ledger: multi-item sales, an audited stock movement trail, notifications and subscriptions.
-- Existing rows are carried over, so this is safe on a database that already holds data.

-- Stock movements: reason, actor, device time, one row per idempotency key ----------

alter table public.stock_movements
  add column reason text,
  add column actor_id uuid default auth.uid() references auth.users (id) on delete set null,
  add column occurred_at timestamptz,
  add column sale_item_id uuid;

update public.stock_movements
set reason = type,
    occurred_at = created_at,
    idempotency_key = type || ':' || coalesce(idempotency_key, id::text);

-- Older rows could share a client key; keep the first and make the rest unique.
update public.stock_movements m
set idempotency_key = m.idempotency_key || ':' || m.id::text
where exists (
  select 1 from public.stock_movements o
  where o.shop_id = m.shop_id
    and o.idempotency_key = m.idempotency_key
    and (o.created_at, o.id) < (m.created_at, m.id)
);

alter table public.stock_movements drop column type;

alter table public.stock_movements
  alter column reason set not null,
  alter column occurred_at set not null,
  alter column occurred_at set default now(),
  alter column idempotency_key set not null,
  add constraint stock_movements_reason_check check (
    reason in (
      'stock_in', 'sale', 'adjustment', 'write_off_expired', 'write_off_damaged',
      'count_correction', 'return'
    )
  ),
  add constraint stock_movements_quantity_delta_check check (quantity_delta <> 0),
  add constraint stock_movements_idempotency_key_check check (char_length(idempotency_key) between 1 and 400),
  add constraint stock_movements_shop_idempotency_key unique (shop_id, idempotency_key);

comment on column public.stock_movements.created_at is 'Server time the movement was recorded.';
comment on column public.stock_movements.occurred_at is 'Device time the change happened (may be earlier when synced offline).';

-- Stock batches -----------------------------------------------------------------

alter table public.stock_batches
  add column received_by uuid default auth.uid() references auth.users (id) on delete set null;

comment on column public.stock_batches.cost_price_per_unit is 'Purchase cost per unit for this delivery.';

-- Sales become a header; lines move to sale_items ------------------------------------

alter table public.sales
  add constraint sales_shop_id_id_key unique (shop_id, id),
  add column item_count integer,
  add column sold_by uuid default auth.uid() references auth.users (id) on delete set null;

create table public.sale_items (
  id uuid primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  sale_id uuid not null,
  product_id uuid not null,
  quantity integer not null check (quantity > 0),
  unit_price numeric(12, 2) not null default 0 check (unit_price >= 0),
  line_total numeric(12, 2) not null check (line_total >= 0),
  allocations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sale_items_sale_fkey foreign key (shop_id, sale_id)
    references public.sales (shop_id, id) on delete cascade,
  constraint sale_items_product_fkey foreign key (shop_id, product_id)
    references public.products (shop_id, id) on delete cascade
);

-- Existing single-product sales become one line each, reusing the sale id as the line id.
insert into public.sale_items (
  id, shop_id, sale_id, product_id, quantity, unit_price, line_total, allocations, created_at, updated_at
)
select id, shop_id, id, product_id, quantity, unit_price, total_amount, allocations, created_at, updated_at
from public.sales;

update public.sales set item_count = 1;

alter table public.sales
  alter column item_count set not null,
  add constraint sales_item_count_check check (item_count > 0),
  drop column product_id,
  drop column quantity,
  drop column unit_price,
  drop column allocations;

update public.stock_movements set sale_item_id = sale_id where sale_id is not null;

alter table public.stock_movements
  add constraint stock_movements_sale_item_fkey foreign key (sale_item_id)
    references public.sale_items (id) on delete set null;

alter table public.stock_discrepancies
  add column sale_item_id uuid references public.sale_items (id) on delete set null;

update public.stock_discrepancies set sale_item_id = sale_id where sale_id is not null;

create trigger sale_items_set_updated_at before update on public.sale_items
  for each row execute function public.set_updated_at();

alter table public.sale_items enable row level security;
revoke all on table public.sale_items from anon;

-- Notifications (one row per recipient) ----------------------------------------------

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('low_stock', 'expiry', 'stock_discrepancy', 'member', 'system')),
  title text not null check (char_length(title) between 1 and 200),
  body text check (body is null or char_length(body) <= 2000),
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger notifications_set_updated_at before update on public.notifications
  for each row execute function public.set_updated_at();

alter table public.notifications enable row level security;
revoke all on table public.notifications from anon;

-- Subscriptions (written only by the server, e.g. a payment webhook) --------------------

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null unique references public.shops (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  status text not null default 'active' check (status in ('trialing', 'active', 'past_due', 'canceled')),
  current_period_end timestamptz,
  provider text check (provider is null or char_length(provider) between 1 and 40),
  provider_customer_id text check (provider_customer_id is null or char_length(provider_customer_id) <= 200),
  provider_subscription_id text check (
    provider_subscription_id is null or char_length(provider_subscription_id) <= 200
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index subscriptions_provider_subscription_key
  on public.subscriptions (provider, provider_subscription_id)
  where provider_subscription_id is not null;

create trigger subscriptions_set_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

alter table public.subscriptions enable row level security;
revoke all on table public.subscriptions from anon;

create function private.handle_new_shop_subscription()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.subscriptions (shop_id) values (new.id) on conflict (shop_id) do nothing;
  return new;
end;
$$;

revoke all on function private.handle_new_shop_subscription() from public, anon, authenticated;

create trigger shops_create_subscription
  after insert on public.shops
  for each row execute function private.handle_new_shop_subscription();

insert into public.subscriptions (shop_id) select id from public.shops on conflict (shop_id) do nothing;

-- Indexes: cover every foreign key and the incremental pull queries ---------------------

drop index if exists public.stock_movements_product_id_idx;
drop index if exists public.stock_discrepancies_product_id_idx;

create index stock_movements_shop_product_idx on public.stock_movements (shop_id, product_id);
create index stock_movements_shop_updated_idx on public.stock_movements (shop_id, updated_at);
create index stock_movements_actor_id_idx on public.stock_movements (actor_id);
create index stock_movements_sale_item_id_idx on public.stock_movements (sale_item_id);

create index stock_batches_received_by_idx on public.stock_batches (received_by);

create index sales_sold_by_idx on public.sales (sold_by);

create index sale_items_shop_sale_idx on public.sale_items (shop_id, sale_id);
create index sale_items_shop_product_idx on public.sale_items (shop_id, product_id);
create index sale_items_shop_updated_idx on public.sale_items (shop_id, updated_at);

create index stock_discrepancies_shop_product_idx on public.stock_discrepancies (shop_id, product_id);
create index stock_discrepancies_sale_item_id_idx on public.stock_discrepancies (sale_item_id);

create index notifications_user_read_idx on public.notifications (user_id, read_at);
create index notifications_shop_updated_idx on public.notifications (shop_id, updated_at);
