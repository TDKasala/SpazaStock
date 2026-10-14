-- Row level security v2: access follows shop membership instead of shop ownership.
--
-- Table privileges decide WHAT a signed-in user may do; policies decide WHICH rows.
-- Stock ledger tables (batches, movements, sales, sale items, discrepancies) are read-only for
-- clients: stock changes only through the security-definer functions, which check membership,
-- lock rows and keep the ledger consistent. The only direct client writes left are a few columns
-- granted explicitly below.

-- Drop the owner-only policies ------------------------------------------------------

drop policy "Owners can view their shops" on public.shops;
drop policy "Owners can create their own shops" on public.shops;
drop policy "Owners can rename their shops" on public.shops;
drop policy "Owners can view shop products" on public.products;
drop policy "Owners can add shop products" on public.products;
drop policy "Owners can edit shop products" on public.products;
drop policy "Owners can view shop batches" on public.stock_batches;
drop policy "Owners can add shop batches" on public.stock_batches;
drop policy "Owners can update shop batches" on public.stock_batches;
drop policy "Owners can view shop sales" on public.sales;
drop policy "Owners can record shop sales" on public.sales;
drop policy "Owners can view shop movements" on public.stock_movements;
drop policy "Owners can record shop movements" on public.stock_movements;
drop policy "Owners can view shop discrepancies" on public.stock_discrepancies;
drop policy "Owners can raise shop discrepancies" on public.stock_discrepancies;
drop policy "Owners can resolve shop discrepancies" on public.stock_discrepancies;

-- Anonymous callers get nothing ----------------------------------------------------

revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on functions from anon;

-- Table privileges for signed-in users -------------------------------------------

revoke all on table
  public.shops,
  public.profiles,
  public.shop_members,
  public.products,
  public.stock_batches,
  public.stock_movements,
  public.sales,
  public.sale_items,
  public.stock_discrepancies,
  public.notifications,
  public.subscriptions
from authenticated;

grant select on table
  public.shops,
  public.profiles,
  public.shop_members,
  public.products,
  public.stock_batches,
  public.stock_movements,
  public.sales,
  public.sale_items,
  public.stock_discrepancies,
  public.notifications,
  public.subscriptions
to authenticated;

grant insert (name), update (name) on public.shops to authenticated;
grant update (display_name, phone) on public.profiles to authenticated;
grant insert (id, shop_id, barcode, name, category, buying_price, selling_price, created_at),
  update (barcode, name, category, buying_price, selling_price)
  on public.products to authenticated;
grant update (resolved_at) on public.stock_discrepancies to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- Shops ----------------------------------------------------------------------------
-- The account owner is matched on owner_id too, so `insert ... returning` works before the
-- membership trigger has run.

create policy "Members can view their shops"
  on public.shops for select to authenticated
  using (owner_id = (select auth.uid()) or id in (select private.my_shop_ids()));

create policy "Users can create a shop they own"
  on public.shops for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy "Owners can rename their shops"
  on public.shops for update to authenticated
  using (id in (select private.my_shop_ids(array['owner'])))
  with check (id in (select private.my_shop_ids(array['owner'])));

-- Profiles -------------------------------------------------------------------------

create policy "Users can view their own and co-members' profiles"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or id in (select private.my_co_member_ids()));

create policy "Users can edit their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Shop members (writes only through the membership functions) -----------------------

create policy "Members can view their shop's members"
  on public.shop_members for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

-- Products -------------------------------------------------------------------------

create policy "Members can view shop products"
  on public.products for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

create policy "Members can register shop products"
  on public.products for insert to authenticated
  with check (shop_id in (select private.my_shop_ids()));

create policy "Owners and managers can edit shop products"
  on public.products for update to authenticated
  using (shop_id in (select private.my_shop_ids(array['owner', 'manager'])))
  with check (shop_id in (select private.my_shop_ids(array['owner', 'manager'])));

-- Stock ledger (read-only) -----------------------------------------------------------

create policy "Members can view shop batches"
  on public.stock_batches for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

create policy "Members can view shop movements"
  on public.stock_movements for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

create policy "Members can view shop sales"
  on public.sales for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

create policy "Members can view shop sale items"
  on public.sale_items for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

create policy "Members can view shop discrepancies"
  on public.stock_discrepancies for select to authenticated
  using (shop_id in (select private.my_shop_ids()));

create policy "Owners and managers can resolve discrepancies"
  on public.stock_discrepancies for update to authenticated
  using (shop_id in (select private.my_shop_ids(array['owner', 'manager'])))
  with check (shop_id in (select private.my_shop_ids(array['owner', 'manager'])));

-- Notifications --------------------------------------------------------------------

create policy "Users can view their notifications"
  on public.notifications for select to authenticated
  using (user_id = (select auth.uid()) and shop_id in (select private.my_shop_ids()));

create policy "Users can mark their notifications read"
  on public.notifications for update to authenticated
  using (user_id = (select auth.uid()) and shop_id in (select private.my_shop_ids()))
  with check (user_id = (select auth.uid()) and shop_id in (select private.my_shop_ids()));

-- Subscriptions (owners read; only the service role writes) ----------------------------

create policy "Owners can view their shop subscription"
  on public.subscriptions for select to authenticated
  using (shop_id in (select private.my_shop_ids(array['owner'])));
