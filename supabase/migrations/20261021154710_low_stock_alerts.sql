-- One phone notification per low-stock episode. The row is removed when sellable stock rises
-- above the minimum, the minimum is cleared, or the product is archived, so the next drop
-- can notify again. Sellable stock excludes batches that are already past their expiry date.

create table private.low_stock_episodes (
  shop_id uuid not null,
  product_id uuid not null,
  primary key (shop_id, product_id),
  constraint low_stock_episodes_product_fkey
    foreign key (shop_id, product_id) references public.products (shop_id, id) on delete cascade
);

comment on table private.low_stock_episodes is
  'A product whose current drop below its minimum has already been announced.';

alter table private.low_stock_episodes enable row level security;
revoke all on table private.low_stock_episodes from public, anon, authenticated;

create function private.generate_low_stock_alerts(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_inserted integer;
begin
  delete from private.low_stock_episodes e
  where not exists (
    select 1
    from public.products p
    cross join lateral private.shop_product_stock_state(
      p.shop_id, p.id, private.shop_today(p.shop_id, v_now)
    ) s
    where p.shop_id = e.shop_id
      and p.id = e.product_id
      and p.archived_at is null
      and p.min_stock_units is not null
      and s.sellable <= p.min_stock_units
  );

  with due as (
    select
      p.shop_id,
      p.id as product_id,
      p.name,
      p.min_stock_units as minimum,
      s.sellable,
      sh.timezone
    from public.products p
    join public.shops sh on sh.id = p.shop_id
    cross join lateral private.shop_product_stock_state(
      p.shop_id, p.id, private.shop_today(p.shop_id, v_now)
    ) s
    where p.archived_at is null
      and p.min_stock_units is not null
      and s.sellable <= p.min_stock_units
      and not exists (
        select 1 from private.low_stock_episodes e
        where e.shop_id = p.shop_id and e.product_id = p.id
      )
      and not exists (
        select 1 from public.low_stock_dismissals d
        where d.shop_id = p.shop_id and d.product_id = p.id and d.cleared_at is null
      )
  ),
  opened as (
    insert into private.low_stock_episodes (shop_id, product_id)
    select shop_id, product_id from due
    on conflict (shop_id, product_id) do nothing
    returning shop_id, product_id
  ),
  notified as (
    insert into public.notifications (
      shop_id, user_id, type, title, body, data, push_status, push_next_at
    )
    select
      o.shop_id,
      m.user_id,
      'low_stock',
      left(format('Low stock: %s', d.name), 200),
      format('%s on hand, minimum %s.', d.sellable, d.minimum),
      jsonb_build_object(
        'kind', 'low_stock',
        'product_id', d.product_id,
        'product_name', d.name,
        'sellable', d.sellable,
        'minimum', d.minimum
      ),
      'pending',
      greatest(v_now, (private.shop_today(o.shop_id, v_now) + time '07:00') at time zone d.timezone)
    from opened o
    join due d on d.shop_id = o.shop_id and d.product_id = o.product_id
    join public.shop_members m
      on m.shop_id = o.shop_id
     and m.user_id is not null
     and m.status = 'active'
     and m.role in ('owner', 'manager')
    returning 1
  )
  select count(*) into v_inserted from notified;

  return v_inserted;
end;
$$;

revoke all on function private.generate_low_stock_alerts(timestamptz) from public, anon, authenticated;

-- Low-stock rows still go out when the shop is not entitled to expiry pushes. Expiry rows
-- keep that entitlement check. A missing subscription, a departed member, or a suspended
-- shop still skips both.
create or replace function public.claim_push_batch(p_limit integer default 50, p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_claimed jsonb;
begin
  update public.notifications n
  set push_status = 'skipped', push_next_at = null
  where n.push_status in ('pending', 'sending') and n.push_next_at <= v_now
    and (
      not exists (select 1 from public.push_subscriptions s where s.user_id = n.user_id)
      or not exists (
        select 1 from public.shop_members m where m.shop_id = n.shop_id and m.user_id = n.user_id
      )
      or not private.shop_is_active(n.shop_id)
      or (n.type is distinct from 'low_stock' and not private.entitled(n.shop_id, 'expiry_push'))
    );

  with due as (
    select n.id
    from public.notifications n
    where n.push_status in ('pending', 'sending') and n.push_next_at <= v_now
    order by n.push_next_at, n.id
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update skip locked
  ),
  claimed as (
    update public.notifications n
    set push_status = 'sending', push_attempts = n.push_attempts + 1, push_next_at = v_now + interval '10 minutes'
    from due
    where n.id = due.id
    returning n.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'notification_id', c.id,
    'title', c.title,
    'body', c.body,
    'data', c.data,
    'attempts', c.push_attempts,
    'subscriptions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth
      ) order by s.created_at), '[]'::jsonb)
      from public.push_subscriptions s where s.user_id = c.user_id
    )
  ) order by c.push_next_at, c.id), '[]'::jsonb)
  into v_claimed
  from claimed c;

  return v_claimed;
end;
$$;
