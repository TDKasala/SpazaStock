-- Barcode aliases and packaging units.
--
-- A product keeps its own barcode (the single item). It can also have packagings (a pack of 6, a
-- case of 24) and extra barcodes, each pointing at the single item or at one packaging. Stock is
-- always counted in single items: receiving 2 cases of 24 adds 48.
--
-- Nothing existing is rewritten. Packagings never change once created; a new size is a new row
-- and the old one is retired, so deliveries keep the conversion they were received with (also
-- copied onto the batch). Barcode links are never deleted: unlinking keeps who, when and why.
--
-- A barcode means one thing per shop: no two products, and no product and alias, share it. Both
-- tables take the same advisory lock on (shop, barcode) before checking, so two phones syncing at
-- once cannot both claim it.
--
-- Error codes the client relies on:
--   22023 invalid_parameter_value -> permanent validation failure
--   23505 unique_violation        -> the barcode is already used in this shop
--   42501 insufficient_privilege  -> caller lacks the permission in this shop
--   P0002 no_data_found           -> product, packaging or barcode is not in this shop
--   SP001                         -> the shop is suspended (from assert_permission/assert_shop_role)

-- Brand and size ----------------------------------------------------------------------------------

alter table public.products
  add column brand text check (brand is null or char_length(btrim(brand)) between 1 and 80),
  add column size text check (size is null or char_length(btrim(size)) between 1 and 40);

comment on column public.products.brand is 'Optional brand, e.g. Coca-Cola. Used when searching.';
comment on column public.products.size is 'Optional size of the single item, e.g. 330ml.';

-- Packagings --------------------------------------------------------------------------------------

create table public.product_packagings (
  id uuid primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  product_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  units_per_package integer not null check (units_per_package between 2 and 10000),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retired_at timestamptz,
  constraint product_packagings_product_fkey foreign key (shop_id, product_id)
    references public.products (shop_id, id) on delete cascade,
  -- Target for foreign keys that pin a barcode or batch to a packaging of its own product.
  constraint product_packagings_shop_product_id_key unique (shop_id, product_id, id)
);

comment on table public.product_packagings is
  'Ways a product is bought, e.g. a case of 24. The conversion never changes; retire and add a new one.';

create index product_packagings_shop_updated_idx on public.product_packagings (shop_id, updated_at);
create index product_packagings_shop_product_idx on public.product_packagings (shop_id, product_id);
create index product_packagings_created_by_idx on public.product_packagings (created_by);

create trigger product_packagings_set_updated_at before update on public.product_packagings
  for each row execute function public.set_updated_at();

create function private.keep_packaging_conversion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.shop_id <> old.shop_id or new.product_id <> old.product_id
     or new.name <> old.name or new.units_per_package <> old.units_per_package then
    raise exception 'A packaging cannot be changed. Retire it and add a new one.' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.keep_packaging_conversion() from public, anon, authenticated;

create trigger product_packagings_keep_conversion before update on public.product_packagings
  for each row execute function private.keep_packaging_conversion();

-- Barcode aliases ---------------------------------------------------------------------------------

create table public.product_barcodes (
  id uuid primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  product_id uuid not null,
  -- Null: the barcode is on the single item.
  packaging_id uuid,
  barcode text not null check (char_length(barcode) between 1 and 64 and barcode !~ '\s'),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unlinked_at timestamptz,
  unlinked_by uuid references auth.users (id) on delete set null,
  unlink_reason text check (unlink_reason is null or char_length(btrim(unlink_reason)) between 1 and 200),
  constraint product_barcodes_product_fkey foreign key (shop_id, product_id)
    references public.products (shop_id, id) on delete cascade,
  constraint product_barcodes_packaging_fkey foreign key (shop_id, product_id, packaging_id)
    references public.product_packagings (shop_id, product_id, id),
  constraint product_barcodes_unlink_consistent check ((unlinked_at is null) = (unlink_reason is null))
);

comment on table public.product_barcodes is
  'Extra barcodes for a product (another single-item code, or a pack or case). Unlinked rows are kept as history.';

create unique index product_barcodes_active_key on public.product_barcodes (shop_id, barcode)
  where unlinked_at is null;
