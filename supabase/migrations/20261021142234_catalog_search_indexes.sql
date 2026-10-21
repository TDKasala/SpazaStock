-- Name, brand and barcode search use a leading wildcard. Trigram indexes serve that
-- where the extension exists. The common-list indexes serve the confirmation pages.
-- Nothing here changes a function argument, backfills a row, or marks a product common.

create schema if not exists extensions;

do $$
begin
  create extension if not exists pg_trgm with schema extensions;
exception
  when others then
    raise notice 'pg_trgm is not available in this database; catalogue text search stays unindexed.';
end
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_trgm') then
    execute 'create index if not exists catalog_products_name_trgm_idx on public.catalog_products using gin (name extensions.gin_trgm_ops)';
    execute 'create index if not exists catalog_products_brand_trgm_idx on public.catalog_products using gin (brand extensions.gin_trgm_ops) where brand is not null';
    execute 'create index if not exists catalog_barcodes_barcode_trgm_idx on public.catalog_barcodes using gin (barcode extensions.gin_trgm_ops)';
  end if;
end
$$;

create index if not exists catalog_products_common_name_idx
  on public.catalog_products (name, id)
  where common;

create index if not exists catalog_products_common_category_name_idx
  on public.catalog_products (category, name, id)
  where common;
