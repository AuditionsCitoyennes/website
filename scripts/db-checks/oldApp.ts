// The old app, replayed. Until cutover it shares the database: its pages read
// and write straight through PostgREST with the public key (anon) or a signed-in
// account's token (authenticated), and its edge functions with the service
// role. Every statement it sends (each .from() and .rpc() of its src and
// functions, at commit 2b303ee) is run here the same way, under `set local
// role`, inside one rolled-back transaction per check.
//
// checkOldApp: what its pages do keeps working. The public pages, the
// verification page, an admin on the auditions and testimonies they created,
// a super admin on everyone's, the registrations, the roles and the journal.
// It holds on every schema from the one before the access rules to the
// current one, so it can be run after each migration of that set.
//
// checkOldAppLimits: what its key and its tokens no longer do past those
// pages, on the current schema. The public key reads published content and
// calls the three by-token functions, nothing else; an admin neither reads
// nor writes another admin's content; an account whose role was removed reads
// none of its drafts; nobody validates a testimony or rewrites who wrote and
// certified it; a role goes with its account and one super admin remains; an
// account's profile data is bounded.

import { randomUUID } from "node:crypto";
import { lit, sqlJson } from "./psql";
import { asAuthenticated } from "./writes";

const SEEN = "pg_temp.old_app_seen";

const as = (role: "anon" | "service_role") => `
set local role ${role};
set local request.jwt.claims = ${lit(JSON.stringify({ role }))};`;

/** A statement as the current role: the rows it wrote, or the SQLSTATE that refused it. */
const writes = (step: string, statement: string) => `
do $step$
declare n bigint;
begin
  ${statement};
  get diagnostics n = row_count;
  insert into ${SEEN} values (${lit(step)}, 'rows ' || n);
exception when others then
  insert into ${SEEN} values (${lit(step)}, 'refused ' || sqlstate);
end $step$;`;

/** A query (or a statement with RETURNING) as the current role: the rows it
 *  answers, those matching `only` when given, or the SQLSTATE that refused it. */
const reads = (step: string, query: string, only = "true") => `
do $step$
declare n bigint;
begin
  with q as (${query}) select count(*) into n from q where ${only};
  insert into ${SEEN} values (${lit(step)}, 'rows ' || n);
exception when others then
  insert into ${SEEN} values (${lit(step)}, 'refused ' || sqlstate);
end $step$;`;

/** A call that answers nothing, as the current role: done, or the SQLSTATE that refused it. */
const calls = (step: string, call: string) => `
do $step$
begin
  perform ${call};
  insert into ${SEEN} values (${lit(step)}, 'done');
exception when others then
  insert into ${SEEN} values (${lit(step)}, 'refused ' || sqlstate);
end $step$;`;

/** One value as the current role, as text, or the SQLSTATE that refused it. */
const says = (step: string, expression: string) => `
do $step$
begin
  insert into ${SEEN} values (${lit(step)}, coalesce((${expression})::text, 'null'));
exception when others then
  insert into ${SEEN} values (${lit(step)}, 'refused ' || sqlstate);
end $step$;`;

type Seen = Record<string, string>;

/** Runs the script in a rolled-back transaction; returns what each step saw. */
function replay(script: string): Seen {
  const [seen] = sqlJson<Seen>(`
begin;
create temp table old_app_seen (step text, outcome text) on commit drop;
grant insert on ${SEEN} to anon, authenticated, service_role;
${script}
reset role;
select coalesce(pg_catalog.jsonb_object_agg(step, outcome), '{}'::jsonb) from ${SEEN};
rollback;`);
  return seen;
}

function compare(seen: Seen, expected: Record<string, string>): string[] {
  return Object.entries(expected)
    .filter(([step, want]) => seen[step] !== want)
    .map(([step, want]) => `${step}: ${seen[step] ?? "not run"}, expected ${want}`);
}

const uuid = (id: string) => `${lit(id)}::uuid`;
const uuids = (ids: string[]) => `array[${ids.map(uuid).join(", ")}]`;

/** Accounts as Auth stores them: confirmed, with the sign-up form's name. */
const accounts = (list: { id: string; name: string; bio?: string }[]) => `
insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, raw_user_meta_data) values
${list
  .map(
    (a) =>
      `  (${lit(a.id)}, 'authenticated', 'authenticated', ${lit(`old-app-${a.id}@example.invalid`)}, pg_catalog.now(), pg_catalog.now(), ${lit(
        JSON.stringify({ username: a.name, ...(a.bio === undefined ? {} : { bio: a.bio }) }),
      )}::jsonb)`,
  )
  .join(",\n")};`;

const ONLINE_CITYCODE = "old-app-check";

