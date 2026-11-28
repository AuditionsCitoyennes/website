-- What a signed-in account may set on a testimony it writes through PostgREST.
--
-- The policies say which rows an account writes; this trigger says which
-- columns keep the server's value on those rows. It restricts the two public
-- roles only: the service role, and the functions that run with their owner's
-- rights (validation by the emailed link, the online form), write as before.
-- So do the foreign keys' own actions, which run as the table's owner: an
-- account's deletion still clears created_by and consent_certified_by.
--
-- On insert:
--   - 'verified' is refused (42501): a testimony is validated by its witness,
--     through the link;
--   - created_by is the caller and created_at the current time;
--   - a consent certification is the caller's own, dated now, or absent.
-- On update:
--   - 'verified' is refused when the row was not validated already; a
--     validated row keeps its status through other changes (its themes), or
--     goes back to 'pending';
--   - audition_id, created_by, created_at and the two consent columns keep
--     their values.
--
-- To undo:
--   drop trigger testimonies_write_guard on public.testimonies;
--   drop function public.testimonies_write_guard();

-- The live site reads and writes this table: fail fast rather than queue behind it.
set lock_timeout = '200ms';

create function public.testimonies_write_guard() returns trigger
  language plpgsql
  security invoker
  set search_path = ''
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.verification_status = 'verified' then
      raise exception 'a testimony is validated by its witness, through the emailed link'
        using errcode = '42501';
    end if;
    new.created_by := auth.uid();
    new.created_at := pg_catalog.now();
    if new.consent_certified_by is null then
      new.consent_certified_at := null;
    else
      new.consent_certified_by := auth.uid();
      new.consent_certified_at := pg_catalog.now();
    end if;
    return new;
  end if;

  if new.verification_status = 'verified'
     and old.verification_status is distinct from 'verified' then
    raise exception 'a testimony is validated by its witness, through the emailed link'
      using errcode = '42501';
  end if;
  new.audition_id := old.audition_id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.consent_certified_by := old.consent_certified_by;
  new.consent_certified_at := old.consent_certified_at;
  return new;
end;
$$;

-- A trigger function is run by its trigger, whoever writes the row: nobody
-- needs to call it.
revoke execute on function public.testimonies_write_guard() from public, anon, authenticated;

create trigger testimonies_write_guard
  before insert or update on public.testimonies
  for each row execute function public.testimonies_write_guard();
