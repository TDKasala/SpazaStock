-- Product pictures.
--
-- Pictures are compressed on the phone (at most 600x600, about 100 KB, WebP or JPEG) and stored in
-- the private `product-images` bucket. The product row keeps only the object path,
-- `<shop_id>/<32 hex characters>.webp|jpg`; the name is a hash of the picture, so the same picture
-- is never stored twice. Objects never change: replacing a picture uploads a new object, points
-- the product at it, and the phone then deletes the old one.
--
-- Access follows the first folder of the path, which is the shop id:
--   read    active members of the shop
--   upload  active members of an active shop (staff register products with a first picture)
--   delete  owners and managers, and only while no product still points at the object, so
--           cleaning up can never leave a product with a missing picture
--
-- Error codes the client relies on:
--   22023 invalid_parameter_value -> bad path, or the picture is not in storage
--   42501 insufficient_privilege  -> not a member, or staff replacing or removing a picture
--   P0002 no_data_found           -> product is not in this shop
--   SP001                         -> the shop is suspended

-- Column --------------------------------------------------------------------------------------------

alter table public.products
  add column image_path text check (
    image_path is null or image_path ~ ('^' || shop_id::text || '/[0-9a-f]{32}\.(webp|jpg)$')
  );

comment on column public.products.image_path is
  'Path of the product picture in the product-images bucket; set only through set_product_image.';

create index products_image_path_idx on public.products (image_path) where image_path is not null;

-- Bucket --------------------------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', false, 262144, array['image/webp', 'image/jpeg'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Helpers used by the storage policies ----------------------------------------------------------------

-- The shop a picture path belongs to, or null when the path is not a product picture path.
create function private.product_image_shop(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{32}\.(webp|jpg)$'
      then split_part(p_name, '/', 1)::uuid
  end;
$$;

create function private.can_upload_product_image(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop uuid := private.product_image_shop(p_name);
begin
  return v_shop is not null
    and private.has_shop_role(v_shop, array['owner', 'manager', 'staff'])
    and private.shop_is_active(v_shop);
end;
$$;

create function private.can_delete_product_image(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop uuid := private.product_image_shop(p_name);
begin
  return v_shop is not null
    and private.has_permission(v_shop, 'products.edit')
    and not exists (select 1 from public.products where image_path = p_name);
end;
$$;

revoke all on function private.product_image_shop(text) from public, anon;
revoke all on function private.can_upload_product_image(text) from public, anon;
revoke all on function private.can_delete_product_image(text) from public, anon;
grant execute on function private.product_image_shop(text) to authenticated;
grant execute on function private.can_upload_product_image(text) to authenticated;
grant execute on function private.can_delete_product_image(text) to authenticated;

-- Storage policies (no update policy: objects never change) ---------------------------------------------

create policy "Members can view their shop's product images"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'product-images'
    and private.product_image_shop(name) in (select private.my_shop_ids())
  );

create policy "Members can upload their shop's product images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and private.can_upload_product_image(name));

create policy "Owners and managers can delete unused product images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and private.can_delete_product_image(name));

-- set_product_image ---------------------------------------------------------------------------------

-- Points a product at an uploaded picture, or clears it with null. Staff may give a product its
-- first picture; replacing or removing one needs products.edit, like other product edits.
-- Returns the product and the previous path when no product uses it any more, so the phone can
-- delete that object.
create function public.set_product_image(p_shop_id uuid, p_product_id uuid, p_image_path text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text := nullif(btrim(coalesce(p_image_path, '')), '');
  v_product public.products;
  v_previous text;
begin
  perform private.assert_shop_role(p_shop_id, array['owner', 'manager', 'staff']);
  if p_product_id is null then
    raise exception 'Product id is required.' using errcode = '22023';
  end if;
  if v_path is not null and private.product_image_shop(v_path) is distinct from p_shop_id then
    raise exception 'This picture does not belong to this shop.' using errcode = '22023';
  end if;

  select * into v_product
  from public.products
  where id = p_product_id and shop_id = p_shop_id
  for update;
  if not found then
    raise exception 'Product not found in this shop.' using errcode = 'P0002';
  end if;

  v_previous := v_product.image_path;
  if v_previous is not distinct from v_path then
    return jsonb_build_object('product', to_jsonb(v_product), 'previous_path', null);
  end if;

  if not private.has_permission(p_shop_id, 'products.edit')
     and not (v_previous is null and v_path is not null) then
    raise exception 'Only an owner or manager can change a product picture.' using errcode = '42501';
  end if;

  if v_path is not null and not exists (
    select 1 from storage.objects where bucket_id = 'product-images' and name = v_path
  ) then
    raise exception 'The picture has not been uploaded.' using errcode = '22023';
  end if;

  update public.products set image_path = v_path
  where id = p_product_id
  returning * into v_product;

  return jsonb_build_object(
    'product', to_jsonb(v_product),
    'previous_path', case
      when v_previous is null then null
      when exists (select 1 from public.products where image_path = v_previous) then null
      else v_previous
    end
  );
end;
$$;

revoke all on function public.set_product_image(uuid, uuid, text) from public, anon;
grant execute on function public.set_product_image(uuid, uuid, text) to authenticated;
