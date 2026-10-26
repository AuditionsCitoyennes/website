// Old-app-shaped writes: the live old app writes testimonies straight through
// PostgREST as `authenticated` (an admin's JWT), and verifies them with
// verify_testimony_by_token as `anon`; the API files online testimonies with
// submit_online_testimony as `service_role`. Done here the same way, inside one
// rolled-back transaction, the derived columns must come out filled and right,
// although none of these roles but service_role can run the helpers the
// trigger calls. Then the trigger's own safety net: with a helper that fails,
// the write still goes through, with NULLs and derive_version = -1. Last, a
// 2 MB answer of 100,000 lines saves well within a statement timeout (the
// trigger cannot catch a cancellation: a slow helper fails the write).

import { randomUUID } from "node:crypto";
import { AUDITION_QUESTIONS, composeAnswers } from "@ac/shared";
import { mismatches, rowsJson, type DerivedRow } from "./parity";
import { lit, sqlJson } from "./psql";

// The claims PostgREST would pass on; auth.uid() reads sub from them.
const asAuthenticated = (admin: string) => `
set local role authenticated;
set local request.jwt.claims = ${lit(JSON.stringify({ sub: admin, role: "authenticated" }))};`;

const asAnon = `
set local role anon;
set local request.jwt.claims = ${lit(JSON.stringify({ role: "anon" }))};`;

/** A long text, as an old-app admin might paste it: one answer of 100,000
 *  lines (about 2 MB), then two short ones. Quadratic helpers take ~7 s on it
 *  locally, linear ones ~0.4 s. */
const LONG_TEXT = [
  AUDITION_QUESTIONS[0],
  ...Array.from({ length: 100_000 }, (_, i) => (i % 10 === 9 ? "" : "Une ligne de réponse ")),
  AUDITION_QUESTIONS[1],
  "Bien.",
  AUDITION_QUESTIONS[2],
  "Tout.",
].join("\n");
const LONG_TIMEOUT = "3s";

function checkLongWrite(): string[] {
  const admin = randomUUID();
  const audition = randomUUID();
  const id = randomUUID();
  let rows: DerivedRow[];
  try {
    [rows] = sqlJson<DerivedRow[]>(`
begin;
insert into public.user_roles (user_id, role) values (${lit(admin)}, 'admin');
${asAuthenticated(admin)}
insert into public.auditions (id, title, date, location, content)
values (${lit(audition)}, 'db:check', current_date, 'Lyon', 'Audition de contrôle');
set local statement_timeout = ${lit(LONG_TIMEOUT)};
insert into public.testimonies (id, audition_id, person_name, content)
values (${lit(id)}, ${lit(audition)}, 'Long', ${lit(LONG_TEXT)});
reset role;
${rowsJson(`from public.testimonies where id = ${lit(id)}::uuid`)}
rollback;`);
  } catch (e) {
    return [
      `a ${LONG_TEXT.length}-character testimony did not save within ${LONG_TIMEOUT}: ${(e as Error).message}`,
    ];
  }
  if (rows.length !== 1) return ["the long testimony was not written"];
  return mismatches(rows[0], "long testimony");
}