export function checkOldApp(): string[] {
  const [superAdmin, admin, other, leaving, removed, pending] = Array.from({ length: 6 }, () =>
    randomUUID(),
  );
  // The other admin's audition, with three testimonies: one to validate by its
  // link, one without a link, one to refuse by its link.
  const theirs = randomUUID();
  const [toValidate, plain, toRefuse] = [randomUUID(), randomUUID(), randomUUID()];
  const [validateToken, refuseToken] = [randomUUID(), randomUUID()];
  const theirDraft = randomUUID();
  const online = randomUUID();
  // What the admin creates through the pages.
  const [mine, myDraft] = [randomUUID(), randomUUID()];
  const [first, second, third, added, bySuperAdmin] = Array.from({ length: 5 }, () => randomUUID());
  const [firstToken, editToken] = [randomUUID(), randomUUID()];
  const removedRole = randomUUID();
  const edits = { person_name: "Témoin relu", person_info: "Relu", content: "Texte relu" };
  const ours = uuids([theirs, theirDraft, online, mine, myDraft]);

  const seen = replay(`
${accounts([
  { id: superAdmin, name: "super admin" },
  { id: admin, name: "admin" },
  { id: other, name: "autre admin" },
  { id: leaving, name: "admin sur le départ" },
  { id: removed, name: "admin retiré" },
  { id: pending, name: "inscription", bio: "Je voudrais aider." },
])}
insert into public.user_roles (user_id, role) values
  (${lit(superAdmin)}, 'super_admin'), (${lit(admin)}, 'admin'), (${lit(other)}, 'admin'),
  (${lit(leaving)}, 'admin');
insert into public.user_roles (id, user_id, role) values (${lit(removedRole)}, ${lit(removed)}, 'admin');
insert into public.auditions (id, title, date, location, content, status, created_by) values
  (${lit(theirs)}, 'old app: publiée', current_date, 'Lyon', 'Audition de contrôle', 'published', ${lit(other)}),
  (${lit(theirDraft)}, 'old app: brouillon', current_date, 'Lyon', 'Audition de contrôle', 'draft', ${lit(other)});
insert into public.auditions (id, title, date, location, content, status, audition_en_ligne, citycode, place) values
  (${lit(online)}, 'old app: en ligne', pg_catalog.date_trunc('month', current_date)::date, 'Mairie de contrôle',
   'Audition en ligne de contrôle', 'published', true, ${lit(ONLINE_CITYCODE)}, '{"insee": "old-app-check"}'::jsonb);
insert into public.testimonies (id, audition_id, person_name, content, topics, email, verification_status, verification_token, created_by) values
  (${lit(toValidate)}, ${lit(theirs)}, 'Témoin 1', 'À valider', array['old-app-check-topic'], 'temoin-1@example.invalid', 'pending', ${lit(validateToken)}, ${lit(other)}),
  (${lit(plain)}, ${lit(theirs)}, 'Témoin 2', 'Sans lien', null, null, null, null, ${lit(other)}),
  (${lit(toRefuse)}, ${lit(theirs)}, 'Témoin 3', 'À refuser', null, 'temoin-3@example.invalid', 'pending', ${lit(refuseToken)}, ${lit(other)}),
  (${lit(randomUUID())}, ${lit(theirDraft)}, 'Témoin 4', 'Dans un brouillon', null, null, null, null, ${lit(other)}),
  (${lit(randomUUID())}, ${lit(online)}, 'Témoin 5', 'En ligne, validé', null, null, 'verified', null, null);

-- The public pages, with the public key.
${as("anon")}
${says("anon: is_admin (useAdminRole)", "public.is_admin()")}
${says("anon: is_super_admin (useSuperAdminRole)", "public.is_super_admin()")}
${reads(
  "anon: published auditions (Index, Analysis)",
  "select id, title, date, location from public.auditions where status = 'published' order by date desc",
  `id = any (${ours})`,
)}
${says(
  "anon: counts of a published audition (Index)",
  `(select total_count || '/' || verified_count from (
     select audition_id, total_count, verified_count from public.audition_testimony_counts) c
    where audition_id = ${uuid(theirs)})`,
)}
${reads(
  "anon: one published audition (AuditionDetail)",
  `select * from public.auditions where id = ${uuid(theirs)} and status = 'published'`,
)}
${reads(
  "anon: its testimonies (AuditionDetail)",
  `select id, audition_id, person_name, person_info, content, topics, verification_status, created_by, created_at
     from public.testimonies where audition_id = ${uuid(theirs)} order by created_at asc`,
  "created_by is not null and created_at is not null",
)}
${reads(
  "anon: auditions of the filters (TestimoniesPanel)",
  "select id, date, location from public.auditions where status = 'published'",
  `id = ${uuid(theirs)}`,
)}
${reads(
  "anon: topics (TestimoniesPanel)",
  "select topic from public.distinct_testimony_topics order by topic asc",
  "topic = 'old-app-check-topic'",
)}
${reads("anon: testimony count (TestimoniesPanel)", "select count(*) from (select id from public.testimonies) t")}
${reads(
  "anon: validated count (TestimoniesPanel)",
  "select count(*) from (select id from public.testimonies where verification_status = 'verified') t",
)}
${reads(
  "anon: a page of testimonies with their audition (TestimoniesPanel)",
  `select t.id, t.person_name, t.person_info, t.content, t.topics, t.verification_status, t.created_at,
          a.id as a_id, a.title, a.location, a.date
     from public.testimonies t left join public.auditions a on a.id = t.audition_id
    where t.audition_id = any (${ours})
    order by t.created_at desc limit 20`,
  "a_id is not null",
)}
${reads("anon: topics per audition (Analysis)", "select topics, audition_id from public.testimonies", `audition_id = ${uuid(theirs)}`)}

-- The verification page, with the public key and the emailed token.
${reads(
  "anon: the testimony of a link (VerifyTestimony)",
  `select * from public.testimony_for_verification(${lit(validateToken)})`,
  "verification_status = 'pending' and created_at is not null",
)}
${reads(
  "anon: its audition (VerifyTestimony)",
  `select location, date, title from public.auditions where id = ${uuid(theirs)}`,
)}
${says(
  "anon: validate with corrections (VerifyTestimony)",
  `public.verify_testimony_by_token(${lit(validateToken)}, ${lit(JSON.stringify(edits))}::jsonb)`,
)}
${says("anon: refuse (VerifyTestimony)", `public.reject_testimony_by_token(${lit(refuseToken)})`)}
reset role;
${says(
  "the validated testimony",
  `(select verification_status || ': ' || person_name || ' / ' || content from public.testimonies where id = ${uuid(toValidate)})`,
)}
${says("the refused testimony", `(select count(*) from public.testimonies where id = ${uuid(toRefuse)})`)}

-- An admin, on the auditions and testimonies they create (Admin, TestimonyManager, TestimonyEditDialog).
${asAuthenticated(admin)}
${says("admin: is_admin", "public.is_admin()")}
${says("admin: is_super_admin", "public.is_super_admin()")}
${reads(
  "admin: creates a published audition (Admin)",
  `insert into public.auditions (id, title, date, location, content, status, created_by)
   values (${lit(mine)}, 'old app: la mienne', current_date, 'Lyon', 'Audition de contrôle', 'published', ${lit(admin)})
   returning id`,
)}
${reads(
  "admin: creates a draft (Admin)",
  `insert into public.auditions (id, title, date, location, content, status, created_by)
   values (${lit(myDraft)}, 'old app: mon brouillon', current_date, 'Lyon', 'Audition de contrôle', 'draft', ${lit(admin)})
   returning id`,
)}
${writes(
  "admin: its testimonies with the audition (Admin)",
  `insert into public.testimonies (id, audition_id, person_name, person_info, content, email, topics, verification_status, verification_token, created_by) values
     (${lit(first)}, ${lit(mine)}, 'Anne', '34 ans', 'Premier texte', 'anne@example.invalid', array['Logement'], 'pending', ${lit(firstToken)}, ${lit(admin)}),
     (${lit(second)}, ${lit(mine)}, 'Bruno', null, 'Deuxième texte', null, null, null, null, ${lit(admin)}),
     (${lit(third)}, ${lit(mine)}, 'Chloé', null, 'Troisième texte', null, null, null, null, ${lit(admin)})`,
)}
${writes(
  "admin: adds a testimony (TestimonyManager)",
  `insert into public.testimonies (id, audition_id, person_name, person_info, content, created_by, email, verification_status)
   values (${lit(added)}, ${lit(myDraft)}, 'Denis', null, 'Dans mon brouillon', ${lit(admin)}, null, null)`,
)}
${reads(
  "admin: the list (Admin)",
  "select id, title, date, location, status, created_by from public.auditions order by date desc",
  `id = any (${uuids([mine, myDraft, theirs])})`,
)}
${reads(
  "admin: testimonies of an own audition, with emails (Admin)",
  `select * from public.admin_testimonies(p_audition_id => ${uuid(mine)})`,
)}
${writes(
  "admin: edits an own testimony (TestimonyEditDialog)",
  `update public.testimonies
      set person_name = 'Anne B.', person_info = '35 ans', content = 'Premier texte, corrigé',
          email = 'anne@example.invalid', topics = array['Logement', 'Transports'], verification_status = 'pending'
    where id = ${uuid(first)}`,
)}
${writes(
  "admin: gives it a new link (TestimonyEditDialog)",
  `update public.testimonies set verification_token = ${lit(editToken)} where id = ${uuid(first)}`,
)}
reset role;
${as("anon")}
${says("anon: validates the admin's testimony by its new link", `public.verify_testimony_by_token(${lit(editToken)}, null)`)}
reset role;
${asAuthenticated(admin)}
${writes(
  "admin: themes of a validated testimony (TestimonyManager, Admin)",
  `update public.testimonies set topics = array['Santé'] where id = ${uuid(first)}`,
)}
${reads(
  "admin: opens an own draft to edit it (Admin)",
  `select title, date, location, content, status from public.auditions where id = ${uuid(myDraft)}`,
)}
${writes(
  "admin: publishes the draft (Admin)",
  `update public.auditions
      set title = 'old app: publié', date = current_date, location = 'Lyon', content = 'Audition de contrôle', status = 'published'
    where id = ${uuid(myDraft)}`,
)}
${writes("admin: deletes an own testimony (TestimonyManager)", `delete from public.testimonies where id = ${uuid(third)}`)}
reset role;
${says(
  "the validated testimony keeps its status through the themes",
  `(select verification_status || ': ' || pg_catalog.array_to_string(topics, ',') from public.testimonies where id = ${uuid(first)})`,
)}

-- A super admin, on everyone's content, the registrations, the roles and the journal.
${asAuthenticated(superAdmin)}
${says("super admin: is_super_admin", "public.is_super_admin()")}
${writes(
  "super admin: adds a testimony to an admin's audition (TestimonyManager)",
  `insert into public.testimonies (id, audition_id, person_name, person_info, content, created_by, email, verification_status)
   values (${lit(bySuperAdmin)}, ${lit(mine)}, 'Élise', null, 'Ajouté par un super admin', ${lit(superAdmin)}, null, null)`,
)}
${reads(
  "super admin: every draft in the list (Admin)",
  "select id, title, date, location, status, created_by from public.auditions order by date desc",
  `id = ${uuid(theirDraft)}`,
)}
${reads(
  "super admin: testimonies of anyone's audition (Admin)",
  `select * from public.admin_testimonies(p_audition_id => ${uuid(theirs)})`,
  "email is null or email = 'temoin-1@example.invalid'",
)}
${writes(
  "super admin: edits anyone's testimony (TestimonyEditDialog)",
  `update public.testimonies
      set person_name = 'Témoin 2', person_info = null, content = 'Sans lien, corrigé', email = null, topics = null
    where id = ${uuid(plain)}`,
)}
${writes(
  "super admin: edits anyone's audition (Admin)",
  `update public.auditions
      set title = 'old app: publiée, revue', date = current_date, location = 'Lyon', content = 'Audition de contrôle', status = 'published'
    where id = ${uuid(theirs)}`,
)}
${reads(
  "super admin: testimonies to analyse (Admin)",
  `select id, content, topics from public.testimonies where audition_id = ${uuid(theirs)}`,
)}
${writes(
  "super admin: themes of anyone's testimony (Admin)",
  `update public.testimonies set topics = array['Emploi'] where id = ${uuid(plain)}`,
)}
${writes("super admin: deletes anyone's testimony (TestimonyManager)", `delete from public.testimonies where id = ${uuid(plain)}`)}
${reads(
  "super admin: the roles (Admin)",
  "select * from public.get_user_roles_with_details()",
  `user_id = ${uuid(admin)} and role = 'admin' and username = 'admin'`,
)}
${reads(
  "super admin: the registrations (Admin)",
  "select * from public.get_pending_registrations()",
  `user_id = ${uuid(pending)} and username = 'inscription' and bio = 'Je voudrais aider.'`,
)}
${writes("super admin: removes a role (Admin)", `delete from public.user_roles where id = ${uuid(removedRole)}`)}
${calls(
  "super admin: its 'role_deleted' line (Admin)",
  `public.insert_audit_log(${uuid(superAdmin)}, 'role_deleted', 'user', ${lit(removed)},
     ${lit(JSON.stringify({ target_email: "retire@example.invalid", target_username: "admin retiré", role: "admin" }))}::jsonb)`,
)}
reset role;

-- An admin deletes an own audition: its testimonies first, a super admin's
-- and a validated one among them, then the audition.
${asAuthenticated(admin)}
${writes("admin: deletes the testimonies of an own audition (Admin)", `delete from public.testimonies where audition_id = ${uuid(mine)}`)}
${writes("admin: then the audition (Admin)", `delete from public.auditions where id = ${uuid(mine)}`)}
reset role;
${says("the deleted audition", `(select count(*) from public.auditions where id = ${uuid(mine)})`)}

-- An admin deletes their account from the old page: the line, then their role.
${asAuthenticated(leaving)}
${calls(
  "leaving admin: its 'account_deleted' line (Admin)",
  `public.insert_audit_log(${uuid(leaving)}, 'account_deleted', 'user', ${lit(leaving)},
     ${lit(JSON.stringify({ target_email: "depart@example.invalid" }))}::jsonb)`,
)}
${writes("leaving admin: removes its own role (Admin)", `delete from public.user_roles where user_id = ${uuid(leaving)}`)}
reset role;

-- handle-registration: the caller's rights with their token, the rest with the service role.
${as("service_role")}
${writes(
  "handle-registration: grants the role",
  `insert into public.user_roles (user_id, role) values (${lit(pending)}, 'admin')`,
)}
${calls(
  "handle-registration: its 'registration_approved' line",
  `public.insert_audit_log(${uuid(superAdmin)}, 'registration_approved', 'user', ${lit(pending)},
     ${lit(JSON.stringify({ target_email: "inscription@example.invalid", target_username: "inscription" }))}::jsonb)`,
)}
reset role;
${asAuthenticated(superAdmin)}
${reads(
  "super admin: the journal (AuditLogTable)",
  "select * from public.get_audit_log(p_limit => 21, p_offset => 0)",
  `(action = 'role_deleted' and target_id = ${lit(removed)})
    or (action = 'account_deleted' and target_id = ${lit(leaving)})
    or (action = 'registration_approved' and target_id = ${lit(pending)})`,
)}
reset role;`);

  return compare(seen, {
    "anon: is_admin (useAdminRole)": "false",
    "anon: is_super_admin (useSuperAdminRole)": "false",
    "anon: published auditions (Index, Analysis)": "rows 2",
    "anon: counts of a published audition (Index)": "3/0",
    "anon: one published audition (AuditionDetail)": "rows 1",
    "anon: its testimonies (AuditionDetail)": "rows 3",
    "anon: auditions of the filters (TestimoniesPanel)": "rows 1",
    "anon: topics (TestimoniesPanel)": "rows 1",
    "anon: testimony count (TestimoniesPanel)": "rows 1",
    "anon: validated count (TestimoniesPanel)": "rows 1",
    "anon: a page of testimonies with their audition (TestimoniesPanel)": "rows 4",
    "anon: topics per audition (Analysis)": "rows 3",
    "anon: the testimony of a link (VerifyTestimony)": "rows 1",
    "anon: its audition (VerifyTestimony)": "rows 1",
    "anon: validate with corrections (VerifyTestimony)": "true",
    "anon: refuse (VerifyTestimony)": "true",
    "the validated testimony": `verified: ${edits.person_name} / ${edits.content}`,
    "the refused testimony": "0",
    "admin: is_admin": "true",
    "admin: is_super_admin": "false",
    "admin: creates a published audition (Admin)": "rows 1",
    "admin: creates a draft (Admin)": "rows 1",
    "admin: its testimonies with the audition (Admin)": "rows 3",
    "admin: adds a testimony (TestimonyManager)": "rows 1",
    "admin: the list (Admin)": "rows 3",
    "admin: testimonies of an own audition, with emails (Admin)": "rows 3",
    "admin: edits an own testimony (TestimonyEditDialog)": "rows 1",
    "admin: gives it a new link (TestimonyEditDialog)": "rows 1",
    "anon: validates the admin's testimony by its new link": "true",
    "admin: themes of a validated testimony (TestimonyManager, Admin)": "rows 1",
    "admin: opens an own draft to edit it (Admin)": "rows 1",
    "admin: publishes the draft (Admin)": "rows 1",
    "admin: deletes an own testimony (TestimonyManager)": "rows 1",
    "the validated testimony keeps its status through the themes": "verified: Santé",
    "super admin: is_super_admin": "true",
    "super admin: adds a testimony to an admin's audition (TestimonyManager)": "rows 1",
    "super admin: every draft in the list (Admin)": "rows 1",
    "super admin: testimonies of anyone's audition (Admin)": "rows 2",
    "super admin: edits anyone's testimony (TestimonyEditDialog)": "rows 1",
    "super admin: edits anyone's audition (Admin)": "rows 1",
    "super admin: testimonies to analyse (Admin)": "rows 2",
    "super admin: themes of anyone's testimony (Admin)": "rows 1",
    "super admin: deletes anyone's testimony (TestimonyManager)": "rows 1",
    "super admin: the roles (Admin)": "rows 1",
    "super admin: the registrations (Admin)": "rows 1",
    "super admin: removes a role (Admin)": "rows 1",
    "super admin: its 'role_deleted' line (Admin)": "done",
    "admin: deletes the testimonies of an own audition (Admin)": "rows 3",
    // The audition went with its last testimony: the page's own delete finds nothing left.
    "admin: then the audition (Admin)": "rows 0",
    "the deleted audition": "0",
    "leaving admin: its 'account_deleted' line (Admin)": "done",
    "leaving admin: removes its own role (Admin)": "rows 1",
    "handle-registration: grants the role": "rows 1",
    "handle-registration: its 'registration_approved' line": "done",
    "super admin: the journal (AuditLogTable)": "rows 3",
  });
}

