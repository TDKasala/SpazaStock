-- SpazaStock core schema.
-- All row IDs are UUIDs generated on the device so offline-created rows keep the same ID once synced.
-- Every table carries updated_at so clients can pull changes incrementally.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Shops ----------------------------------------------------------------------

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index shops_owner_id_idx on public.shops (owner_id);

-- Products -------------------------------------------------------------------

create table public.products (
  id uuid primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  barcode text not null check (char_length(barcode) between 1 and 64),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  category text not null default 'other' check (
    category in (
      'groceries', 'beverages', 'snacks', 'bakery', 'dairy',
      'personal_care', 'household', 'airtime', 'other'
    )
  ),
  buying_price numeric(12, 2) check (buying_price >= 0),
  selling_price numeric(12, 2) check (selling_price >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_shop_barcode_key unique (shop_id, barcode),
  -- Target for composite foreign keys that pin child rows to the product's own shop.
  constraint products_shop_id_id_key unique (shop_id, id)
);

create index products_shop_updated_idx on public.products (shop_id, updated_at);

-- Stock batches (one row per delivery) ---------------------------------------

create table public.stock_batches (
  id uuid primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  product_id uuid not null,
  quantity integer not null check (quantity >= 0),
  initial_quantity integer not null check (initial_quantity > 0),
  expiry_date date,
  cost_price_per_unit numeric(12, 2) check (cost_price_per_unit >= 0),
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_batches_product_fkey foreign key (shop_id, product_id)
    references public.products (shop_id, id) on delete cascade
);

create index stock_batches_fefo_idx
  on public.stock_batches (shop_id, product_id, expiry_date, received_at)
  where quantity > 0;
create index stock_batches_shop_updated_idx on public.stock_batches (shop_id, updated_at);
create index stock_batches_product_id_idx on public.stock_batches (product_id);

-- Sales ----------------------------------------------------------------------

create table public.sales (
  id uuid primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  product_id uuid not null,
  quantity integer not null check (quantity > 0),
  unit_price numeric(12, 2) not null default 0 check (unit_price >= 0),
  total_amount numeric(12, 2) not null check (total_amount >= 0),
  allocations jsonb not null default '[]'::jsonb,
  idempotency_key text not null,
  sold_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_shop_idempotency_key unique (shop_id, idempotency_key),
  constraint sales_product_fkey foreign key (shop_id, product_id)
    references public.products (shop_id, id) on delete cascade
);

create index sales_shop_sold_at_idx on public.sales (shop_id, sold_at desc);
create index sales_shop_updated_idx on public.sales (shop_id, updated_at);
create index sales_product_id_idx on public.sales (product_id);

-- Stock movements (append-only audit trail) ----------------------------------

create table public.stock_movements (
  id uuid primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  product_id uuid not null,
  batch_id uuid references public.stock_batches (id) on delete set null,
  sale_id uuid references public.sales (id) on delete set null,
  type text not null check (type in ('stock_in', 'sale', 'adjustment')),
  quantity_delta integer not null,
  resulting_total_quantity integer not null,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_movements_product_fkey foreign key (shop_id, product_id)
    references public.products (shop_id, id) on delete cascade
);

create index stock_movements_shop_created_idx on public.stock_movements (shop_id, created_at desc);
create index stock_movements_product_id_idx on public.stock_movements (product_id);
create index stock_movements_batch_id_idx on public.stock_movements (batch_id);
create index stock_movements_sale_id_idx on public.stock_movements (sale_id);

-- Stock discrepancies --------------------------------------------------------
-- Raised when a sale synced from a device needed more units than the server had,
-- e.g. two offline devices sold the same last items. The sale is kept because the
-- goods physically left the shop; the shortfall flags the product for a recount.

create table public.stock_discrepancies (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  product_id uuid not null,
  sale_id uuid references public.sales (id) on delete set null,
  shortfall integer not null check (shortfall > 0),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_discrepancies_product_fkey foreign key (shop_id, product_id)
    references public.products (shop_id, id) on delete cascade
);

create index stock_discrepancies_shop_updated_idx on public.stock_discrepancies (shop_id, updated_at);
create index stock_discrepancies_product_id_idx on public.stock_discrepancies (product_id);
create index stock_discrepancies_sale_id_idx on public.stock_discrepancies (sale_id);

-- updated_at triggers --------------------------------------------------------

create trigger shops_set_updated_at before update on public.shops
  for each row execute function public.set_updated_at();
create trigger products_set_updated_at before update on public.products
  for each row execute function public.set_updated_at();
create trigger stock_batches_set_updated_at before update on public.stock_batches
  for each row execute function public.set_updated_at();
create trigger sales_set_updated_at before update on public.sales
  for each row execute function public.set_updated_at();
create trigger stock_movements_set_updated_at before update on public.stock_movements
  for each row execute function public.set_updated_at();
create trigger stock_discrepancies_set_updated_at before update on public.stock_discrepancies
  for each row execute function public.set_updated_at();
