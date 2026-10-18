-- Shared catalog pictures live in the same private bucket as shop pictures, under
-- catalog/<catalog product id>.webp|jpg. A shop product still keeps its own copy.

alter table public.catalog_products
  add column image_path text;

alter table public.catalog_products
  add constraint catalog_products_image_path_check check (
    image_path is null
    or image_path ~ ('^catalog/' || id::text || '\.(webp|jpg)$')
  );

comment on column public.catalog_products.image_path is
  'Path of the shared picture in product-images; set only through set_catalog_image, and only while empty.';

-- The catalog product a shared picture path belongs to, or null when the path is not one.
create function private.catalog_image_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^catalog/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg)$'
      then split_part(split_part(p_name, '/', 2), '.', 1)::uuid
  end;
$$;

-- An active member may upload the shared picture only for a catalog product their shop already uses.
create function private.can_upload_catalog_image(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid := private.catalog_image_id(p_name);
begin
  return v_id is not null
    and exists (
      select 1
      from public.products
      where catalog_product_id = v_id
        and archived_at is null
        and shop_id in (select private.my_shop_ids())
        and private.has_shop_role(shop_id, array['owner', 'manager', 'staff'])
        and private.shop_is_active(shop_id)
    );
end;
$$;

revoke all on function private.catalog_image_id(text) from public, anon;
revoke all on function private.can_upload_catalog_image(text) from public, anon;
grant execute on function private.catalog_image_id(text) to authenticated;
grant execute on function private.can_upload_catalog_image(text) to authenticated;

-- Any active shop member can read a shared picture, including before their shop has the product.
create policy "Members can view shared catalog images"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'product-images'
    and private.catalog_image_id(name) is not null
    and exists (select 1 from private.my_shop_ids())
  );

create policy "Members can upload a shared catalog image"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and private.can_upload_catalog_image(name));

-- Sets the shared picture the first time only. A later shop does not replace it.
-- Returns the path that is stored.
create function public.set_catalog_image(
  p_shop_id uuid,
  p_catalog_product_id uuid,
  p_image_path text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text := nullif(btrim(coalesce(p_image_path, '')), '');
  v_stored text;
begin
  perform private.assert_shop_role(p_shop_id, array['owner', 'manager', 'staff']);
  if p_catalog_product_id is null or v_path is null then
    raise exception 'Catalog product and picture are required.' using errcode = '22023';
  end if;
  if private.catalog_image_id(v_path) is distinct from p_catalog_product_id then
    raise exception 'This picture does not belong to that catalog product.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.products
    where shop_id = p_shop_id
      and catalog_product_id = p_catalog_product_id
      and archived_at is null
  ) then
    raise exception 'This shop does not use that catalog product.' using errcode = '42501';
  end if;

  select image_path into v_stored
  from public.catalog_products
  where id = p_catalog_product_id
  for update;
  if not found then
    raise exception 'Catalog product not found.' using errcode = 'P0002';
  end if;
  if v_stored is not null then
    return v_stored;
  end if;

  if not exists (
    select 1 from storage.objects where bucket_id = 'product-images' and name = v_path
  ) then
    raise exception 'The picture has not been uploaded.' using errcode = '22023';
  end if;

  update public.catalog_products
  set image_path = v_path
  where id = p_catalog_product_id and image_path is null
  returning image_path into v_stored;

  if v_stored is null then
    select image_path into v_stored from public.catalog_products where id = p_catalog_product_id;
  end if;
  return v_stored;
end;
$$;

revoke all on function public.set_catalog_image(uuid, uuid, text) from public, anon;
grant execute on function public.set_catalog_image(uuid, uuid, text) to authenticated;
