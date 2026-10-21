-- Online testimonies: the weekly quota counts only testimonies that still exist.
--
-- Someone who deletes their testimony from the link in the confirmation email
-- (or whose testimony is removed) may send another one within the same week.
-- The quota rows stay as they were (their testimony_id is set to NULL when
-- the testimony goes, by the foreign key) and are purged after 8 days as
-- before; only the check below changes.

set lock_timeout = '200ms';

comment on column public.online_testimony_submissions.testimony_id is
  'The testimony this submission created; NULL once it is deleted — and then it no longer counts towards the weekly quota.';

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

  -- Housekeeping. Links expire after 14 days: what was never verified goes.
  -- Online auditions left empty go too — a month late, so as never to touch
  -- one a request begun just before midnight is still filling. And the quota
  -- forgets an address once its week is over.
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
  delete from public.online_testimony_submissions
  where created_at < now() - interval '8 days';

  return jsonb_build_object(
    'testimony_id', v_testimony,
    'audition_id', v_audition,
    'audition_created', v_created
  );
end;
$$;