export function checkWrites(): string[] {
  const admin = randomUUID();
  const audition = randomUUID();
  const [tagged, untagged, pending, failing] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const token = randomUUID();
  const onlineToken = randomUUID();
  const online = {
    name: "Inès",
    info: "En ligne",
    content: composeAnswers(["Comme ci", "Comme ça", "Plus de BUS"]),
  };
  const ids = [tagged, untagged, pending];
  const edits = {
    person_name: "Témoin Vérifié",
    person_info: "Édité par le lien",
    content: composeAnswers(["Très BIEN, merci", "", "Changer l'ÉCOLE"]),
  };

  const out = sqlJson<unknown>(`
begin;
insert into public.user_roles (user_id, role) values (${lit(admin)}, 'admin');
${asAuthenticated(admin)}
insert into public.auditions (id, title, date, location, content)
values (${lit(audition)}, 'db:check', current_date, 'Lyon', 'Audition de contrôle');
insert into public.testimonies (id, audition_id, person_name, person_info, content, topics)
values (${lit(tagged)}, ${lit(audition)}, 'Anne', '34 ans', 'Premier texte', array['démocratie', 'Énergie']);
insert into public.testimonies (id, audition_id, person_name, content)
values (${lit(untagged)}, ${lit(audition)}, 'Bruno', 'Sans thème');
update public.testimonies set content = ${lit(composeAnswers(["Ça va", "La France va mal", ""]))} where id = ${lit(tagged)};
update public.testimonies set topics = array['Logement', 'transports'] where id = ${lit(untagged)};
update public.testimonies set person_info = 'Retraité' where id = ${lit(untagged)};
insert into public.testimonies (id, audition_id, person_name, content, verification_status, verification_token)
values (${lit(pending)}, ${lit(audition)}, 'Chloé', 'Texte avant vérification', 'pending', ${lit(token)});
reset role;
${asAnon}
select pg_catalog.to_jsonb(public.verify_testimony_by_token(${lit(token)}, ${lit(JSON.stringify(edits))}::jsonb));
reset role;
${rowsJson(`from public.testimonies where id = any (array[${ids.map((id) => `${lit(id)}::uuid`).join(", ")}])`)}
set local role service_role;
select pg_catalog.to_jsonb(public.submit_online_testimony(
  'db-check', ${lit(online.name)}, ${lit(online.info)}, ${lit(online.content)}, 'db-check', 'Mairie de contrôle',
  '{"insee": "db-check"}'::jsonb, pg_catalog.date_trunc('month', current_date)::date,
  'Audition en ligne de contrôle', 'Contrôle', ${lit(onlineToken)}::uuid) ? 'testimony_id');
reset role;
${rowsJson(`from public.testimonies where verification_token = ${lit(onlineToken)}`)}
create or replace function ac.answers_text(p_content text) returns text
language plpgsql immutable strict set search_path = '' as $$ begin raise exception 'db:check'; end $$;
${asAuthenticated(admin)}
insert into public.testimonies (id, audition_id, person_name, content, topics)
values (${lit(failing)}, ${lit(audition)}, 'Denis', 'Écrit malgré tout', array['santé']);
reset role;
${rowsJson(`from public.testimonies where id = ${lit(failing)}::uuid`)}
rollback;`);

  const errors: string[] = [];
  const [verified, rows, submitted, onlineRows, failed] = out as [
    boolean,
    DerivedRow[],
    boolean,
    DerivedRow[],
    DerivedRow[],
  ];
  if (verified !== true) errors.push("verify_testimony_by_token with edits did not verify the row");
  if (submitted !== true || onlineRows.length !== 1) {
    errors.push("submit_online_testimony did not file the testimony");
  } else {
    errors.push(...mismatches(onlineRows[0], "submit_online_testimony as service_role"));
  }
  if (rows.length !== ids.length) errors.push(`${rows.length} rows written of ${ids.length}`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const verifiedRow = byId.get(pending);
  if (verifiedRow && verifiedRow.content !== edits.content) {
    errors.push("verify_testimony_by_token did not apply the edits");
  }
  for (const [label, id] of [
    ["insert with topics, then content update", tagged],
    ["insert without topics, then topics and person_info updates", untagged],
    ["verify_testimony_by_token with edits", pending],
  ] as const) {
    const row = byId.get(id);
    if (row) errors.push(...mismatches(row, label));
  }
  const f = failed[0];
  if (!f) {
    errors.push("a failing helper blocked the write");
  } else if (
    f.derive_version !== -1 ||
    f.search_text !== null ||
    f.theme_mask !== null ||
    f.themes_approx !== null ||
    f.untagged !== null
  ) {
    errors.push(`a failing helper should leave NULLs and derive_version -1: ${JSON.stringify(f)}`);
  }
  errors.push(...checkLongWrite());
  return errors;
}
