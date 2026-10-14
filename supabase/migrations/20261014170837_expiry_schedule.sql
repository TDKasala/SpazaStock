-- Scheduling for automated expiry alerts (production only; the PGlite test harness skips
-- *_schedule.sql because it has no pg_cron, pg_net or Vault).
--
-- Every 15 minutes pg_cron runs the generator inside the database, so alerts appear whether or
-- not anyone has the app open. Every 5 minutes, if pushes are due, pg_net calls the expiry-push
-- Edge Function, which sends Web Push messages and reports back through complete_push().
--
-- Required Vault secrets (created once, never stored in this repository):
--   project_url         https://<project-ref>.supabase.co
--   expiry_push_secret  random token the Edge Function also reads through push_config()
--   vapid_public_key, vapid_private_key, vapid_subject  Web Push signing keys
-- See README "Scheduling and push deployment".

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create function private.invoke_expiry_push()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request bigint;
begin
  if not exists (
    select 1 from public.notifications
    where push_status in ('pending', 'sending') and push_next_at <= now()
  ) then
    return null;
  end if;

  v_url := private.vault_secret('project_url');
  v_secret := private.vault_secret('expiry_push_secret');
  if v_url is null or v_secret is null then
    raise warning 'Expiry push is not configured: Vault secrets project_url and expiry_push_secret are required.';
    return null;
  end if;

  select net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/expiry-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) into v_request;
  return v_request;
end;
$$;

revoke all on function private.invoke_expiry_push() from public, anon, authenticated;

-- cron.schedule replaces a job with the same name, so re-running this is harmless.
select cron.schedule('expiry-alerts-generate', '*/15 * * * *', 'select private.generate_expiry_alerts()');
select cron.schedule('expiry-alerts-push', '*/5 * * * *', 'select private.invoke_expiry_push()');
