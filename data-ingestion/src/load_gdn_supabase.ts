/*
 * Auditions Citoyennes — data ingestion pipeline
 * Copyright (C) 2026 Auditions Citoyennes
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. This program is distributed WITHOUT ANY WARRANTY;
 * see the GNU Affero General Public License for more details:
 * <https://www.gnu.org/licenses/>.
 */

/**
 * GDN curation, stage 5: load the curated + anonymised testimonies into
 * Supabase `public.imported_auditions`, tagged source='gdn'.
 *
 * SAFE BY DEFAULT — dry run: it validates and prints what it WOULD write and
 * touches nothing. Pass --execute (plus SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * in the env — RLS blocks anon writes) to actually upsert. Rows load as
 * status='draft': invisible to the public until the RGPD gate for GDN is
 * cleared (lawful basis + mentions légales + erasure route). Upsert is keyed on
 * (source, source_id) so re-runs update instead of duplicating.
 *
 * Run the migration first: supabase/migrations/20260711120000_imported_auditions.sql
 *
 * Usage: npm run load:gdn            (dry run)
 *        npm run load:gdn -- --execute
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { readNdjson } from "./lib/ndjson.js";
import { INTERIM_DIR, REPO_ROOT } from "./lib/paths.js";
import { loadRegistry, getSource } from "./lib/sources.js";
import { manifestEntry } from "./lib/manifest.js";

const { values: flags } = parseArgs({
  options: {
    execute: { type: "boolean", default: false },
    limit: { type: "string" },
    "chunk-size": { type: "string", default: "500" },
    // 'draft' (default, invisible to the public) or 'published' (visible — only
    // for a local test; the RGPD gate must be cleared before a real go-live).
    status: { type: "string", default: "draft" },
  },
});
const status = flags.status === "published" ? "published" : "draft";
if (status === "published") {
  console.warn(
    "! loading as status='published' — for testing only; RGPD gate (lawful basis + notice + erasure) must be cleared before a real publish.",
  );
}

const IN = path.join(INTERIM_DIR, "gdn", "curation", "curated-anonymised.ndjson");
if (!fs.existsSync(IN)) {
  console.error(`missing ${IN} — run "npm run curate:gdn:redact:apply" first`);
  process.exit(1);
}

const PRECISE = new Set(["housenumber", "street", "venue"]);
const source = getSource(loadRegistry(), "gdn");
const retrievedAt = manifestEntry("gdn", "events")?.retrieved_at ?? null;
const attribution = source.attribution.replace("{date}", (retrievedAt ?? "").slice(0, 10) || "—");

/** "23/02/2019" (or free text containing it) → "2019-02-23"; else null. */
function toIsoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.match(/\b([0-3]?\d)\/([01]?\d)\/(\d{4})\b/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function testimonyText(t: Record<string, string>): string {
  const labels: [keyof typeof t, string][] = [
    ["deroulement", "Déroulé"],
    ["constats", "Constats et diagnostics"],
    ["propositions", "Propositions"],
    ["avis", "Avis divergents"],
  ];
  return labels
    .map(([k, label]) => (t[k]?.trim() ? `## ${label}\n${t[k].trim()}` : ""))
    .filter(Boolean)
    .join("\n\n");
}

interface Row {
  source: string;
  source_id: string;
  title: string;
  held_on: string | null;
  address: string | null;
  city: string | null;
  postcode: string | null;
  citycode: string | null;
  lat: number | null;
  lng: number | null;
  geocode_precision: string;
  testimony: string;
  topics: string[];
  url: string | null;
  license: string;
  attribution: string;
  retrieved_at: string | null;
  has_personal_data: boolean;
  redaction_applied: boolean;
  status: "draft" | "published";
}

interface CuratedRow {
  id: string;
  title?: string;
  event_url?: string | null;
  location?: {
    precision?: string;
    lat?: unknown;
    lng?: unknown;
    address_raw?: string | null;
    city?: string | null;
    postcode?: string | null;
    citycode?: string | null;
  };
  cr?: { lieu_date?: unknown };
  testimony?: Record<string, string>;
  curation?: { personal_data?: boolean; topics?: unknown };
  redaction_applied?: boolean;
}

const rows: Row[] = [];
const violations: string[] = [];
for await (const it of readNdjson<CuratedRow>(IN)) {
  if (flags.limit && rows.length >= Number(flags.limit)) break;
  const loc = it.location ?? {};
  const precise = PRECISE.has(loc.precision ?? "");
  const lat = precise ? (typeof loc.lat === "number" ? loc.lat : null) : null;
  const lng = precise ? (typeof loc.lng === "number" ? loc.lng : null) : null;
  // Enforce the DB honesty invariant locally so --execute never 400s on the CHECK.
  if (precise && (lat === null || lng === null)) {
    violations.push(`${it.id}: precise tier "${loc.precision}" but missing coords`);
    continue;
  }
  const hasPd = Boolean(it.curation?.personal_data);
  const redacted = Boolean(it.redaction_applied);
  rows.push({
    source: "gdn",
    source_id: it.id,
    title: String(it.title ?? "Réunion locale").slice(0, 500),
    held_on: toIsoDate(it.cr?.lieu_date),
    address: loc.address_raw ?? null,
    city: loc.city ?? null,
    postcode: loc.postcode ?? null,
    citycode: loc.citycode ?? null, // INSEE — filled by enrich_citycode.ts
    lat,
    lng,
    geocode_precision: loc.precision ?? "unknown",
    testimony: testimonyText(it.testimony ?? {}),
    topics: Array.isArray(it.curation?.topics) ? it.curation.topics : [],
    url: it.event_url ?? null,
    license: source.license,
    attribution,
    retrieved_at: retrievedAt,
    has_personal_data: hasPd,
    redaction_applied: redacted,
    status,
  });
}

console.log(
  `prepared ${rows.length} rows for public.imported_auditions (source='gdn', status='${status}')`,
);
if (violations.length) {
  console.error(
    `✗ ${violations.length} rows violate the coords/precision invariant — fix before load:`,
  );
  for (const v of violations.slice(0, 10)) console.error(`   ${v}`);
  process.exit(1);
}
const pd = rows.filter((r) => r.has_personal_data);
const unredactedPd = pd.filter((r) => !r.redaction_applied);
console.log(
  `  with personal data: ${pd.length} (redaction applied: ${pd.length - unredactedPd.length})`,
);
if (unredactedPd.length) {
  console.warn(
    `  ! ${unredactedPd.length} rows have personal data with NO redaction applied — they load as draft but must not be published.`,
  );
}

if (!flags.execute) {
  console.log("\n--- DRY RUN (no DB write). Sample row: ---");
  const s = rows[0];
  console.log(JSON.stringify({ ...s, testimony: `${s.testimony.slice(0, 160)}…` }, null, 2));
  console.log(
    "\nRun the migration, then re-run with --execute + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to write.",
  );
  process.exit(0);
}

// --- execute -----------------------------------------------------------------
function readEnvVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  for (const p of [path.join(REPO_ROOT, "apps", "api", ".env"), path.join(REPO_ROOT, ".env")]) {
    if (!fs.existsSync(p)) continue;
    const line = fs
      .readFileSync(p, "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith(`${name}=`));
    if (line)
      return line
        .slice(line.indexOf("=") + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
  }
  return undefined;
}

const url = readEnvVar("SUPABASE_URL");
const key = readEnvVar("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error(
    "--execute needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (env or apps/api/.env)",
  );
  process.exit(1);
}

const chunkSize = Number(flags["chunk-size"]) || 500;
let written = 0;
for (let i = 0; i < rows.length; i += chunkSize) {
  const chunk = rows.slice(i, i + chunkSize);
  const res = await fetch(
    `${url.replace(/\/$/, "")}/rest/v1/imported_auditions?on_conflict=source,source_id`,
    {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(chunk),
    },
  );
  if (!res.ok) {
    console.error(
      `✗ upsert failed at chunk ${i / chunkSize} — HTTP ${res.status}: ${await res.text()}`,
    );
    process.exit(1);
  }
  written += chunk.length;
  console.log(`  upserted ${written}/${rows.length}`);
}
console.log(`✓ ${written} rows upserted into imported_auditions (status='draft', source='gdn')`);
