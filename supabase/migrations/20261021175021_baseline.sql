-- Baseline: production's schema as it really was on 2026-10-21, dumped with
-- `supabase db dump --linked` after that day's security fixes. Structure only,
-- never rows.
--
-- It replaces every earlier migration file. Production had been edited
-- outside them, so they no longer rebuilt it: a blank database made from them
-- differed in its policies, functions and constraints. The old files are in
-- the git history; the cutover draft that was held back sits in
-- supabase/cutover/ and must be rewritten against this schema before use.
--
-- On production, the migration history marks the old versions reverted and
-- this one applied (`supabase migration repair`). Local, staging and CI
-- databases are built from this file onwards.




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."app_role" AS ENUM (
    'admin',
    'moderator',
    'user',
    'super_admin'
);


ALTER TYPE "public"."app_role" OWNER TO "postgres";


CREATE TYPE "public"."audition_status" AS ENUM (
    'published',
    'draft'
);


ALTER TYPE "public"."audition_status" OWNER TO "postgres";


CREATE TYPE "public"."geocode_precision" AS ENUM (
    'housenumber',
    'street',
    'venue',
    'municipality',
    'unknown'
);


ALTER TYPE "public"."geocode_precision" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_testimonies"("p_audition_id" "uuid" DEFAULT NULL::"uuid", "p_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("id" "uuid", "audition_id" "uuid", "person_name" "text", "person_info" "text", "content" "text", "topics" "text"[], "email" "text", "verification_status" "text", "created_by" "uuid", "created_at" timestamp with time zone)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not (public.is_admin() or public.is_super_admin()) then
    raise exception 'Accès réservé aux administrateurs' using errcode = '42501';
  end if;
  if p_audition_id is null and p_id is null then
    raise exception 'p_audition_id ou p_id requis' using errcode = '22023';
  end if;
  return query
    select t.id, t.audition_id, t.person_name, t.person_info, t.content, t.topics,
           t.email, t.verification_status, t.created_by, t.created_at
    from public.testimonies t
    where (p_audition_id is null or t.audition_id = p_audition_id)
      and (p_id is null or t.id = p_id)
    order by t.created_at, t.id;
end;
$$;


