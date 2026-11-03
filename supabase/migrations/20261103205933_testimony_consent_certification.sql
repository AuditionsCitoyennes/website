-- Who certified a testimony's consent, and when.
--
-- A volunteer who types in testimonies heard at an in-person audition ticks
-- one box per submission: every witness agreed to be published, under the
-- name or pseudonym they chose, knowing it may reveal their opinions and that
-- they can have it removed at any time (for under-15s, with a parent's
-- agreement). The API stores, on each testimony it creates that way, the
-- signed-in volunteer and the time: what shows the consent was given.
--
-- Null on the testimonies sent online (their author ticks their own box and
-- validates by email) and on those published before this box existed.
--
-- The volunteer's account is deleted: consent_certified_by goes null with it,
-- as created_by does; consent_certified_at stays.
--
-- No column grant to anon or authenticated: they keep their nine columns
-- (scripts/db-checks/allowlist.json). Admins read testimonies through
-- admin_testimonies(), whose columns are its own.
set lock_timeout = '200ms';

alter table public.testimonies
  add column consent_certified_by uuid references auth.users (id) on delete set null,
  add column consent_certified_at timestamptz,
  add constraint testimonies_consent_certified_dated
    check (consent_certified_by is null or consent_certified_at is not null);

comment on column public.testimonies.consent_certified_by is
  'The volunteer who certified that the witness agreed to publication (null: sent online, or published before the certification).';
comment on column public.testimonies.consent_certified_at is
  'When the volunteer certified the witness''s agreement.';
