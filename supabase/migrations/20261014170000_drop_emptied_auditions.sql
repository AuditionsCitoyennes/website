-- An audition never outlives its last testimony.
--
-- When the last testimony of an audition goes — deleted by an admin, removed
-- by its witness through the emailed link (the site's server), cleared by the
-- online form's housekeeping — the audition goes with it, in the same
-- transaction. Done here rather than in the API so that it holds on every
-- path an admin or the server takes, the old app's admin pages included (it
-- shares this database).
--
-- Only an audition that loses a testimony is concerned: one just created and
-- not filled yet is left alone. Nothing moves a testimony to another audition,
-- so a move is not watched.

set lock_timeout = '200ms';

-- SECURITY DEFINER: the audition is removed whatever the deleter's own rights
-- on auditions — once the deleter is found to be an admin or the server (see
-- below). A trigger function cannot be called directly (nor through the API):
-- there is nothing to revoke.
--
-- lock_timeout: see the lock below.
create or replace function public.drop_emptied_audition()
returns trigger
language plpgsql
security definer
set search_path = ''
set lock_timeout = '300ms'
as $$
declare
  v_claims text;
  v_role text;
begin
  -- Who is deleting: the API role in the JWT PostgREST passes on (none for a
  -- direct connection: the server's own). Until the cutover, the legacy
  -- by-token policies let anyone — signed in or not — delete any pending
  -- testimony: the audition is not theirs to delete on top of it. Admins and
  -- the server only. (Claims that cannot be read: nobody's.)
  v_claims := nullif(current_setting('request.jwt.claims', true), '');
  begin
    v_role := case
      when v_claims is null then 'server'
      else coalesce(v_claims::jsonb ->> 'role', 'unknown')
    end;
  exception
    when others then
      v_role := 'unknown';
  end;
  if v_role not in ('server', 'service_role')
     and not (public.is_admin() or public.is_super_admin()) then
    return null;
  end if;

  -- Locked first: a testimony being added to it at this moment (its foreign
  -- key check, or the online form, holds the row) is committed before the
  -- check below, which then sees it — each statement here sees what was
  -- committed when it starts. Not found: already gone (deleted with its
  -- testimonies, or by an earlier row of the same statement).
  --
  -- Never a reason for the deletion of the testimony itself to fail: held
  -- longer than any write takes (300 ms, well under the 1 s after which
  -- Postgres looks for deadlocks), the audition is left as it is. That is the
  -- case of an audition being deleted at this very moment — its testimonies
  -- with it, this one waited for: waiting on would deadlock the two.
  begin
    perform 1 from public.auditions where id = old.audition_id for update;
    if found
       and not exists (select 1 from public.testimonies where audition_id = old.audition_id) then
      delete from public.auditions where id = old.audition_id;
    end if;
  exception
    when lock_not_available or deadlock_detected then
      null; -- left as it is
  end;
  return null;
end;
$$;

drop trigger if exists drop_emptied_audition_on_delete on public.testimonies;
create trigger drop_emptied_audition_on_delete
  after delete on public.testimonies
  for each row
  when (old.audition_id is not null)
  execute function public.drop_emptied_audition();

-- The online form: its housekeeping now runs BEFORE the month's audition is
-- taken. Expired testimonies it deletes can empty an audition, which the
-- trigger above then locks; done after, while this request already held its
-- own audition, two requests could each wait for the other's. The quota purge
-- comes last and skips rows someone else holds instead of waiting on them.
-- Otherwise unchanged (20261014150000).
create or replace function public.submit_online_testimony(
  p_email_hash text,
  p_person_name text,
  p_person_info text,
  p_content text,
  p_citycode text,
  p_location text,
  p_place jsonb,
  p_month date,
  p_title text,
  p_audition_content text,
  p_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_last timestamptz;
  v_audition uuid;
  v_created boolean := false;
  v_testimony uuid := gen_random_uuid();
begin
  -- One submission per email at a time: the quota check and the insert below
  -- cannot interleave with another request for the same address.
  perform pg_advisory_xact_lock(hashtextextended('online-testimony:' || p_email_hash, 0));

  -- Only testimonies that still exist count: one deleted — from its own
  -- email link, by its author — frees the week again.
  select max(created_at) into v_last
  from public.online_testimony_submissions
  where email_hash = p_email_hash
    and testimony_id is not null
    and created_at > now() - interval '7 days';
  if v_last is not null then
    -- PT429: PostgREST answers 429; the detail is when the next one is allowed.
    raise exception 'weekly_limit'
      using errcode = 'PT429', detail = to_char((v_last + interval '7 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  end if;

  -- Housekeeping, before anything is locked. Links expire after 14 days: what
  -- was never verified goes (and an audition it leaves empty, with it).
  -- Online auditions found empty a month later go too — those left so before
  -- auditions went with their last testimony.
  delete from public.testimonies t
  using public.auditions a
  where a.id = t.audition_id
    and a.audition_en_ligne
    and t.verification_status = 'pending'
    and t.created_at < now() - interval '15 days';
  delete from public.auditions a
  where a.audition_en_ligne
    and a."date" < (p_month - interval '1 month')::date
    and not exists (select 1 from public.testimonies t where t.audition_id = a.id);

  -- This place's audition of the month: created by its first testimony. Two
  -- first testimonies at once: one inserts, the other waits for it and finds
  -- it — locked, so that it cannot be deleted under this testimony. (Deleted
  -- between the two statements: inserted again on the next turn. Never a
  -- testimony without its audition: it would pass for an ordinary one.)
  loop
    insert into public.auditions
      (title, "date", location, content, status, audition_en_ligne, citycode, place)
    values
      (p_title, p_month, p_location, p_audition_content, 'published', true, p_citycode, p_place)
    on conflict (citycode, "date") where audition_en_ligne do nothing
    returning id into v_audition;
    if v_audition is not null then
      v_created := true;
      exit;
    end if;
    select id into v_audition
    from public.auditions
    where audition_en_ligne and citycode = p_citycode and "date" = p_month
    for key share;
    exit when v_audition is not null;
  end loop;

  insert into public.testimonies
    (id, audition_id, person_name, person_info, content, email, verification_status, verification_token, created_by)
  values
    (v_testimony, v_audition, p_person_name, p_person_info, p_content, null, 'pending', p_token, null);

  insert into public.online_testimony_submissions (testimony_id, email_hash)
  values (v_testimony, p_email_hash);

  -- And the quota forgets an address once its week is over. Last, and never
  -- waiting: a row someone else holds (a testimony being deleted clears its
  -- testimony_id) is purged next time.
  delete from public.online_testimony_submissions
  where id in (
    select id from public.online_testimony_submissions
    where created_at < now() - interval '8 days'
    for update skip locked
  );

  return jsonb_build_object(
    'testimony_id', v_testimony,
    'audition_id', v_audition,
    'audition_created', v_created
  );
end;
$$;
