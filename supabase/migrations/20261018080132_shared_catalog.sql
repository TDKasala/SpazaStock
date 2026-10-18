-- Shared product catalog.
--
-- Shop products stay shop-specific (prices, stock, batches, expiry). This catalog is only the
-- shared identity of a barcode: name, brand, size and where that information came from.
-- A barcode belongs to one catalog product. Two shops can link their own products to it and
-- still keep different prices and quantities.
--
-- Trust: external < user_submitted < verified. A later external value never replaces a
-- user-submitted or verified field. A verified row is not edited by a shop; a differing save
-- is stored as a correction until a platform admin applies it.
--
-- The Open Food Facts cache (product_lookup_cache) is unchanged and still service-role only.
-- Looking up a barcode does not insert a catalog row. A person saves one.

-- Platform audit can name a catalog target -------------------------------------------------------

alter table public.platform_audit_log drop constraint platform_audit_log_target_type_check;
alter table public.platform_audit_log add constraint platform_audit_log_target_type_check
  check (target_type is null or target_type in (
    'shop', 'user', 'admin', 'plan', 'feature', 'subscription', 'platform', 'catalog'
  ));

insert into private.platform_role_permissions (role, permission) values
  ('superadmin', 'catalog.verify');

-- Catalog -----------------------------------------------------------------------------------------

