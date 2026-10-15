-- Shared barcode lookup cache for Smart Product Scan (Open Food Facts and future providers).
-- Platform data: only the service role (Edge Function) may read or write. Shop products are
-- never written from this cache; the phone only uses suggestions to prefill registration.

create table public.product_lookup_cache (
  barcode text primary key,
  status text not null check (status in ('found', 'not_found')),
  payload jsonb,
  provider text not null default 'open_food_facts',
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint product_lookup_cache_payload_check check (
    (status = 'not_found' and payload is null) or (status = 'found' and payload is not null)
  )
);

create index product_lookup_cache_expires_at_idx on public.product_lookup_cache (expires_at);

comment on table public.product_lookup_cache is
  'Normalized barcode suggestions from external catalogs. Service role only; never auto-writes shop products.';

alter table public.product_lookup_cache enable row level security;
-- No policies for anon/authenticated: PostgREST clients cannot read or write.
revoke all on table public.product_lookup_cache from anon, authenticated;
grant all on table public.product_lookup_cache to service_role;

-- Per-shop lookup rate windows (one row per shop per minute bucket).
create table public.product_lookup_rate (
  shop_id uuid not null references public.shops (id) on delete cascade,
  window_start timestamptz not null,
  request_count int not null default 0 check (request_count >= 0),
  primary key (shop_id, window_start)
);

comment on table public.product_lookup_rate is
  'Counts product-lookup Edge Function calls per shop per minute for rate limiting.';

alter table public.product_lookup_rate enable row level security;
revoke all on table public.product_lookup_rate from anon, authenticated;
grant all on table public.product_lookup_rate to service_role;
