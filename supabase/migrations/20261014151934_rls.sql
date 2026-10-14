-- Row level security: a signed-in owner can only reach rows that belong to shops they own.
-- Sales and stock movements form an append-only ledger, so they have no update/delete policies.

alter table public.shops enable row level security;
alter table public.products enable row level security;
alter table public.stock_batches enable row level security;
alter table public.sales enable row level security;
alter table public.stock_movements enable row level security;
alter table public.stock_discrepancies enable row level security;

revoke all on table
  public.shops,
  public.products,
  public.stock_batches,
  public.sales,
  public.stock_movements,
  public.stock_discrepancies
from anon;

-- Shops ----------------------------------------------------------------------

create policy "Owners can view their shops"
  on public.shops for select to authenticated
  using (owner_id = (select auth.uid()));

create policy "Owners can create their own shops"
  on public.shops for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy "Owners can rename their shops"
  on public.shops for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- Products -------------------------------------------------------------------

create policy "Owners can view shop products"
  on public.products for select to authenticated
  using (shop_id in (select s.id from public.shops s where s.owner_id = (select auth.uid())));

create policy "Owners can add shop products"
  on public.products for insert to authenticated
  with check (shop_id in (select s.id from public.shops s where s.owner_id = (select auth.uid())));

create policy "Owners can edit shop products"
  on public.products for update to authenticated
  using (shop_id in (select s.id from public.shops s where s.owner_id = (select auth.uid())))
  with check (shop_id in (select s.id from public.shops s where s.owner_id = (select auth.uid())));

-- Stock batches --------------------------------------------------------------

create policy "Owners can view shop batches"
  on public.stock_batches for select to authenticated
  using (shop_id in (select s.id from public.shops s where s.owner_id = (select auth.uid())));

create policy "Owners can add shop batches"
  on public.stock_batches for insert to authenticated
  with check (shop_id in (select s.id from public.shops s where s.owner_id = (select auth.uid())));

create policy "Owners can update shop batches"
  on public.stock_batches for update to authenticated
  using (shop_id in (select s.id from public.shops s where s.owner_id = (select auth.uid())))
  with check (shop_id in (select s.id from public.shops s where s.owner_id = (select auth.uid())));

-- Sales ----------------------------------------------------------------------

create policy "Owners can view shop sales"
  on public.sales for select to authenticated
  using (shop_id in (select s.id from public.shops s where s.owner_id = (select auth.uid())));

create policy "Owners can record shop sales"
  on public.sales for insert to authenticated
  with check (shop_id in (select s.id from public.shops s where s.owner_id = (select auth.uid())));

-- Stock movements ------------------------------------------------------------

create policy "Owners can view shop movements"
  on public.stock_movements for select to authenticated
  using (shop_id in (select s.id from public.shops s where s.owner_id = (select auth.uid())));

create policy "Owners can record shop movements"
  on public.stock_movements for insert to authenticated
  with check (shop_id in (select s.id from public.shops s where s.owner_id = (select auth.uid())));

-- Stock discrepancies --------------------------------------------------------

create policy "Owners can view shop discrepancies"
  on public.stock_discrepancies for select to authenticated
  using (shop_id in (select s.id from public.shops s where s.owner_id = (select auth.uid())));

create policy "Owners can raise shop discrepancies"
  on public.stock_discrepancies for insert to authenticated
  with check (shop_id in (select s.id from public.shops s where s.owner_id = (select auth.uid())));

create policy "Owners can resolve shop discrepancies"
  on public.stock_discrepancies for update to authenticated
  using (shop_id in (select s.id from public.shops s where s.owner_id = (select auth.uid())))
  with check (shop_id in (select s.id from public.shops s where s.owner_id = (select auth.uid())));