create table public.catalog_products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  brand text check (brand is null or char_length(btrim(brand)) between 1 and 80),
  category text not null check (
    category in (
      'groceries', 'beverages', 'snacks', 'bakery', 'dairy',
      'personal_care', 'household', 'airtime', 'other'
    )
  ),
  package_size text check (package_size is null or char_length(btrim(package_size)) between 1 and 40),
  package_quantity numeric check (package_quantity is null or package_quantity > 0),
  package_unit text check (package_unit is null or char_length(btrim(package_unit)) between 1 and 16),
  image_url text check (
    image_url is null or (char_length(image_url) between 1 and 500 and image_url ~ '^https://')
  ),
  ingredients text check (ingredients is null or char_length(btrim(ingredients)) between 1 and 4000),
  source text not null check (source in ('open_food_facts', 'user')),
  verification_status text not null check (verification_status in ('external', 'user_submitted', 'verified')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.catalog_products is
  'Shared product identity. Shop prices, stock and expiry are not stored here.';

create index catalog_products_updated_idx on public.catalog_products (updated_at);

create trigger catalog_products_set_updated_at before update on public.catalog_products
  for each row execute function public.set_updated_at();

create table public.catalog_barcodes (
  barcode text primary key check (char_length(barcode) between 1 and 64 and barcode !~ '\s'),
  catalog_product_id uuid not null references public.catalog_products (id) on delete cascade,
  kind text not null check (kind in ('unit', 'alternate', 'pack')),
  units_per_package integer,
  source text not null check (source in ('open_food_facts', 'user')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_barcodes_units_check check (
    (kind = 'pack' and units_per_package between 2 and 10000)
    or (kind in ('unit', 'alternate') and units_per_package is null)
  )
);

comment on table public.catalog_barcodes is
  'One barcode, one catalog product. A pack code points at the single item; it is not a second product.';

create index catalog_barcodes_product_idx on public.catalog_barcodes (catalog_product_id);

create trigger catalog_barcodes_set_updated_at before update on public.catalog_barcodes
  for each row execute function public.set_updated_at();

create table public.catalog_corrections (
  id uuid primary key default gen_random_uuid(),
  catalog_product_id uuid not null references public.catalog_products (id) on delete cascade,
  shop_id uuid references public.shops (id) on delete set null,
  proposed_name text check (proposed_name is null or char_length(btrim(proposed_name)) between 1 and 200),
  proposed_brand text check (proposed_brand is null or char_length(btrim(proposed_brand)) between 1 and 80),
  proposed_category text check (
    proposed_category is null or proposed_category in (
      'groceries', 'beverages', 'snacks', 'bakery', 'dairy',
      'personal_care', 'household', 'airtime', 'other'
    )
  ),
  proposed_package_size text check (
    proposed_package_size is null or char_length(btrim(proposed_package_size)) between 1 and 40
  ),
  proposed_package_quantity numeric check (proposed_package_quantity is null or proposed_package_quantity > 0),
  proposed_package_unit text check (
    proposed_package_unit is null or char_length(btrim(proposed_package_unit)) between 1 and 16
  ),
  proposed_ingredients text check (
    proposed_ingredients is null or char_length(btrim(proposed_ingredients)) between 1 and 4000
  ),
  proposed_image_url text check (
    proposed_image_url is null
    or (char_length(proposed_image_url) between 1 and 500 and proposed_image_url ~ '^https://')
  ),
  reason text not null check (char_length(btrim(reason)) between 1 and 200),
  status text not null default 'pending' check (status in ('pending', 'applied', 'dismissed')),
  submitted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.catalog_corrections is
  'A proposed fix for a verified catalog product. Applying it is a platform action.';

create index catalog_corrections_product_idx on public.catalog_corrections (catalog_product_id, status);

create trigger catalog_corrections_set_updated_at before update on public.catalog_corrections
  for each row execute function public.set_updated_at();

-- Shop products may point at a catalog identity. Prices stay on the shop row. -------------------

alter table public.products
  add column catalog_product_id uuid references public.catalog_products (id);

comment on column public.products.catalog_product_id is
  'Shared catalog identity, when this shop product was saved from one. Stock and prices stay here.';

create unique index products_shop_catalog_active_key
  on public.products (shop_id, catalog_product_id)
  where catalog_product_id is not null and archived_at is null;

-- Access: active shop members may read. Writes go through the functions below. ------------------

alter table public.catalog_products enable row level security;
alter table public.catalog_barcodes enable row level security;
alter table public.catalog_corrections enable row level security;

revoke all on table public.catalog_products, public.catalog_barcodes, public.catalog_corrections
  from public, anon, authenticated;
grant select on table public.catalog_products, public.catalog_barcodes, public.catalog_corrections
  to authenticated;
grant all on table public.catalog_products, public.catalog_barcodes, public.catalog_corrections
  to service_role;

create policy "Active members can view catalog products"
  on public.catalog_products for select to authenticated
  using (exists (
    select 1 from public.shop_members m
    where m.user_id = (select auth.uid()) and m.status = 'active'
  ));

create policy "Active members can view catalog barcodes"
  on public.catalog_barcodes for select to authenticated
  using (exists (
    select 1 from public.shop_members m
    where m.user_id = (select auth.uid()) and m.status = 'active'
  ));

create policy "Active members can view catalog corrections"
  on public.catalog_corrections for select to authenticated
  using (exists (
    select 1 from public.shop_members m
    where m.user_id = (select auth.uid()) and m.status = 'active'
  ));

-- Helpers -----------------------------------------------------------------------------------------

create function private.lock_catalog_barcode(p_barcode text)
returns void
language sql
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('catalog|' || p_barcode, 0));
$$;

revoke all on function private.lock_catalog_barcode(text) from public, anon, authenticated;

create function private.catalog_rank(p_status text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'external' then 1
    when 'user_submitted' then 2
    when 'verified' then 3
    else 0
  end;
$$;

revoke all on function private.catalog_rank(text) from public, anon, authenticated;

-- Incoming text wins only when it outranks what is stored, or when the stored value is empty.
create function private.merge_catalog_text(
  p_stored text,
  p_incoming text,
  p_stored_status text,
  p_incoming_status text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_incoming is null then p_stored
    when p_stored is null then p_incoming
    when private.catalog_rank(p_incoming_status) > private.catalog_rank(p_stored_status) then p_incoming
    else p_stored
  end;
$$;

revoke all on function private.merge_catalog_text(text, text, text, text) from public, anon, authenticated;

create function private.merge_catalog_number(
  p_stored numeric,
  p_incoming numeric,
  p_stored_status text,
  p_incoming_status text
)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_incoming is null then p_stored
    when p_stored is null then p_incoming
    when private.catalog_rank(p_incoming_status) > private.catalog_rank(p_stored_status) then p_incoming
    else p_stored
  end;
$$;

revoke all on function private.merge_catalog_number(numeric, numeric, text, text) from public, anon, authenticated;

create function private.clean_https_url(p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_clean text := nullif(btrim(p_value), '');
begin
  if v_clean is null then
    return null;
  end if;
  if char_length(v_clean) > 500 or v_clean !~ '^https://' then
    return null;
  end if;
  return v_clean;
end;
$$;

revoke all on function private.clean_https_url(text) from public, anon, authenticated;

-- Sets the shop product's catalog link when the catalog row exists and this shop does not
-- already point another active product at it. Never copies prices. Never fails the product save.
create function private.attach_catalog_link(p_product public.products, p_catalog_id uuid)
returns public.products
language plpgsql
set search_path = ''
as $$
declare
  v_product public.products := p_product;
begin
  if p_catalog_id is null or v_product.catalog_product_id is not null then
    return v_product;
  end if;
  if not exists (select 1 from public.catalog_products where id = p_catalog_id) then
    return v_product;
  end if;
  if exists (
    select 1 from public.products
    where shop_id = v_product.shop_id
      and catalog_product_id = p_catalog_id
      and archived_at is null
      and id <> v_product.id
  ) then
    return v_product;
  end if;

  update public.products
  set catalog_product_id = p_catalog_id
  where id = v_product.id and shop_id = v_product.shop_id and catalog_product_id is null
  returning * into v_product;
  return v_product;
exception
  when unique_violation then
    return p_product;
end;
$$;

revoke all on function private.attach_catalog_link(public.products, uuid) from public, anon, authenticated;

-- Saves a barcode the caller confirmed. The first writer keeps the row; a second writer for the
-- same barcode gets that row back. Verified fields are left as they are.
create function public.submit_catalog_product(
  p_shop_id uuid,
  p_barcode text,
  p_name text,
  p_category text,
  p_brand text default null,
  p_package_size text default null,
  p_package_quantity numeric default null,
  p_package_unit text default null,
  p_image_url text default null,
  p_ingredients text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_barcode text := private.clean_barcode(p_barcode);
  v_name text := btrim(coalesce(p_name, ''));
  v_brand text;
  v_size text;
  v_unit text;
  v_ingredients text;
  v_image text;
  v_product public.catalog_products;
  v_link public.catalog_barcodes;
  v_correction_id uuid;
  v_reason text := 'Details differ from the verified catalog product.';
begin
  perform private.assert_shop_role(p_shop_id, array['owner', 'manager', 'staff']);
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
  if p_package_quantity is not null and p_package_quantity <= 0 then
    raise exception 'Package quantity must be greater than zero.' using errcode = '22023';
  end if;
  v_brand := private.optional_text(p_brand, null, 80, 'Brand');
  v_size := private.optional_text(p_package_size, null, 40, 'Size');
  v_unit := private.optional_text(p_package_unit, null, 16, 'Unit');
  v_ingredients := private.optional_text(p_ingredients, null, 4000, 'Ingredients');
  v_image := private.clean_https_url(p_image_url);

  for i in 1..3 loop
    perform private.lock_catalog_barcode(v_barcode);
    select * into v_link from public.catalog_barcodes where barcode = v_barcode;
    if found then
      select * into v_product from public.catalog_products where id = v_link.catalog_product_id for update;
      if v_product.verification_status = 'verified' then
        if v_name is distinct from v_product.name
           or (v_brand is not null and v_brand is distinct from v_product.brand)
           or p_category is distinct from v_product.category
           or (v_size is not null and v_size is distinct from v_product.package_size)
           or (p_package_quantity is not null and p_package_quantity is distinct from v_product.package_quantity)
           or (v_unit is not null and v_unit is distinct from v_product.package_unit)
           or (v_ingredients is not null and v_ingredients is distinct from v_product.ingredients)
           or (v_image is not null and v_image is distinct from v_product.image_url)
        then
          select id into v_correction_id
          from public.catalog_corrections
          where catalog_product_id = v_product.id
            and submitted_by = (select auth.uid())
            and status = 'pending'
            and proposed_name is not distinct from case when v_name is distinct from v_product.name then v_name else null end
            and proposed_brand is not distinct from case when v_brand is not null and v_brand is distinct from v_product.brand then v_brand else null end
            and shop_id = p_shop_id
          limit 1;
          if v_correction_id is null then
            insert into public.catalog_corrections (
              catalog_product_id, shop_id, proposed_name, proposed_brand, proposed_category,
              proposed_package_size, proposed_package_quantity, proposed_package_unit,
              proposed_ingredients, proposed_image_url, reason, submitted_by
            )
            values (
              v_product.id, p_shop_id,
              case when v_name is distinct from v_product.name then v_name else null end,
              case when v_brand is not null and v_brand is distinct from v_product.brand then v_brand else null end,
              case when p_category is distinct from v_product.category then p_category else null end,
              case when v_size is not null and v_size is distinct from v_product.package_size then v_size else null end,
              case when p_package_quantity is not null and p_package_quantity is distinct from v_product.package_quantity then p_package_quantity else null end,
              case when v_unit is not null and v_unit is distinct from v_product.package_unit then v_unit else null end,
              case when v_ingredients is not null and v_ingredients is distinct from v_product.ingredients then v_ingredients else null end,
              case when v_image is not null and v_image is distinct from v_product.image_url then v_image else null end,
              v_reason, (select auth.uid())
            )
            returning id into v_correction_id;
          end if;
        end if;
        return jsonb_build_object(
          'product', to_jsonb(v_product), 'correction_id', v_correction_id, 'created', false
        );
      end if;

      update public.catalog_products
      set name = private.merge_catalog_text(name, v_name, verification_status, 'user_submitted'),
          brand = private.merge_catalog_text(brand, v_brand, verification_status, 'user_submitted'),
          category = private.merge_catalog_text(category, p_category, verification_status, 'user_submitted'),
          package_size = private.merge_catalog_text(package_size, v_size, verification_status, 'user_submitted'),
          package_quantity = private.merge_catalog_number(package_quantity, p_package_quantity, verification_status, 'user_submitted'),
          package_unit = private.merge_catalog_text(package_unit, v_unit, verification_status, 'user_submitted'),
          ingredients = private.merge_catalog_text(ingredients, v_ingredients, verification_status, 'user_submitted'),
          image_url = private.merge_catalog_text(image_url, v_image, verification_status, 'user_submitted'),
          source = case
            when private.catalog_rank('user_submitted') > private.catalog_rank(verification_status) then 'user'
            else source
          end,
          verification_status = case
            when private.catalog_rank('user_submitted') > private.catalog_rank(verification_status) then 'user_submitted'
            else verification_status
          end
      where id = v_product.id
      returning * into v_product;

      return jsonb_build_object(
        'product', to_jsonb(v_product), 'correction_id', null, 'created', false
      );
    end if;

    begin
      insert into public.catalog_products (
        name, brand, category, package_size, package_quantity, package_unit,
        image_url, ingredients, source, verification_status, created_by
      )
      values (
        v_name, v_brand, p_category, v_size, p_package_quantity, v_unit,
        v_image, v_ingredients, 'user', 'user_submitted', (select auth.uid())
      )
      returning * into v_product;

      insert into public.catalog_barcodes (barcode, catalog_product_id, kind, source, created_by)
      values (v_barcode, v_product.id, 'unit', 'user', (select auth.uid()));

      return jsonb_build_object(
        'product', to_jsonb(v_product), 'correction_id', null, 'created', true
      );
    exception
      when unique_violation then
        null;
    end;
  end loop;

  raise exception 'Barcode % is already in the catalog.', v_barcode using errcode = '23505';
end;
$$;

-- Attaches an alternate or pack code to a catalog product this shop already uses.
create function public.link_catalog_barcode(
  p_shop_id uuid,
  p_catalog_product_id uuid,
  p_barcode text,
  p_kind text,
  p_units_per_package integer default null
)
returns public.catalog_barcodes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_barcode text := private.clean_barcode(p_barcode);
  v_link public.catalog_barcodes;
  v_owner uuid;
begin
  perform private.assert_shop_role(p_shop_id, array['owner', 'manager', 'staff']);
  if p_catalog_product_id is null then
    raise exception 'Catalog product id is required.' using errcode = '22023';
  end if;
  if v_barcode = '' or char_length(v_barcode) > 64 then
    raise exception 'Barcode is required (up to 64 characters).' using errcode = '22023';
  end if;
  if p_kind not in ('alternate', 'pack') then
    raise exception 'Link an alternate barcode or a pack barcode.' using errcode = '22023';
  end if;
  if p_kind = 'pack' and (p_units_per_package is null or p_units_per_package < 2 or p_units_per_package > 10000) then
    raise exception 'A pack holds 2 to 10,000 units.' using errcode = '22023';
  end if;
  if p_kind = 'alternate' and p_units_per_package is not null then
    raise exception 'An alternate barcode is one unit.' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.products
    where shop_id = p_shop_id and catalog_product_id = p_catalog_product_id and archived_at is null
  ) then
    raise exception 'This shop does not use that catalog product.' using errcode = '42501';
  end if;

  perform private.lock_catalog_barcode(v_barcode);
  select * into v_link from public.catalog_barcodes where barcode = v_barcode;
  if found then
    if v_link.catalog_product_id <> p_catalog_product_id then
      raise exception 'Barcode % already belongs to another catalog product.', v_barcode using errcode = '23505';
    end if;
    return v_link;
  end if;

  select id into v_owner from public.catalog_products where id = p_catalog_product_id;
  if v_owner is null then
    raise exception 'Catalog product not found.' using errcode = 'P0002';
  end if;

  insert into public.catalog_barcodes (
    barcode, catalog_product_id, kind, units_per_package, source, created_by
  )
  values (
    v_barcode, p_catalog_product_id, p_kind,
    case when p_kind = 'pack' then p_units_per_package else null end,
    'user', (select auth.uid())
  )
  returning * into v_link;

  return v_link;
exception
  when unique_violation then
    select * into v_link from public.catalog_barcodes where barcode = v_barcode;
    if v_link.catalog_product_id = p_catalog_product_id then
      return v_link;
    end if;
    raise exception 'Barcode % already belongs to another catalog product.', v_barcode using errcode = '23505';
end;
$$;

create function public.submit_catalog_correction(
  p_shop_id uuid,
  p_catalog_product_id uuid,
  p_reason text,
  p_name text default null,
  p_brand text default null,
  p_category text default null,
  p_package_size text default null,
  p_package_quantity numeric default null,
  p_package_unit text default null,
  p_ingredients text default null,
  p_image_url text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.catalog_products;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_id uuid;
begin
  perform private.assert_shop_role(p_shop_id, array['owner', 'manager', 'staff']);
  if v_reason = '' or char_length(v_reason) > 200 then
    raise exception 'A reason is required (up to 200 characters).' using errcode = '22023';
  end if;
  select * into v_product from public.catalog_products where id = p_catalog_product_id;
  if not found then
    raise exception 'Catalog product not found.' using errcode = 'P0002';
  end if;
  if v_product.verification_status <> 'verified' then
    raise exception 'Only a verified catalog product takes a correction.' using errcode = '22023';
  end if;

  insert into public.catalog_corrections (
    catalog_product_id, shop_id, proposed_name, proposed_brand, proposed_category,
    proposed_package_size, proposed_package_quantity, proposed_package_unit,
    proposed_ingredients, proposed_image_url, reason, submitted_by
  )
  values (
    p_catalog_product_id, p_shop_id,
    private.optional_text(p_name, null, 200, 'Product name'),
    private.optional_text(p_brand, null, 80, 'Brand'),
    p_category,
    private.optional_text(p_package_size, null, 40, 'Size'),
    p_package_quantity,
    private.optional_text(p_package_unit, null, 16, 'Unit'),
    private.optional_text(p_ingredients, null, 4000, 'Ingredients'),
    private.clean_https_url(p_image_url),
    v_reason, (select auth.uid())
  )
  returning id into v_id;
  return v_id;
end;
$$;

create function public.apply_catalog_correction(p_correction_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_correction public.catalog_corrections;
  v_product public.catalog_products;
begin
  if not private.has_platform_permission('catalog.verify') then
    return private.platform_denied('catalog.verify', 'catalog', p_correction_id::text);
  end if;
  v_reason := private.require_reason(p_reason);

  select * into v_correction
  from public.catalog_corrections
  where id = p_correction_id and status = 'pending'
  for update;
  if not found then
    raise exception 'Correction not found.' using errcode = 'P0002';
  end if;

  update public.catalog_products
  set name = coalesce(v_correction.proposed_name, name),
      brand = coalesce(v_correction.proposed_brand, brand),
      category = coalesce(v_correction.proposed_category, category),
      package_size = coalesce(v_correction.proposed_package_size, package_size),
      package_quantity = coalesce(v_correction.proposed_package_quantity, package_quantity),
      package_unit = coalesce(v_correction.proposed_package_unit, package_unit),
      ingredients = coalesce(v_correction.proposed_ingredients, ingredients),
      image_url = coalesce(v_correction.proposed_image_url, image_url),
      verification_status = 'verified'
  where id = v_correction.catalog_product_id
  returning * into v_product;

  update public.catalog_corrections set status = 'applied' where id = p_correction_id;

  perform private.audit(
    'catalog.verify', 'success', 'catalog', v_product.id::text, v_correction.shop_id, v_reason
  );

  return jsonb_build_object('ok', true, 'product', to_jsonb(v_product));
end;
$$;

revoke all on function public.submit_catalog_product(uuid, text, text, text, text, text, numeric, text, text, text)
  from public, anon;
revoke all on function public.link_catalog_barcode(uuid, uuid, text, text, integer) from public, anon;
revoke all on function public.submit_catalog_correction(uuid, uuid, text, text, text, text, text, numeric, text, text, text)
  from public, anon;
revoke all on function public.apply_catalog_correction(uuid, text) from public, anon;

grant execute on function public.submit_catalog_product(uuid, text, text, text, text, text, numeric, text, text, text)
  to authenticated;
grant execute on function public.link_catalog_barcode(uuid, uuid, text, text, integer) to authenticated;
grant execute on function public.submit_catalog_correction(uuid, uuid, text, text, text, text, text, numeric, text, text, text)
  to authenticated;
grant execute on function public.apply_catalog_correction(uuid, text) to authenticated;

-- upsert_product: optional catalog link, still does not copy prices --------------------------------

drop function public.upsert_product(uuid, uuid, text, text, text, numeric, numeric, timestamptz, text, text);

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
  p_size text default null,
  p_catalog_product_id uuid default null
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
    return private.attach_catalog_link(v_product, p_catalog_product_id);
  end if;

  perform private.lock_barcode(p_shop_id, v_barcode);
  select * into v_alias
  from public.product_barcodes
  where shop_id = p_shop_id and barcode = v_barcode and unlinked_at is null;
  if found then
    if v_alias.packaging_id is not null then
      raise exception 'Barcode % is linked to a pack of another product in this shop.', v_barcode
        using errcode = '23505';
    end if;
    select * into v_product from public.products where id = v_alias.product_id;
    return private.attach_catalog_link(v_product, p_catalog_product_id);
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

  return private.attach_catalog_link(v_product, p_catalog_product_id);
end;
$$;

revoke all on function public.upsert_product(uuid, uuid, text, text, text, numeric, numeric, timestamptz, text, text, uuid)
  from public, anon;
grant execute on function public.upsert_product(uuid, uuid, text, text, text, numeric, numeric, timestamptz, text, text, uuid)
  to authenticated;
