-- Every SECURITY DEFINER function of schema public sets its search_path.
--
-- is_admin(), is_super_admin(), has_role(), get_audit_log() and
-- verify_testimony() name every object with its schema, so an empty
-- search_path changes nothing in what they do: they do not depend on the
-- caller's. (get_pending_registrations() and get_user_roles_with_details()
-- got theirs in 20261127100300.)
--
-- verify_testimony(text, text) is also closed to the public roles: neither
-- site calls it, the verification pages use the three *_by_token functions.
--
-- To undo:
--   alter function public.is_admin() reset search_path;        (and the four others)
--   grant execute on function public.verify_testimony(text, text) to anon, authenticated;

-- The live site calls these functions in every policy: fail fast rather than
-- queue behind it.
set lock_timeout = '200ms';

alter function public.is_admin() set search_path = '';
alter function public.is_super_admin() set search_path = '';
alter function public.has_role(public.app_role, uuid) set search_path = '';
alter function public.get_audit_log(integer, integer) set search_path = '';
alter function public.verify_testimony(text, text) set search_path = '';

revoke execute on function public.verify_testimony(text, text) from public, anon, authenticated;
grant execute on function public.verify_testimony(text, text) to service_role;
