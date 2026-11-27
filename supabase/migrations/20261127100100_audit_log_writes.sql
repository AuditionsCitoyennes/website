-- Who writes an audit entry, and how large it may be.
--
-- The server writes any entry: the API and the edge functions with the
-- service role, and a direct session (psql, a scheduled job, the seed), which
-- carries no request claims and is not PostgREST's connection. Its metadata
-- holds at most 16 kB.
--
-- A signed-in account, through PostgREST, writes the two entries the admin
-- pages write from the browser, about a user, under its own id, with at most
-- 2 kB of metadata:
--   - 'role_deleted', when it is a super admin;
--   - 'account_deleted' about itself, when it holds a role.
-- Anything else is refused (42501), an oversized entry too (22023).
--
-- Same signature and grants as before: signed-in accounts and the service
-- role. A super admin who removes their own role from the old admin page gets
-- no line: that page writes it after the role is gone, and ignores the answer.
--
-- To undo: run again the `create or replace function public.insert_audit_log`
-- of 20261103120000_draft_reads_and_audit_log_authors.sql.

-- The live site calls this function: fail fast rather than queue behind it.
set lock_timeout = '200ms';

create or replace function public.insert_audit_log(
  p_user_id uuid,
  p_action text,
  p_target_type text default null,
  p_target_id text default null,
  p_metadata jsonb default '{}'::jsonb
) returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_size integer := coalesce(pg_catalog.octet_length(p_metadata::text), 0);
  v_server boolean;
begin
  -- Claims that cannot be read are nobody's: the call fails.
  v_server := coalesce(auth.role(), '') = 'service_role'
    or (nullif(pg_catalog.current_setting('request.jwt.claims', true), '') is null
        and nullif(pg_catalog.current_setting('request.jwt.claim.role', true), '') is null
        and session_user <> 'authenticator');

  if v_server then
    if v_size > 16384 then
      raise exception 'the metadata of an audit entry holds at most 16 kB'
        using errcode = '22023';
    end if;
  else
    if auth.uid() is null
       or p_user_id is distinct from auth.uid()
       or p_target_type is distinct from 'user'
       or p_target_id is null
       or pg_catalog.length(p_target_id) > 64
       or not coalesce(
         (p_action = 'role_deleted' and public.is_super_admin())
         or (p_action = 'account_deleted'
             and p_target_id = auth.uid()::text
             and public.is_admin()),
         false) then
      raise exception 'an audit entry is written by the server, or by a signed-in admin about a role removed or their own account deleted'
        using errcode = '42501';
    end if;
    if v_size > 2048 then
      raise exception 'the metadata of an audit entry holds at most 2 kB'
        using errcode = '22023';
    end if;
  end if;

  insert into public.audit_log (user_id, action, target_type, target_id, metadata)
  values (p_user_id, p_action, p_target_type, p_target_id, p_metadata);
end;
$$;

revoke execute on function public.insert_audit_log(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.insert_audit_log(uuid, text, text, text, jsonb)
  to authenticated, service_role;