create index product_barcodes_shop_updated_idx on public.product_barcodes (shop_id, updated_at);
create index product_barcodes_packaging_idx on public.product_barcodes (shop_id, product_id, packaging_id);
create index product_barcodes_created_by_idx on public.product_barcodes (created_by);
create index product_barcodes_unlinked_by_idx on public.product_barcodes (unlinked_by);

create trigger product_barcodes_set_updated_at before update on public.product_barcodes
  for each row execute function public.set_updated_at();

-- Batches remember what was scanned ---------------------------------------------------------------

alter table public.stock_batches
  add column packaging_id uuid,
  add column package_quantity integer,
  add column units_per_package integer,
  add column received_barcode_id uuid references public.product_barcodes (id) on delete set null,
  add constraint stock_batches_packaging_fkey foreign key (shop_id, product_id, packaging_id)
    references public.product_packagings (shop_id, product_id, id),
  add constraint stock_batches_packaging_check check (
    (packaging_id is null and package_quantity is null and units_per_package is null)
    or (
      packaging_id is not null and package_quantity > 0 and units_per_package >= 2
      and initial_quantity = package_quantity * units_per_package
    )
  );

comment on column public.stock_batches.units_per_package is
  'Conversion used when the delivery was received, copied from the packaging.';

create index stock_batches_packaging_idx on public.stock_batches (shop_id, product_id, packaging_id);
create index stock_batches_received_barcode_idx on public.stock_batches (received_barcode_id);

-- One meaning per barcode per shop ----------------------------------------------------------------

create function private.lock_barcode(p_shop_id uuid, p_barcode text)
returns void
language sql
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended(p_shop_id::text || '|' || p_barcode, 0));
$$;

revoke all on function private.lock_barcode(uuid, text) from public, anon, authenticated;

create function private.product_barcode_free_of_aliases()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_barcode(new.shop_id, new.barcode);
  if exists (
    select 1 from public.product_barcodes
    where shop_id = new.shop_id and barcode = new.barcode and unlinked_at is null
  ) then
    raise exception 'Barcode % is already linked to a product in this shop.', new.barcode using errcode = '23505';
  end if;
  return new;
end;
$$;

revoke all on function private.product_barcode_free_of_aliases() from public, anon, authenticated;

create trigger products_barcode_free_of_aliases
  before insert or update of barcode on public.products
  for each row execute function private.product_barcode_free_of_aliases();

create function private.alias_barcode_free_of_products()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.unlinked_at is null then
    perform private.lock_barcode(new.shop_id, new.barcode);
    if exists (select 1 from public.products where shop_id = new.shop_id and barcode = new.barcode) then
      raise exception 'Barcode % is already a product barcode in this shop.', new.barcode using errcode = '23505';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.alias_barcode_free_of_products() from public, anon, authenticated;

create trigger product_barcodes_free_of_products
  before insert or update of barcode, unlinked_at on public.product_barcodes
  for each row execute function private.alias_barcode_free_of_products();

-- Access: members read; writes only through the functions below -----------------------------------

alter table public.product_packagings enable row level security;
alter table public.product_barcodes enable row level security;

revoke all on table public.product_packagings, public.product_barcodes from anon, authenticated;
grant select on table public.product_packagings, public.product_barcodes to authenticated;

create policy "Members can view shop packagings"
  on public.product_packagings for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

create policy "Members can view shop barcodes"
  on public.product_barcodes for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

-- Shared helpers ----------------------------------------------------------------------------------

