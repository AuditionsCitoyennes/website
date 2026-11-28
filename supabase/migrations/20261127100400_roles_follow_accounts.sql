-- A role belongs to an account, an audition outlives its author, and one
-- super admin always remains.
--
-- 1. user_roles.user_id references the account: a role row goes with its
--    account. The rows whose account is already gone are deleted first (their
--    number is printed).
-- 2. auditions.created_by becomes ON DELETE SET NULL, as testimonies.created_by
--    already is: an account that created auditions can be deleted, and its
--    auditions stay, without an author.
-- 3. The last super_admin row cannot be deleted, nor changed to another role,
--    whoever asks: through PostgREST, with the service role, or because the
--    account itself is being deleted (Auth then answers a database error and
--    the account stays). Two removals at once cannot both pass.
--
-- To undo:
--   drop trigger keep_one_super_admin on public.user_roles;
--   drop function public.keep_one_super_admin();
--   alter table public.user_roles drop constraint user_roles_user_id_fkey;
--   alter table public.auditions
--     drop constraint auditions_created_by_fkey,
--     add constraint auditions_created_by_fkey
--       foreign key (created_by) references auth.users (id);

-- The live site reads these tables and Auth writes auth.users: fail fast
-- rather than queue behind them.
set lock_timeout = '200ms';

do $$
declare
  v_gone bigint;
begin
  delete from public.user_roles ur
   where not exists (select 1 from auth.users u where u.id = ur.user_id);
  get diagnostics v_gone = row_count;
  raise notice 'role rows of accounts that no longer exist, deleted: %', v_gone;
end;
$$;

-- Added unchecked, then checked: the check reads the rows without holding
-- auth.users against writes.
alter table public.user_roles
  add constraint user_roles_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete cascade
  not valid;
alter table public.user_roles validate constraint user_roles_user_id_fkey;

alter table public.auditions
  drop constraint auditions_created_by_fkey,
  add constraint auditions_created_by_fkey
    foreign key (created_by) references auth.users (id) on delete set null
    not valid;
alter table public.auditions validate constraint auditions_created_by_fkey;

create function public.keep_one_super_admin() returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if old.role <> 'super_admin' or new.role = 'super_admin' then
      return new;
    end if;
  elsif old.role <> 'super_admin' then
    return old;
  end if;

  -- A super admin's role is going. One removal at a time: the second one
  -- waits here, then counts what the first one left.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public.user_roles:super_admin', 0));
  if not exists (
    select 1 from public.user_roles ur
     where ur.role = 'super_admin' and ur.id <> old.id
  ) then
    raise exception 'the last super admin keeps their role'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    return new;
  end if;
  return old;
end;
$$;

-- A trigger function is run by its trigger, whoever writes the row: nobody
-- needs to call it.
revoke execute on function public.keep_one_super_admin() from public, anon, authenticated;

create trigger keep_one_super_admin
  before delete or update of role on public.user_roles
  for each row execute function public.keep_one_super_admin();
