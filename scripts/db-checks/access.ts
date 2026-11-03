// Who reads drafts, and who writes the audit log, through the roles PostgREST
// uses, inside one rolled-back transaction:
// - a draft audition and its testimonies are read by admins only; anon and a
//   signed-in user who is not an admin see the published audition and its
//   testimonies;
// - insert_audit_log writes for the service role (any author, none included)
//   and for a signed-in user about their own action; anon, and a signed-in
//   user writing for someone else or for nobody, are refused.

import { randomUUID } from "node:crypto";
import { lit, sqlJson } from "./psql";
import { asAuthenticated } from "./writes";

const as = (role: "anon" | "service_role") => `
set local role ${role};
set local request.jwt.claims = ${lit(JSON.stringify({ role }))};`;

type Seen = { who: string; what: string; value: string }[];

/** As the current role: the ids it can read among ours. */
const reads = (who: string, auditions: string[], testimonies: string[]) => `
insert into pg_temp.access_seen
select ${lit(who)}, 'audition', id::text from public.auditions
 where id in (${auditions.map((a) => `${lit(a)}::uuid`).join(", ")});
insert into pg_temp.access_seen
select ${lit(who)}, 'testimony', id::text from public.testimonies
 where id in (${testimonies.map((t) => `${lit(t)}::uuid`).join(", ")});`;

/** As the current role: one audit entry, written or refused (with its SQLSTATE). */
const writesLog = (who: string, author: string | null) => `
do $$
begin
  perform public.insert_audit_log(${author ? `${lit(author)}::uuid` : "null"}, 'db:check', 'user', 'access');
  insert into pg_temp.access_seen values (${lit(who)}, 'audit', 'written');
exception when others then
  insert into pg_temp.access_seen values (${lit(who)}, 'audit', 'refused ' || sqlstate);
end
$$;`;

export function checkAccess(): string[] {
  const admin = randomUUID();
  const user = randomUUID();
  const other = randomUUID();
  const published = randomUUID();
  const draft = randomUUID();
  const [p1, p2, d1] = [randomUUID(), randomUUID(), randomUUID()];
  const auditions = [published, draft];
  const testimonies = [p1, p2, d1];

  const [seen] = sqlJson<Seen>(`
begin;
create temp table access_seen (who text, what text, value text) on commit drop;
grant insert on pg_temp.access_seen to anon, authenticated, service_role;
insert into public.user_roles (user_id, role) values (${lit(admin)}, 'admin');
-- audit_log.user_id references an account.
insert into auth.users (id) values (${lit(user)}), (${lit(other)});
insert into public.auditions (id, title, date, location, content, status) values
  (${lit(published)}, 'db:check publiée', current_date, 'Lyon', 'Audition de contrôle', 'published'),
  (${lit(draft)}, 'db:check brouillon', current_date, 'Lyon', 'Audition de contrôle', 'draft');
insert into public.testimonies (id, audition_id, person_name, content) values
  (${lit(p1)}, ${lit(published)}, 'Témoin 1', 'Un témoignage'),
  (${lit(p2)}, ${lit(published)}, 'Témoin 2', 'Un autre témoignage'),
  (${lit(d1)}, ${lit(draft)}, 'Témoin 3', 'Le témoignage d''un brouillon');
${as("anon")}
${reads("anon", auditions, testimonies)}
${writesLog("anon", null)}
reset role;
${asAuthenticated(user)}
${reads("user", auditions, testimonies)}
${writesLog("user for self", user)}
${writesLog("user for another", other)}
${writesLog("user for nobody", null)}
reset role;
${asAuthenticated(admin)}
${reads("admin", auditions, testimonies)}
reset role;
${as("service_role")}
${writesLog("server for nobody", null)}
${writesLog("server for a user", other)}
reset role;
insert into pg_temp.access_seen
select 'log', 'entries', count(*)::text from public.audit_log
 where action = 'db:check' and target_id = 'access';
select coalesce(json_agg(json_build_object('who', who, 'what', what, 'value', value)), '[]'::json)
  from pg_temp.access_seen;
rollback;`);

  const ids = (who: string, what: string) =>
    seen
      .filter((s) => s.who === who && s.what === what)
      .map((s) => s.value)
      .sort();
  const audit = (who: string) => seen.find((s) => s.who === who && s.what === "audit")?.value;
  const same = (a: string[], b: string[]) => a.join() === [...b].sort().join();
  const name = (id: string) =>
    ({ [published]: "published", [draft]: "draft", [p1]: "p1", [p2]: "p2", [d1]: "d1" })[id] ?? id;

  const errors: string[] = [];
  const expectReads = (who: string, wantA: string[], wantT: string[]) => {
    const gotA = ids(who, "audition");
    const gotT = ids(who, "testimony");
    if (!same(gotA, wantA))
      errors.push(`${who} reads auditions [${gotA.map(name)}], expected [${wantA.map(name)}]`);
    if (!same(gotT, wantT))
      errors.push(`${who} reads testimonies [${gotT.map(name)}], expected [${wantT.map(name)}]`);
  };
  expectReads("anon", [published], [p1, p2]);
  expectReads("user", [published], [p1, p2]);
  expectReads("admin", [published, draft], [p1, p2, d1]);

  const expectAudit = (who: string, written: boolean) => {
    const got = audit(who);
    const ok = written ? got === "written" : got?.startsWith("refused 42501");
    if (!ok)
      errors.push(
        `${who}: audit entry ${got ?? "not tried"}, expected ${written ? "written" : "refused (42501)"}`,
      );
  };
  expectAudit("anon", false);
  expectAudit("user for self", true);
  expectAudit("user for another", false);
  expectAudit("user for nobody", false);
  expectAudit("server for nobody", true);
  expectAudit("server for a user", true);
  const entries = seen.find((s) => s.who === "log")?.value;
  if (entries !== "3") errors.push(`${entries} audit entries written, expected 3`);
  return errors;
}