export function checkOldAppLimits(): string[] {
  const [superAdmin, admin, other, former, pending] = Array.from({ length: 5 }, () => randomUUID());
  // The admin's own audition: a pending testimony and a validated, certified one.
  const mine = randomUUID();
  const [myPending, myValidated, forged] = [randomUUID(), randomUUID(), randomUUID()];
  // The other admin's: a published audition and a draft.
  const [theirs, theirDraft] = [randomUUID(), randomUUID()];
  const [theirTestimony, theirDraftTestimony] = [randomUUID(), randomUUID()];
  // The former admin's draft, and an online audition (nobody's).
  const [formerDraft, formerTestimony] = [randomUUID(), randomUUID()];
  const online = randomUUID();
  const [onlinePending, onlineValidated] = [randomUUID(), randomUUID()];
  const token = randomUUID();
  const certified = "2026-01-15 10:00:00+00";
  const longBio = "b".repeat(5000);
  const longName = "n".repeat(300);
  const kb = (n: number) => lit(JSON.stringify({ note: "x".repeat(n * 1024) }));
  const drafts = uuids([theirDraft, formerDraft]);
  const newTestimony = (audition: string, extra = "") => `
    insert into public.testimonies (audition_id, person_name, content, created_by${extra ? ", verification_status" : ""})
    values (${lit(audition)}, 'Témoin', 'Un témoignage', ${lit(admin)}${extra})`;
  const audit = (author: string | null, action: string, target: string, metadata = "'{}'") =>
    `public.insert_audit_log(${author ? uuid(author) : "null"}, ${lit(action)}, 'user', ${lit(target)}, ${metadata}::jsonb)`;

  const seen = replay(`
${accounts([
  { id: superAdmin, name: "super admin" },
  { id: admin, name: "admin" },
  { id: other, name: "autre admin" },
  { id: former, name: "ancien admin" },
  { id: pending, name: longName, bio: longBio },
])}
insert into public.user_roles (user_id, role) values
  (${lit(superAdmin)}, 'super_admin'), (${lit(admin)}, 'admin'), (${lit(other)}, 'admin');
-- One super admin: this one.
delete from public.user_roles where role = 'super_admin' and user_id <> ${uuid(superAdmin)};
insert into public.auditions (id, title, date, location, content, status, created_by) values
  (${lit(mine)}, 'old app: la mienne', current_date, 'Lyon', 'Audition de contrôle', 'published', ${lit(admin)}),
  (${lit(theirs)}, 'old app: la leur', current_date, 'Lyon', 'Audition de contrôle', 'published', ${lit(other)}),
  (${lit(theirDraft)}, 'old app: leur brouillon', current_date, 'Lyon', 'Audition de contrôle', 'draft', ${lit(other)}),
  (${lit(formerDraft)}, 'old app: brouillon d''un ancien admin', current_date, 'Lyon', 'Audition de contrôle', 'draft', ${lit(former)});
insert into public.auditions (id, title, date, location, content, status, audition_en_ligne, citycode, place) values
  (${lit(online)}, 'old app: en ligne', pg_catalog.date_trunc('month', current_date)::date, 'Mairie de contrôle',
   'Audition en ligne de contrôle', 'published', true, ${lit(ONLINE_CITYCODE)}, '{"insee": "old-app-check"}'::jsonb);
insert into public.testimonies (id, audition_id, person_name, content, email, verification_status, verification_token, created_by, created_at, consent_certified_by, consent_certified_at) values
  (${lit(myPending)}, ${lit(mine)}, 'Anne', 'En attente', 'anne@example.invalid', 'pending', ${lit(token)}, ${lit(admin)}, ${lit(certified)}, null, null),
  (${lit(myValidated)}, ${lit(mine)}, 'Bruno', 'Validé', null, 'verified', null, ${lit(admin)}, ${lit(certified)}, ${lit(admin)}, ${lit(certified)}),
  (${lit(theirTestimony)}, ${lit(theirs)}, 'Chloé', 'Chez un autre admin', 'chloe@example.invalid', 'pending', ${lit(randomUUID())}, ${lit(other)}, ${lit(certified)}, null, null),
  (${lit(theirDraftTestimony)}, ${lit(theirDraft)}, 'Denis', 'Dans leur brouillon', null, null, null, ${lit(other)}, ${lit(certified)}, null, null),
  (${lit(formerTestimony)}, ${lit(formerDraft)}, 'Élise', 'Dans le brouillon d''un ancien admin', null, null, null, ${lit(former)}, ${lit(certified)}, null, null),
  (${lit(onlinePending)}, ${lit(online)}, 'Farid', 'En ligne, en attente', null, 'pending', ${lit(randomUUID())}, null, ${lit(certified)}, null, null),
  (${lit(onlineValidated)}, ${lit(online)}, 'Gaëlle', 'En ligne, validé', null, 'verified', null, null, ${lit(certified)}, null, null);

-- The public key: published content and the three by-token functions, nothing else.
${as("anon")}
${reads("anon: counts of drafts", "select audition_id from public.audition_testimony_counts", `audition_id = any (${drafts})`)}
${reads("anon: drafts", "select id from public.auditions", `id = any (${drafts})`)}
${reads("anon: a pending online testimony", "select id from public.testimonies", `id = ${uuid(onlinePending)}`)}
${says("anon: has_role", `public.has_role('admin', ${uuid(admin)})`)}
${says("anon: verify_testimony", `public.verify_testimony('verify', ${lit(token)})`)}
${reads("anon: get_audit_log", "select * from public.get_audit_log()")}
${reads("anon: get_pending_registrations", "select * from public.get_pending_registrations()")}
${reads("anon: get_user_roles_with_details", "select * from public.get_user_roles_with_details()")}
${reads("anon: admin_testimonies", `select * from public.admin_testimonies(p_audition_id => ${uuid(theirs)})`)}
${calls("anon: an audit entry", audit(null, "account_deleted", admin))}
${reads("anon: audit_log", "select id from public.audit_log")}
${reads("anon: user_roles", "select id from public.user_roles")}
${reads("anon: a witness's email", `select email from public.testimonies where id = ${uuid(theirTestimony)}`)}
${writes("anon: inserts an audition", `insert into public.auditions (title, date, location, content) values ('x', current_date, 'Lyon', 'x')`)}
${writes("anon: updates a testimony", `update public.testimonies set content = 'x' where id = ${uuid(theirTestimony)}`)}
${writes("anon: deletes an audition", `delete from public.auditions where id = ${uuid(theirs)}`)}
${writes("anon: truncates audit_log", "truncate public.audit_log")}
${writes("anon: truncates user_roles", "truncate public.user_roles")}
reset role;

-- A confirmed account without a role (a registration waiting for approval).
${asAuthenticated(pending)}
${calls("pending: an audit entry about itself", audit(pending, "account_deleted", pending))}
${calls("pending: a server's audit entry", audit(pending, "registration_approved", pending))}
${reads("pending: drafts", "select id from public.auditions", `id = any (${drafts})`)}
${reads("pending: audit_log", "select id from public.audit_log")}
${writes("pending: truncates audit_log", "truncate public.audit_log")}
${says("pending: has_role", `public.has_role('admin', ${uuid(admin)})`)}
reset role;

-- An admin, past their own content.
${asAuthenticated(admin)}
${reads("admin: another admin's draft", "select id from public.auditions", `id = ${uuid(theirDraft)}`)}
${reads("admin: the testimonies of that draft", "select id from public.testimonies", `id = ${uuid(theirDraftTestimony)}`)}
${reads("admin: another admin's testimonies with emails", `select * from public.admin_testimonies(p_audition_id => ${uuid(theirs)})`)}
${reads("admin: one of them by its id", `select * from public.admin_testimonies(p_id => ${uuid(theirTestimony)})`)}
${reads("admin: own testimonies with emails", `select * from public.admin_testimonies(p_audition_id => ${uuid(mine)})`)}
${writes("admin: adds a testimony to another admin's audition", newTestimony(theirs))}
${writes("admin: adds a testimony to an online audition", newTestimony(online))}
${writes("admin: edits another admin's testimony", `update public.testimonies set content = 'x' where id = ${uuid(theirTestimony)}`)}
${writes("admin: deletes another admin's testimony", `delete from public.testimonies where id = ${uuid(theirTestimony)}`)}
${writes("admin: deletes the testimonies of another admin's audition", `delete from public.testimonies where audition_id = ${uuid(theirs)}`)}
${writes("admin: edits another admin's audition", `update public.auditions set title = 'x' where id = ${uuid(theirs)}`)}
${writes("admin: deletes another admin's audition", `delete from public.auditions where id = ${uuid(theirs)}`)}
${writes("admin: edits an online testimony", `update public.testimonies set content = 'x' where id = ${uuid(onlineValidated)}`)}
${writes("admin: deletes an online testimony", `delete from public.testimonies where id = ${uuid(onlineValidated)}`)}
${writes("admin: moves an own testimony to another audition", `update public.testimonies set audition_id = ${uuid(theirs)} where id = ${uuid(myPending)}`)}
${writes("admin: validates an own pending testimony", `update public.testimonies set verification_status = 'verified' where id = ${uuid(myPending)}`)}
${writes("admin: adds a testimony already validated", newTestimony(mine, ", 'verified'"))}
${writes(
  "admin: rewrites who wrote and certified an own testimony",
  `update public.testimonies
      set created_by = ${uuid(other)}, created_at = '2019-01-01', consent_certified_by = ${uuid(other)}, consent_certified_at = '2019-01-01'
    where id = ${uuid(myValidated)}`,
)}
${writes(
  "admin: adds a testimony in another's name, dated and certified by another",
  `insert into public.testimonies (id, audition_id, person_name, content, created_by, created_at, consent_certified_by, consent_certified_at)
   values (${lit(forged)}, ${lit(mine)}, 'Témoin', 'Un témoignage', ${lit(other)}, '2019-01-01', ${lit(other)}, '2019-01-01')`,
)}
${writes(
  "admin: adds an audition in another admin's name",
  `insert into public.auditions (title, date, location, content, created_by) values ('x', current_date, 'Lyon', 'x', ${lit(other)})`,
)}
${writes("admin: adds an audition without an author", `insert into public.auditions (title, date, location, content) values ('x', current_date, 'Lyon', 'x')`)}
${writes("admin: hands an own audition to another admin", `update public.auditions set created_by = ${uuid(other)} where id = ${uuid(mine)}`)}
${calls("admin: a 'role_deleted' line", audit(admin, "role_deleted", other))}
${calls("admin: an 'account_deleted' line about another", audit(admin, "account_deleted", other))}
${calls("admin: a line in another's name", audit(other, "account_deleted", other))}
${calls("admin: a server's line", audit(admin, "audition_deleted", admin))}
${calls("admin: an 'account_deleted' line with 3 kB", audit(admin, "account_deleted", admin, kb(3)))}
${writes("admin: grants itself a role", `insert into public.user_roles (user_id, role) values (${lit(admin)}, 'super_admin')`)}
${writes("admin: changes a role", `update public.user_roles set role = 'super_admin' where user_id = ${uuid(admin)}`)}
${writes("admin: removes another admin's role", `delete from public.user_roles where user_id = ${uuid(other)}`)}
${reads("admin: the roles", "select * from public.get_user_roles_with_details()")}
${reads("admin: the registrations", "select * from public.get_pending_registrations()")}
${reads("admin: the journal", "select * from public.get_audit_log()")}
${writes("admin: truncates auditions", "truncate public.auditions cascade")}
reset role;
${says(
  "the testimony the admin tried to move, validate and re-attribute",
  `(select (audition_id = ${uuid(mine)})::text || ' ' || verification_status from public.testimonies where id = ${uuid(myPending)})`,
)}
${says(
  "who wrote and certified the admin's validated testimony",
  `(select (created_by = ${uuid(admin)} and consent_certified_by = ${uuid(admin)}
            and created_at = ${lit(certified)} and consent_certified_at = ${lit(certified)})
     from public.testimonies where id = ${uuid(myValidated)})`,
)}
${says(
  "who wrote and certified the testimony added in another's name",
  `(select (created_by = ${uuid(admin)} and consent_certified_by = ${uuid(admin)}
            and created_at = pg_catalog.now() and consent_certified_at = pg_catalog.now())
     from public.testimonies where id = ${uuid(forged)})`,
)}

-- An account whose role was removed.
${asAuthenticated(former)}
${reads("former admin: an own draft", "select id from public.auditions", `id = ${uuid(formerDraft)}`)}
${reads("former admin: the testimonies of that draft", "select id from public.testimonies", `id = ${uuid(formerTestimony)}`)}
${reads("former admin: admin_testimonies", `select * from public.admin_testimonies(p_audition_id => ${uuid(formerDraft)})`)}
${writes("former admin: edits an own draft", `update public.auditions set title = 'x' where id = ${uuid(formerDraft)}`)}
${calls("former admin: an 'account_deleted' line", audit(former, "account_deleted", former))}
reset role;

-- A super admin: everything on content, but no validation in a witness's place,
-- and the last super admin role stays.
${asAuthenticated(superAdmin)}
${writes("super admin: validates a pending testimony", `update public.testimonies set verification_status = 'verified' where id = ${uuid(theirTestimony)}`)}
${calls("super admin: a 'role_deleted' line with 3 kB", audit(superAdmin, "role_deleted", other, kb(3)))}
${calls("super admin: a 'role_deleted' line about a 65-character id", audit(superAdmin, "role_deleted", "x".repeat(65)))}
${writes("super admin: removes the last super admin role", `delete from public.user_roles where user_id = ${uuid(superAdmin)}`)}
${reads(
  "super admin: a registration's name and presentation, cut",
  "select * from public.get_pending_registrations()",
  `user_id = ${uuid(pending)} and pg_catalog.length(username) = 80 and pg_catalog.length(bio) = 600`,
)}
reset role;

-- The server.
${as("service_role")}
${writes("server: removes the last super admin role", `delete from public.user_roles where user_id = ${uuid(superAdmin)}`)}
${writes("server: changes the last super admin role", `update public.user_roles set role = 'admin' where user_id = ${uuid(superAdmin)}`)}
${calls("server: an audit entry with 17 kB", audit(null, "audition_deleted", "x", kb(17)))}
${calls("server: an audit entry with 15 kB", audit(null, "audition_deleted", "x", kb(15)))}
reset role;

-- Accounts, as Auth writes and deletes them.
${writes(
  "a profile of 17 kB at sign-up",
  `insert into auth.users (id, aud, role, email, raw_user_meta_data)
   values (${lit(randomUUID())}, 'authenticated', 'authenticated', 'old-app-big@example.invalid', ${kb(17)}::jsonb)`,
)}
${writes("a profile raised to 17 kB", `update auth.users set raw_user_meta_data = ${kb(17)}::jsonb where id = ${uuid(pending)}`)}
${writes("a profile of 15 kB", `update auth.users set raw_user_meta_data = ${kb(15)}::jsonb where id = ${uuid(pending)}`)}
${writes("the last super admin's account is deleted", `delete from auth.users where id = ${uuid(superAdmin)}`)}
${writes("an admin's account is deleted", `delete from auth.users where id = ${uuid(other)}`)}
${says("the deleted admin's role rows", `(select count(*) from public.user_roles where user_id = ${uuid(other)})`)}
${says(
  "the deleted admin's auditions",
  `(select count(*) || ' kept, ' || count(created_by) || ' with an author' from public.auditions where id = any (${uuids([theirs, theirDraft])}))`,
)}`);

  return compare(seen, {
    "anon: counts of drafts": "rows 0",
    "anon: drafts": "rows 0",
    "anon: a pending online testimony": "rows 0",
    "anon: has_role": "refused 42501",
    "anon: verify_testimony": "refused 42501",
    "anon: get_audit_log": "refused 42501",
    "anon: get_pending_registrations": "refused 42501",
    "anon: get_user_roles_with_details": "refused 42501",
    "anon: admin_testimonies": "refused 42501",
    "anon: an audit entry": "refused 42501",
    "anon: audit_log": "refused 42501",
    "anon: user_roles": "refused 42501",
    "anon: a witness's email": "refused 42501",
    "anon: inserts an audition": "refused 42501",
    "anon: updates a testimony": "refused 42501",
    "anon: deletes an audition": "refused 42501",
    "anon: truncates audit_log": "refused 42501",
    "anon: truncates user_roles": "refused 42501",
    "pending: an audit entry about itself": "refused 42501",
    "pending: a server's audit entry": "refused 42501",
    "pending: drafts": "rows 0",
    "pending: audit_log": "refused 42501",
    "pending: truncates audit_log": "refused 42501",
    "pending: has_role": "refused 42501",
    "admin: another admin's draft": "rows 0",
    "admin: the testimonies of that draft": "rows 0",
    "admin: another admin's testimonies with emails": "rows 0",
    "admin: one of them by its id": "rows 0",
    "admin: own testimonies with emails": "rows 2",
    "admin: adds a testimony to another admin's audition": "refused 42501",
    "admin: adds a testimony to an online audition": "refused 42501",
    "admin: edits another admin's testimony": "rows 0",
    "admin: deletes another admin's testimony": "rows 0",
    "admin: deletes the testimonies of another admin's audition": "rows 0",
    "admin: edits another admin's audition": "rows 0",
    "admin: deletes another admin's audition": "rows 0",
    "admin: edits an online testimony": "rows 0",
    "admin: deletes an online testimony": "rows 0",
    // Written, and the audition kept: see "the testimony the admin tried to move".
    "admin: moves an own testimony to another audition": "rows 1",
    "admin: validates an own pending testimony": "refused 42501",
    "admin: adds a testimony already validated": "refused 42501",
    // Written, and the four columns kept: see "who wrote and certified".
    "admin: rewrites who wrote and certified an own testimony": "rows 1",
    "admin: adds a testimony in another's name, dated and certified by another": "rows 1",
    "admin: adds an audition in another admin's name": "refused 42501",
    "admin: adds an audition without an author": "refused 42501",
    "admin: hands an own audition to another admin": "refused 42501",
    "admin: a 'role_deleted' line": "refused 42501",
    "admin: an 'account_deleted' line about another": "refused 42501",
    "admin: a line in another's name": "refused 42501",
    "admin: a server's line": "refused 42501",
    "admin: an 'account_deleted' line with 3 kB": "refused 22023",
    "admin: grants itself a role": "refused 42501",
    "admin: changes a role": "refused 42501",
    "admin: removes another admin's role": "rows 0",
    "admin: the roles": "rows 0",
    "admin: the registrations": "rows 0",
    "admin: the journal": "rows 0",
    "admin: truncates auditions": "refused 42501",
    "the testimony the admin tried to move, validate and re-attribute": "true pending",
    "who wrote and certified the admin's validated testimony": "true",
    "who wrote and certified the testimony added in another's name": "true",
    "former admin: an own draft": "rows 0",
    "former admin: the testimonies of that draft": "rows 0",
    "former admin: admin_testimonies": "refused 42501",
    "former admin: edits an own draft": "rows 0",
    "former admin: an 'account_deleted' line": "refused 42501",
    "super admin: validates a pending testimony": "refused 42501",
    "super admin: a 'role_deleted' line with 3 kB": "refused 22023",
    "super admin: a 'role_deleted' line about a 65-character id": "refused 42501",
    "super admin: removes the last super admin role": "refused 23514",
    "super admin: a registration's name and presentation, cut": "rows 1",
    "server: removes the last super admin role": "refused 23514",
    "server: changes the last super admin role": "refused 23514",
    "server: an audit entry with 17 kB": "refused 22023",
    "server: an audit entry with 15 kB": "done",
    "a profile of 17 kB at sign-up": "refused 22023",
    "a profile raised to 17 kB": "refused 22023",
    "a profile of 15 kB": "rows 1",
    "the last super admin's account is deleted": "refused 23514",
    "an admin's account is deleted": "rows 1",
    "the deleted admin's role rows": "0",
    "the deleted admin's auditions": "2 kept, 0 with an author",
  });
}
