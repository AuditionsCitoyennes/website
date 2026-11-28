// Who reads drafts, and who writes the audit log, through the roles PostgREST
// uses, inside one rolled-back transaction:
// - a draft audition is read by the admin who created it and by super admins;
//   its testimonies by them, and by the admin who created the testimony. Anon,
//   a signed-in account without a role and another admin see the published
//   audition and its testimonies;
// - insert_audit_log writes any entry for the server: the service role, and a
//   session without request claims (psql, a scheduled job, the seed), with at
//   most 16 kB of metadata. A signed-in account writes two entries, about a
//   user, under its own id, with at most 2 kB: 'role_deleted' as a super
//   admin, 'account_deleted' about itself as an admin. Anything else is
//   refused.

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

interface Entry {
  author: string | null;
  action?: string;
  target?: string;
  /** Size of the metadata, in kB. */
  kb?: number;
}

/** As the current role: one audit entry, written or refused (with its SQLSTATE). */
const writesLog = (
  who: string,
  { author, action = "db:check", target = "access", kb = 0 }: Entry,
) => `
do $$
begin
  perform public.insert_audit_log(${author ? `${lit(author)}::uuid` : "null"}, ${lit(action)}, 'user', ${lit(target)},
    ${lit(JSON.stringify({ check: "access", note: "x".repeat(kb * 1024) }))}::jsonb);
  insert into pg_temp.access_seen values (${lit(who)}, 'audit', 'written');
exception when others then
  insert into pg_temp.access_seen values (${lit(who)}, 'audit', 'refused ' || sqlstate);
end
$$;`;

export function checkAccess(): string[] {
  const [author, admin, superAdmin, user, other] = Array.from({ length: 5 }, () => randomUUID());
  const published = randomUUID();
  const draft = randomUUID();
  // d1 by the draft's author, d2 added to that draft by the other admin.
  const [p1, p2, d1, d2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const auditions = [published, draft];
  const testimonies = [p1, p2, d1, d2];

  const [seen] = sqlJson<Seen>(`
begin;
create temp table access_seen (who text, what text, value text) on commit drop;
grant insert on pg_temp.access_seen to anon, authenticated, service_role;
-- A role, an audition's author and an audit entry's author each reference an account.
insert into auth.users (id) values
  (${lit(author)}), (${lit(admin)}), (${lit(superAdmin)}), (${lit(user)}), (${lit(other)});
insert into public.user_roles (user_id, role) values
  (${lit(author)}, 'admin'), (${lit(admin)}, 'admin'), (${lit(superAdmin)}, 'super_admin');
insert into public.auditions (id, title, date, location, content, status, created_by) values
  (${lit(published)}, 'db:check publiée', current_date, 'Lyon', 'Audition de contrôle', 'published', ${lit(author)}),
  (${lit(draft)}, 'db:check brouillon', current_date, 'Lyon', 'Audition de contrôle', 'draft', ${lit(author)});
insert into public.testimonies (id, audition_id, person_name, content, created_by) values
  (${lit(p1)}, ${lit(published)}, 'Témoin 1', 'Un témoignage', ${lit(author)}),
  (${lit(p2)}, ${lit(published)}, 'Témoin 2', 'Un autre témoignage', ${lit(author)}),
  (${lit(d1)}, ${lit(draft)}, 'Témoin 3', 'Le témoignage d''un brouillon', ${lit(author)}),
  (${lit(d2)}, ${lit(draft)}, 'Témoin 4', 'Ajouté par un autre admin', ${lit(admin)});
${writesLog("psql session", { author: null })}
${as("anon")}
${reads("anon", auditions, testimonies)}
${writesLog("anon", { author: null })}
reset role;
${asAuthenticated(user)}
${reads("user", auditions, testimonies)}
${writesLog("user for self", { author: user, action: "account_deleted", target: user })}
${writesLog("user for another", { author: other })}
${writesLog("user for nobody", { author: null })}
reset role;
${asAuthenticated(admin)}
${reads("admin", auditions, testimonies)}
${writesLog("admin, a server's entry", { author: admin })}
${writesLog("admin, role_deleted", { author: admin, action: "role_deleted", target: other })}
${writesLog("admin, account_deleted about another", { author: admin, action: "account_deleted", target: other })}
${writesLog("admin, account_deleted with 3 kB", { author: admin, action: "account_deleted", target: admin, kb: 3 })}
${writesLog("admin, account_deleted", { author: admin, action: "account_deleted", target: admin })}
reset role;
${asAuthenticated(author)}
${reads("author", auditions, testimonies)}
reset role;
${asAuthenticated(superAdmin)}
${reads("super admin", auditions, testimonies)}
${writesLog("super admin, role_deleted", { author: superAdmin, action: "role_deleted", target: other })}
reset role;
${as("service_role")}
${writesLog("server for nobody", { author: null })}
${writesLog("server for a user", { author: other, kb: 15 })}
${writesLog("server with 17 kB", { author: null, kb: 17 })}
reset role;
insert into pg_temp.access_seen
select 'log', 'entries', count(*)::text from public.audit_log
 where metadata ->> 'check' = 'access';
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
    ({
      [published]: "published",
      [draft]: "draft",
      [p1]: "p1",
      [p2]: "p2",
      [d1]: "d1",
      [d2]: "d2",
    })[id] ?? id;

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
  expectReads("admin", [published], [p1, p2, d2]);
  expectReads("author", [published, draft], [p1, p2, d1, d2]);
  expectReads("super admin", [published, draft], [p1, p2, d1, d2]);

  const expectAudit = (who: string, want: "written" | "refused 42501" | "refused 22023") => {
    const got = audit(who);
    if (got !== want) errors.push(`${who}: audit entry ${got ?? "not tried"}, expected ${want}`);
  };
  expectAudit("psql session", "written");
  expectAudit("anon", "refused 42501");
  expectAudit("user for self", "refused 42501");
  expectAudit("user for another", "refused 42501");
  expectAudit("user for nobody", "refused 42501");
  expectAudit("admin, a server's entry", "refused 42501");
  expectAudit("admin, role_deleted", "refused 42501");
  expectAudit("admin, account_deleted about another", "refused 42501");
  expectAudit("admin, account_deleted with 3 kB", "refused 22023");
  expectAudit("admin, account_deleted", "written");
  expectAudit("super admin, role_deleted", "written");
  expectAudit("server for nobody", "written");
  expectAudit("server for a user", "written");
  expectAudit("server with 17 kB", "refused 22023");
  const entries = seen.find((s) => s.who === "log")?.value;
  if (entries !== "5") errors.push(`${entries} audit entries written, expected 5`);
  return errors;
}
