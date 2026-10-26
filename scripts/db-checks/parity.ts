// Derived parity: the columns the trigger keeps (search_text, theme_mask,
// themes_approx, untagged) against the TypeScript the site runs, over every
// testimony in the database plus the edge corpus of fixture.ts (inserted in a
// rolled-back transaction). Also: no row may carry derive_version = -1.

import { randomUUID } from "node:crypto";
import { AUDITION_THEMES, searchHaystack, themesApproximate, themesOf } from "@ac/shared";
import { fixtureRows } from "./fixture";
import { lit, sqlJson } from "./psql";

export interface DerivedRow {
  id: string;
  person_name: string;
  person_info: string | null;
  content: string;
  topics: string[] | null;
  search_text: string | null;
  theme_mask: number | null;
  themes_approx: boolean | null;
  untagged: boolean | null;
  derive_version: number | null;
}

const COLUMNS =
  "id, person_name, person_info, content, topics, search_text, theme_mask, themes_approx, untagged, derive_version";

/** A select printing the rows as one jsonb array. */
export const rowsJson = (from: string) =>
  `select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.id), '[]'::jsonb) from (select ${COLUMNS} ${from}) x;`;

const ORDER = new Map<string, number>(AUDITION_THEMES.map((t, i) => [t, i]));

/** What the site makes of a row, in the columns' terms. */
export function expected(
  row: Pick<DerivedRow, "person_name" | "person_info" | "content" | "topics">,
) {
  return {
    search_text: searchHaystack(row),
    theme_mask: themesOf(row.topics).reduce((m, t) => m | (1 << ORDER.get(t)!), 0),
    themes_approx: themesApproximate(row.topics),
    untagged: !row.topics?.length,
    derive_version: 1,
  };
}

const show = (v: unknown) => {
  const s = JSON.stringify(v);
  if (s.length <= 160) return s;
  return `${s.slice(0, 160)}…${typeof v === "string" ? ` (${v.length} chars)` : ""}`;
};

/** Every difference between a row's columns and the TypeScript. */
export function mismatches(row: DerivedRow, label: string): string[] {
  let want: ReturnType<typeof expected>;
  try {
    want = expected(row);
  } catch (e) {
    return [`${label}: the TypeScript throws on this row (${(e as Error).message})`];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(want) as [keyof typeof want, unknown][]) {
    if (row[k] !== v) {
      let where = "";
      if (k === "search_text" && typeof v === "string" && typeof row[k] === "string") {
        const a = row[k] as string;
        let i = 0;
        while (i < a.length && i < v.length && a[i] === v[i]) i++;
        where = ` (first difference at ${i}: sql ${show(a.slice(i, i + 20))}, ts ${show(v.slice(i, i + 20))})`;
      }
      out.push(`${label} ${k}: sql ${show(row[k])}, ts ${show(v)}${where}`);
    }
  }
  return out;
}

const PAGE = 2000;

function* databaseRows(): Generator<DerivedRow[]> {
  let after: string | null = null;
  for (;;) {
    const where: string = after ? `where id > ${lit(after)}::uuid` : "";
    const [page] = sqlJson<DerivedRow[]>(
      rowsJson(`from public.testimonies ${where} order by id limit ${PAGE}`),
    );
    if (page.length === 0) return;
    yield page;
    if (page.length < PAGE) return;
    after = page[page.length - 1].id;
  }
}

function fixtureResults(): DerivedRow[] {
  const rows = fixtureRows().map((r) => ({ id: randomUUID(), ...r }));
  const [out] = sqlJson<DerivedRow[]>(`
begin;
insert into public.testimonies (id, person_name, person_info, content, topics)
select id, person_name, person_info, content, topics
  from pg_catalog.jsonb_to_recordset(${lit(JSON.stringify(rows))}::jsonb)
    as x(id uuid, person_name text, person_info text, content text, topics text[]);
${rowsJson(`from public.testimonies where id = any (array[${rows.map((r) => `${lit(r.id)}::uuid`).join(", ")}])`)}
rollback;`);
  if (out.length !== rows.length)
    throw new Error(`fixture: ${out.length} rows back of ${rows.length}`);
  // The rows as sent, not as read back: a transport difference must not hide.
  const sent = new Map<string, (typeof rows)[number]>(rows.map((r) => [r.id, r]));
  return out.map((r) => ({ ...r, ...sent.get(r.id)! }));
}

export function checkParity(): { errors: string[]; checked: number } {
  const errors: string[] = [];
  let checked = 0;
  let failed = 0;
  for (const page of databaseRows()) {
    for (const row of page) {
      checked++;
      if (row.derive_version === -1) failed++;
      errors.push(...mismatches(row, `testimony ${row.id}`));
    }
  }
  if (failed) errors.push(`${failed} testimonies have derive_version = -1`);
  const fixture = fixtureResults();
  for (const [i, row] of fixture.entries()) {
    checked++;
    errors.push(...mismatches(row, `fixture #${i} ${show(row.content).slice(0, 40)}`));
  }
  return { errors, checked };
}