create function private.clean_barcode(p_barcode text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(coalesce(p_barcode, ''), '\s', '', 'g');
$$;

revoke all on function private.clean_barcode(text) from public, anon, authenticated;

-- Optional text: null keeps (returns p_current), blank clears, anything else is trimmed.
create function private.optional_text(p_value text, p_current text, p_max integer, p_label text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_clean text := nullif(btrim(p_value), '');
begin
  if p_value is null then
    return p_current;
  end if;
  if v_clean is not null and char_length(v_clean) > p_max then
    raise exception '% is too long (up to % characters).', p_label, p_max using errcode = '22023';
  end if;
  return v_clean;
end;
$$;

revoke all on function private.optional_text(text, text, integer, text) from public, anon, authenticated;

-- upsert_product: + brand and size; an alias barcode resolves to its product -----------------------

drop function public.upsert_product(uuid, uuid, text, text, text, numeric, numeric, timestamptz);

create function public.upsert_product(
  p_id uuid,
  p_shop_id uuid,
  p_barcode text,
  p_name text,
  p_category text,
  p_buying_price numeric,
  p_selling_price numeric,
  p_created_at timestamptz,
  p_brand text default null,
  p_size text default null
)
returns public.products
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products;
  v_alias public.product_barcodes;
  v_barcode text := private.clean_barcode(p_barcode);
  v_brand text;
  v_size text;
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
  v_brand := private.optional_text(p_brand, null, 80, 'Brand');
  v_size := private.optional_text(p_size, null, 40, 'Size');

  select * into v_product from public.products where id = p_id and shop_id = p_shop_id;
  if found then
    return v_product;
  end if;

  perform private.lock_barcode(p_shop_id, v_barcode);
  select * into v_alias
  from public.product_barcodes
  where shop_id = p_shop_id and barcode = v_barcode and unlinked_at is null;
  if found then
    -- Another phone linked this barcode first. A single-item barcode is the same product, so the
    -- phone remaps to it; a pack or case barcode is not one unit and cannot be a product barcode.
    if v_alias.packaging_id is not null then
      raise exception 'Barcode % is linked to a pack of another product in this shop.', v_barcode
        using errcode = '23505';
    end if;
    select * into v_product from public.products where id = v_alias.product_id;
    return v_product;
  end if;

  insert into public.products (
    id, shop_id, barcode, name, category, buying_price, selling_price, created_at, brand, size
  )
  values (
    p_id, p_shop_id, v_barcode, btrim(p_name), coalesce(p_category, 'other'),
    p_buying_price, p_selling_price, coalesce(p_created_at, now()), v_brand, v_size
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

-- update_product: + brand and size (null keeps, blank clears) -------------------------------------

drop function public.update_product(uuid, uuid, text, text, text, numeric, numeric);

create function public.update_product(
  p_shop_id uuid,
  p_product_id uuid,
  p_barcode text,
  p_name text,
  p_category text,
  p_buying_price numeric,
  p_selling_price numeric,
  p_brand text default null,
  p_size text default null
)
returns public.products
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products;
  v_current public.products;
  v_barcode text := private.clean_barcode(p_barcode);
  v_name text := btrim(coalesce(p_name, ''));
begin
  perform private.assert_permission(p_shop_id, 'products.edit');
  if p_product_id is null then
    raise exception 'Product id is required.' using errcode = '22023';
  end if;
  if v_barcode = '' or char_length(v_barcode) > 64 then
    raise exception 'Barcode is required (up to 64 characters).' using errcode = '22023';
  end if;
  if v_name = '' or char_length(v_name) > 200 then
    raise exception 'Product name is required (up to 200 characters).' using errcode = '22023';
  end if;
  if p_category is null or p_category not in (
    'groceries', 'beverages', 'snacks', 'bakery', 'dairy', 'personal_care', 'household', 'airtime', 'other'
  ) then
    raise exception 'Unknown product category.' using errcode = '22023';
  end if;
  if p_buying_price < 0 or p_selling_price < 0 then
    raise exception 'Prices cannot be negative.' using errcode = '22023';
  end if;

  select * into v_current from public.products where id = p_product_id and shop_id = p_shop_id for update;
  if not found then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;

  perform private.lock_barcode(p_shop_id, v_barcode);
  if exists (
    select 1 from public.products
    where shop_id = p_shop_id and barcode = v_barcode and id <> p_product_id
  ) or exists (
    select 1 from public.product_barcodes
    where shop_id = p_shop_id and barcode = v_barcode and unlinked_at is null
  ) then
    raise exception 'Another product in this shop already uses barcode %.', v_barcode using errcode = '23505';
  end if;

  update public.products
  set barcode = v_barcode,
      name = v_name,
      category = p_category,
      buying_price = p_buying_price,
      selling_price = p_selling_price,
      brand = private.optional_text(p_brand, v_current.brand, 80, 'Brand'),
      size = private.optional_text(p_size, v_current.size, 40, 'Size')
  where id = p_product_id and shop_id = p_shop_id
  returning * into v_product;

  return v_product;
exception
  when unique_violation then
    raise exception 'Another product in this shop already uses barcode %.', v_barcode using errcode = '23505';
end;
$$;

-- record_stock_in: + packaging and the scanned barcode --------------------------------------------

drop function public.record_stock_in(uuid, uuid, uuid, integer, date, numeric, timestamptz, text);

create function public.record_stock_in(
  p_batch_id uuid,
  p_shop_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_expiry_date date,
  p_cost_price_per_unit numeric,
  p_received_at timestamptz,
  p_idempotency_key text,
  p_packaging_id uuid default null,
  p_package_quantity integer default null,
  p_barcode_id uuid default null
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
  v_units integer;
  v_barcode_id uuid;
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
  if (p_packaging_id is null) <> (p_package_quantity is null) then
    raise exception 'A packaging needs a number of packages, and the other way round.' using errcode = '22023';
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

  -- A retired packaging is still accepted: the delivery may have been scanned before it was retired.
  if p_packaging_id is not null then
    select units_per_package into v_units
    from public.product_packagings
    where id = p_packaging_id and shop_id = p_shop_id and product_id = p_product_id;
    if not found then
      raise exception 'Packaging not found for this product.' using errcode = 'P0002';
    end if;
    if p_package_quantity <= 0 or p_package_quantity::bigint * v_units <> p_quantity then
      raise exception 'Quantity must be % packages × % units.', p_package_quantity, v_units using errcode = '22023';
    end if;
  end if;

  -- The scanned barcode is a note, not a requirement: a link refused on sync must not lose the delivery.
  select id into v_barcode_id
  from public.product_barcodes
  where id = p_barcode_id and shop_id = p_shop_id and product_id = p_product_id;

  insert into public.stock_batches (
    id, shop_id, product_id, quantity, initial_quantity, expiry_date, cost_price_per_unit,
    received_at, received_by, packaging_id, package_quantity, units_per_package, received_barcode_id
  )
  values (
    p_batch_id, p_shop_id, p_product_id, p_quantity, p_quantity, p_expiry_date,
    p_cost_price_per_unit, coalesce(p_received_at, now()), (select auth.uid()),
    p_packaging_id, p_package_quantity, v_units, v_barcode_id
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

-- Packagings --------------------------------------------------------------------------------------

create function public.create_product_packaging(
  p_id uuid,
  p_shop_id uuid,
  p_product_id uuid,
  p_name text,
  p_units_per_package integer,
  p_created_at timestamptz default null
)
returns public.product_packagings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_packaging public.product_packagings;
begin
  perform private.assert_permission(p_shop_id, 'products.edit');
  if p_id is null then
    raise exception 'Packaging id is required.' using errcode = '22023';
  end if;
  if v_name = '' or char_length(v_name) > 40 then
    raise exception 'Packaging name is required (up to 40 characters).' using errcode = '22023';
  end if;
  if p_units_per_package is null or p_units_per_package < 2 or p_units_per_package > 10000 then
    raise exception 'A packaging holds 2 to 10,000 units.' using errcode = '22023';
  end if;

  perform 1 from public.products where id = p_product_id and shop_id = p_shop_id for update;
  if not found then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;

  select * into v_packaging from public.product_packagings where id = p_id;
  if found then
    if v_packaging.shop_id = p_shop_id and v_packaging.product_id = p_product_id
       and v_packaging.name = v_name and v_packaging.units_per_package = p_units_per_package then
      return v_packaging;
    end if;
    raise exception 'This packaging id is already used elsewhere.' using errcode = '23505';
  end if;

  insert into public.product_packagings (id, shop_id, product_id, name, units_per_package, created_at)
  values (p_id, p_shop_id, p_product_id, v_name, p_units_per_package, coalesce(p_created_at, now()))
  returning * into v_packaging;

  return v_packaging;
end;
$$;

-- Retiring hides a packaging from new deliveries and unlinks its barcodes; history keeps it.
create function public.retire_product_packaging(p_shop_id uuid, p_packaging_id uuid)
returns public.product_packagings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_packaging public.product_packagings;
begin
  perform private.assert_permission(p_shop_id, 'products.edit');

  select * into v_packaging
  from public.product_packagings
  where id = p_packaging_id and shop_id = p_shop_id;
  if not found then
    raise exception 'Packaging not found in this shop.' using errcode = 'P0002';
  end if;
  perform 1 from public.products where id = v_packaging.product_id for update;

  if v_packaging.retired_at is not null then
    return v_packaging;
  end if;

  update public.product_barcodes
  set unlinked_at = now(), unlinked_by = (select auth.uid()), unlink_reason = 'Packaging retired'
  where packaging_id = p_packaging_id and shop_id = p_shop_id and unlinked_at is null;

  update public.product_packagings set retired_at = now()
  where id = p_packaging_id
  returning * into v_packaging;

  return v_packaging;
end;
$$;

-- Linking and unlinking barcodes ------------------------------------------------------------------

create function public.link_product_barcode(
  p_id uuid,
  p_shop_id uuid,
  p_product_id uuid,
  p_packaging_id uuid,
  p_barcode text,
  p_created_at timestamptz default null
)
returns public.product_barcodes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_barcode text := private.clean_barcode(p_barcode);
  v_link public.product_barcodes;
  v_owner_name text;
begin
  perform private.assert_permission(p_shop_id, 'products.edit');
  if p_id is null then
    raise exception 'Barcode link id is required.' using errcode = '22023';
  end if;
  if v_barcode = '' or char_length(v_barcode) > 64 then
    raise exception 'Barcode is required (up to 64 characters).' using errcode = '22023';
  end if;

  perform 1 from public.products where id = p_product_id and shop_id = p_shop_id for update;
  if not found then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;

  select * into v_link from public.product_barcodes where id = p_id;
  if found then
    if v_link.shop_id = p_shop_id and v_link.product_id = p_product_id and v_link.barcode = v_barcode
       and v_link.packaging_id is not distinct from p_packaging_id then
      return v_link;
    end if;
    raise exception 'This barcode link id is already used elsewhere.' using errcode = '23505';
  end if;

  if p_packaging_id is not null then
    perform 1 from public.product_packagings
    where id = p_packaging_id and shop_id = p_shop_id and product_id = p_product_id;
    if not found then
      raise exception 'Packaging not found for this product.' using errcode = 'P0002';
    end if;
    if exists (select 1 from public.product_packagings where id = p_packaging_id and retired_at is not null) then
      raise exception 'This packaging has been retired. Choose another one.' using errcode = '22023';
    end if;
  end if;

  perform private.lock_barcode(p_shop_id, v_barcode);

  select name into v_owner_name from public.products where shop_id = p_shop_id and barcode = v_barcode;
  if found then
    raise exception 'Barcode % is already used by %.', v_barcode, v_owner_name using errcode = '23505';
  end if;

  select * into v_link
  from public.product_barcodes
  where shop_id = p_shop_id and barcode = v_barcode and unlinked_at is null;
  if found then
    -- The same link made on another phone: keep the first one.
    if v_link.product_id = p_product_id and v_link.packaging_id is not distinct from p_packaging_id then
      return v_link;
    end if;
    select name into v_owner_name from public.products where id = v_link.product_id;
    raise exception 'Barcode % is already used by %.', v_barcode, v_owner_name using errcode = '23505';
  end if;

  insert into public.product_barcodes (id, shop_id, product_id, packaging_id, barcode, created_at)
  values (p_id, p_shop_id, p_product_id, p_packaging_id, v_barcode, coalesce(p_created_at, now()))
  returning * into v_link;

  return v_link;
end;
$$;

-- Correcting a mistaken link. The link is kept as history. With p_reverse_unsold, deliveries
-- received through this barcode that are still completely unsold are taken back out of stock;
-- deliveries that have been partly sold are left alone and listed in "kept".
create function public.unlink_product_barcode(
  p_shop_id uuid,
  p_barcode_id uuid,
  p_reason text,
  p_reverse_unsold boolean default false,
  p_occurred_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_uid uuid := (select auth.uid());
  v_link public.product_barcodes;
  v_batch public.stock_batches;
  v_total integer;
  v_reversed jsonb := '[]'::jsonb;
  v_kept jsonb := '[]'::jsonb;
begin
  perform private.assert_permission(p_shop_id, 'products.edit');
  if coalesce(p_reverse_unsold, false) and not private.has_permission(p_shop_id, 'stock.adjust') then
    raise exception 'You cannot take stock back out in this shop.' using errcode = '42501';
  end if;
  if v_reason = '' or char_length(v_reason) > 200 then
    raise exception 'A reason is required (up to 200 characters).' using errcode = '22023';
  end if;

  select * into v_link from public.product_barcodes where id = p_barcode_id and shop_id = p_shop_id;
  if not found then
    raise exception 'Barcode link not found in this shop.' using errcode = 'P0002';
  end if;
  perform 1 from public.products where id = v_link.product_id for update;
  select * into v_link from public.product_barcodes where id = p_barcode_id for update;

  if v_link.unlinked_at is not null then
    return jsonb_build_object('barcode', to_jsonb(v_link), 'duplicate', true, 'reversed', v_reversed, 'kept', v_kept);
  end if;

  update public.product_barcodes
  set unlinked_at = now(), unlinked_by = v_uid, unlink_reason = v_reason
  where id = p_barcode_id
  returning * into v_link;

  for v_batch in
    select * from public.stock_batches
    where shop_id = p_shop_id and received_barcode_id = p_barcode_id and quantity > 0
    order by received_at, id
    for update
  loop
    if coalesce(p_reverse_unsold, false) and v_batch.quantity = v_batch.initial_quantity then
      update public.stock_batches set quantity = 0 where id = v_batch.id;
      v_total := private.product_stock(p_shop_id, v_batch.product_id);
      insert into public.stock_movements (
        id, shop_id, product_id, batch_id, reason, quantity_delta, resulting_total_quantity,
        idempotency_key, actor_id, occurred_at
      )
      values (
        gen_random_uuid(), p_shop_id, v_batch.product_id, v_batch.id, 'count_correction', -v_batch.quantity,
        v_total, 'unlink:' || p_barcode_id || ':' || v_batch.id, v_uid, coalesce(p_occurred_at, now())
      );
      v_reversed := v_reversed || jsonb_build_array(jsonb_build_object('batch_id', v_batch.id, 'quantity', v_batch.quantity));
    else
      v_kept := v_kept || jsonb_build_array(jsonb_build_object(
        'batch_id', v_batch.id, 'quantity', v_batch.quantity, 'initial_quantity', v_batch.initial_quantity
      ));
    end if;
  end loop;

  return jsonb_build_object(
    'barcode', to_jsonb(v_link), 'duplicate', false, 'reversed', v_reversed, 'kept', v_kept,
    'total_quantity', private.product_stock(p_shop_id, v_link.product_id)
  );
end;
$$;

-- Only signed-in users may call these ------------------------------------------------------------

revoke all on function public.upsert_product(uuid, uuid, text, text, text, numeric, numeric, timestamptz, text, text)
  from public, anon;
revoke all on function public.update_product(uuid, uuid, text, text, text, numeric, numeric, text, text)
  from public, anon;
revoke all on function public.record_stock_in(uuid, uuid, uuid, integer, date, numeric, timestamptz, text, uuid, integer, uuid)
  from public, anon;
revoke all on function public.create_product_packaging(uuid, uuid, uuid, text, integer, timestamptz) from public, anon;
revoke all on function public.retire_product_packaging(uuid, uuid) from public, anon;
revoke all on function public.link_product_barcode(uuid, uuid, uuid, uuid, text, timestamptz) from public, anon;
revoke all on function public.unlink_product_barcode(uuid, uuid, text, boolean, timestamptz) from public, anon;

grant execute on function public.upsert_product(uuid, uuid, text, text, text, numeric, numeric, timestamptz, text, text)
  to authenticated;
grant execute on function public.update_product(uuid, uuid, text, text, text, numeric, numeric, text, text)
  to authenticated;
grant execute on function public.record_stock_in(uuid, uuid, uuid, integer, date, numeric, timestamptz, text, uuid, integer, uuid)
  to authenticated;
grant execute on function public.create_product_packaging(uuid, uuid, uuid, text, integer, timestamptz) to authenticated;
grant execute on function public.retire_product_packaging(uuid, uuid) to authenticated;
grant execute on function public.link_product_barcode(uuid, uuid, uuid, uuid, text, timestamptz) to authenticated;
grant execute on function public.unlink_product_barcode(uuid, uuid, text, boolean, timestamptz) to authenticated;
