-- An account's profile data holds at most 16 kB.
--
-- The profile (auth.users.raw_user_meta_data) is what an account says about
-- itself: the sign-up form's name and presentation, a provider's claims. Both
-- sites send well under 2 kB. Auth stores whatever it is sent, at sign-up and
-- on every later change by the account, so the bound is set where the value
-- is written: a trigger on auth.users refuses a value over 16 kB when it is
-- new or differs from the stored one. A row that already holds more keeps
-- signing in and can be updated in its other columns; this file prints how
-- many such rows exist.
--
-- The trigger function lives outside schema auth and reads no table. Where
-- the migration role may not create a trigger on auth.users, the file says so
-- in a NOTICE and the bound is then set by Auth's "Before User Created" hook
-- (Authentication > Hooks, function public.hook_before_user_created), which
-- covers sign-ups only. The hook function is created either way, executable
-- by Auth's role alone, and does nothing until the dashboard names it.
--
-- To undo:
--   drop trigger if exists profile_bound on auth.users;
--   drop function public.enforce_profile_bound();
--   drop function public.hook_before_user_created(jsonb);

-- Auth writes this table at every sign-in: fail fast rather than queue behind it.
set lock_timeout = '200ms';

create function public.enforce_profile_bound() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if coalesce(pg_catalog.octet_length(new.raw_user_meta_data::text), 0) <= 16384 then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.raw_user_meta_data is not distinct from old.raw_user_meta_data then
      return new;
    end if;
  end if;
  raise exception 'the profile data of an account holds at most 16 kB'
    using errcode = '22023';
end;
$$;

-- A trigger function is run by its trigger, whoever writes the row: nobody
-- needs to call it.
revoke execute on function public.enforce_profile_bound() from public, anon, authenticated;

create function public.hook_before_user_created(event jsonb) returns jsonb
  language plpgsql
  stable
  set search_path = ''
as $$
begin
  if pg_catalog.octet_length((event -> 'user' -> 'user_metadata')::text) > 16384 then
    return pg_catalog.jsonb_build_object(
      'error', pg_catalog.jsonb_build_object(
        'http_code', 422,
        'message', 'the profile data of an account holds at most 16 kB'));
  end if;
  return '{}'::jsonb;
end;
$$;

revoke execute on function public.hook_before_user_created(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;

do $$
declare
  v_over bigint;
begin
  begin
    create trigger profile_bound
      before insert or update of raw_user_meta_data on auth.users
      for each row execute function public.enforce_profile_bound();
    raise notice 'profile bound installed: a trigger on auth.users refuses profile data over 16 kB';
  exception when insufficient_privilege then
    raise notice 'profile bound not installed: this role may not create a trigger on auth.users. Set Authentication > Hooks > Before User Created to public.hook_before_user_created';
  end;

  select count(*) into v_over
    from auth.users u
   where pg_catalog.octet_length(u.raw_user_meta_data::text) > 16384;
  raise notice 'accounts whose stored profile data is over 16 kB: %', v_over;
end;
$$;