ALTER FUNCTION "public"."admin_testimonies"("p_audition_id" "uuid", "p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."drop_emptied_audition"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    SET "lock_timeout" TO '300ms'
    AS $$
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


ALTER FUNCTION "public"."drop_emptied_audition"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_audit_log"("p_limit" integer DEFAULT 20, "p_offset" integer DEFAULT 0) RETURNS TABLE("id" "uuid", "action" "text", "target_type" "text", "target_id" "text", "metadata" "jsonb", "created_at" timestamp with time zone, "user_email" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  -- Only super_admin can call this
  IF NOT public.is_super_admin() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    al.id,
    al.action,
    al.target_type,
    al.target_id,
    al.metadata,
    al.created_at,
    u.email::text AS user_email
  FROM public.audit_log al
  LEFT JOIN auth.users u ON u.id = al.user_id
  ORDER BY al.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;


ALTER FUNCTION "public"."get_audit_log"("p_limit" integer, "p_offset" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_pending_registrations"() RETURNS TABLE("user_id" "uuid", "email" "text", "username" "text", "bio" "text", "created_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    u.id as user_id,
    u.email::text,
    (u.raw_user_meta_data->>'username')::text as username,
    (u.raw_user_meta_data->>'bio')::text as bio,
    u.created_at
  FROM auth.users u
  WHERE u.email_confirmed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur WHERE ur.user_id = u.id
    )
  ORDER BY u.created_at DESC;
END;
$$;


ALTER FUNCTION "public"."get_pending_registrations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_user_roles_with_details"() RETURNS TABLE("id" "uuid", "user_id" "uuid", "role" "text", "created_at" timestamp with time zone, "email" "text", "username" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    ur.id,
    ur.user_id,
    ur.role::text,
    ur.created_at,
    u.email::text,
    (u.raw_user_meta_data->>'username')::text as username
  FROM public.user_roles ur
  LEFT JOIN auth.users u ON u.id = ur.user_id
  ORDER BY ur.created_at DESC;
END;
$$;


ALTER FUNCTION "public"."get_user_roles_with_details"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_role"("_role" "public"."app_role", "_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _user_id AND role = _role
    );
  $$;


ALTER FUNCTION "public"."has_role"("_role" "public"."app_role", "_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_verified_testimony"("p_audition" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.testimonies
    where audition_id = p_audition and verification_status = 'verified'
  )
$$;


ALTER FUNCTION "public"."has_verified_testimony"("p_audition" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."insert_audit_log"("p_user_id" "uuid", "p_action" "text", "p_target_type" "text" DEFAULT NULL::"text", "p_target_id" "text" DEFAULT NULL::"text", "p_metadata" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  INSERT INTO public.audit_log (user_id, action, target_type, target_id, metadata)
  VALUES (p_user_id, p_action, p_target_type, p_target_id, p_metadata);
END;
$$;


ALTER FUNCTION "public"."insert_audit_log"("p_user_id" "uuid", "p_action" "text", "p_target_type" "text", "p_target_id" "text", "p_metadata" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role IN ('admin', 'super_admin')
    );
  $$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_online_audition"("p_audition" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce((select audition_en_ligne from public.auditions where id = p_audition), false)
$$;


ALTER FUNCTION "public"."is_online_audition"("p_audition" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_super_admin"() RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'super_admin'
    );
  $$;


ALTER FUNCTION "public"."is_super_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."online_testimony_ids"("p_unverified_only" boolean) RETURNS "uuid"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(array_agg(t.id), '{}'::uuid[])
  from public.testimonies t
  join public.auditions a on a.id = t.audition_id
  where a.audition_en_ligne
    and (not p_unverified_only or t.verification_status is distinct from 'verified')
$$;


ALTER FUNCTION "public"."online_testimony_ids"("p_unverified_only" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reject_testimony_by_token"("p_token" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if p_token is null then
    return false;
  end if;
  delete from public.testimonies t
   where t.verification_token::text = p_token
     and t.verification_status = 'pending'
     and t.created_at >= now() - interval '14 days'
     and not public.is_online_audition(t.audition_id);
  return found;
end;
$$;


ALTER FUNCTION "public"."reject_testimony_by_token"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_online_testimony"("p_email_hash" "text", "p_person_name" "text", "p_person_info" "text", "p_content" "text", "p_citycode" "text", "p_location" "text", "p_place" "jsonb", "p_month" "date", "p_title" "text", "p_audition_content" "text", "p_token" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."submit_online_testimony"("p_email_hash" "text", "p_person_name" "text", "p_person_info" "text", "p_content" "text", "p_citycode" "text", "p_location" "text", "p_place" "jsonb", "p_month" "date", "p_title" "text", "p_audition_content" "text", "p_token" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."testimony_for_verification"("p_token" "text") RETURNS TABLE("id" "uuid", "person_name" "text", "person_info" "text", "content" "text", "verification_status" "text", "audition_id" "uuid", "created_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select t.id, t.person_name, t.person_info, t.content,
         t.verification_status, t.audition_id, t.created_at
  from public.testimonies t
  where p_token is not null
    and t.verification_token::text = p_token
    and not public.is_online_audition(t.audition_id)
$$;


ALTER FUNCTION "public"."testimony_for_verification"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verify_testimony"("p_action" "text", "p_token" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_testimony_id uuid;
  v_created_at timestamptz;
BEGIN
  -- Find the testimony and check creation date
  SELECT id, created_at INTO v_testimony_id, v_created_at
  FROM public.testimonies
  WHERE verification_token = p_token
    AND verification_status = 'pending';

  IF v_testimony_id IS NULL THEN
    RETURN false;
  END IF;

  -- Check if token is expired (14 days)
  IF v_created_at < now() - interval '14 days' THEN
    RETURN false;
  END IF;

  IF p_action = 'verify' THEN
    UPDATE public.testimonies
    SET verification_status = 'verified'
    WHERE id = v_testimony_id;
    RETURN true;
  ELSIF p_action = 'reject' THEN
    DELETE FROM public.testimonies
    WHERE id = v_testimony_id;
    RETURN true;
  END IF;

  RETURN false;
END;
$$;


ALTER FUNCTION "public"."verify_testimony"("p_action" "text", "p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verify_testimony_by_token"("p_token" "text", "p_edits" "jsonb" DEFAULT NULL::"jsonb") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_name text := nullif(btrim(p_edits ->> 'person_name'), '');
  v_info text := nullif(btrim(p_edits ->> 'person_info'), '');
  v_content text := nullif(btrim(p_edits ->> 'content'), '');
begin
  if p_token is null then
    return false;
  end if;
  if p_edits is not null and (
    v_name is null or v_content is null
    or length(v_name) > 200
    or length(coalesce(v_info, '')) > 500
    or length(v_content) > 20000
  ) then
    raise exception 'Modifications invalides' using errcode = '22023';
  end if;

  update public.testimonies t
     set verification_status = 'verified',
         person_name = case when p_edits is null then t.person_name else v_name end,
         person_info = case when p_edits is null then t.person_info else v_info end,
         content = case when p_edits is null then t.content else v_content end
   where t.verification_token::text = p_token
     and t.verification_status = 'pending'
     and t.created_at >= now() - interval '14 days'
     and not public.is_online_audition(t.audition_id);
  return found;
end;
$$;


ALTER FUNCTION "public"."verify_testimony_by_token"("p_token" "text", "p_edits" "jsonb") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "action" "text" NOT NULL,
    "target_type" "text",
    "target_id" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."auditions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "date" "date" NOT NULL,
    "location" "text" NOT NULL,
    "content" "text" NOT NULL,
    "status" "public"."audition_status" DEFAULT 'published'::"public"."audition_status",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "audition_en_ligne" boolean DEFAULT false NOT NULL,
    "citycode" "text",
    "place" "jsonb",
    CONSTRAINT "auditions_en_ligne_shape" CHECK (((NOT "audition_en_ligne") OR (("citycode" IS NOT NULL) AND ("place" IS NOT NULL) AND ("date" = ("date_trunc"('month'::"text", ("date")::timestamp without time zone))::"date"))))
);


ALTER TABLE "public"."auditions" OWNER TO "postgres";


COMMENT ON COLUMN "public"."auditions"."audition_en_ligne" IS 'Audition en ligne : regroupe les témoignages déposés sur le site pour une mairie et un mois.';



CREATE TABLE IF NOT EXISTS "public"."testimonies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "audition_id" "uuid",
    "person_name" "text" NOT NULL,
    "person_info" "text",
    "content" "text" NOT NULL,
    "topics" "text"[],
    "email" "text",
    "verification_status" "text",
    "verification_token" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."testimonies" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."audition_testimony_counts" AS
 SELECT "t"."audition_id",
    ("count"(*))::integer AS "total_count",
    ("count"(*) FILTER (WHERE ("t"."verification_status" = 'verified'::"text")))::integer AS "verified_count"
   FROM ("public"."testimonies" "t"
     JOIN "public"."auditions" "a" ON (("a"."id" = "t"."audition_id")))
  WHERE ((NOT "a"."audition_en_ligne") OR ("t"."verification_status" = 'verified'::"text"))
  GROUP BY "t"."audition_id";


ALTER VIEW "public"."audition_testimony_counts" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."distinct_testimony_topics" AS
 SELECT DISTINCT "unnest"("t"."topics") AS "topic"
   FROM ("public"."testimonies" "t"
     JOIN "public"."auditions" "a" ON (("a"."id" = "t"."audition_id")))
  WHERE (("a"."status" = 'published'::"public"."audition_status") AND ("t"."topics" IS NOT NULL) AND ((NOT "a"."audition_en_ligne") OR ("t"."verification_status" = 'verified'::"text")));


ALTER VIEW "public"."distinct_testimony_topics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."imported_auditions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source" "text" NOT NULL,
    "source_id" "text" NOT NULL,
    "title" "text" NOT NULL,
    "held_on" "date",
    "address" "text",
    "city" "text",
    "postcode" "text",
    "citycode" "text",
    "lat" double precision,
    "lng" double precision,
    "geocode_precision" "public"."geocode_precision" NOT NULL,
    "testimony" "text" NOT NULL,
    "topics" "text"[] DEFAULT '{}'::"text"[],
    "url" "text",
    "license" "text" NOT NULL,
    "attribution" "text" NOT NULL,
    "retrieved_at" timestamp with time zone,
    "source_offset_m" real,
    "has_personal_data" boolean DEFAULT false NOT NULL,
    "redaction_applied" boolean DEFAULT false NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "imported_auditions_pd_gate" CHECK ((("status" <> 'published'::"text") OR ("has_personal_data" = false) OR ("redaction_applied" = true))),
    CONSTRAINT "imported_auditions_precise_coords" CHECK (((("geocode_precision" = ANY (ARRAY['housenumber'::"public"."geocode_precision", 'street'::"public"."geocode_precision", 'venue'::"public"."geocode_precision"])) AND ("lat" IS NOT NULL) AND ("lng" IS NOT NULL)) OR (("geocode_precision" = ANY (ARRAY['municipality'::"public"."geocode_precision", 'unknown'::"public"."geocode_precision"])) AND ("lat" IS NULL) AND ("lng" IS NULL)))),
    CONSTRAINT "imported_auditions_status_chk" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text"])))
);


ALTER TABLE "public"."imported_auditions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."online_testimony_submissions" (
    "id" bigint NOT NULL,
    "testimony_id" "uuid",
    "email_hash" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."online_testimony_submissions" OWNER TO "postgres";


COMMENT ON COLUMN "public"."online_testimony_submissions"."testimony_id" IS 'The testimony this submission created; NULL once it is deleted — and then it no longer counts towards the weekly quota.';



ALTER TABLE "public"."online_testimony_submissions" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."online_testimony_submissions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."user_roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "public"."app_role" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_roles" OWNER TO "postgres";


ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."auditions"
    ADD CONSTRAINT "auditions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."imported_auditions"
    ADD CONSTRAINT "imported_auditions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."imported_auditions"
    ADD CONSTRAINT "imported_auditions_source_uid" UNIQUE ("source", "source_id");



ALTER TABLE ONLY "public"."online_testimony_submissions"
    ADD CONSTRAINT "online_testimony_submissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."testimonies"
    ADD CONSTRAINT "testimonies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_role_key" UNIQUE ("user_id", "role");



CREATE UNIQUE INDEX "auditions_en_ligne_mairie_mois" ON "public"."auditions" USING "btree" ("citycode", "date") WHERE "audition_en_ligne";



CREATE INDEX "imported_auditions_citycode_idx" ON "public"."imported_auditions" USING "btree" ("citycode");



CREATE INDEX "imported_auditions_source_idx" ON "public"."imported_auditions" USING "btree" ("source");



CREATE INDEX "imported_auditions_status_idx" ON "public"."imported_auditions" USING "btree" ("status");



CREATE INDEX "online_testimony_submissions_email_idx" ON "public"."online_testimony_submissions" USING "btree" ("email_hash", "created_at");



CREATE INDEX "testimonies_audition_id_idx" ON "public"."testimonies" USING "btree" ("audition_id");



CREATE OR REPLACE TRIGGER "drop_emptied_audition_on_delete" AFTER DELETE ON "public"."testimonies" FOR EACH ROW WHEN (("old"."audition_id" IS NOT NULL)) EXECUTE FUNCTION "public"."drop_emptied_audition"();



CREATE OR REPLACE TRIGGER "set_imported_auditions_updated_at" BEFORE UPDATE ON "public"."imported_auditions" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."auditions"
    ADD CONSTRAINT "auditions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."online_testimony_submissions"
    ADD CONSTRAINT "online_testimony_submissions_testimony_id_fkey" FOREIGN KEY ("testimony_id") REFERENCES "public"."testimonies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."testimonies"
    ADD CONSTRAINT "testimonies_audition_id_fkey" FOREIGN KEY ("audition_id") REFERENCES "public"."auditions"("id");



ALTER TABLE ONLY "public"."testimonies"
    ADD CONSTRAINT "testimonies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



CREATE POLICY "Admin delete auditions" ON "public"."auditions" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "Admin delete roles" ON "public"."user_roles" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "Admin delete testimonies" ON "public"."testimonies" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "Admin insert auditions" ON "public"."auditions" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "Admin insert testimonies" ON "public"."testimonies" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "Admin read roles" ON "public"."user_roles" FOR SELECT USING ("public"."is_admin"());



CREATE POLICY "Admin update auditions" ON "public"."auditions" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "Admin update testimonies" ON "public"."testimonies" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "Anyone can view published imported auditions" ON "public"."imported_auditions" FOR SELECT USING (("status" = 'published'::"text"));



CREATE POLICY "Authenticated can delete imported auditions" ON "public"."imported_auditions" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "Authenticated can insert imported auditions" ON "public"."imported_auditions" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Authenticated can update imported auditions" ON "public"."imported_auditions" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Online auditions are changed by admins only" ON "public"."auditions" AS RESTRICTIVE FOR UPDATE TO "authenticated", "anon" USING (((NOT "audition_en_ligne") OR ( SELECT "public"."is_admin"() AS "is_admin") OR ( SELECT "public"."is_super_admin"() AS "is_super_admin"))) WITH CHECK (((NOT "audition_en_ligne") OR ( SELECT "public"."is_admin"() AS "is_admin") OR ( SELECT "public"."is_super_admin"() AS "is_super_admin")));



CREATE POLICY "Online auditions are created by the server only" ON "public"."auditions" AS RESTRICTIVE FOR INSERT TO "authenticated", "anon" WITH CHECK ((NOT "audition_en_ligne"));



CREATE POLICY "Online auditions are deleted by admins only" ON "public"."auditions" AS RESTRICTIVE FOR DELETE TO "authenticated", "anon" USING (((NOT "audition_en_ligne") OR ( SELECT "public"."is_admin"() AS "is_admin") OR ( SELECT "public"."is_super_admin"() AS "is_super_admin")));



CREATE POLICY "Online auditions are public once one testimony is verified" ON "public"."auditions" AS RESTRICTIVE FOR SELECT TO "authenticated", "anon" USING (((NOT "audition_en_ligne") OR ( SELECT "public"."is_admin"() AS "is_admin") OR ( SELECT "public"."is_super_admin"() AS "is_super_admin") OR "public"."has_verified_testimony"("id")));



CREATE POLICY "Online testimonies are added by admins only" ON "public"."testimonies" AS RESTRICTIVE FOR INSERT TO "authenticated", "anon" WITH CHECK ((( SELECT "public"."is_admin"() AS "is_admin") OR ( SELECT "public"."is_super_admin"() AS "is_super_admin") OR (NOT "public"."is_online_audition"("audition_id"))));



CREATE POLICY "Online testimonies are changed by admins only" ON "public"."testimonies" AS RESTRICTIVE FOR UPDATE TO "authenticated", "anon" USING ((( SELECT "public"."is_admin"() AS "is_admin") OR ( SELECT "public"."is_super_admin"() AS "is_super_admin") OR ("id" <> ALL (( SELECT "public"."online_testimony_ids"(false) AS "online_testimony_ids")::"uuid"[])))) WITH CHECK ((( SELECT "public"."is_admin"() AS "is_admin") OR ( SELECT "public"."is_super_admin"() AS "is_super_admin") OR (NOT "public"."is_online_audition"("audition_id"))));



CREATE POLICY "Online testimonies are deleted by admins only" ON "public"."testimonies" AS RESTRICTIVE FOR DELETE TO "authenticated", "anon" USING ((( SELECT "public"."is_admin"() AS "is_admin") OR ( SELECT "public"."is_super_admin"() AS "is_super_admin") OR ("id" <> ALL (( SELECT "public"."online_testimony_ids"(false) AS "online_testimony_ids")::"uuid"[]))));



CREATE POLICY "Online testimonies are public once verified" ON "public"."testimonies" AS RESTRICTIVE FOR SELECT TO "authenticated", "anon" USING ((( SELECT "public"."is_admin"() AS "is_admin") OR ( SELECT "public"."is_super_admin"() AS "is_super_admin") OR ("id" <> ALL (( SELECT "public"."online_testimony_ids"(true) AS "online_testimony_ids")::"uuid"[]))));



CREATE POLICY "Public read auditions" ON "public"."auditions" FOR SELECT USING (true);



CREATE POLICY "Public read testimonies" ON "public"."testimonies" FOR SELECT USING (true);



CREATE POLICY "Super admins grant roles" ON "public"."user_roles" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "public"."is_super_admin"() AS "is_super_admin"));



ALTER TABLE "public"."audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."auditions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."imported_auditions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."online_testimony_submissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "super_admin_read_audit_log" ON "public"."audit_log" FOR SELECT USING ("public"."is_super_admin"());



ALTER TABLE "public"."testimonies" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_roles" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































REVOKE ALL ON FUNCTION "public"."admin_testimonies"("p_audition_id" "uuid", "p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_testimonies"("p_audition_id" "uuid", "p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_testimonies"("p_audition_id" "uuid", "p_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."drop_emptied_audition"() TO "anon";
GRANT ALL ON FUNCTION "public"."drop_emptied_audition"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."drop_emptied_audition"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_audit_log"("p_limit" integer, "p_offset" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_audit_log"("p_limit" integer, "p_offset" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_audit_log"("p_limit" integer, "p_offset" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_pending_registrations"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_pending_registrations"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_pending_registrations"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_user_roles_with_details"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_roles_with_details"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_roles_with_details"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."has_role"("_role" "public"."app_role", "_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."has_role"("_role" "public"."app_role", "_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_role"("_role" "public"."app_role", "_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."has_verified_testimony"("p_audition" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."has_verified_testimony"("p_audition" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_verified_testimony"("p_audition" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."insert_audit_log"("p_user_id" "uuid", "p_action" "text", "p_target_type" "text", "p_target_id" "text", "p_metadata" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."insert_audit_log"("p_user_id" "uuid", "p_action" "text", "p_target_type" "text", "p_target_id" "text", "p_metadata" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."insert_audit_log"("p_user_id" "uuid", "p_action" "text", "p_target_type" "text", "p_target_id" "text", "p_metadata" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_online_audition"("p_audition" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_online_audition"("p_audition" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_online_audition"("p_audition" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_super_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_super_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_super_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."online_testimony_ids"("p_unverified_only" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."online_testimony_ids"("p_unverified_only" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."online_testimony_ids"("p_unverified_only" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reject_testimony_by_token"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reject_testimony_by_token"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."reject_testimony_by_token"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reject_testimony_by_token"("p_token" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_online_testimony"("p_email_hash" "text", "p_person_name" "text", "p_person_info" "text", "p_content" "text", "p_citycode" "text", "p_location" "text", "p_place" "jsonb", "p_month" "date", "p_title" "text", "p_audition_content" "text", "p_token" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_online_testimony"("p_email_hash" "text", "p_person_name" "text", "p_person_info" "text", "p_content" "text", "p_citycode" "text", "p_location" "text", "p_place" "jsonb", "p_month" "date", "p_title" "text", "p_audition_content" "text", "p_token" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."testimony_for_verification"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."testimony_for_verification"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."testimony_for_verification"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."testimony_for_verification"("p_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."verify_testimony"("p_action" "text", "p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."verify_testimony"("p_action" "text", "p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."verify_testimony"("p_action" "text", "p_token" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."verify_testimony_by_token"("p_token" "text", "p_edits" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."verify_testimony_by_token"("p_token" "text", "p_edits" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."verify_testimony_by_token"("p_token" "text", "p_edits" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."verify_testimony_by_token"("p_token" "text", "p_edits" "jsonb") TO "service_role";


















GRANT ALL ON TABLE "public"."audit_log" TO "anon";
GRANT ALL ON TABLE "public"."audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."auditions" TO "anon";
GRANT ALL ON TABLE "public"."auditions" TO "authenticated";
GRANT ALL ON TABLE "public"."auditions" TO "service_role";



GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."testimonies" TO "anon";
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."testimonies" TO "authenticated";
GRANT ALL ON TABLE "public"."testimonies" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."testimonies" TO "anon";
GRANT SELECT("id") ON TABLE "public"."testimonies" TO "authenticated";



GRANT SELECT("audition_id") ON TABLE "public"."testimonies" TO "anon";
GRANT SELECT("audition_id") ON TABLE "public"."testimonies" TO "authenticated";



GRANT SELECT("person_name") ON TABLE "public"."testimonies" TO "anon";
GRANT SELECT("person_name") ON TABLE "public"."testimonies" TO "authenticated";



GRANT SELECT("person_info") ON TABLE "public"."testimonies" TO "anon";
GRANT SELECT("person_info") ON TABLE "public"."testimonies" TO "authenticated";



GRANT SELECT("content") ON TABLE "public"."testimonies" TO "anon";
GRANT SELECT("content") ON TABLE "public"."testimonies" TO "authenticated";



GRANT SELECT("topics") ON TABLE "public"."testimonies" TO "anon";
GRANT SELECT("topics") ON TABLE "public"."testimonies" TO "authenticated";



GRANT SELECT("verification_status") ON TABLE "public"."testimonies" TO "anon";
GRANT SELECT("verification_status") ON TABLE "public"."testimonies" TO "authenticated";



GRANT SELECT("created_by") ON TABLE "public"."testimonies" TO "anon";
GRANT SELECT("created_by") ON TABLE "public"."testimonies" TO "authenticated";



GRANT SELECT("created_at") ON TABLE "public"."testimonies" TO "anon";
GRANT SELECT("created_at") ON TABLE "public"."testimonies" TO "authenticated";



GRANT ALL ON TABLE "public"."audition_testimony_counts" TO "anon";
GRANT ALL ON TABLE "public"."audition_testimony_counts" TO "authenticated";
GRANT ALL ON TABLE "public"."audition_testimony_counts" TO "service_role";



GRANT ALL ON TABLE "public"."distinct_testimony_topics" TO "anon";
GRANT ALL ON TABLE "public"."distinct_testimony_topics" TO "authenticated";
GRANT ALL ON TABLE "public"."distinct_testimony_topics" TO "service_role";



GRANT ALL ON TABLE "public"."imported_auditions" TO "anon";
GRANT ALL ON TABLE "public"."imported_auditions" TO "authenticated";
GRANT ALL ON TABLE "public"."imported_auditions" TO "service_role";



GRANT ALL ON TABLE "public"."online_testimony_submissions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."online_testimony_submissions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."online_testimony_submissions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."online_testimony_submissions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."user_roles" TO "anon";
GRANT ALL ON TABLE "public"."user_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_roles" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";
































-- ---------------------------------------------------------------------------
-- Privileges production took away. A dump restates the grants an object has,
-- not the ones it lost, and on a blank database the default privileges above
-- grant everything to anon/authenticated at creation time. Without this block
-- a database built from this file would expose testimonies' email and
-- verification_token again (see 20261021170000 in the git history).

-- Table-level SELECT goes; revoking it also drops column grants, so the
-- readable columns are granted again after it.
revoke select on table public.testimonies from anon, authenticated;
grant select (
  id,
  audition_id,
  person_name,
  person_info,
  content,
  topics,
  verification_status,
  created_by,
  created_at
) on public.testimonies to anon, authenticated;

-- The server alone (service role) reads and writes online submissions and
-- calls submit_online_testimony; admin_testimonies is for signed-in admins.
revoke all on table public.online_testimony_submissions from anon, authenticated;
revoke execute on function public.submit_online_testimony(
  text, text, text, text, text, text, jsonb, date, text, text, uuid
) from anon, authenticated;
revoke execute on function public.admin_testimonies(uuid, uuid) from anon;
