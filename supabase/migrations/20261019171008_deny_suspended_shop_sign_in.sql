-- Owners and managers are told that a suspended shop cannot be signed into.
create or replace function public.admin_set_shop_status(p_shop_id uuid, p_status text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_shop public.shops;
begin
  if not private.has_platform_permission('tenants.manage') then
    return private.platform_denied('tenant.status', 'shop', p_shop_id::text, p_shop_id);
  end if;
  v_reason := private.require_reason(p_reason);
  if p_status is null or p_status not in ('active', 'suspended') then
    raise exception 'Status must be active or suspended.' using errcode = '22023';
  end if;

  select * into v_shop from public.shops where id = p_shop_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_shop.status = p_status then
    return jsonb_build_object('ok', true, 'unchanged', true, 'status', p_status);
  end if;

  update public.shops
  set status = p_status,
      suspended_at = case when p_status = 'suspended' then now() end,
      suspended_by = case when p_status = 'suspended' then (select auth.uid()) end,
      suspension_reason = case when p_status = 'suspended' then v_reason end
  where id = p_shop_id;

  perform private.audit(
    case when p_status = 'suspended' then 'tenant.suspended' else 'tenant.reactivated' end,
    'success', 'shop', p_shop_id::text, p_shop_id, v_reason,
    jsonb_build_object('before', v_shop.status, 'after', p_status, 'shop_name', v_shop.name)
  );

  insert into public.notifications (shop_id, user_id, type, title, body, data)
  select
    p_shop_id, m.user_id, 'system',
    case when p_status = 'suspended' then 'Shop suspended' else 'Shop reactivated' end,
    case
      when p_status = 'suspended'
        then format('%s is suspended. Sign-in is refused until it is reactivated. Contact SpazaStock support.', v_shop.name)
      else format('%s is active again. Waiting changes will now sync.', v_shop.name)
    end,
    jsonb_build_object('kind', 'shop_status', 'status', p_status)
  from public.shop_members m
  where m.shop_id = p_shop_id and m.user_id is not null and m.status = 'active'
    and m.role in ('owner', 'manager');

  return jsonb_build_object('ok', true, 'unchanged', false, 'status', p_status);
end;
$$;
